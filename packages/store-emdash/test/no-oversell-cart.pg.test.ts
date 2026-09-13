/**
 * THE cart-layer acceptance gate, on the document adapter — the store-postgres
 * suite of the same name, re-pointed at `EmdashCartStore`. Postgres only:
 * better-sqlite3 serializes writes in one process, so it verifies the shape and
 * never the contention.
 *
 * N concurrent add-to-cart requests against stock M (N > M) must never oversell:
 * exactly M carts get a line, N−M get `OUT_OF_STOCK`, and the final count is 0.
 * The guarantee has to survive the CART layer, not just the reserve port, which is
 * what separates this file from `no-oversell.pg.test.ts`.
 *
 * The M/N/loop numbers and the four original assertions are unchanged. Three
 * assertions are ADDED, because the document model makes them checkable:
 *
 * - every winning cart's add mutation ends `completed` — a line whose ledger entry
 *   is still a claim would mean the completion bracket tore;
 * - the aggregate holds exactly M holds — no orphan reservation was left behind by
 *   a loser;
 * - the units are conserved: `onHand` plus the held units equals M.
 *
 * The pool is sized so each of the N callers can hold its OWN connection; a pool
 * narrower than the crowd serializes the writers and weakens the race, which is
 * why this file builds its own storage instead of taking the shared one.
 */
import {
	addLine,
	createCart,
	currency,
	getCart,
	idempotencyKey,
	sku,
	updateLine,
} from "@otta-sh/domain";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	CAS_MAX_ATTEMPTS,
	collectionOf,
	INVENTORY_COLLECTION,
	isStorageContentionError,
	newInventoryDoc,
	normalizeCartDoc,
	normalizeInventoryDoc,
	type InventoryDoc,
	type StorageAccess,
} from "../src/index.js";
import { CART_LAYOUT } from "./cart-collections.js";
import { makeCartHarness } from "./cart-harness.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { settleOne } from "./helpers/fault-injection.js";

type AddResult = Awaited<ReturnType<typeof addLine>>;

/** Structural test that a settled value really is an `addLine` answer. */
function isAddResult(value: unknown): value is AddResult {
	return (
		typeof value === "object" && value !== null && typeof (value as AddResult).ok === "boolean"
	);
}

const M = 5;
const N = 50;
const LOOPS = 15;
const USD = currency("USD");

describe.skipIf(!PG_ENABLED)("no oversell through a cart [postgres]", () => {
	let storage: StorageAccess;
	let close: () => Promise<void>;

	beforeAll(async () => {
		const db = await makePgStorage(CART_LAYOUT, N + 4);
		storage = db.storage;
		close = db.close;
	}, 180_000);

	afterAll(async () => {
		await close?.();
	});

	test(`${String(N)} concurrent add-to-carts at stock ${String(M)} never oversell, ${String(LOOPS)} times over`, async () => {
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		let maxAttempts = 0;
		let contentionErrors = 0;
		const h = makeCartHarness(storage, {
			onCasAttempts: (_operation, attempts) => {
				if (attempts > maxAttempts) maxAttempts = attempts;
			},
		});

		const winnersPerLoop: number[] = [];
		for (let loop = 0; loop < LOOPS; loop++) {
			// A fresh sku per loop: each race is independent, and nothing has to
			// truncate the storage table (which would drop the revision trigger the
			// whole design depends on).
			const stockKeeping = `SKU-CART-RACE-${String(loop)}`;
			await inventory.compareAndSet(stockKeeping, null, newInventoryDoc(stockKeeping, M));

			// Each request is its own cart; the concurrent adds race the same stock.
			const cartIds = await Promise.all(Array.from({ length: N }, () => createCart(h.deps, USD)));
			const settled = await Promise.all(
				cartIds.map((cartId, i) =>
					settleOne(
						addLine(
							h.deps,
							cartId,
							sku(stockKeeping),
							null,
							1,
							idempotencyKey(`k-${String(loop)}-${String(i)}`),
						),
					),
				),
			);

			let ok = 0;
			let oos = 0;
			let contendedHere = 0;
			for (const result of settled) {
				if (isStorageContentionError(result)) {
					contendedHere++;
					continue;
				}
				if (result instanceof Error) throw result;
				// Anything that is neither a settled result nor an Error is a fault this
				// suite must not paper over by casting it into a result shape.
				if (!isAddResult(result)) {
					throw new Error(`unexpected non-result rejection: ${JSON.stringify(result)}`);
				}
				const add = result;
				if (add.ok) {
					ok++;
				} else {
					// The ONLY acceptable non-ok reason: contention has its own type and
					// must never be collapsed into "the item is gone".
					expect(add.reason, `loop ${String(loop)}: failure reason`).toBe("OUT_OF_STOCK");
					oos++;
				}
			}
			contentionErrors += contendedHere;

			expect(ok, `loop ${String(loop)}: carts with a line`).toBe(M);
			expect(oos, `loop ${String(loop)}: OUT_OF_STOCK count`).toBe(N - M);
			expect(await h.onHand(stockKeeping), `loop ${String(loop)}: final onHand`).toBe(0);
			winnersPerLoop.push(ok);

			// Exactly M lines were written, and every one of them has a COMPLETED
			// ledger entry: a line behind an unfinished claim would mean the
			// claim→movement→completion bracket tore.
			let lines = 0;
			for (const cartId of cartIds) {
				const doc = await h.carts.get(cartId);
				if (doc === null) throw new Error(`loop ${String(loop)}: missing cart document`);
				const cart = normalizeCartDoc(doc);
				for (const line of Object.values(cart.lines)) {
					lines++;
					const record = cart.mutations[line.reserveKey ?? ""];
					expect(record?.completed, `loop ${String(loop)}: ledger entry for ${line.lineId}`).toBe(
						true,
					);
				}
			}
			expect(lines, `loop ${String(loop)}: cart lines written`).toBe(M);

			// No orphan reservation: M holds, and the units are conserved.
			const doc = await inventory.get(stockKeeping);
			if (doc === null) throw new Error(`loop ${String(loop)}: missing inventory document`);
			const holds = Object.values(normalizeInventoryDoc(doc).holds);
			expect(holds, `loop ${String(loop)}: holds`).toHaveLength(M);
			expect(
				doc.onHand + holds.reduce((sum, hold) => sum + hold.qty, 0),
				`loop ${String(loop)}: units conserved`,
			).toBe(M);
		}

		console.info(
			`[no-oversell-cart] loops=${String(LOOPS)} winnersPerLoop=${winnersPerLoop.join(",")} ` +
				`maxCasAttempts=${String(maxAttempts)}/${String(CAS_MAX_ATTEMPTS)} ` +
				`contentionErrors=${String(contentionErrors)}`,
		);
		expect(winnersPerLoop).toEqual(Array.from({ length: LOOPS }, () => M));
		expect(contentionErrors, "typed contention failures").toBe(0);
		expect(maxAttempts).toBeLessThan(CAS_MAX_ATTEMPTS);
	}, 300_000);

	test("racing different-key adjusts converge: the stored qty always equals the hold's", async () => {
		// What keeps `adjustLine`'s repair pass honest. Two adjusts with DIFFERENT keys
		// race one line: the qty is re-derived from the hold inside the step, and the
		// hold can move between that read and the cart write, so without the repair the
		// loser's stale qty could stick and the line would disagree with the hold
		// forever — a cart showing 5 over a hold of 7.
		//
		// The assertion is the invariant, not a particular winner: EITHER target may
		// win (the inventory adjusts serialize on the aggregate's own revision), but
		// the pair must agree, and the units must be conserved.
		const inventory = collectionOf<InventoryDoc>(storage, INVENTORY_COLLECTION);
		const h = makeCartHarness(storage);
		const stockKeeping = "SKU-CART-ADJUST-RACE";
		await inventory.compareAndSet(stockKeeping, null, newInventoryDoc(stockKeeping, 100));

		const cartId = await createCart(h.deps, USD);
		const add = await addLine(h.deps, cartId, sku(stockKeeping), null, 2, idempotencyKey("kAdd"));
		if (!add.ok) throw new Error("the seed add must succeed");

		// Both started before the first await, so they contend for the hold AND for
		// the cart document's revision.
		const [a, b] = await Promise.all([
			updateLine(h.deps, cartId, add.line.lineId, 5, idempotencyKey("keyA")),
			updateLine(h.deps, cartId, add.line.lineId, 7, idempotencyKey("keyB")),
		]);
		expect(a.ok, "keyA").toBe(true);
		expect(b.ok, "keyB").toBe(true);

		const doc = await inventory.get(stockKeeping);
		if (doc === null) throw new Error("missing inventory document");
		const hold = normalizeInventoryDoc(doc).holds[idempotencyKey("kAdd")];
		if (hold === undefined) throw new Error("missing hold");
		const cart = await getCart(h.deps, cartId);
		const line = cart?.lines[0];

		expect([5, 7], "the hold landed on one of the two targets").toContain(hold.qty);
		// THE invariant: no blend, no desync, and never a cart that promises more
		// than the hold reserves.
		expect(line?.qty, "the stored line qty equals the hold's").toBe(hold.qty);
		expect(doc.onHand + hold.qty, "units conserved").toBe(100);
	}, 120_000);
});
