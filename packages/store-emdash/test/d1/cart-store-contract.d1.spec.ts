/**
 * The domain's `cartStoreContract` against `EmdashCartStore`, on **D1**.
 *
 * The contract suite IS the spec, and this file runs it in full on the dialect
 * Otta actually ships on — zero skips, the same cases the fake, the SQL adapter
 * and the two Node tiers run. If it is green here, the cart document model works
 * on D1's SQLite build and not only on `better-sqlite3`'s, which matters most for
 * the one thing this tier exercises that the others cannot: `listExpired` is a
 * real indexed `query()` through the host's OWN Kysely wiring, with the host's
 * limit clamp and cursor, against a `json_extract` expression D1 has to plan.
 *
 * The harness wiring is `test/cart-harness.ts`, imported rather than restated —
 * it names no Node driver, so it loads inside `workerd`. Only the storage BINDING
 * differs, and that is what `describe-d1.ts` supplies. Nothing in that file needed
 * changing to host this suite: it takes any layout, and the cart layout is derived
 * from `src` exactly as the inventory one is.
 */
import { cartStoreContract } from "@otta-sh/domain/testing";
import { CART_LAYOUT } from "../cart-collections.js";
import { makeCartHarness } from "../cart-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(CART_LAYOUT);
cartStoreContract(async () => makeCartHarness(bound.storage), { dialect: "d1" });
