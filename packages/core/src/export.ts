/**
 * Data export: ALL of Core's data as JSON in bounded pages, so "your data is
 * yours" is true and a future importer into full Otta has something to read.
 *
 * Private route `data/export` (also an MCP tool). Input
 * `{ kind: "products" | "stock" | "orders", cursor?, limit? }`; limit defaults
 * to 50 and is clamped to 1..100. Pass `nextCursor` back until it is null.
 *
 * Every document is exported exactly as stored (including `v`), with ONE
 * exception: orders never include `orderKey` (the secret that lets anyone read
 * the order) or `ipTag` (a buyer-address hash). Both are stripped. Nothing else
 * is removed or renamed, so an importer reads the shapes in model.ts.
 *
 * One consequence: the stored `successUrl` embeds the secret (`...#key=<orderKey>`),
 * so its copy of the key is replaced by the placeholder `{ORDER_KEY}` (the same
 * token the `successUrl` setting uses). That is the only edited value.
 *
 * Calls: 1 storage query per page, nothing else (no settings, no logs).
 */
import type { PluginContext } from "emdash/plugin";
import { SCHEMA_VERSION, type OrderDoc, type ProductDoc, type StockDoc } from "./model.js";
import { asRecord, coll, fail } from "./util.js";
import { redactOrder } from "./orders.js";

export const EXPORT_KINDS = ["products", "stock", "orders"] as const;
export type ExportKind = (typeof EXPORT_KINDS)[number];
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;

export interface ExportResult {
	ok: true;
	schemaVersion: typeof SCHEMA_VERSION;
	kind: ExportKind;
	items: Array<{ id: string; data: Record<string, unknown> }>;
	nextCursor: string | null;
}

/** An order as exported: everything stored except the secret `orderKey` and `ipTag`. */
function orderForExport(o: OrderDoc): Record<string, unknown> {
	return redactOrder(o);
}

export async function exportData(input: unknown, ctx: PluginContext) {
	const i = asRecord(input);
	const kind = i["kind"];
	if (typeof kind !== "string" || !(EXPORT_KINDS as readonly string[]).includes(kind))
		return fail("BAD_INPUT", 'kind must be "products", "stock" or "orders"');
	let limit = DEFAULT_LIMIT;
	if (i["limit"] != null) {
		const n = i["limit"];
		if (typeof n !== "number" || !Number.isInteger(n))
			return fail("BAD_INPUT", "limit must be an integer");
		limit = Math.min(MAX_LIMIT, Math.max(1, n));
	}
	const cursor = i["cursor"];
	if (cursor != null && (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 4000))
		return fail("BAD_INPUT", "cursor must be the nextCursor of a previous page");

	const k = kind as ExportKind;
	const r = await coll<ProductDoc | StockDoc | OrderDoc>(ctx, k).query({
		limit,
		...(typeof cursor === "string" ? { cursor } : {}),
	});
	const items = r.items.map(({ id, data }) => ({
		id,
		data: k === "orders" ? orderForExport(data as OrderDoc) : { ...(data as object) },
	}));
	const out: ExportResult = {
		ok: true,
		schemaVersion: SCHEMA_VERSION,
		kind: k,
		items,
		nextCursor: r.hasMore && r.cursor ? r.cursor : null,
	};
	return out;
}
