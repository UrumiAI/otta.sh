/**
 * Review A, A2: the read heal inside a BUDGETED sweep tick.
 *
 * On Postgres, one legacy order holding text `jsonb` cannot read makes the
 * expiry leg's `listExpirable` fail, and the storage guard heals by paging the
 * whole orders collection. The tick meters every storage call against its query
 * budget (sized for D1's per-invocation cap), so a bad order deep in the
 * collection used to stop the walk partway — every tick, from page 0 — and expiry
 * stayed stuck as on `main`, with the leg's budget burned each minute.
 *
 * The walk now runs past the tick's meter (`UNMETERED_COLLECTION`): the budget is
 * for D1, and the heal only fires on a Postgres error. It stays bounded by its
 * own page budget, and resumes where it stopped.
 *
 * Postgres-only (`process.env.PG_CONNECTION_STRING`): SQLite reads both escapes,
 * so there is nothing to heal there.
 */
import { ORDERS_COLLECTION, type OrderDoc, type StorageAccess } from "@otta-sh/store-emdash";
import { makePgStorage } from "@otta-sh/store-emdash/testing";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { runCommerceSweeps, SWEEP_TASK_NAME, SWEEP_TICK_QUERY_BUDGET } from "../src/cron/index.js";
import {
	memoryCursors,
	placeLapsedOrder,
	recordingSender,
	sweepContext,
} from "./cron-sweep-fixtures.js";
import { commerceStorageLayout } from "./sandbox/storage-layout.js";

const PG = process.env.PG_CONNECTION_STRING !== undefined;

/** Comfortably past the expiry leg's share of the default budget (about 15
 *  queries, so about 1,500 documents of walk). */
const FILLER = 2_000;

describe.skipIf(!PG)(
	"the expiry sweep heals a deep legacy row within one budgeted tick [postgres]",
	() => {
		let db: Awaited<ReturnType<typeof makePgStorage>> | undefined;
		let storage: StorageAccess;

		beforeAll(async () => {
			db = await makePgStorage(commerceStorageLayout());
			storage = db.storage;
		}, 120_000);

		afterAll(async () => {
			await db?.close();
		});

		test("a pending order with a lone surrogate, behind 2,000 orders, is expired on the first tick", async () => {
			vi.spyOn(console, "warn").mockImplementation(() => {});
			const now = new Date();
			const order = await placeLapsedOrder(storage, `deep-${crypto.randomUUID()}`, now);
			const raw = storage[ORDERS_COLLECTION];
			if (raw === undefined) throw new Error("orders collection missing");
			const doc = (await raw.get(order.id)) as OrderDoc;
			// Re-insert the order AFTER the filler, so it is the newest row: the last
			// one the walk reaches.
			await raw.delete(order.id);
			for (let i = 0; i < FILLER; i += 100) {
				await Promise.all(
					Array.from({ length: 100 }, (_, j) =>
						raw.put(`filler-${String(i + j)}`, { ...doc, state: "failed" }),
					),
				);
			}
			// Legacy: written past the guard, the way a pre-fix row looks.
			await raw.put(order.id, { ...doc, buyerRef: `${doc.buyerRef}\uD800` });
			await expect(raw.query({ where: { state: "pending" } })).rejects.toThrow(/type json/);

			const summary = await runCommerceSweeps(sweepContext(storage), SWEEP_TASK_NAME, {
				cursors: memoryCursors(),
				emailSender: recordingSender([]),
				now,
				queryBudget: SWEEP_TICK_QUERY_BUDGET,
				// What is under test is the QUERY budget (D1's cap). The wall-clock box
				// is a separate limit, and on a loaded machine a 2,000-row walk alone
				// can outlast its 9.5 s, which stopped the leg early ("0, more next
				// tick") in one full pg run. So it is opened wide here.
				budgetMs: 60_000,
			});

			const leg = summary.legs.find((entry) => entry.leg === "expire-orders");
			expect(leg?.ok, leg?.error).toBe(true);
			expect(leg?.count).toBe(1);
			const after = (await raw.get(order.id)) as OrderDoc;
			expect(after.state).toBe("expired");
			expect(after.buyerRef).toBe(`${doc.buyerRef}\uFFFD`);
		}, 120_000);
	},
);
