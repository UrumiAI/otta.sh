import { afterEach, describe, expect, test } from "vitest";
import { decodeCarrier, decodePath, encodePath } from "../src/admin/scaffold/index.js";
import {
	blocksOf,
	buttons,
	confirmOf,
	fieldEntries,
	findBlock,
	findBlocks,
	formFor,
	group,
	openGroupIds,
	panel,
	panelLabels,
	type LooseBlock,
} from "./helpers/blocks.js";
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// The admin Coupons console under the REAL workerd-on-Node sandbox
// (ADMIN-CONSOLE.md §12.2): a keyset-paged coupons list (search =
// case-insensitive EXACT code match) drilling into a per-coupon detail/edit
// leaf with TWO task-named panels — Coupon · Redemptions (D-2). Create; LWW
// FULL-REPLACE edit (the wire has no partial update: every editable field is
// submitted on every save, pre-filled with the current value, so "leave
// unchanged" = "don't touch the pre-fill" and "clear" = "blank the field" —
// asserted explicitly below); delete with the forbid-if-redeemed audit-trail
// conflict rendered honestly, beside the Redemptions count that gates it.
// Money is integer minor units via the shared money-input helper; percentage
// rates are integer basis points via the shared exact-integer percent parser
// (percent-input).

interface CouponRow {
	id: string;
	code: string;
	type: string;
	amountCents: number | null;
	rateBps: number | null;
	capCents: number | null;
	currency: string | null;
	minSubtotalCents: number | null;
	startsAt: string | null;
	expiresAt: string | null;
	maxUses: number | null;
	maxUsesPerCustomer: number | null;
	usesCount: number;
	createdAt: string;
}

/** A stateful stub standing in for the coupon-admin HTTP surface. Mutations
 *  (POST/PUT/DELETE) move real state read back by GET, so create→list,
 *  edit→reload and delete→idempotent-replay exercise real transitions. The
 *  PUT handler mirrors the REAL service's omit⇒null coercion (rules-admin.ts
 *  maps every absent update field to null before the store call) — the wire
 *  genuinely cannot express "leave unchanged", which is exactly what the
 *  full-replace tests below depend on. */
function makeCouponsState() {
	const coupons: CouponRow[] = [
		{
			id: "c-summer",
			code: "SUMMER25",
			type: "percentage",
			amountCents: null,
			rateBps: 1000,
			capCents: 2000,
			currency: null,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: "2026-09-01T00:00:00.000Z",
			maxUses: 100,
			maxUsesPerCustomer: 1,
			usesCount: 3, // REDEEMED — delete must be blocked (audit trail)
			createdAt: "2026-07-01T00:00:00.000Z",
		},
		{
			id: "c-five",
			code: "FIVEOFF",
			type: "fixed_amount",
			amountCents: 500,
			rateBps: null,
			capCents: null,
			currency: "USD",
			minSubtotalCents: 3500,
			startsAt: "2026-07-01T00:00:00.000Z",
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
			usesCount: 0, // never redeemed — deletable
			createdAt: "2026-06-01T00:00:00.000Z",
		},
	];
	return { coupons };
}

function sortedNewestFirst(rows: CouponRow[]): CouponRow[] {
	return rows.toSorted(
		(a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
	);
}

function attachCouponsStub(stub: StubCommerceServer, state: ReturnType<typeof makeCouponsState>) {
	stub.respondWith("GET", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const [path, query = ""] = req.url.split("?");
		if (path === "/admin/coupons") {
			const q = new URLSearchParams(query);
			const cursor = q.get("cursor");
			let search = q.get("search");
			let offset = 0;
			if (cursor !== null) {
				// Opaque-to-the-plugin cursor: "<offset>|<search-or-empty>" (the real
				// service embeds the filter in its base64url token the same way).
				const [offsetStr = "0", embedded = ""] = cursor.split("|");
				offset = Number.parseInt(offsetStr, 10);
				search = embedded.length > 0 ? embedded : null;
			}
			const limit = Number.parseInt(q.get("limit") ?? "25", 10);
			let rows = sortedNewestFirst(state.coupons);
			if (search !== null) {
				const needle = search.toLowerCase();
				rows = rows.filter((r) => r.code.toLowerCase() === needle); // EXACT, case-insensitive
			}
			const page = rows.slice(offset, offset + limit);
			const nextCursor = offset + limit < rows.length ? `${offset + limit}|${search ?? ""}` : null;
			return { status: 200, body: { ok: true, coupons: page, nextCursor } };
		}
		return { status: 404, body: { error: "unknown" } };
	});

	stub.respondWith("POST", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		if (req.url !== "/admin/coupons") return { status: 404, body: { error: "unknown" } };
		const body = req.body as Record<string, unknown>;
		if (
			state.coupons.some((c) => c.id === body.id) ||
			state.coupons.some((c) => c.code === body.code)
		) {
			return { status: 500, body: { ok: false, error: "internal_error" } };
		}
		const created: CouponRow = {
			id: String(body.id),
			code: String(body.code),
			type: String(body.type),
			amountCents: (body.amountCents ?? null) as number | null,
			rateBps: (body.rateBps ?? null) as number | null,
			capCents: (body.capCents ?? null) as number | null,
			currency: (body.currency ?? null) as string | null,
			minSubtotalCents: (body.minSubtotalCents ?? null) as number | null,
			startsAt: (body.startsAt ?? null) as string | null,
			expiresAt: (body.expiresAt ?? null) as string | null,
			maxUses: (body.maxUses ?? null) as number | null,
			maxUsesPerCustomer: (body.maxUsesPerCustomer ?? null) as number | null,
			usesCount: 0,
			createdAt: `2026-07-2${state.coupons.length}T00:00:00.000Z`,
		};
		state.coupons.push(created);
		return { status: 201, body: { ok: true, coupon: created } };
	});

	stub.respondWith("PUT", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const match = /^\/admin\/coupons\/([^/]+)$/.exec(req.url);
		if (match === null) return { status: 404, body: { error: "unknown" } };
		const couponId = decodeURIComponent(match[1] ?? "");
		const coupon = state.coupons.find((c) => c.id === couponId);
		if (coupon === undefined) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
		const body = req.body as Record<string, unknown>;
		// The REAL service's omit⇒null coercion — an absent key CLEARS the field.
		coupon.amountCents = (body.amountCents ?? null) as number | null;
		coupon.rateBps = (body.rateBps ?? null) as number | null;
		coupon.capCents = (body.capCents ?? null) as number | null;
		coupon.minSubtotalCents = (body.minSubtotalCents ?? null) as number | null;
		coupon.startsAt = (body.startsAt ?? null) as string | null;
		coupon.expiresAt = (body.expiresAt ?? null) as string | null;
		coupon.maxUses = (body.maxUses ?? null) as number | null;
		coupon.maxUsesPerCustomer = (body.maxUsesPerCustomer ?? null) as number | null;
		return { status: 200, body: { ok: true, coupon } };
	});

	stub.respondWith("DELETE", (req: RecordedRequest) => {
		if (req.headers["x-internal-token"] === undefined) {
			return { status: 401, body: { ok: false, error: "unauthorized" } };
		}
		const match = /^\/admin\/coupons\/([^/]+)$/.exec(req.url);
		if (match === null) return { status: 404, body: { error: "unknown" } };
		const couponId = decodeURIComponent(match[1] ?? "");
		const idx = state.coupons.findIndex((c) => c.id === couponId);
		if (idx === -1) return { status: 404, body: { ok: false, reason: "NOT_FOUND" } };
		if ((state.coupons[idx]?.usesCount ?? 0) > 0) {
			return { status: 409, body: { ok: false, reason: "IN_USE_BY_REDEMPTIONS" } };
		}
		state.coupons.splice(idx, 1);
		return { status: 200, body: { ok: true } };
	});
}

async function seedToken(sandbox: SandboxHandle, stub: StubCommerceServer, token: string) {
	await sandbox.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-token",
		values: { internalToken: token },
	});
	stub.requests.length = 0;
}

// Block-search helpers built on the recursive traversal in
// `test/helpers/blocks.ts` (spec V-1, §15) — `BlockRenderer` recurses into
// `columns`/`tab`/`accordion` children (R-25), and this screen's detail now
// nests its `fields`/`accordion`/`actions` blocks inside a `tab`'s panels, so
// a flat `blocks.filter(...)` search would silently return `[]` here.
type Blk = LooseBlock;
function tableOf(blocks: Blk[]) {
	return findBlock(blocks, "table") as
		| { rows?: Array<Record<string, unknown>>; next_cursor?: string; empty_text?: string }
		| undefined;
}
function tableRows(blocks: Blk[]): Array<Record<string, unknown>> {
	return tableOf(blocks)?.rows ?? [];
}
function bannerOf(blocks: Blk[]) {
	return findBlock(blocks, "banner") as
		| { variant?: string; title?: string; description?: string }
		| undefined;
}
function formFields(blocks: Blk[], submitActionId: string): Array<Record<string, unknown>> {
	const form = formFor(blocks, submitActionId);
	return (form?.fields ?? []) as Array<Record<string, unknown>>;
}
/** Every `fields` entry ANYWHERE in the tree (identity strip + both panels),
 *  keyed by label — the labels are unique across all three `fields` blocks
 *  (§12.2), so one Map is a safe, layout-agnostic read of "what does this
 *  detail show". */
function detailFields(blocks: Blk[]): Map<string, string> {
	const entries = findBlocks(blocks, "fields").flatMap((b) =>
		Array.isArray(b.fields) ? (b.fields as Array<{ label: string; value: string }>) : [],
	);
	return new Map(entries.map((f) => [f.label, f.value]));
}
function actionButtons(blocks: Blk[]): Array<Record<string, unknown>> {
	return buttons(blocks);
}
/** The open form's `target` combobox options — asserted to decode to a real
 *  NavPath rather than trusting a hand-encoded guess. */
function openTargetOptions(blocks: Blk[]): Array<{ value: string; label: string }> {
	const fields = formFields(blocks, "coupons:open");
	const targetField = fields.find((f) => f.action_id === "target");
	return (targetField?.options as Array<{ value: string; label: string }> | undefined) ?? [];
}
function headerTexts(blocks: Blk[]): string[] {
	return findBlocks(blocks, "header").map((b) => String(b.text));
}

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;
afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

async function boot(state: ReturnType<typeof makeCouponsState>, token = "admin-token-xyz") {
	stub = await startStubCommerceServer();
	attachCouponsStub(stub, state);
	sandbox = await loadPluginInSandbox({
		allowedHosts: [stub.host],
		commerceServiceBaseUrl: stub.baseUrl,
	});
	if (token.length > 0) await seedToken(sandbox, stub, token);
}

/** Open a coupon's detail via its OWN encoded target — the same path an
 *  operator's combobox selection takes (never a hand-built shortcut). */
async function openCoupon(code: string): Promise<Blk[]> {
	return blocksOf(
		await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:open",
			values: { target: encodePath([code]) },
		}),
	);
}

/**
 * Submit a form the way em-dash does: `values` PLUS the `block_id` the form
 * carried, which is where every id/watermark now rides (F-2, B-1, V-3b).
 * Driving it any other way would test a wire shape the renderer never sends.
 */
async function submitForm(
	blocks: Blk[],
	submitActionId: string,
	values: Record<string, unknown>,
): Promise<Blk[]> {
	const form = formFor(blocks, submitActionId);
	expect(form, `no form submitting ${submitActionId}`).toBeDefined();
	return blocksOf(
		await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: submitActionId,
			values,
			block_id: form!.block_id,
		}),
	);
}

/** Click a button the way em-dash does: `action_id` + `value`, and NO
 *  `block_id` — a button echoes none (B-1). */
async function click(button: Record<string, unknown> | undefined): Promise<Blk[]> {
	expect(button, "no such button").toBeDefined();
	return blocksOf(
		await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: button!.action_id,
			value: button!.value,
		}),
	);
}

/** The full edit-form value set for FIVEOFF exactly as its pre-fill renders
 *  it (the "untouched form" baseline of the unchanged-vs-clear tests).
 *  `couponId`/`code`/`type` are NOT here — they ride in the form's `block_id`
 *  carrier, not as visible fields (F-2). */
const FIVEOFF_PREFILL = {
	amount: "5.00",
	minSubtotal: "35.00",
	startsAt: "2026-07-01T00:00:00.000Z",
	expiresAt: "",
	maxUses: "",
	maxUsesPerCustomer: "",
};

/** The full edit-form value set for SUMMER25 (percentage) exactly as its
 *  pre-fill renders it — the baseline for the percentage family's
 *  unchanged/clear/changed round-trips (rateBps, capCents, maxUses,
 *  maxUsesPerCustomer, expiresAt). */
const SUMMER25_PREFILL = {
	ratePercent: "10.00",
	cap: "20.00",
	minSubtotal: "",
	startsAt: "",
	expiresAt: "2026-09-01T00:00:00.000Z",
	maxUses: "100",
	maxUsesPerCustomer: "1",
};

describe("admin Coupons console — list level (workerd sandbox)", () => {
	test("page_load /coupons renders the list newest-first with honest discount/window/uses columns (no Type column) and forwards the kv-sourced admin token", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" });
		const blocks = blocksOf(outcome);
		expect(headerTexts(blocks)).toContain("Coupons");
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/coupons"));
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
		const table = tableOf(blocks) as { columns?: Array<{ key: string }> } | undefined;
		// T-5: the Type badge column is deleted — Discount already reads
		// "20% off" / "$5.00 off".
		expect((table?.columns ?? []).map((c) => c.key)).toEqual([
			"code",
			"discount",
			"window",
			"uses",
		]);
		const rows = tableRows(blocks);
		expect(rows.map((r) => r.code)).toEqual(["SUMMER25", "FIVEOFF"]);
		// bps as an exact percent + a currency-less cap as a plain decimal (a
		// percentage coupon is currency-agnostic — no invented symbol);
		// fixed_amount money via the shared symbol-bearing formatter.
		expect(rows[0]?.discount).toBe("10.00% off (cap 20.00)");
		expect(rows[1]?.discount).toBe("$5.00 off");
		expect(rows[0]?.window).toBe("until 2026-09-01");
		expect(rows[1]?.window).toBe("from 2026-07-01");
		expect(rows[0]?.uses).toBe("3 / 100");
		expect(rows[1]?.uses).toBe("0 / ∞");
	});

	test("NO-TOKEN page_load /coupons fails closed with E-7's normative banner (no raw HTTP status/URL, no single named cause)", async () => {
		const state = makeCouponsState();
		await boot(state, "");
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" });
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/coupons|401/);
		// X-42: the fail-closed banner must not name a single cause.
		expect(String(banner?.description)).toMatch(/admin token in Settings/i);
		expect(String(banner?.description)).toMatch(/fault in the console itself/i);
	});

	test("apply-filter searches by EXACT code, case-insensitively, and keeps the entered value in the (inline, L-2) search form", async () => {
		const state = makeCouponsState();
		await boot(state);
		const list = blocksOf(
			await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" }),
		);
		stub!.requests.length = 0;
		const blocks = await submitForm(list, "coupons:apply-filter", { search: "fiveoff" });
		const req = stub!.requests.find((r) => r.url.startsWith("/admin/coupons"));
		expect(req?.url).toContain("search=fiveoff");
		expect(tableRows(blocks).map((r) => r.code)).toEqual(["FIVEOFF"]);
		const filterField = formFields(blocks, "coupons:apply-filter").find(
			(f) => f.action_id === "search",
		);
		expect(filterField?.initial_value).toBe("fiveoff");
		// L-2: 1 field renders INLINE — the search form is not wrapped in an
		// accordion.
		expect(findBlocks(blocks, "accordion").some((a) => a.block_id === "coupons:filters")).toBe(
			false,
		);
	});

	test("a search with no match shows an honest empty state, never a fail-closed banner", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:apply-filter",
			values: { search: "NOPE" },
		});
		const blocks = blocksOf(outcome);
		expect(tableRows(blocks)).toHaveLength(0);
		expect(String(tableOf(blocks)?.empty_text)).toMatch(/no coupon/i);
		expect(bannerOf(blocks)).toBeUndefined();
	});

	test("KEYSET PAGING: a full page carries next_cursor; coupons:page loads the next page through the opaque cursor round-trip", async () => {
		const state = makeCouponsState();
		for (let i = 0; i < 30; i++) {
			state.coupons.push({
				id: `c-bulk-${String(i).padStart(2, "0")}`,
				code: `BULK${String(i).padStart(2, "0")}`,
				type: "fixed_amount",
				amountCents: 100 + i,
				rateBps: null,
				capCents: null,
				currency: "USD",
				minSubtotalCents: null,
				startsAt: null,
				expiresAt: null,
				maxUses: null,
				maxUsesPerCustomer: null,
				usesCount: 0,
				createdAt: `2026-05-01T00:00:${String(i).padStart(2, "0")}.000Z`,
			});
		}
		await boot(state);
		const first = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" });
		const firstBlocks = blocksOf(first);
		expect(tableRows(firstBlocks)).toHaveLength(25);
		const nextToken = tableOf(firstBlocks)?.next_cursor;
		expect(nextToken).toBeDefined();
		stub!.requests.length = 0;

		const second = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "coupons:page",
			value: { cursor: nextToken },
		});
		const pagedReq = stub!.requests.find((r) => r.url.startsWith("/admin/coupons"));
		expect(pagedReq?.url).toContain("cursor=");
		const secondRows = tableRows(blocksOf(second));
		expect(secondRows).toHaveLength(7); // 32 total = 25 + 7
		expect(tableOf(blocksOf(second))?.next_cursor).toBeUndefined();
	});

	test("the create form's type-specific fields carry `condition` (F-5b) — both branches present, gated on `type`", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" });
		const fields = formFields(blocksOf(outcome), "coupons:create");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		expect(byId.get("amount")?.condition).toEqual({ field: "type", eq: "fixed_amount" });
		expect(byId.get("currency")?.condition).toEqual({ field: "type", eq: "fixed_amount" });
		expect(byId.get("ratePercent")?.condition).toEqual({ field: "type", eq: "percentage" });
		expect(byId.get("cap")?.condition).toEqual({ field: "type", eq: "percentage" });
		expect(byId.get("type")?.initial_value).toBe("fixed_amount"); // R-12b
		// The 5 shared axes have no field on the create form at all (§12.2) —
		// each already has a home in the edit form.
		for (const removed of [
			"minSubtotal",
			"startsAt",
			"expiresAt",
			"maxUses",
			"maxUsesPerCustomer",
		]) {
			expect(byId.has(removed)).toBe(false);
		}
	});

	test("create (fixed_amount) POSTs EXACT integer minor units; the five shared axes are not on this form and are sent explicit null", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:create",
			values: {
				id: "c-ten",
				code: "TENOFF",
				type: "fixed_amount",
				amount: "10.00",
				currency: "usd",
			},
		});
		const post = stub!.requests.find((r) => r.method === "POST" && r.url === "/admin/coupons");
		expect(post).toBeDefined();
		expect(post!.body).toEqual({
			id: "c-ten",
			code: "TENOFF",
			type: "fixed_amount",
			amountCents: 1000,
			rateBps: null,
			capCents: null,
			currency: "USD",
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
		const blocks = blocksOf(outcome);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("created");
		expect(tableRows(blocks).some((r) => r.code === "TENOFF")).toBe(true);
	});

	test("create (percentage) POSTs exact basis points + cap; the five shared axes are sent explicit null even when the request smuggles extra keys", async () => {
		const state = makeCouponsState();
		await boot(state);
		await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:create",
			values: {
				id: "c-pct",
				code: "PCT7",
				type: "percentage",
				amount: "",
				currency: "",
				ratePercent: "7.25",
				cap: "20.00",
				// A devtools-crafted request could still send these — the handler
				// must not read them (they are not on the real form).
				minSubtotal: "50.00",
				startsAt: "2026-08-01",
				maxUses: "50",
			},
		});
		const post = stub!.requests.find((r) => r.method === "POST" && r.url === "/admin/coupons");
		expect(post!.body).toEqual({
			id: "c-pct",
			code: "PCT7",
			type: "percentage",
			amountCents: null,
			rateBps: 725,
			capCents: 2000,
			currency: null,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
	});

	test.each([
		["a 3-decimal amount", { amount: "4.999", currency: "USD" }],
		["a negative amount", { amount: "-1", currency: "USD" }],
		["a zero amount", { amount: "0", currency: "USD" }],
		["a non-numeric amount", { amount: "abc", currency: "USD" }],
		["a bad currency", { amount: "5.00", currency: "US" }],
	])(
		"fixed_amount create with %s is caught at the plugin boundary — no POST sent (money parse edge)",
		async (_label, overrides) => {
			const state = makeCouponsState();
			await boot(state);
			const outcome = await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "coupons:create",
				values: { id: "c-bad", code: "BAD", type: "fixed_amount", ...overrides },
			});
			expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
			expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
		},
	);

	test.each([
		["a 3-decimal rate", "7.255"],
		["a zero rate", "0"],
		["a non-numeric rate", "ten"],
	])(
		"percentage create with %s is caught at the plugin boundary — no POST sent (percent parse edge)",
		async (_label, ratePercent) => {
			const state = makeCouponsState();
			await boot(state);
			const outcome = await sandbox!.invokeRoute("admin", {
				type: "form_submit",
				action_id: "coupons:create",
				values: {
					id: "c-bad",
					code: "BAD",
					type: "percentage",
					amount: "",
					currency: "",
					ratePercent,
				},
			});
			expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
			expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
		},
	);

	test("CROSS-TYPE honesty: filling a percentage-only field on a fixed_amount create (and vice versa) is an explicit error, never silently dropped", async () => {
		const state = makeCouponsState();
		await boot(state);
		const fixedWithRate = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:create",
			values: {
				id: "c-x",
				code: "X1",
				type: "fixed_amount",
				amount: "5.00",
				currency: "USD",
				ratePercent: "10",
				cap: "",
			},
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(fixedWithRate))?.variant).toBe("error");

		const pctWithAmount = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:create",
			values: {
				id: "c-y",
				code: "Y1",
				type: "percentage",
				amount: "5.00",
				currency: "",
				ratePercent: "10",
				cap: "",
			},
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(pctWithAmount))?.variant).toBe("error");
	});

	test("creating a coupon with a duplicate id/code fails with a GENERIC error notice (no raw status)", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:create",
			values: {
				id: "c-five",
				code: "FIVEOFF",
				type: "fixed_amount",
				amount: "5.00",
				currency: "USD",
			},
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|500/);
		expect(state.coupons.filter((c) => c.code === "FIVEOFF")).toHaveLength(1);
	});

	test("the unfiltered TRUE-ZERO state shows `empty` (not the table), whose action forces the New coupon group open (E-2, B-6)", async () => {
		const state = { coupons: [] as CouponRow[] };
		await boot(state);
		const list = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" });
		const blocks = blocksOf(list);
		expect(findBlock(blocks, "table")).toBeUndefined();
		const empty = findBlock(blocks, "empty") as
			| { title?: string; actions?: Array<Record<string, unknown>> }
			| undefined;
		expect(empty?.title).toMatch(/no coupons/i);
		const newButton = (empty?.actions ?? []).find((a) => a.action_id === "coupons:new");
		expect(newButton).toBeDefined();
		// L-8: the create group already exists (collapsed) even at zero rows —
		// there has to be a group for the button to force open.
		expect(group(blocks, "coupons:new")?.default_open).not.toBe(true);

		const opened = await click(newButton);
		// B-6: BOTH a changed block_id and default_open:true.
		const openedGroup = findBlocks(opened, "accordion").find((a) => a.default_open === true);
		expect(openedGroup).toBeDefined();
		expect(openedGroup?.block_id).not.toBe("coupons:new");
		expect(openGroupIds(opened)).toHaveLength(1); // X-18
	});
});

describe("admin Coupons console — detail/edit leaf (workerd sandbox)", () => {
	test("opening a coupon drills to its detail via the open form's OWN encoded target (a combobox, never a select — L-7/X-22), loading the FULL summary (incl. the window)", async () => {
		const state = makeCouponsState();
		await boot(state);
		const list = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" });
		const listBlocks = blocksOf(list);
		const openField = formFields(listBlocks, "coupons:open").find((f) => f.action_id === "target");
		expect(openField?.type).toBe("combobox"); // R-17a/R-17b, X-22
		expect(openField?.initial_value).toBe("none");
		const option = openTargetOptions(listBlocks).find(
			(o) => decodePath(o.value)?.[0] === "FIVEOFF",
		);
		expect(option).toBeDefined();
		expect(option!.label).toBe("FIVEOFF · $5.00 off · 0 / ∞");
		stub!.requests.length = 0;

		const blocks = await openCoupon("FIVEOFF");
		// The detail load is the exact-search list read — the only read that
		// carries startsAt/expiresAt (GET /admin/coupons/:code omits them, and
		// the full-replace edit form MUST pre-fill the window or saving would
		// silently clear it).
		const loadReq = stub!.requests.find((r) => r.url.startsWith("/admin/coupons?"));
		expect(loadReq?.url).toContain("search=FIVEOFF");
		expect(headerTexts(blocks)).toContain("Coupon — FIVEOFF");
		expect(panelLabels(blocks)).toEqual(["Coupon", "Redemptions"]); // D-2, constant set
		const fields = detailFields(blocks);
		// M-10/F-2: no bare internal "id" row — the code is the human handle.
		expect(fields.has("ID")).toBe(false);
		expect(fields.get("Code")).toBe("FIVEOFF");
		expect(fields.get("Type")).toBe("fixed_amount");
		expect(fields.get("Discount")).toBe("$5.00 off");
		expect(fields.get("Uses")).toBe("0 / ∞");
		expect(fields.get("Currency")).toBe("USD");
		expect(fields.get("Created (UTC)")).toBe("2026-06-01T00:00:00Z"); // M-6: ms trimmed
		expect(fields.get("Minimum spend")).toBe("$35.00");
		expect(fields.get("Valid")).toBe("from 2026-07-01");
		expect(fields.get("Redemptions")).toBe("0");
		expect(fields.get("Max total uses")).toBe("unlimited");
		// M-11a: the axis is named, never a bare "Remaining".
		expect(fields.has("Remaining")).toBe(false);
		expect(fields.get("Remaining redemptions")).toBe("unlimited");
		expect(actionButtons(blocks).some((e) => e.action_id === "coupons:back")).toBe(true);
	});

	test("the Redemptions meter renders only when max uses is set, and never carries money as a bare count", async () => {
		const state = makeCouponsState();
		await boot(state);
		const unlimited = await openCoupon("FIVEOFF"); // maxUses null
		expect(findBlock(unlimited, "meter")).toBeUndefined();

		const capped = await openCoupon("SUMMER25"); // maxUses 100, usesCount 3
		const meter = findBlock(capped, "meter") as
			| { label?: string; value?: number; max?: number; custom_value?: string }
			| undefined;
		expect(meter).toBeDefined();
		expect(meter?.value).toBe(3);
		expect(meter?.max).toBe(100);
		expect(meter?.custom_value).toBe("3 of 100");
	});

	test("the Edit group is default_open TRUE on every render (D-5 rank 3 — a loaded coupon is always editable) and its label carries the discount + window (D-6)", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		const editGroup = group(blocks, "coupons:c-five:edit");
		expect(editGroup).toBeDefined();
		expect(editGroup?.default_open).toBe(true);
		expect(String(editGroup?.label)).toContain("Edit —");
		expect(String(editGroup?.label)).toContain("$5.00 off");
		expect(String(editGroup?.label).length).toBeLessThanOrEqual(60); // X-11
		expect(openGroupIds(blocks)).toEqual(["coupons:c-five:edit"]); // X-18
	});

	test("the edit form carries couponId/code/type INVISIBLY in its block_id (F-2) and pre-fills every editable field (unset ⇒ blank), so an untouched save cannot clear anything", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		const form = formFor(blocks, "coupons:save");
		expect(form).toBeDefined();
		const carried = decodeCarrier(form!.block_id as string);
		expect(carried?.couponId).toBe("c-five");
		expect(carried?.code).toBe("FIVEOFF");
		expect(carried?.type).toBe("fixed_amount");
		const fields = formFields(blocks, "coupons:save");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		// None of these ride as VISIBLE fields (F-2).
		for (const forbidden of ["couponId", "code", "type"]) {
			expect(byId.has(forbidden)).toBe(false);
		}
		expect(byId.get("amount")?.type).toBe("text_input"); // never number_input (float)
		expect(byId.get("amount")?.initial_value).toBe("5.00");
		expect(byId.get("minSubtotal")?.initial_value).toBe("35.00");
		expect(byId.get("startsAt")?.initial_value).toBe("2026-07-01T00:00:00.000Z");
		expect(byId.get("expiresAt")?.initial_value).toBeUndefined(); // unset ⇒ blank
		expect(byId.get("maxUses")?.initial_value).toBeUndefined();
		// a fixed_amount coupon renders NO percentage-only fields
		expect(byId.has("ratePercent")).toBe(false);
		expect(byId.has("cap")).toBe(false);
	});

	test("UNCHANGED semantics: saving the untouched pre-fill PUTs a full replacement carrying every current value — nothing is cleared", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		const outcome = await submitForm(blocks, "coupons:save", { ...FIVEOFF_PREFILL });
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.url).toBe("/admin/coupons/c-five");
		// EVERY editable key is present and explicit (never relying on the wire's
		// omit⇒null coercion), with "unset" as an explicit null.
		expect(put!.body).toEqual({
			amountCents: 500,
			rateBps: null,
			capCents: null,
			minSubtotalCents: 3500,
			startsAt: "2026-07-01T00:00:00.000Z",
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
		const banner = bannerOf(outcome);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		const coupon = state.coupons.find((c) => c.id === "c-five");
		expect(coupon?.minSubtotalCents).toBe(3500); // unchanged
		expect(coupon?.startsAt).toBe("2026-07-01T00:00:00.000Z"); // unchanged
	});

	test("CLEAR semantics: blanking a pre-filled field saves it as an explicit null, and the reloaded detail shows it cleared", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		const outcome = await submitForm(blocks, "coupons:save", {
			...FIVEOFF_PREFILL,
			minSubtotal: "",
			startsAt: "",
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.body).toMatchObject({
			amountCents: 500,
			minSubtotalCents: null,
			startsAt: null,
		});
		const coupon = state.coupons.find((c) => c.id === "c-five");
		expect(coupon?.minSubtotalCents).toBeNull();
		expect(coupon?.startsAt).toBeNull();
		// The re-rendered edit form reflects the clear — its pre-fill is blank now.
		const fields = formFields(outcome, "coupons:save");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		expect(byId.get("minSubtotal")?.initial_value).toBeUndefined();
		expect(bannerOf(outcome)?.variant).toBe("default");
	});

	test("a PERCENTAGE coupon's edit form pre-fills its own family (rate, cap, window, use bounds) and renders no fixed-amount fields", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("SUMMER25");
		const form = formFor(blocks, "coupons:save");
		const carried = decodeCarrier(form!.block_id as string);
		expect(carried?.type).toBe("percentage");
		const fields = formFields(blocks, "coupons:save");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		expect(byId.get("ratePercent")?.type).toBe("text_input"); // never number_input (float)
		expect(byId.get("ratePercent")?.initial_value).toBe("10.00");
		expect(byId.get("cap")?.initial_value).toBe("20.00");
		expect(byId.get("expiresAt")?.initial_value).toBe("2026-09-01T00:00:00.000Z");
		expect(byId.get("maxUses")?.initial_value).toBe("100");
		expect(byId.get("maxUsesPerCustomer")?.initial_value).toBe("1");
		expect(byId.get("minSubtotal")?.initial_value).toBeUndefined(); // unset ⇒ blank
		expect(byId.get("startsAt")?.initial_value).toBeUndefined();
		// a percentage coupon renders NO fixed-amount-only field
		expect(byId.has("amount")).toBe(false);
	});

	test("UNCHANGED semantics (percentage): saving the untouched pre-fill PUTs a full replacement carrying rate/cap/window/use bounds — nothing is cleared", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("SUMMER25");
		const outcome = await submitForm(blocks, "coupons:save", { ...SUMMER25_PREFILL });
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.url).toBe("/admin/coupons/c-summer");
		expect(put!.body).toEqual({
			amountCents: null,
			rateBps: 1000,
			capCents: 2000,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: "2026-09-01T00:00:00.000Z",
			maxUses: 100,
			maxUsesPerCustomer: 1,
		});
		expect(bannerOf(outcome)?.variant).toBe("default");
		const coupon = state.coupons.find((c) => c.id === "c-summer");
		expect(coupon?.rateBps).toBe(1000); // unchanged
		expect(coupon?.capCents).toBe(2000);
		expect(coupon?.expiresAt).toBe("2026-09-01T00:00:00.000Z");
		expect(coupon?.maxUses).toBe(100);
		expect(coupon?.maxUsesPerCustomer).toBe(1);
	});

	test("CLEAR semantics (percentage): blanking cap/expiry/use bounds saves each as an explicit null while the rate is carried; the reloaded form shows them cleared", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("SUMMER25");
		const outcome = await submitForm(blocks, "coupons:save", {
			...SUMMER25_PREFILL,
			cap: "",
			expiresAt: "",
			maxUses: "",
			maxUsesPerCustomer: "",
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.body).toMatchObject({
			rateBps: 1000, // carried, not clobbered
			capCents: null,
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
		const coupon = state.coupons.find((c) => c.id === "c-summer");
		expect(coupon?.capCents).toBeNull();
		expect(coupon?.expiresAt).toBeNull();
		expect(coupon?.maxUses).toBeNull();
		expect(coupon?.maxUsesPerCustomer).toBeNull();
		expect(coupon?.rateBps).toBe(1000);
		// The re-rendered edit form reflects the clears — pre-fills are blank now.
		const fields = formFields(outcome, "coupons:save");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		expect(byId.get("cap")?.initial_value).toBeUndefined();
		expect(byId.get("expiresAt")?.initial_value).toBeUndefined();
		expect(byId.get("maxUses")?.initial_value).toBeUndefined();
		expect(bannerOf(outcome)?.variant).toBe("default");
	});

	test("CHANGED semantics (percentage): edited rate/cap/expiry/use bounds PUT exact integers (bps, minor units) with the expiry normalized to ISO UTC", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("SUMMER25");
		const outcome = await submitForm(blocks, "coupons:save", {
			...SUMMER25_PREFILL,
			ratePercent: "12.5",
			cap: "25.00",
			expiresAt: "2026-10-01",
			maxUses: "200",
			maxUsesPerCustomer: "2",
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.body).toEqual({
			amountCents: null,
			rateBps: 1250, // "12.5" ⇒ exact integer bps, padded fraction
			capCents: 2500,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: "2026-10-01T00:00:00.000Z", // normalized to ISO UTC
			maxUses: 200,
			maxUsesPerCustomer: 2,
		});
		const banner = bannerOf(outcome);
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		const coupon = state.coupons.find((c) => c.id === "c-summer");
		expect(coupon?.rateBps).toBe(1250);
		expect(coupon?.capCents).toBe(2500);
		expect(coupon?.maxUses).toBe(200);
	});

	test("an expiry at-or-before the start is caught at the plugin boundary on SAVE — no PUT sent", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("SUMMER25");
		const outcome = await submitForm(blocks, "coupons:save", {
			...SUMMER25_PREFILL,
			startsAt: "2026-09-01T00:00:00Z",
			expiresAt: "2026-08-01T00:00:00Z",
		});
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
		expect(bannerOf(outcome)?.variant).toBe("error");
	});

	test("a percentage coupon cannot blank its rate — the one axis with no 'unset'; no PUT sent, context preserved", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("SUMMER25");
		const outcome = await submitForm(blocks, "coupons:save", {
			...SUMMER25_PREFILL,
			ratePercent: "",
		});
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
		expect(bannerOf(outcome)?.variant).toBe("error");
		expect(headerTexts(outcome)).toContain("Coupon — SUMMER25");
	});

	test("a fixed_amount coupon cannot blank its amount — the one axis with no 'unset' (the domain requires it); no PUT sent", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		const outcome = await submitForm(blocks, "coupons:save", { ...FIVEOFF_PREFILL, amount: "" });
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
		const banner = bannerOf(outcome);
		expect(banner?.variant).toBe("error");
		// still on the detail (the merchant's context is preserved)
		expect(headerTexts(outcome)).toContain("Coupon — FIVEOFF");
	});

	test("saving a coupon that no longer exists renders an honest not-found notice", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		state.coupons = state.coupons.filter((c) => c.id !== "c-five"); // vanished mid-edit
		const outcome = await submitForm(blocks, "coupons:save", { ...FIVEOFF_PREFILL });
		const banner = bannerOf(outcome);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/not found/i);
	});

	test("a save whose block_id fails to decode (a tampered/expired form) is a rendered error, never a silent bounce", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:save",
			values: { amount: "5.00" },
			block_id: "not-a-carrier",
		});
		const blocks = blocksOf(outcome);
		expect(bannerOf(blocks)?.variant).toBe("error");
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
	});

	test("an unredeemed coupon's detail offers a GENERIC 'Delete coupon' button (M-7: the code lives in confirm.title, not the button label) with audit-trail danger copy; a REDEEMED coupon's detail withholds it honestly (DA-7)", async () => {
		const state = makeCouponsState();
		await boot(state);
		const deletable = await openCoupon("FIVEOFF");
		const deleteButton = actionButtons(deletable).find((e) => e.action_id === "coupons:delete");
		expect(deleteButton).toBeDefined();
		expect(deleteButton!.label).toBe("Delete coupon"); // generic — M-7
		expect(deleteButton!.style).toBe("danger");
		const confirm = confirmOf(deleteButton);
		expect(confirm.style).toBe("danger");
		expect(confirm.title).toBe("Delete FIVEOFF?"); // the code lives HERE
		expect(String(confirm.text)).toMatch(/never-redeemed/i);
		expect(String(confirm.text).length).toBeLessThanOrEqual(200); // X-11

		const redeemed = await openCoupon("SUMMER25");
		expect(actionButtons(redeemed).some((e) => e.action_id === "coupons:delete")).toBe(false);
		const blockedNote = findBlocks(redeemed, "context").find((b) =>
			/audit trail/i.test(String(b.text)),
		);
		expect(blockedNote).toBeDefined();
		expect(String(blockedNote?.text)).toContain("redeemed 3 times");
		// DA-7a: names the alternative, no "deliberately"/"there is no"/"we do not".
		expect(String(blockedNote?.text)).not.toMatch(/deliberately|there is no|we do not/i);
		expect(String(blockedNote?.text)).toMatch(/expiry to a past date/i);
	});

	test("deleting an unredeemed coupon DELETEs, returns to the list with a 'deleted' notice; a repeat delete is an idempotent no-op", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		const deleteButton = actionButtons(blocks).find((e) => e.action_id === "coupons:delete");
		const first = await click(deleteButton);
		const del = stub!.requests.find((r) => r.method === "DELETE");
		expect(del?.url).toBe("/admin/coupons/c-five");
		expect(headerTexts(first)).toContain("Coupons"); // back on the list
		const firstBanner = bannerOf(first);
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(tableRows(first).some((r) => r.code === "FIVEOFF")).toBe(false);

		const second = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "coupons:delete",
			value: { couponId: "c-five", code: "FIVEOFF" },
		});
		const secondBanner = bannerOf(blocksOf(second));
		expect(secondBanner?.variant).toBe("default"); // never an error
		expect(String(secondBanner?.title)).toMatch(/already deleted/i);
	});

	test("deleting a REDEEMED coupon is refused with the audit-trail conflict rendered honestly, on the coupon's own detail", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "coupons:delete",
			value: { couponId: "c-summer", code: "SUMMER25" },
		});
		const blocks = blocksOf(outcome);
		const banner = bannerOf(blocks);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toMatch(/redeemed/i);
		expect(String(banner?.description)).toMatch(/audit trail/i);
		expect(String(banner?.description)).not.toMatch(/HTTP \d|409/);
		expect(headerTexts(blocks)).toContain("Coupon — SUMMER25"); // context preserved
		expect(state.coupons.some((c) => c.id === "c-summer")).toBe(true); // never deleted
	});

	test("opening an unknown code renders an honest not-found view, never a fail-closed banner", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:open",
			values: { target: encodePath(["GHOST"]) },
		});
		const blocks = blocksOf(outcome);
		expect(headerTexts(blocks)).toContain("Coupon not found");
		expect(String(bannerOf(blocks)?.description)).toContain("GHOST");
		expect(actionButtons(blocks).some((e) => e.action_id === "coupons:back")).toBe(true);
	});

	test("back from the detail returns to the coupons list", async () => {
		const state = makeCouponsState();
		await boot(state);
		const detail = await openCoupon("FIVEOFF");
		const backButton = actionButtons(detail).find((e) => e.action_id === "coupons:back");
		const back = await click(backButton);
		expect(headerTexts(back)).toContain("Coupons");
	});

	test("the Coupon panel's own fields (Minimum spend, Valid) live INSIDE the tab panel, findable via `panel()`", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		const couponPanel = panel(blocks, "Coupon");
		expect(fieldEntries(couponPanel)).toContain("Minimum spend=$35.00");
		expect(fieldEntries(couponPanel)).toContain("Valid=from 2026-07-01");
		const redemptionsPanel = panel(blocks, "Redemptions");
		expect(fieldEntries(redemptionsPanel)).toContain("Redemptions=0");
	});
});
