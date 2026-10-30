/**
 * Are the tables behind a collection's content read actually THERE? (issue #140)
 *
 * em-dash's live loader (`emdash@1.3.1`, `dist/loader-*.mjs`) catches a
 * missing-table fault and folds it into a valid-looking negative answer:
 * `loadEntry` does `if (isMissingTableError(error)) return;` and
 * `loadCollection` does `if (isMissingTableError(error)) return { entries: [] };`.
 * No `error`, no throw, no log. So a page that got "no product" or "no
 * products" back cannot tell "this row does not exist" from "the content store
 * has no table to look in" — and the second one used to render as a 404 on
 * every product URL and the operator's "No products yet. / Open the admin" to
 * every shopper on the shop page.
 *
 * This is the tell. It runs ONLY on the negative path — after a read has
 * already come back empty — so a page that found its content pays nothing: ONE
 * statement, `SELECT (SELECT 1 FROM ec_<collection> LIMIT 1), (SELECT 1 FROM
 * _emdash_collections LIMIT 1), …` — a scalar `LIMIT 1` subquery per table the
 * loader's read touches — through the SAME database handle the loader used
 * (`getDb` from `emdash/runtime`, a public export; it honours the per-request
 * database a playground session installs, so the probe and the read cannot
 * disagree about which database they asked). A missing table fails the whole
 * statement at prepare time on SQLite/D1 and Postgres alike.
 *
 * The loader swallows a missing table ANYWHERE in its query, not only the
 * collection's own, so the probe covers the system tables that query reads too
 * (`LOADER_TABLES`; every one exists on a fresh install — see
 * content-store.test.ts, which also pins the emdash version this list was
 * audited against). A table the loader starts reading in a later emdash
 * release is not covered until the list is re-audited.
 *
 * Any failure counts: a table missing, the handle unobtainable, the query
 * faulting. Each is "the store cannot answer", never "the row is not there".
 *
 * An em-dash release that reports a missing table as `{ error }` (or a
 * dedicated error the caller can match) would make this probe redundant; the
 * callers' existing error branches would then catch the case on their own.
 */
import type { Kysely } from "kysely";

/**
 * The system tables em-dash's entry/collection read cannot work without, read
 * from `loader-*.mjs` (emdash@1.3.1): the field schema (`_emdash_fields` joined
 * to `_emdash_collections`), the folded taxonomy and byline hydration
 * (`content_taxonomies`, `taxonomies`, `_emdash_content_bylines`,
 * `_emdash_bylines`), the folded SEO select every entry read makes
 * (`_emdash_seo`), the media lookup (`media`) and the revision read
 * (`revisions`).
 */
export const LOADER_TABLES: readonly string[] = [
	"_emdash_collections",
	"_emdash_fields",
	"content_taxonomies",
	"taxonomies",
	"_emdash_content_bylines",
	"_emdash_bylines",
	"_emdash_seo",
	"media",
	"revisions",
];

/** Any Kysely handle: `getDb` from `emdash/runtime`, or one a test stands up.
 *  The probe names tables at runtime, so it reads through an untyped schema. */
export type ProbeDb = Pick<Kysely<any>, "selectNoFrom">;

/** em-dash names a collection's content table `ec_<slug>` and refuses any slug
 *  that is not a plain identifier; the probe holds itself to the same rule. */
const COLLECTION_SLUG = /^[a-z][a-z0-9_]*$/;

/** How SQLite/D1 ("no such table") and Postgres ("relation … does not exist")
 *  word a missing table. Only picks the log wording; every failure is still an
 *  outage. */
const MISSING_TABLE = /no such table|relation "[^"]*" does not exist/i;

/**
 * `true` when `collection`'s content table can be read — the caller's empty
 * answer is then genuine (a 404, an empty shop). `false` when it cannot — the
 * caller's empty answer is an outage, and this has already logged it for the
 * operator, tagged with `where` (the page that asked).
 */
export async function contentTableAnswers(
	collection: string,
	openDb: () => Promise<ProbeDb>,
	where: string,
): Promise<boolean> {
	const table = `ec_${collection}`;
	try {
		if (!COLLECTION_SLUG.test(collection)) {
			throw new Error(`"${collection}" is not a collection slug`);
		}
		const db = await openDb();
		await db
			.selectNoFrom((eb) =>
				[table, ...LOADER_TABLES].map((name, index) =>
					eb.selectFrom(name).select(eb.lit(1).as("one")).limit(1).as(`t${index}`),
				),
			)
			.execute();
		return true;
	} catch (cause) {
		// Name what the probe actually saw. A missing table is a fact; any other
		// fault (no handle, a transient D1 error) only means the probe could not
		// confirm the tables — the read's empty answer may even be a genuine 404.
		const finding = MISSING_TABLE.test(String(cause))
			? `content table "${table}" or an emdash system table it needs is missing`
			: `could not confirm that content table "${table}" and the emdash system tables it needs are readable (the probe itself failed)`;
		console.error(
			`[site-staging] ${where}: the content read came back empty, and ${finding} — treating it as a content-store outage, not a missing product (emdash's loader reports a missing table as "not found", issue #140):`,
			cause,
		);
		return false;
	}
}
