import type { IdGen } from "@otta-sh/domain";

/** Zero-dep collision-free id source for production adapters (risk R5). */
export const uuidIdGen: IdGen = {
	newId(): string {
		return crypto.randomUUID();
	},
};
