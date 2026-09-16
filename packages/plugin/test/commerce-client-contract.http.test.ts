/**
 * The HTTP tier of `commerceClientContract` (work order 02, INC-A7 / D7 tier
 * T5(a)).
 *
 * This file binds the transport-agnostic contract to `HttpCommerceClient` and
 * the four admin HTTP clients over a LIVE `@otta-sh/service` (Postgres-backed)
 * — the same harness the eight source client test files used, and the same
 * `PG_CONNECTION_STRING` gating, so a run without a database skips exactly what
 * it skipped before.
 *
 * It REPLACES the transport-agnostic cases of
 * `http-commerce-client.test.ts`, `http-commerce-client-cart.test.ts` and
 * `admin-rules-client.test.ts`. Each of those files keeps only its HTTP-wire
 * cases (request shape, headers, base-URL joining, status→error mapping); see
 * `test/contracts/README.md` for the classification rule.
 *
 * ⚠ THIS FILE IS DELETED AT INC-D3b together with the HTTP transport. The
 * contract it invokes is what survives — INC-B10a/b/c add a second tier that
 * runs the very same cases with no HTTP anywhere.
 */
import { afterAll, describe } from "vitest";
import { AdminOrdersClient } from "../src/admin/admin-orders-client.js";
import { AdminProductsClient } from "../src/admin/admin-products-client.js";
import { AdminRulesClient } from "../src/admin/admin-rules-client.js";
import { ReportingSettingsClient } from "../src/admin/reporting-client.js";
import type { CommerceClient } from "../src/product-commerce/commerce-client.js";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import {
	adminOrdersProductsClientContract,
	adminRulesReportingClientContract,
	type AdminClientSurfaces,
	type CommerceClientTier,
	storefrontCommerceClientContract,
} from "./contracts/commerce-client-contract.js";
import { sharedTierSeeders } from "./helpers/commerce-tier-arrange.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/** The admin gate + write gate secrets the admin tier's service enforces —
 *  exactly the pair `admin-rules-client.test.ts` booted its service with. */
const ADMIN_TOKEN = "admin-secret";
const ADMIN_SERVICE_TOKEN = "svc-secret";

interface HttpTierOptions {
	name: string;
	/** Boot the service with the admin + write gates closed, and thread both
	 *  tokens into every client. Omitted ⇒ a gate-open service and tokenless
	 *  clients, which is how the storefront client tests always ran. */
	gated?: boolean;
}

/**
 * The HTTP tier. `arrange` programs backend state the way the source files
 * already did — through the client's own writes against the live service — so
 * nothing here is invented: `arrange.product` is their `seedProduct` /
 * `parentProduct` helpers, and `arrange.cart` is their `createCart` setup call.
 */
function httpTier(options: HttpTierOptions): CommerceClientTier {
	let service: LiveService | undefined;
	let client: CommerceClient | undefined;

	function baseOptions(): { fetch: typeof globalThis.fetch; baseUrl: string } {
		if (service === undefined) throw new Error("tier not set up");
		return { fetch: globalThis.fetch, baseUrl: service.baseUrl };
	}

	function serviceOrThrow(): LiveService {
		if (service === undefined) throw new Error("tier not set up");
		return service;
	}

	/**
	 * A real login, end to end over the wire and through a CAPTURING MAIL SENDER.
	 *
	 * The magic link's token is in the mail and nowhere else — the request reply is
	 * deliberately generic, so that an attacker cannot learn from it whether an
	 * account exists — which means the only honest way to hold the token a shopper
	 * would have received is to capture the message. The service is started with a
	 * sender that records instead of delivering, and this reads the last recorded
	 * login message. Both calls go through the CLIENT, so the case is exercising the
	 * transport rather than a shortcut around it.
	 */
	async function login(email: string): Promise<{ bearer: string; customerId?: string }> {
		const live = serviceOrThrow();
		const c = await clientOrThrow();
		await c.requestLoginLink(email);
		// BY RECIPIENT AS WELL AS TEMPLATE. The capture is cumulative for the whole
		// slice, so "the last login message" is whichever case logged in most recently —
		// which would hand this call another shopper's challenge and mint a session for
		// the wrong customer. A case asserting cross-customer isolation would then be
		// comparing one customer against themselves, and would pass while proving nothing.
		const captured = live.emailSender.sends.filter(
			(sent) => sent.template === "customer-login-link" && String(sent.to) === email,
		);
		const last = captured[captured.length - 1];
		if (last === undefined) {
			throw new Error(`arrange.session: no login message was dispatched to ${email}`);
		}
		const challengeId = last.data["challengeId"];
		const token = last.data["token"];
		if (typeof challengeId !== "string" || typeof token !== "string") {
			throw new Error("arrange.session: the captured login message carries no challenge");
		}
		const verified = await c.verifyLogin(challengeId, token);
		if (!verified.ok) throw new Error(`arrange.session: login failed (${verified.reason})`);
		const customerId = await live.stores.sessionStore.validate(verified.sessionToken);
		return {
			bearer: verified.sessionToken,
			...(customerId === null ? {} : { customerId }),
		};
	}

	async function clientOrThrow(): Promise<CommerceClient> {
		if (client === undefined) throw new Error("tier not set up");
		return client;
	}

	return {
		name: options.name,
		async setup() {
			if (service !== undefined) return; // one service per tier, however many slices ask
			service = await startLiveService(
				options.gated === true
					? { internalToken: ADMIN_TOKEN, serviceToken: ADMIN_SERVICE_TOKEN }
					: {},
			);
			client = new HttpCommerceClient({
				...baseOptions(),
				...(options.gated === true ? { serviceToken: ADMIN_SERVICE_TOKEN } : {}),
			});
		},
		async teardown() {
			if (service === undefined) return;
			await service.stop();
			service = undefined;
			client = undefined;
		},
		async reset() {
			// A DOCUMENTED NO-OP for this tier. The live service owns one isolated
			// Postgres schema for the whole slice and the lifted cases address
			// disjoint product ids, skus, cart ids and idempotency keys — which is
			// how they always ran. Dropping and re-migrating a schema per case
			// would be a behavioural change (and minutes of runtime) for no gained
			// assertion. A tier whose backend is cheap to rebuild does the real
			// thing here instead.
		},
		makeClient: clientOrThrow,
		async makeAdminClients(): Promise<AdminClientSurfaces> {
			const shared = {
				...baseOptions(),
				...(options.gated === true
					? { adminToken: ADMIN_TOKEN, serviceToken: ADMIN_SERVICE_TOKEN }
					: {}),
			};
			return {
				orders: new AdminOrdersClient(shared),
				products: new AdminProductsClient(shared),
				rules: new AdminRulesClient(shared),
				reporting: new ReportingSettingsClient(shared),
			};
		},
		// NO `clock` HOOK, and the reason is structural rather than an omission: this
		// tier stands ONE service, with one clock, for the whole slice, and its
		// `reset()` is a documented no-op — so winding that clock forward would expire
		// every other case's holds with no way to put them back. The one case whose
		// subject is an elapsed deadline therefore skips here and runs on a tier whose
		// backend is cheap to rebuild, saying so in its own name.
		//
		// `payments` IS declared: this tier composes a gateway that mints an intent
		// with no network call, so a checkout genuinely succeeds on it.
		payments: { method: "stripe" },
		arrange: {
			...sharedTierSeeders({
				get orderStore() {
					return serviceOrThrow().stores.orderStore;
				},
				get addressStore() {
					return serviceOrThrow().stores.addressStore;
				},
				get sessionStore() {
					return serviceOrThrow().stores.sessionStore;
				},
				get shippingRules() {
					return serviceOrThrow().stores.shippingRules;
				},
				get couponStore() {
					return serviceOrThrow().stores.couponStore;
				},
				get taxRules() {
					return serviceOrThrow().stores.taxRules;
				},
			}),
			session: login,
			async product(spec) {
				const c = await clientOrThrow();
				await c.upsertProductCommerce(
					spec.productId,
					{
						sku: spec.sku,
						...(spec.price !== undefined ? { price: spec.price } : {}),
						...(spec.title !== undefined ? { title: spec.title } : {}),
						...(spec.onHand !== undefined ? { initialOnHand: spec.onHand } : {}),
					},
					spec.idempotencyKey,
				);
				return spec.productId;
			},
			async cart(currency) {
				const c = await clientOrThrow();
				const { cartId } = await c.createCart(currency);
				return cartId;
			},
		},
	};
}

const storefront = httpTier({ name: "http, live @otta-sh/service, Postgres" });
const admin = httpTier({ name: "http, live @otta-sh/service, Postgres", gated: true });

describe.skipIf(PG === undefined)("commerceClientContract over HttpCommerceClient", () => {
	afterAll(async () => {
		await storefront.teardown();
	});
	storefrontCommerceClientContract(storefront);
});

describe.skipIf(PG === undefined)("commerceClientContract over the admin HTTP clients", () => {
	afterAll(async () => {
		await admin.teardown();
	});
	adminRulesReportingClientContract(admin);
	// Bound to the GATED tier like its sibling slice: the admin surface needs both
	// the admin gate and the write gate closed, or INC-B10b's first case would be
	// written against a service that never enforces them. It contributes no cases
	// yet — it only holds this tier to the slice's requirements.
	adminOrdersProductsClientContract(admin);
});
