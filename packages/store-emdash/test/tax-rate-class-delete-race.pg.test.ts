/**
 * #742: a guarded tax-rate create racing the delete of its class, on Postgres.
 *
 * **Postgres-required**: better-sqlite3 serializes writes in-process, so it can
 * verify the statements but cannot lose a race. The contract suite pins the
 * refusal itself on every dialect; this file proves the guard holds when the
 * delete and the creates really interleave over independent connections.
 *
 * `deleteClass` is a compare-and-delete at the revision it read the class's empty
 * rates map at; `createRate({ requireDeclaredClass: true })` decides "declared" on
 * the read its embed is compare-and-set against. One of them moves the class
 * document first, the other's guarded write refuses and its retry re-reads. So in
 * every round exactly one of two worlds holds:
 *
 * - **the delete won**: the class document is GONE (not re-minted nameless), every
 *   create was refused `TAX_RATE_CLASS_NOT_DECLARED`, no rate and no id claim of
 *   theirs is left;
 * - **a create won first**: the delete answered `in_use_by_rates`, the class is
 *   still declared, and it holds exactly the rates whose creates succeeded.
 *
 * Before #742 the first world could end with a nameless class document holding a
 * rate no admin could see — the delete `ok` AND a create `ok`.
 */
import { describe, expect, test } from "vitest";
import { CAS_MAX_ATTEMPTS } from "../src/index.js";
import { makePgStorage, PG_ENABLED } from "./describe-each-dialect.js";
import { TAX_RULES_LAYOUT } from "./rules-collections.js";
import { makeTaxRulesHarness } from "./rules-harness.js";

/** Creators per round (each in its own zone, so none is a duplicate of another). */
const CREATORS = 8;
const ROUNDS = 48;
/** The delete starts 0…(n−1) ms after the creates, cycling by round. */
const DELETE_DELAYS_MS = 16;

describe.skipIf(!PG_ENABLED)("tax-rate create vs class delete race [postgres] (#742)", () => {
	test("the class is gone XOR it is declared and holds every rate that was created", async () => {
		const db = await makePgStorage(TAX_RULES_LAYOUT, CREATORS + 6);
		let deepestCreate = 0;
		const h = makeTaxRulesHarness(db.storage, {
			onCasAttempts: (operation, attempts) => {
				if (operation === "createTaxRate") deepestCreate = Math.max(deepestCreate, attempts);
			},
		});
		const outcomes = { deleteWon: 0, createWon: 0 };
		try {
			for (let round = 0; round < ROUNDS; round++) {
				const classId = `c-${String(round)}`;
				await h.store.createClass({ id: classId, name: "Racing" });
				const rateId = (i: number) => `r-${String(round)}-${String(i)}`;
				const creates = Array.from(
					{ length: CREATORS },
					(_unused, i) => () =>
						h.store.createRate({
							id: rateId(i),
							taxClassId: classId,
							zoneId: `z-${String(i)}`,
							rateBps: 700 + i,
							appliesToShipping: false,
							requireDeclaredClass: true,
						}),
				);
				// Move the delete through the crowd, and stagger its start across the
				// creates' id-claim round trip, so both worlds — and the window where a
				// create has read the class but not yet embedded — are exercised.
				const at = round % (CREATORS + 1);
				const delayMs = round % DELETE_DELAYS_MS;
				const tasks: (() => Promise<unknown>)[] = [...creates];
				tasks.splice(at, 0, async () => {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					return h.store.deleteClass(classId);
				});
				const settled = await Promise.allSettled(tasks.map((run) => run()));
				const deleted = settled[at];
				const created = settled.filter((_s, i) => i !== at);

				expect(deleted?.status, `round ${String(round)}: delete settles`).toBe("fulfilled");
				const deleteResult = deleted?.status === "fulfilled" ? deleted.value : undefined;
				const won = created.filter((s) => s.status === "fulfilled");
				for (const lost of created.filter((s) => s.status === "rejected")) {
					expect(lost.reason, `round ${String(round)}: a refused create`).toMatchObject({
						code: "TAX_RATE_CLASS_NOT_DECLARED",
						taxClassId: classId,
					});
				}

				if ((deleteResult as { ok?: boolean } | undefined)?.ok === true) {
					outcomes.deleteWon++;
					expect(won, `round ${String(round)}: delete won, no create landed`).toHaveLength(0);
					// GONE — not a nameless document holding a rate.
					expect(await h.classes.get(classId)).toBeNull();
					expect(await h.store.countRatesByClass(classId)).toBe(0);
					for (let i = 0; i < CREATORS; i++) {
						expect(await h.rateOwners.get(rateId(i)), `claim ${rateId(i)} given back`).toBeNull();
					}
				} else {
					outcomes.createWon++;
					expect(deleteResult).toEqual({ ok: false, reason: "in_use_by_rates" });
					expect((await h.store.listClasses()).some((c) => c.id === classId)).toBe(true);
					// The class never left, so no create could have been refused.
					expect(won).toHaveLength(CREATORS);
					expect(await h.store.countRatesByClass(classId)).toBe(CREATORS);
				}
			}
			// The world #742 was about must actually have occurred, or this proved nothing.
			expect(outcomes.deleteWon).toBeGreaterThan(0);
			expect(deepestCreate).toBeLessThanOrEqual(CAS_MAX_ATTEMPTS);
			console.log(
				`[tax-rate-class-delete-race] delete won ${String(outcomes.deleteWon)}, ` +
					`create won ${String(outcomes.createWon)} of ${String(ROUNDS)} rounds; ` +
					`max createTaxRate CAS attempts ${String(deepestCreate)}`,
			);
		} finally {
			await db.close();
		}
	}, 120_000);
});
