/**
 * What the recount's index plan suites share: the PHYSICAL indexes the host would
 * build for a declaration, and a record of the statements a store call sent.
 *
 * The dialect harnesses deliberately build no physical index (the host's
 * `syncDeclaredStorageIndexes` is internal to its build), so a plan cannot be
 * inspected there. These two suites build them the way EmDash 1.3.1's
 * `generateCreateIndexSql` does on the SQLite branch — one expression index per
 * declaration, `(plugin_id, collection, json_extract(data, '$.<field>')...)`, named
 * `idx_plugin_<plugin>_<collection>_<fields joined by _>`, created in DECLARATION
 * order (`createStorageIndexes` walks the list in order). Creation order is the
 * point: with no statistics, SQLite breaks a tie between equally good indexes by
 * taking the one created last.
 *
 * No Node driver is named here, so the D1 spec loads it inside `workerd` too.
 */
import { sql, type Kysely, type LogEvent } from "kysely";

/** The plugin id every harness collection is namespaced under. */
export const PLAN_PLUGIN_ID = "otta";

/** The name the host gives a declared, non-unique index. */
export function hostIndexName(collection: string, fields: readonly string[]): string {
	return `idx_plugin_${PLAN_PLUGIN_ID}_${collection}_${fields.join("_")}`.substring(0, 128);
}

/** Build each declared index as the host would, in declaration order (SQLite/D1). */
export async function createHostIndexes(
	// oxlint-disable-next-line typescript/no-explicit-any -- any migrated host database
	db: Kysely<any>,
	collection: string,
	indexes: readonly (string | readonly string[])[],
): Promise<void> {
	for (const index of indexes) {
		const fields = typeof index === "string" ? [index] : [...index];
		const expressions = fields.map((field) => `json_extract(data, '$.${field}')`).join(", ");
		await sql
			.raw(
				`CREATE INDEX IF NOT EXISTS "${hostIndexName(collection, fields)}" ` +
					`ON _plugin_storage(plugin_id, collection, ${expressions})`,
			)
			.execute(db);
	}
}

/** One statement as Kysely compiled and sent it. */
export interface SentStatement {
	readonly sql: string;
	readonly parameters: readonly unknown[];
}

/** A Kysely `log` hook that records every statement, and a way to read them. */
export function statementRecorder(): {
	log(event: LogEvent): void;
	take(): SentStatement[];
} {
	let sent: SentStatement[] = [];
	return {
		log(event) {
			sent.push({ sql: event.query.sql, parameters: event.query.parameters });
		},
		take() {
			const taken = sent;
			sent = [];
			return taken;
		},
	};
}

/** The recount's two counts: `count()` statements filtering on `state`. */
export function recountCounts(statements: readonly SentStatement[]): SentStatement[] {
	return statements.filter(
		(s) =>
			/count\(/i.test(s.sql) && s.sql.includes("'$.state'") && s.sql.includes("_plugin_storage"),
	);
}
