/**
 * The domain's four identity contracts against the document adapters on **D1** —
 * the dialect Otta actually ships on, through the host's OWN Kysely wiring.
 *
 * All four contracts run in full, with no skips. What this tier exercises that the
 * others cannot is the READ contract these stores depend on, planned by D1's SQLite
 * build: the `emailLower` equality behind the email lookup's healing fallback, the
 * `customerId` equality the session history pages on, and the two prune arms —
 * `consumed` as a text mirror and `expiresAt` as a range — that stand in for the OR
 * the filter algebra cannot express. Every one of those is a `json_extract`
 * expression with the host's own limit clamp and cursor on top, and a declared index
 * is a read contract rather than a performance knob, so this is where that contract
 * is checked against the runtime that will serve it.
 *
 * It also runs the WebCrypto digest that keys every session document inside
 * `workerd`, which is the environment that made `node:crypto` unusable in the first
 * place.
 *
 * The harness wiring is `test/identity-harness.ts`, imported rather than restated —
 * it names no Node driver, so it loads inside `workerd`. Only the storage BINDING
 * differs, and that is what `describe-d1.ts` supplies.
 */
import {
	addressBookContract,
	credentialVerifierContract,
	customerStoreContract,
	sessionContract,
} from "@otta-sh/domain/testing";
import { IDENTITY_LAYOUT } from "../identity-collections.js";
import {
	makeAddressHarness,
	makeCustomerHarness,
	makeSessionHarness,
	makeVerifierHarness,
} from "../identity-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(IDENTITY_LAYOUT);

customerStoreContract(async () => makeCustomerHarness(bound.storage), { dialect: "d1" });
addressBookContract(async () => makeAddressHarness(bound.storage), { dialect: "d1" });
sessionContract(async () => makeSessionHarness(bound.storage), { dialect: "d1" });
credentialVerifierContract(async () => makeVerifierHarness(bound.storage), { dialect: "d1" });
