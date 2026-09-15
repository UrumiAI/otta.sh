/**
 * The seeding half of a `commerceClientContract` tier, written ONCE against the
 * `@otta-sh/domain` ports and used by both transports' tiers.
 *
 * WHY SHARED RATHER THAN WRITTEN TWICE. A shared case is only an equivalence
 * proof if the two tiers arrange the same state; two hand-written copies of an
 * arrangement drift, and a case that then fails on one tier tells you nothing
 * about the transport because the setups were not the same. So the arrangement is
 * one function over the PORTS, and each tier supplies its own adapters — a real
 * document store on one side, a real Postgres schema on the other. Real databases
 * on both, never a mock on either.
 *
 * WHAT IS SEEDED HERE AND WHAT IS NOT. Only state the storefront client surface
 * cannot write for itself: a guest order, a customer's address, a shipping rule, a
 * coupon. Products and carts are NOT here — the client's own writes create those,
 * and a case whose subject is one of those writes must call it rather than hide it
 * behind an arrangement.
 *
 * SESSIONS ARE NOT HERE EITHER, deliberately. Each tier mints one through the
 * login it genuinely has, because a bearer written straight into a session store
 * would prove nothing about the login path the cases depend on.
 */
import {
	cents,
	currency as toCurrency,
	idempotencyKey as toIdempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
	type AddressStore,
	type CouponStore,
	type OrderStore,
	type SessionStore,
	type ShippingRulesStore,
} from "@otta-sh/domain";
import type { CommerceClientTierArrange } from "../contracts/commerce-client-contract.js";

/** The ports a tier hands over so the arrangement below can run on it. */
export interface CommerceTierSeedPorts {
	orderStore: OrderStore;
	addressStore: AddressStore;
	sessionStore: SessionStore;
	shippingRules: ShippingRulesStore;
	couponStore: CouponStore;
}

/** The four seeding hooks every tier shares. The two it does not share — `product`
 *  and `cart`, which go through the client's own writes — and `session` stay with
 *  the tier. */
export type SharedTierSeeders = Pick<
	CommerceClientTierArrange,
	"order" | "address" | "shippingMethod" | "coupon"
>;

/**
 * Far enough out that a seeded order is never a lapsed one, on either tier's
 * clock. The cases that seed an order are about ownership and about the public
 * projection; none of them is about a deadline, and a deadline already in the past
 * would make them about one by accident.
 */
const SEEDED_HOLD_EXPIRES_AT = "2099-01-01T00:00:00.000Z";

export function sharedTierSeeders(ports: CommerceTierSeedPorts): SharedTierSeeders {
	return {
		async order(spec) {
			const unitPrice = spec.unitPrice ?? { amount: 1500, currency: "USD" };
			const quantity = spec.quantity ?? 1;
			const lineCurrency = toCurrency(unitPrice.currency);
			const total = cents(unitPrice.amount * quantity);
			// A GUEST order: it names an email and no customer, which is the state every
			// order is in until its buyer proves that inbox. Logging in as the same
			// address is what claims it, and that is the path the ownership cases take.
			await ports.orderStore.createFromCart({
				orderId: toOrderId(spec.orderId),
				cartId: null,
				currency: lineCurrency,
				idempotencyKey: toIdempotencyKey(`arranged-${spec.orderId}`),
				holdExpiresAt: SEEDED_HOLD_EXPIRES_AT,
				buyerRef: spec.buyerRef,
				paymentMethod: "stripe",
				lines: [
					{
						productId: toProductId(spec.productId ?? `prod-${spec.orderId}`),
						sku: toSku(spec.sku ?? `SKU-${spec.orderId}`),
						title: spec.title ?? spec.orderId,
						unitPrice: cents(unitPrice.amount),
						currency: lineCurrency,
						quantity,
						fulfillmentKind: "digital",
						reservationId: null,
					},
				],
				totals: { subtotal: total, total, currency: lineCurrency },
			});
			return spec.orderId;
		},

		async address(session, spec) {
			// Resolved through the session store rather than taken from the session's
			// `customerId`, which a tier may not expose — and resolving it is the same
			// derivation every `my` read performs, so the arrangement cannot accidentally
			// address a customer the bearer does not actually resolve to.
			const customerId = await ports.sessionStore.validate(session.bearer);
			if (customerId === null) throw new Error("arrange.address: the session does not resolve");
			await ports.addressStore.create(customerId, {
				kind: "shipping",
				name: spec.name,
				line1: "1 Arranged Street",
				line2: null,
				city: "Town",
				region: null,
				postalCode: "00001",
				country: "US",
				isDefault: true,
			});
		},

		async shippingMethod(spec) {
			await ports.shippingRules.createZone({ id: spec.zoneId, name: spec.zoneId, regions: null });
			await ports.shippingRules.createMethod({
				id: spec.methodId,
				zoneId: spec.zoneId,
				name: spec.methodId,
				type: "flat_rate",
			});
			// NO RATE when the spec carries none, which is how a case arranges the
			// rate-missing refusal: a method a merchant added and never priced.
			if (spec.rate !== undefined) {
				await ports.shippingRules.createRate({
					methodId: spec.methodId,
					currency: toCurrency(spec.rate.currency),
					amountCents: cents(spec.rate.amount),
					minSubtotalCents: null,
				});
			}
		},

		async coupon(spec) {
			await ports.couponStore.create({
				id: spec.id,
				code: spec.code,
				type: "fixed_amount",
				amountCents: cents(spec.amount.amount),
				rateBps: null,
				capCents: null,
				currency: toCurrency(spec.amount.currency),
				minSubtotalCents:
					spec.minSubtotalCents === undefined || spec.minSubtotalCents === null
						? null
						: cents(spec.minSubtotalCents),
				startsAt: spec.startsAt ?? null,
				expiresAt: spec.expiresAt ?? null,
				maxUses: spec.maxUses ?? null,
				maxUsesPerCustomer: null,
			});
		},
	};
}
