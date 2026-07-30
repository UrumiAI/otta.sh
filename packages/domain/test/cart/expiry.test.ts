import {
	addLine,
	createCart,
	currency,
	expireHolds,
	getCart,
	idempotencyKey,
	sku,
	updateLine,
} from "@otta-sh/domain";
import { describe, expect, test } from "vitest";
import { makeFakeCartHarness } from "./fake-harness.js";

const USD = currency("USD");
const PAST_TTL_MS = 16 * 60 * 1000;

// B4 — hold expiry via the injected Clock (no real sleeping).
describe("hold expiry (fake)", () => {
	test("an expired hold is released and its stock returns", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		expect(await h.onHand("SKU-1")).toBe(3);

		h.advance(PAST_TTL_MS);
		const reclaimed = await expireHolds(h.deps);
		expect(reclaimed).toBe(1);
		expect(await h.onHand("SKU-1")).toBe(5);
		const cart = await getCart(h.deps, cartId);
		expect(cart?.lines).toHaveLength(0);
	});

	test("double expiry does not double-release the same hold", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");

		h.advance(PAST_TTL_MS);
		const first = await expireHolds(h.deps);
		const second = await expireHolds(h.deps);
		expect(first).toBe(1);
		expect(second).toBe(0); // already released — the guarded flip only wins once
		expect(await h.onHand("SKU-1")).toBe(5); // returned exactly once, not 7
	});

	test("a mutation resets the hold TTL so an active shopper is not reaped", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");

		// 10 min in (< 15 min TTL), the shopper adjusts the line → hold resets.
		h.advance(10 * 60 * 1000);
		const up = await updateLine(h.deps, cartId, add.line.lineId, 3, idempotencyKey("k2"));
		if (!up.ok) throw new Error("adjust must succeed");

		// 10 more min (20 total, but only 10 since the reset) — still alive.
		h.advance(10 * 60 * 1000);
		expect(await expireHolds(h.deps)).toBe(0);
		expect(await h.onHand("SKU-1")).toBe(2); // 5 - 3, hold intact

		// Past the reset deadline — now it reaps.
		h.advance(PAST_TTL_MS);
		expect(await expireHolds(h.deps)).toBe(1);
		expect(await h.onHand("SKU-1")).toBe(5);
	});

	test("expiry flip re-checks expires_at: a hold TTL-reset between listing and release is not reaped", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku("SKU-1"), null, 2, idempotencyKey("k1"));
		if (!add.ok) throw new Error("add must succeed");
		const reservationId = add.line.reservationId ?? "";

		// Script the sweep's TOCTOU window by hand: list at a `now` where the hold
		// looks expired…
		h.advance(PAST_TTL_MS);
		const staleNow = h.deps.clock.now().toISOString();
		const listed = await h.cartStore.listExpired(staleNow, staleNow);
		expect(listed).toEqual([{ reservationId }]);

		// …then an active shopper's mutation resets the hold before the release
		// lands. The guarded flip re-checks the deadline atomically: NOT reaped.
		const up = await updateLine(h.deps, cartId, add.line.lineId, 3, idempotencyKey("k2"));
		if (!up.ok) throw new Error("adjust must succeed");
		const won = await h.cartStore.expireHold(reservationId, staleNow, staleNow);
		expect(won).toBe(false);
		expect(await h.onHand("SKU-1")).toBe(2); // 5 − 3: the hold is intact
		expect((await getCart(h.deps, cartId))?.lines).toHaveLength(1);
	});

	test("a raw non-cart hold older than the TTL is not reaped by the cart sweep", async () => {
		const h = makeFakeCartHarness();
		await h.seedStock("SKU-1", 5);
		// A direct Phase-0 reserve (no cart involvement, no ledger entry, no
		// stamped deadline) — e.g. an admin/API hold awaiting an explicit
		// commit/release. The cart sweep must never silently release it.
		const raw = await h.inventory.reserve("SKU-1", 2, idempotencyKey("raw-1"));
		if (!raw.ok) throw new Error("raw reserve must succeed");

		h.advance(PAST_TTL_MS * 10);
		expect(await expireHolds(h.deps)).toBe(0);
		expect(await h.onHand("SKU-1")).toBe(3); // still held
		expect(h.inventory.reservationState(raw.reservationId)).toBe("held");
	});
});
