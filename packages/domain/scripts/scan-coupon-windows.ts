/**
 * Lists stored coupons whose window bounds checkout cannot read (issue #364).
 * READ-ONLY: it reads an export of the coupon documents and prints a report; it
 * never touches a database.
 *
 * WHY. Checkout reads a coupon's `startsAt` / `expiresAt` with
 * `parseCouponInstant`, which FAILS CLOSED: a bound that is not a zoned ISO-8601
 * date-time (`2026-12-01T00:00:00` with no `Z`), or names a date that does not
 * exist (`2026-02-30T00:00:00Z`), makes the coupon "not active". Older coupons were
 * written before the console checked bounds on save, so a coupon that worked under
 * the earlier `Date.parse` reading can switch off after an upgrade. Run this
 * before releasing, and fix any coupon it lists (edit its dates, or retire it).
 *
 * USAGE — export the `coupons` collection as JSON, then pass the file (or pipe it):
 *
 *     # Cloudflare D1 (production)
 *     wrangler d1 execute YOUR-D1-DATABASE-NAME --remote --json --command \
 *       "SELECT id, data FROM _plugin_storage WHERE plugin_id = 'otta' AND collection = 'coupons'" \
 *       > coupons.json
 *     # a local SQLite database
 *     sqlite3 -json path/to/data.db \
 *       "SELECT id, data FROM _plugin_storage WHERE plugin_id = 'otta' AND collection = 'coupons'" \
 *       > coupons.json
 *
 *     node packages/domain/scripts/scan-coupon-windows.ts coupons.json
 *
 * It accepts wrangler's `--json` output, an array of `{ id, data }` rows (`data`
 * the stored JSON text or object), or an array of coupon documents. It prints one
 * line per unreadable bound and exits 1 when it found any, 0 when every bound is
 * readable, and 2 when it could not read its input (never a clean report).
 *
 * Dev-only and unpublished, like the other scripts here. Only erasable TypeScript
 * syntax is used, so Node (22.18+) runs it directly.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The coupon document fields this scan reads. */
interface CouponWindowDoc {
	readonly couponId?: unknown;
	readonly code?: unknown;
	readonly startsAt?: unknown;
	readonly expiresAt?: unknown;
}

/** One bound checkout cannot read. */
export interface UnreadableBound {
	readonly couponId: string;
	readonly code: string;
	readonly field: "startsAt" | "expiresAt";
	readonly value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The coupon documents in `input`: wrangler's `[{ results: [...] }]`, rows of
 * `{ id, data }` (`data` as JSON text or an object), or the documents themselves.
 * Throws on anything else, so an unreadable export never reads as a clean scan.
 */
export function couponRowsFrom(input: unknown): CouponWindowDoc[] {
	if (!Array.isArray(input)) throw new Error("expected a JSON array");
	const rows: unknown[] = input.flatMap((entry: unknown) =>
		isRecord(entry) && Array.isArray(entry["results"]) ? (entry["results"] as unknown[]) : [entry],
	);
	return rows.map((row, i) => {
		if (!isRecord(row)) throw new Error(`row ${String(i)} is not an object`);
		const data = row["data"];
		if (typeof data === "string") {
			const parsed: unknown = JSON.parse(data);
			if (!isRecord(parsed)) throw new Error(`row ${String(i)}: data is not an object`);
			return parsed;
		}
		return isRecord(data) ? data : row;
	});
}

/** Every non-null window bound `parse` cannot read, in input order. */
export function unreadableCouponWindows(
	docs: readonly CouponWindowDoc[],
	parse: (text: string) => number | null,
): UnreadableBound[] {
	const found: UnreadableBound[] = [];
	for (const doc of docs) {
		for (const field of ["startsAt", "expiresAt"] as const) {
			const value = doc[field];
			if (value === null || value === undefined) continue;
			if (typeof value === "string" && parse(value) !== null) continue;
			found.push({
				couponId: String(doc.couponId ?? "?"),
				code: String(doc.code ?? "?"),
				field,
				value: typeof value === "string" ? value : JSON.stringify(value),
			});
		}
	}
	return found;
}

async function main(): Promise<number> {
	// Loaded by URL, not by a static import: Node runs this file directly, and
	// the domain's sources import each other with `.js` specifiers Node cannot
	// resolve. `validate-coupon.ts` has only type imports, so it loads alone.
	const { parseCouponInstant } = (await import(
		new URL("../src/pricing/validate-coupon.ts", import.meta.url).href
	)) as typeof import("../src/pricing/validate-coupon.js");
	const path = process.argv[2];
	let docs: CouponWindowDoc[];
	try {
		const text = readFileSync(path === undefined || path === "-" ? 0 : path, "utf8");
		docs = couponRowsFrom(JSON.parse(text));
	} catch (err) {
		console.error(`scan-coupon-windows: could not read the coupon export: ${String(err)}`);
		return 2;
	}
	const found = unreadableCouponWindows(docs, parseCouponInstant);
	for (const bound of found) {
		console.log(`${bound.couponId}\t${bound.code}\t${bound.field}\t${bound.value}`);
	}
	console.log(
		found.length === 0
			? `${String(docs.length)} coupon(s) scanned: every window bound is readable.`
			: `${String(docs.length)} coupon(s) scanned: ${String(found.length)} unreadable bound(s). Checkout treats these coupons as not active; edit their dates or retire them.`,
	);
	return found.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
	process.exitCode = await main();
}
