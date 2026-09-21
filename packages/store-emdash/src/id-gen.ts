import type { IdGen } from "@otta-sh/domain";

/**
 * Zero-dep collision-free id source for the in-process adapters. WebCrypto off
 * `globalThis`, never `node:crypto`: this module is bundled into the workerd
 * sandbox, where a `node:` import is a runtime failure the type system would not
 * have caught.
 *
 * This duplicated `@otta-sh/store-postgres`'s `uuidIdGen` on purpose. Importing
 * it instead was forbidden by `store-emdash-is-sandbox-clean`, and rightly: that
 * package's entry pulled a Kysely/pg graph into a module that ships inside the
 * isolate. `@otta-sh/store-postgres` is gone now; this is what remains.
 */
export const uuidIdGen: IdGen = {
	newId(): string {
		return globalThis.crypto.randomUUID();
	},
};
