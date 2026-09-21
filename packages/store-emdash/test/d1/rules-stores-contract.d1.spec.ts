/**
 * The domain's two rules contracts against `EmdashShippingRulesStore` and
 * `EmdashTaxRulesStore` on **D1** — the dialect Otta actually ships on, through
 * the host's OWN Kysely wiring.
 *
 * Both contracts run in full, with no skips. What this tier exercises that the
 * others cannot is how D1's SQLite build plans the reads these stores are built
 * out of: the unfiltered paged `query` that both list reads scan (no declared
 * index anywhere in either collection, so the page and its cursor are the whole
 * read contract), and the `compareAndSet`/`compareAndDelete` pairs that carry the
 * money guard and the two parent/child delete guards. A declared index is a read
 * contract rather than a performance knob, and "none declared" is one too — this
 * is where it is checked against the runtime that will serve it.
 *
 * The harness wiring is `test/rules-harness.ts`, imported rather than restated —
 * it names no Node driver, so it loads inside `workerd`. Only the storage BINDING
 * differs, and that is what `describe-d1.ts` supplies.
 */
import { shippingRulesStoreContract, taxRulesStoreContract } from "@otta-sh/domain/testing";
import { RULES_LAYOUT } from "../rules-collections.js";
import { makeShippingRulesHarness, makeTaxRulesHarness } from "../rules-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(RULES_LAYOUT);

shippingRulesStoreContract(async () => makeShippingRulesHarness(bound.storage), { dialect: "d1" });
taxRulesStoreContract(async () => makeTaxRulesHarness(bound.storage), { dialect: "d1" });
