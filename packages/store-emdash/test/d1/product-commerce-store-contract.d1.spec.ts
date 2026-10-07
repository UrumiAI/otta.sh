/**
 * The domain's `productCommerceStoreContract` against
 * `EmdashProductCommerceStore`, on **D1** — the dialect Otta actually ships on,
 * through the host's OWN Kysely wiring.
 *
 * The contract runs in full, with no skips: the same cases the fake, the SQL adapter
 * and the two Node tiers run. What this tier exercises that the others cannot is the
 * READ contract. The admin list is the widest indexed predicate this store issues —
 * `lifecycle`, `publishKey` and `productKind` as equalities, `createdAt` as both a
 * range and an ORDER BY, and a `productId in [...]` batch for the two bulk reads —
 * and every one of those is a `json_extract` expression D1's SQLite build has to
 * plan, with the host's own limit clamp and cursor on top. A declared index is a read
 * contract rather than a performance knob, so this is where that contract is checked
 * against the runtime that will serve it.
 *
 * The harness wiring is `test/product-commerce-harness.ts`, imported rather than
 * restated — it names no Node driver, so it loads inside `workerd`. Only the storage
 * BINDING differs, and that is what `describe-d1.ts` supplies.
 */
import { productCommerceStoreContract } from "@otta-sh/domain/testing";
import { PRODUCT_COMMERCE_LAYOUT } from "../product-commerce-collections.js";
import { makeProductCommerceHarness } from "../product-commerce-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(PRODUCT_COMMERCE_LAYOUT);

productCommerceStoreContract(async () => makeProductCommerceHarness(bound.storage), {
	dialect: "d1",
});
