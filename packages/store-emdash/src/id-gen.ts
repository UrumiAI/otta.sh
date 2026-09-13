import type { IdGen } from "@otta-sh/domain";

/**
 * Zero-dep collision-free id source for the in-process adapters. WebCrypto off
 * `globalThis`, never `node:crypto`: this module is bundled into the workerd
 * sandbox, where a `node:` import is a runtime failure the type system would not
 * have caught.
 *
 * This duplicates `@otta-sh/store-postgres`'s `uuidIdGen` on purpose. Importing
 * it instead is forbidden by `store-emdash-is-sandbox-clean`, and rightly: that
 * package's entry pulls a Kysely/pg graph into a module that ships inside the
 * isolate. The duplication is also temporary in one direction — the
 * store-postgres copy goes when that package does, and this one is what remains.
 */
export const uuidIdGen: IdGen = {
	newId(): string {
		return globalThis.crypto.randomUUID();
	},
};
