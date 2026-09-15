/**
 * The in-process store composition: every commerce adapter, constructed once
 * over the document store the host injects.
 *
 * ONE SET PER INVOCATION, and one shared clock and id source across all of them.
 * That is not tidiness: a checkout writes a cart, an inventory hold and an order
 * in three separate guarded writes, and a deadline stamped by one store has to be
 * the same instant the next store compares against. Two clocks would make hold
 * expiry disagree with itself.
 *
 * THE CROSS-STORE EDGES ARE WIRED HERE, because they are real edges and not
 * conveniences:
 *  - the cart store takes the inventory store (it stamps hold deadlines and
 *    reserves through it, and needs the adapter-level deadline stamp the domain
 *    port does not declare);
 *  - the order store takes the same inventory store (hold adoption, commit and
 *    release are cross-aggregate);
 *  - the order store also takes the reporting store as its rollup writer, so
 *    revenue and order-state rollups accrue from the first order rather than
 *    being backfilled later;
 *  - the credential verifier takes the customer store, because a login challenge
 *    resolves to a customer.
 * Everything else shares state through the collections rather than through an
 * object, which is why it takes no sibling store.
 *
 * TWO TTLs TAKE THE DOMAIN'S DEFAULTS HERE, AND THAT IS A PARITY GAP, not a
 * design choice — say so plainly, because the knob exists in both places this
 * composition replaces. The deployment documentation carries one environment
 * variable that drives BOTH the cart hold and the checkout hold, and the settings
 * aggregate this function builds a store for carries a hold-TTL setting of its
 * own. Neither is read here: nothing in the plugin reads a TTL yet, so a
 * deployment that had moved its hold window would silently get fifteen minutes
 * back.
 *
 * Reading it belongs with the settings and scheduled-sweep wiring, where the
 * value is loaded once and the sweeps that expire holds run — a TTL read
 * per-request off a store is a read on the hot path for a value that changes
 * almost never. It is a MUST-CLOSE item before a deployment flips to this
 * transport, and it is recorded as one rather than left for someone to discover
 * from a shorter hold.
 *
 * SANDBOX-CLEAN. Nothing here opens a connection, reads an environment or
 * imports host code: the storage arrives injected on `ctx`, the clock is `Date`
 * and the id source is WebCrypto off `globalThis`. That is the whole reason the
 * adapters can run inside the isolate at all (ADR-0018).
 */

import type {
	AddressStore,
	Clock,
	CouponStore,
	CustomerCredentialVerifier,
	CustomerStore,
	EntitlementStore,
	IdGen,
	PaymentEventStore,
	SessionStore,
} from "@otta-sh/domain";
import {
	EmdashAddressStore,
	EmdashCartStore,
	EmdashCouponStore,
	EmdashCredentialVerifier,
	EmdashCustomerStore,
	EmdashEntitlementStore,
	EmdashInventoryStore,
	EmdashOrderNotesStore,
	EmdashOrderStore,
	EmdashPaymentEventStore,
	EmdashProductCommerceStore,
	EmdashReportingStore,
	EmdashSessionStore,
	EmdashSettingsStore,
	EmdashShippingRulesStore,
	EmdashTaxRulesStore,
	systemClock,
	uuidIdGen,
} from "@otta-sh/store-emdash";
import type { StorageAccess as AdapterStorageAccess } from "@otta-sh/store-emdash";
import type { PluginContext, StorageAccess as PluginStorageAccess } from "../types.js";

/** Test-facing overrides. A deploy passes none of them. */
export interface InProcessCommerceStoresOptions {
	/** Deterministic time, for a suite that pins deadlines. Default: real time. */
	clock?: Clock;
	/** Deterministic ids, for a suite that pins them. Default: WebCrypto UUIDs. */
	idGen?: IdGen;
}

/**
 * Every store the storefront surface composes over, plus the clock and id source
 * they share. Typed to the concrete adapter where a caller needs more than the
 * domain port declares, and to the port otherwise.
 */
export interface InProcessCommerceStores {
	readonly clock: Clock;
	readonly idGen: IdGen;
	readonly inventory: EmdashInventoryStore;
	readonly cartStore: EmdashCartStore;
	readonly orderStore: EmdashOrderStore;
	readonly orderNotesStore: EmdashOrderNotesStore;
	readonly productCommerce: EmdashProductCommerceStore;
	readonly couponStore: CouponStore;
	readonly shippingRules: EmdashShippingRulesStore;
	readonly taxRules: EmdashTaxRulesStore;
	readonly entitlementStore: EntitlementStore;
	readonly paymentEventStore: PaymentEventStore;
	readonly customerStore: CustomerStore;
	readonly addressStore: AddressStore;
	readonly sessionStore: SessionStore;
	readonly credentialVerifier: CustomerCredentialVerifier;
	readonly reportingStore: EmdashReportingStore;
	readonly settingsStore: EmdashSettingsStore;
}

/**
 * The message a caller gets when the context carries no document store. Named
 * and specific, because the fix is a descriptor edit in a different file: the
 * deployment declares the collections, the host builds the store from that
 * declaration, and a context without one means the declaration is missing.
 */
export const MISSING_STORAGE_MESSAGE =
	"in-process commerce needs the plugin's document store; declare the commerce collections so the host injects it";

/** Construct every commerce store over `ctx.storage`, sharing one clock and one
 *  id source. Throws {@link MISSING_STORAGE_MESSAGE} when the context has none. */
export function createInProcessCommerceStores(
	ctx: PluginContext,
	options: InProcessCommerceStoresOptions = {},
): InProcessCommerceStores {
	/**
	 * THE ONE PLACE THE TWO SHAPES MEET, and the reason the plugin's context can
	 * describe the document store without naming the host's types. `ctx.storage` is
	 * declared against this package's own structural mirror (see `types.ts`); the
	 * adapters are written against theirs. This assignment is what proves the two
	 * agree — a drift in either is a typecheck failure HERE rather than a runtime
	 * surprise in a store method, and it costs nothing at runtime: the annotation
	 * emits no code.
	 *
	 * BOTH DIRECTIONS are checked, by this assignment and by the mutual-assignability
	 * pair below it. One direction alone would let the mirror drift WIDER — a method
	 * the adapters need but the mirror does not describe still satisfies "mirror is
	 * assignable to adapter" for every field they share, and the gap would surface
	 * only when a store called the missing method.
	 */
	const storage: AdapterStorageAccess | undefined = ctx.storage;
	if (storage === undefined) throw new Error(MISSING_STORAGE_MESSAGE);
	// The other direction, type-only: what the adapters accept is also describable by
	// the mirror, so neither shape can quietly gain or lose a method.
	const mirrored: PluginStorageAccess = storage;
	void mirrored;

	const clock = options.clock ?? systemClock;
	const idGen = options.idGen ?? uuidIdGen;

	const inventory = new EmdashInventoryStore({ storage, idGen, clock });
	const reportingStore = new EmdashReportingStore({ storage, clock });
	// ONE customer store, shared with the verifier that resolves a login
	// challenge to a customer: the stores hold no state of their own beyond the
	// collections, so sharing the instance is what keeps the edge visible.
	const customerStore = new EmdashCustomerStore({ storage, idGen, clock });

	return {
		clock,
		idGen,
		inventory,
		cartStore: new EmdashCartStore({ storage, inventory, idGen, clock }),
		// The rollup writer travels with the order store, so every transition and
		// every finalized refund rolls up as it happens.
		orderStore: new EmdashOrderStore({
			storage,
			inventory,
			idGen,
			clock,
			reporting: reportingStore,
		}),
		orderNotesStore: new EmdashOrderNotesStore({ storage, idGen, clock }),
		productCommerce: new EmdashProductCommerceStore({ storage, clock }),
		couponStore: new EmdashCouponStore({ storage, idGen, clock }),
		shippingRules: new EmdashShippingRulesStore({ storage, clock }),
		taxRules: new EmdashTaxRulesStore({ storage, clock }),
		entitlementStore: new EmdashEntitlementStore({ storage, idGen, clock }),
		paymentEventStore: new EmdashPaymentEventStore({ storage }),
		customerStore,
		addressStore: new EmdashAddressStore({ storage, idGen, clock }),
		sessionStore: new EmdashSessionStore({ storage, idGen, clock }),
		credentialVerifier: new EmdashCredentialVerifier({
			storage,
			customerStore,
			idGen,
			clock,
		}),
		reportingStore,
		settingsStore: new EmdashSettingsStore({ storage, clock }),
	};
}
