/**
 * Issue #127 (and #18): the admin's `holdTtlMinutes` setting IS the cart hold.
 *
 * The setting was persisted, validated and shown back in the admin, and the cron
 * sweep read it — but the in-process client's cart use-cases never did, so every
 * add and adjust stamped the domain's fifteen-minute default and every lazy read
 * measured against it. Changing the setting changed nothing a shopper could see,
 * and a store on a shorter window had its sweep and its cart reads disagree about
 * when a hold lapsed.
 *
 * Every case goes through the CLIENT over a real document store (in-memory
 * SQLite, the host's own migrations), with the setting written through the real
 * settings store — the same one the admin form saves to. Time moves on a clock
 * every store in the composition shares.
 */
import { DEFAULT_OPERATIONAL_SETTINGS, idempotencyKey } from "@otta-sh/domain";
import { FixedClock } from "@otta-sh/domain/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const MINUTE = 60_000;

describe("the cart hold follows the admin's holdTtlMinutes setting", () => {
	const clock = new FixedClock(new Date());
	let h: InProcessCommerceHarness;
	let seq = 0;

	beforeAll(async () => {
		h = await makeInProcessCommerce({ clock });
	});
	afterAll(async () => {
		await h.close();
	});
	beforeEach(async () => {
		await h.reset();
	});

	/** A published, priced product with `onHand` units, and an empty cart. */
	async function arrange(onHand = 5): Promise<{ cartId: string; productId: string; sku: string }> {
		seq += 1;
		const productId = `prod-ttl-${String(seq)}`;
		const sku = `SKU-TTL-${String(seq)}`;
		await h.client.upsertProductCommerce(
			productId,
			{ sku, price: { amount: 1200, currency: "USD" }, title: "Held", initialOnHand: onHand },
			`seed-${String(seq)}`,
		);
		await h.client.activateProductCommerce(
			productId,
			`seed-${String(seq)}-publish`,
			"2026-01-01T00:00:00.000Z",
		);
		const { cartId } = await h.client.createCart("USD");
		return { cartId, productId, sku };
	}

	async function setHoldTtl(minutes: number): Promise<void> {
		seq += 1;
		await h.stores.settingsStore.update(
			{ holdTtlMinutes: minutes },
			idempotencyKey(`settings-${String(seq)}`),
		);
	}

	function inMinutes(minutes: number): string {
		return new Date(clock.now().getTime() + minutes * MINUTE).toISOString();
	}

	test("with nothing saved, an add holds for the settings default (15 minutes)", async () => {
		const { cartId, productId, sku } = await arrange();
		const added = await h.client.addCartLine(cartId, sku, productId, 1, "add-default");
		if (!added.ok) throw new Error(added.reason);
		expect(added.line.expiresAt).toBe(inMinutes(DEFAULT_OPERATIONAL_SETTINGS.holdTtlMinutes));
	});

	test("a saved LONGER window is the deadline an add stamps, and the hold outlives the default", async () => {
		await setHoldTtl(30);
		const { cartId, productId, sku } = await arrange();
		const added = await h.client.addCartLine(cartId, sku, productId, 2, "add-long");
		if (!added.ok) throw new Error(added.reason);
		expect(added.line.expiresAt).toBe(inMinutes(30));

		// Past the old fifteen-minute default, well inside the configured thirty: the
		// lazy expiry on read must leave the line and its hold alone.
		clock.advance(20 * MINUTE);
		const read = await h.client.getCart(cartId);
		expect(read).toMatchObject({ ok: true, cart: { lines: [{ qty: 2 }] } });
		expect(read.ok && read.cart.lines[0]?.reservationId).toBe(added.line.reservationId);

		// And past the configured window it lapses like any other hold.
		clock.advance(11 * MINUTE);
		expect(await h.client.getCart(cartId)).toMatchObject({ ok: true, cart: { lines: [] } });
	});

	test("a saved SHORTER window lapses the hold on read, and the stock is free again", async () => {
		await setHoldTtl(5);
		const { cartId, productId, sku } = await arrange(2);
		const added = await h.client.addCartLine(cartId, sku, productId, 2, "add-short");
		if (!added.ok) throw new Error(added.reason);
		expect(added.line.expiresAt).toBe(inMinutes(5));

		clock.advance(6 * MINUTE);
		expect(await h.client.getCart(cartId)).toMatchObject({ ok: true, cart: { lines: [] } });

		// Released, not merely hidden: both units are addable to a fresh cart.
		const { cartId: fresh } = await h.client.createCart("USD");
		expect((await h.client.addCartLine(fresh, sku, productId, 2, "add-short-again")).ok).toBe(true);
	});

	test("an adjust re-stamps the deadline with the CURRENT setting", async () => {
		const { cartId, productId, sku } = await arrange();
		const added = await h.client.addCartLine(cartId, sku, productId, 1, "add-then-adjust");
		if (!added.ok) throw new Error(added.reason);

		// The operator changes the window while the hold is live; the next mutation is
		// measured against the new value, not the one in force when the line was added.
		await setHoldTtl(45);
		clock.advance(MINUTE);
		const adjusted = await h.client.adjustCartLine(cartId, added.line.lineId, 2, "adjust-1");
		if (!adjusted.ok) throw new Error(adjusted.reason);
		expect(adjusted.line.expiresAt).toBe(inMinutes(45));
	});

	test("the client reports the effective window, following the setting live", async () => {
		expect(await h.client.getCartHoldTtlMinutes()).toBe(
			DEFAULT_OPERATIONAL_SETTINGS.holdTtlMinutes,
		);
		await setHoldTtl(25);
		expect(await h.client.getCartHoldTtlMinutes()).toBe(25);
	});
});
