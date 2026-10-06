import { describe, expect, test } from "vitest";
import { cents, currency } from "../money/cents.js";
import { idempotencyKey, orderId, productId, sku, type OrderId } from "../money/ids.js";
import type { Clock } from "../ports/clock.js";
import type { EmailTemplate } from "../ports/email-sender.js";
import type { CreateOrderInput, OrderStore, OutboxEmail } from "../ports/order-store.js";
import type { OrderNotice, OrderState } from "../orders/model.js";
import { emailTemplateForNotice, emailTemplateForState } from "../orders/state-machine.js";
import {
	dispatchOrderEmails,
	dispatchOrderEmailsForOrder,
	transitionOrder,
} from "../orders/transition.js";
import type { FakeEmailSender } from "./fake-email-sender.js";

/** One outbox row as stored, read back for the assertions the port cannot express:
 *  whether a completed row was SENT or SKIPPED, and how many attempts it carries. */
export interface StoredOutboxRow {
	readonly toState: OrderState;
	readonly notice: OrderNotice | null;
	/** The store's lifecycle word — `"pending"`, `"sending"`, `"sent"`, `"skipped"`
	 *  or `"failed"`. */
	readonly status: string;
	readonly attempts: number;
}

export interface EmailRecipientHarness {
	store: OrderStore;
	emailSender: FakeEmailSender;
	clock: Clock;
	/** Every outbox row of the order, state rows and notices alike, in the order they
	 *  were enqueued. */
	outboxRows(orderId: OrderId): Promise<readonly StoredOutboxRow[]>;
}

export interface EmailRecipientContractOptions {
	dialect: string;
}

const USD = currency("USD");

/** An x402 gate buyer's reference (ADR-0028 Decision 7): the payer wallet, not an
 *  email address. */
const X402_BUYER_REF = "x402:0x1111111111111111111111111111111111111111";

function orderInput(id: string, overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`key-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: X402_BUYER_REF,
		paymentMethod: "x402",
		lines: [
			{
				productId: productId(`p-${id}`),
				sku: sku(`SKU-${id}`),
				title: "Field guide (PDF)",
				unitPrice: cents(900),
				currency: USD,
				quantity: 1,
				fulfillmentKind: "digital",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(900), total: cents(900), currency: USD },
		...overrides,
	};
}

async function seed(
	h: EmailRecipientHarness,
	id: string,
	overrides?: Partial<CreateOrderInput>,
): Promise<OrderId> {
	const { order } = await h.store.createFromCart(orderInput(id, overrides));
	return order.id;
}

/** The generic state-machine command — the one every outbox-enqueuing move shares. */
async function driveTo(h: EmailRecipientHarness, id: OrderId, path: readonly OrderState[]) {
	for (const to of path) {
		const res = await transitionOrder(
			{ orderStore: h.store },
			{ orderId: id, toState: to, idempotencyKey: idempotencyKey(`t:${id}:${to}`) },
		);
		expect(res.ok, `transition to ${to}`).toBe(true);
	}
}

function drain(h: EmailRecipientHarness, onSkipped?: (row: OutboxEmail) => void) {
	return dispatchOrderEmails(
		{ orderStore: h.store, emailSender: h.emailSender, clock: h.clock },
		onSkipped === undefined ? {} : { onSkipped },
	);
}

/** The template a stored row renders — the dispatcher's own choice, so the case
 *  proves the row it skipped really was the template it is named for. */
function templateOf(row: StoredOutboxRow): EmailTemplate | null {
	return row.notice !== null
		? emailTemplateForNotice(row.notice)
		: emailTemplateForState(row.toState);
}

/** A claim instant at the harness clock and a five-minute lease past it. */
function claimWindow(h: EmailRecipientHarness): { now: string; lease: string } {
	const now = h.clock.now();
	return {
		now: now.toISOString(),
		lease: new Date(now.getTime() + 5 * 60 * 1000).toISOString(),
	};
}

/** Far past any lease a case sets — "long after". */
const LATER = "2099-01-01T00:00:00.000Z";

/**
 * Every order email that can fire for an x402 gate order, and how the order gets
 * there. ADR-0028 Decision 7 lists eight; `order-shipped` and `order-delivered` are
 * reachable too (an operator may move a paid order through processing → shipped →
 * delivered — `adminNextStates` offers each step), so they are listed as well. The
 * only order template missing is none: this is every `EmailTemplate` but
 * `customer-login-link`, which is not an order email.
 */
const X402_REACHABLE_TEMPLATES: readonly {
	template: EmailTemplate;
	path: readonly OrderState[];
	notice?: OrderNotice;
}[] = [
	{ template: "order-confirmation", path: ["paid"] },
	{ template: "order-processing", path: ["paid", "processing"] },
	{ template: "order-shipped", path: ["paid", "processing", "shipped"] },
	{ template: "order-delivered", path: ["paid", "processing", "shipped", "delivered"] },
	{ template: "order-completed", path: ["paid", "completed"] },
	{ template: "order-cancelled", path: ["cancelled"] },
	{ template: "order-expired", path: ["expired"] },
	{ template: "order-refunded", path: ["paid", "refunded"] },
	// ADR-0026's notice for a refund announced on its own (a manual refund recorded
	// in Money → Refunds, which is how an x402 refund is recorded).
	{ template: "order-refund-issued", path: ["paid"], notice: "refund-issued" },
	// ADR-0022's notice. Unreachable for x402, which cannot refund automatically, but
	// covered: the decision is the recipient's, never the template's.
	{ template: "order-late-payment-refunded", path: ["expired"], notice: "late-payment-refunded" },
];

/**
 * "The order's email recipient, or none" (ADR-0028 Decision 7, increment 4).
 *
 * An order whose `buyerRef` is not an email address — an x402 gate buyer's
 * `x402:0x…` wallet reference — has no email recipient, and no email is ever sent
 * for it. The decision is made in ONE place, the drain's recipient resolution, so it
 * covers every row the outbox can hold. Such a row is completed as SKIPPED: its own
 * terminal outcome, never recorded as sent (ADR-0026 — a write reports whether its
 * email went), and not an attempt.
 *
 * Runs against the fake first, then each dialect (SQLite, Postgres, D1), because the
 * "skipped" completion is a store write.
 */
export function emailRecipientContract(
	makeHarness: () => Promise<EmailRecipientHarness>,
	opts: EmailRecipientContractOptions,
): void {
	describe(`emailRecipientContract [${opts.dialect}]`, () => {
		// -- one case per template that can fire for an x402 order ----------------

		for (const { template, path, notice } of X402_REACHABLE_TEMPLATES) {
			test(`${template} is skipped, never sent, for an order with no email recipient`, async () => {
				const h = await makeHarness();
				const id = await seed(h, "ord-x402");
				await driveTo(h, id, path);
				if (notice !== undefined) {
					expect(
						await h.store.enqueueNotice(id, {
							kind: notice,
							amount: cents(900),
							currency: USD,
							refundId: "refund-1",
						}),
					).toBe(true);
				}

				expect(await drain(h)).toBe(0);
				expect(h.emailSender.sends).toEqual([]);
				const rows = await h.outboxRows(id);
				// The template's row was really enqueued — and, like every other row of the
				// order, completed as skipped.
				expect(rows.map(templateOf)).toContain(template);
				expect(rows.map((r) => r.status)).toEqual(rows.map(() => "skipped"));
				// Terminal: nothing of the order is ever claimed again.
				expect(await h.store.claimNextEmailForOrder(id, LATER, LATER)).toBeNull();
			});
		}

		test("any buyerRef that is not an email address yields no recipient, not only an x402 one", async () => {
			const h = await makeHarness();
			const id = await seed(h, "ord-no-at", { buyerRef: "wallet-without-an-at-sign" });
			await driveTo(h, id, ["paid"]);
			expect(await drain(h)).toBe(0);
			expect(h.emailSender.sends).toEqual([]);
			expect((await h.outboxRows(id)).map((r) => r.status)).toEqual(["skipped"]);
		});

		test("an ordinary order is unchanged: its email goes to buyerRef verbatim and is recorded as sent", async () => {
			const h = await makeHarness();
			// Checkout stores buyerRef as typed; the recipient is not re-normalized.
			const id = await seed(h, "ord-card", {
				buyerRef: "Buyer@Example.com",
				paymentMethod: "stripe",
			});
			await driveTo(h, id, ["paid"]);
			expect(await drain(h)).toBe(1);
			expect(h.emailSender.sends.map((s) => [s.to, s.template])).toEqual([
				["Buyer@Example.com", "order-confirmation"],
			]);
			expect((await h.outboxRows(id)).map((r) => r.status)).toEqual(["sent"]);
		});

		test("the drain reports a skipped row through onSkipped — never onSent — and does not count it", async () => {
			const h = await makeHarness();
			const x402 = await seed(h, "ord-x402");
			const card = await seed(h, "ord-card", {
				buyerRef: "buyer@example.com",
				paymentMethod: "stripe",
			});
			await driveTo(h, x402, ["paid"]);
			await driveTo(h, card, ["paid"]);

			const skipped: OutboxEmail[] = [];
			const sent: OutboxEmail[] = [];
			// The inline path's dispatcher (first attempts only), as an admin write runs it.
			const deps = { orderStore: h.store, emailSender: h.emailSender, clock: h.clock };
			const options = {
				onlyUnattempted: true,
				onSkipped: (row: OutboxEmail) => skipped.push(row),
				onSent: (row: OutboxEmail) => sent.push(row),
			};
			expect(await dispatchOrderEmailsForOrder(deps, x402, options)).toBe(0);
			expect(skipped.map((r) => [r.orderId, r.toState])).toEqual([[x402, "paid"]]);
			expect(sent).toEqual([]);

			expect(await dispatchOrderEmailsForOrder(deps, card, options)).toBe(1);
			expect(sent.map((r) => [r.orderId, r.toState])).toEqual([[card, "paid"]]);
			expect(skipped).toHaveLength(1);
			expect(h.emailSender.sends.map((s) => s.to)).toEqual(["buyer@example.com"]);
		});

		// -- the store's "skipped" completion -------------------------------------

		test("markEmailSkipped completes a claimed row as skipped: terminal, not sent, not an attempt", async () => {
			const h = await makeHarness();
			const id = await seed(h, "ord-1");
			await driveTo(h, id, ["paid"]);
			const { now, lease } = claimWindow(h);
			const row = await h.store.claimNextEmail(now, lease);
			expect(row?.attempts).toBe(1);

			await h.store.markEmailSkipped(row!.id, now);

			expect(await h.outboxRows(id)).toEqual([
				{ toState: "paid", notice: null, status: "skipped", attempts: 0 },
			]);
			// Neither claim ever hands it out again — not even after any lease.
			expect(await h.store.claimNextEmail(LATER, LATER)).toBeNull();
			expect(await h.store.claimNextEmailForOrder(id, LATER, LATER)).toBeNull();
		});

		test("markEmailSkipped writes only a claimed row: a sent row stays sent, a pending one pending, and a second skip is a no-op", async () => {
			const h = await makeHarness();
			const id = await seed(h, "ord-1");
			await driveTo(h, id, ["paid", "processing"]);
			const { now, lease } = claimWindow(h);

			const first = await h.store.claimNextEmailForOrder(id, now, lease);
			await h.store.markEmailSent(first!.id, now);
			await h.store.markEmailSkipped(first!.id, now);

			const second = await h.store.claimNextEmailForOrder(id, now, lease);
			await h.store.markEmailSkipped(second!.id, now);
			await h.store.markEmailSkipped(second!.id, now);

			expect(await h.outboxRows(id)).toEqual([
				{ toState: "paid", notice: null, status: "sent", attempts: 1 },
				{ toState: "processing", notice: null, status: "skipped", attempts: 0 },
			]);

			// A pending row (never claimed) is not skippable: it is still claimed next.
			await driveTo(h, id, ["shipped"]);
			const pending = (await h.outboxRows(id))[2];
			expect(pending?.status).toBe("pending");
			const third = await h.store.claimNextEmailForOrder(id, now, lease);
			expect(third?.toState).toBe("shipped");
		});

		test("a skipped row leaves the order's other rows claimable", async () => {
			const h = await makeHarness();
			const id = await seed(h, "ord-1");
			await driveTo(h, id, ["paid", "processing"]);
			const { now, lease } = claimWindow(h);
			const first = await h.store.claimNextEmail(now, lease);
			expect(first?.toState).toBe("paid");
			await h.store.markEmailSkipped(first!.id, now);
			const next = await h.store.claimNextEmail(now, lease);
			expect(next?.toState).toBe("processing");
		});
	});
}
