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

/** A buyer reference that is a wallet id, not an email address. */
const WALLET_BUYER_REF = "wallet:0x1111111111111111111111111111111111111111";

function orderInput(id: string, overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
	return {
		orderId: orderId(id),
		cartId: null,
		currency: USD,
		idempotencyKey: idempotencyKey(`key-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: WALLET_BUYER_REF,
		paymentMethod: "stripe",
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
 * Every order email that can fire for an order with no email recipient, and how
 * the order gets there. This is every `EmailTemplate` but `customer-login-link`,
 * which is not an order email (an operator may move a paid order through
 * processing → shipped → delivered — `adminNextStates` offers each step).
 */
const NO_RECIPIENT_TEMPLATES: readonly {
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
	// in Money → Refunds).
	{ template: "order-refund-issued", path: ["paid"], notice: "refund-issued" },
	// ADR-0022's notice: covered too — the decision is the recipient's, never the
	// template's.
	{ template: "order-late-payment-refunded", path: ["expired"], notice: "late-payment-refunded" },
];

/**
 * "The order's email recipient, or none" (ADR-0028 Decision 7, increment 4).
 *
 * An order whose `buyerRef` is not an email address — a
 * `wallet:0x…` reference, say — has no email recipient, and no email is ever sent
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
		// -- one case per template that can fire for an order with no recipient ----------------

		for (const { template, path, notice } of NO_RECIPIENT_TEMPLATES) {
			test(`${template} is skipped, never sent, for an order with no email recipient`, async () => {
				const h = await makeHarness();
				const id = await seed(h, "ord-wallet");
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

		test("any buyerRef that is not an email address yields no recipient, not only a wallet one", async () => {
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
			const wallet = await seed(h, "ord-wallet");
			const card = await seed(h, "ord-card", {
				buyerRef: "buyer@example.com",
				paymentMethod: "stripe",
			});
			await driveTo(h, wallet, ["paid"]);
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
			expect(await dispatchOrderEmailsForOrder(deps, wallet, options)).toBe(0);
			expect(skipped.map((r) => [r.orderId, r.toState])).toEqual([[wallet, "paid"]]);
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

		test("markEmailSkipped leaves a sent row sent, and a second skip is a no-op", async () => {
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
		});

		test("markEmailSkipped leaves a PENDING row pending: a claim handed back is still handed out again", async () => {
			const h = await makeHarness();
			const id = await seed(h, "ord-1");
			await driveTo(h, id, ["paid"]);
			const { now, lease } = claimWindow(h);

			const claimed = await h.store.claimNextEmailForOrder(id, now, lease);
			// Handed back untried: pending again, the claim's attempt taken back off.
			await h.store.releaseEmailClaim(claimed!.id);
			await h.store.markEmailSkipped(claimed!.id, now);

			expect(await h.outboxRows(id)).toEqual([
				{ toState: "paid", notice: null, status: "pending", attempts: 0 },
			]);
			expect((await h.store.claimNextEmailForOrder(id, now, lease))?.id).toBe(claimed!.id);
		});

		test("markEmailSkipped leaves a FAILED row failed", async () => {
			const h = await makeHarness();
			const id = await seed(h, "ord-1");
			await driveTo(h, id, ["paid"]);
			const { now, lease } = claimWindow(h);

			const claimed = await h.store.claimNextEmailForOrder(id, now, lease);
			// Retries exhausted: parked `failed`.
			await h.store.rescheduleEmail(claimed!.id, null);
			await h.store.markEmailSkipped(claimed!.id, now);

			expect(await h.outboxRows(id)).toEqual([
				{ toState: "paid", notice: null, status: "failed", attempts: 1 },
			]);
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
