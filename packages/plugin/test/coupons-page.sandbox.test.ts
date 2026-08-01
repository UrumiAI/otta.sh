import { afterEach, describe, expect, test } from "vitest";
import { couponStatus, couponUsesSummary } from "../src/admin/coupons-page.js";
import {
	decodeCarrier,
	decodePath,
	encodeCarrier,
	encodePath,
} from "../src/admin/scaffold/index.js";
import { assertBlockContract } from "./helpers/block-contract.js";
import {
	blocksOf,
	buttons,
	confirmOf,
	emptyActions,
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
			// A service whose filter narrows its own PAGE WINDOW rather than its
			// query — the shape the products list already has for "Low stock only",
			// and a legal one for any list port: a page of zero matches with more
			// pages still behind it. Staged by a sentinel needle, because this stub's
			// ordinary path filters BEFORE it slices and so can never produce it.
			if (`${q.get("search") ?? ""}${q.get("cursor") ?? ""}`.toLowerCase().includes("narrowed")) {
				return { status: 200, body: { ok: true, coupons: [], nextCursor: "0|NARROWED" } };
			}
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
			// `total` is the count of the whole FILTERED set (INC-23) — computed
			// before the slice, exactly as the service's COUNT(*) is taken under the
			// list's own predicate rather than over its page.
			return { status: 200, body: { ok: true, coupons: page, nextCursor, total: rows.length } };
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
/** Banners in the TOP-LEVEL array only. `findBlocks` recurses, and the edit
 *  group now holds a banner of its own, so a recursive read cannot answer "is
 *  this coupon marked?" — and §2's banner budget (X-31) counts only these. */
function topLevelBanners(blocks: Blk[]): Array<Record<string, unknown>> {
	return blocks.filter((b) => b.type === "banner");
}
function formSubmitId(form: Blk): string {
	return String((form.submit as { action_id?: unknown } | undefined)?.action_id ?? "");
}
/** What `blocks/form.tsx` would post for an UNTOUCHED form: every field's
 *  `initial_value`, and no key at all for a field without one. */
function formInitialValues(blocks: Blk[], submitActionId: string): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const field of formFields(blocks, submitActionId)) {
		if (field.initial_value !== undefined) out[String(field.action_id)] = field.initial_value;
	}
	return out;
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

/** The list, freshly loaded. */
async function loadList(): Promise<Blk[]> {
	return blocksOf(await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" }));
}

/** Drill into the create screen the way an operator does — by CLICKING the
 *  promoted "New coupon" button (INC-14), never by hand-firing its action. */
async function openNewCouponScreen(from?: Blk[]): Promise<Blk[]> {
	const list = from ?? (await loadList());
	return click(buttons(list).find((b) => b.action_id === "coupons:new"));
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

/**
 * What the RENDERER submits for FIVEOFF's untouched edit form — the "operator
 * opened it and pressed Save" baseline of the unchanged-vs-clear tests.
 *
 * This is `blocks/form.tsx`'s `getInitialValues` verbatim: every field's
 * `initial_value`, and NO KEY AT ALL for a field that has none. Filling the
 * absent ones in with `""` would test a wire shape the renderer never sends,
 * and would quietly convert "never submitted" into "explicitly cleared" —
 * which are now different instructions.
 *
 * The window bounds are DAYS, not instants: they render as `date_input`
 * elements. `couponId`/`code`/`type` are absent too — they ride in the form's
 * `block_id` carrier, not as visible fields (F-2).
 */
const FIVEOFF_PREFILL = {
	amount: "5.00",
	startsAt: "2026-07-01",
	showLimits: false,
	minSubtotal: "35.00",
};

/** The same, for SUMMER25 (percentage) — the baseline for that family's
 *  unchanged/clear/changed round-trips (rateBps, capCents, maxUses,
 *  maxUsesPerCustomer, expiresAt). */
const SUMMER25_PREFILL = {
	ratePercent: "10.00",
	expiresAt: "2026-09-01",
	showLimits: false,
	cap: "20.00",
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
		const table = tableOf(blocks) as
			| { columns?: Array<{ key: string; label: string; format?: string }> }
			| undefined;
		// T-5: the Type badge column is deleted — Discount already reads
		// "20% off" / "$5.00 off". T-2: identity FIRST, money LAST.
		expect((table?.columns ?? []).map((c) => c.key)).toEqual([
			"code",
			"status",
			"discount",
			"window",
			"uses",
			"minSpend",
		]);
		const rows = tableRows(blocks);
		expect(rows.map((r) => r.code)).toEqual(["SUMMER25", "FIVEOFF"]);
		// bps as an exact percent + a currency-less cap as a plain decimal (a
		// percentage coupon is currency-agnostic — no invented symbol);
		// fixed_amount money via the shared symbol-bearing formatter.
		expect(rows[0]?.discount).toBe("10.00% off (cap 20.00)");
		expect(rows[1]?.discount).toBe("$5.00 off");
		expect(rows[0]?.window).toBe("until 1 Sept 2026");
		expect(rows[1]?.window).toBe("from 1 Jul 2026");
		// `N of M` against a bound, `N uses` without one — the `∞` glyph is gone
		// (it does not localize, and the meter/picker already say it in words).
		expect(rows[0]?.uses).toBe("3 of 100");
		expect(rows[1]?.uses).toBe("0 uses");
		// Money LAST (T-2) and pre-formatted (M-1): an ABSENT minimum is an em
		// dash, never "$0.00" and never "Free" — no minimum ≠ a minimum of
		// nothing — and the currency rides in the formatted string, so there is
		// no Currency column and no currency repeated per row (M-2).
		expect((table?.columns ?? []).at(-1)?.key).toBe("minSpend");
		expect((table?.columns ?? []).at(-1)?.label).toBe("Min spend");
		expect(rows[0]?.minSpend).toBe("—");
		expect(rows[1]?.minSpend).toBe("$35.00");
		expect((table?.columns ?? []).some((c) => c.label.includes("USD"))).toBe(false);
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

	test("a search with no match shows an honest, designed empty state — heading, body copy and `Clear filters` — never a fail-closed banner (INC-12)", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:apply-filter",
			values: { search: "NOPE" },
		});
		const blocks = blocksOf(outcome);
		assertBlockContract(blocks, { screen: "coupons", level: "list" });
		expect(tableRows(blocks)).toHaveLength(0);
		// The zero-row table is REPLACED, so there is no `empty_text` under a table
		// nobody can see — the state itself carries the words.
		expect(tableOf(blocks)).toBeUndefined();
		const empty = findBlock(blocks, "empty");
		expect(String(empty?.title)).toMatch(/no coupon matches/i);
		expect(String(empty?.description).length).toBeLessThanOrEqual(200);
		expect(bannerOf(blocks)).toBeUndefined();

		// The undo, and nothing else: "New coupon" is already promoted above the
		// table (INC-14), so this state offers exactly one act.
		const actions = emptyActions(blocks);
		expect(actions.map((a) => a.label)).toEqual(["Clear filters"]);
		const cleared = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "coupons:apply-filter",
				value: actions[0]?.value,
			}),
		);
		assertBlockContract(cleared, { screen: "coupons", level: "list" });
		// Back on the coupons LIST with every coupon, and the search box empty —
		// the cleared value is visible, not stranded (B-7).
		expect(headerTexts(cleared)).toContain("Coupons");
		expect(tableRows(cleared).map((r) => r.code)).toEqual(["SUMMER25", "FIVEOFF"]);
		expect(findBlocks(cleared, "section")).toEqual([]);
		expect(
			formFields(cleared, "coupons:apply-filter").find((f) => f.action_id === "search")
				?.initial_value,
		).toBeUndefined();
	});

	test("INC-12 outcome 3: a filtered page narrowed to zero WITH a page behind it keeps `Load more` alive — no `empty` block, no `empty_text`, and the note says the scan can continue", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await submitForm(
			blocksOf(await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" })),
			"coupons:apply-filter",
			{ search: "NARROWED" },
		);
		assertBlockContract(blocks, { screen: "coupons", level: "list" });
		expect(tableRows(blocks)).toHaveLength(0);
		// The designed zero state would REPLACE the table, and `empty_text` would
		// collapse it to a bare <p> — either one takes the operator's only way
		// forward with it.
		expect(findBlocks(blocks, "empty")).toEqual([]);
		expect(tableOf(blocks)).toBeDefined();
		expect(tableOf(blocks)?.empty_text).toBeUndefined();
		expect(tableOf(blocks)?.next_cursor).toBeDefined();
		expect(
			findBlocks(blocks, "context").some((c) => String(c.text).includes("Load more scans further")),
		).toBe(true);
		// The undo is still one click away on the summary section — the state that
		// suppressed the `empty` block did not take `Clear filters` with it.
		expect(
			(findBlocks(blocks, "section")[0]?.accessory as { label?: string } | undefined)?.label,
		).toBe("Clear filters");
		// And the scan really does continue: the cursor round-trips.
		const page2 = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "coupons:page",
				value: { cursor: tableOf(blocks)?.next_cursor },
			}),
		);
		assertBlockContract(page2, { screen: "coupons", level: "list" });
		expect(bannerOf(page2)).toBeUndefined();
	});

	test("INC-12: the intro line leads with the row count, pluralized, page-scoped only when paging is in play, and silent at zero", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = blocksOf(
			await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" }),
		);
		// 2 coupons, one page, no cursor ⇒ this IS the set.
		const intro = String(blocks.find((b) => b.type === "context")?.text);
		expect(intro).toMatch(/^2 coupons · /);
		expect(intro.length).toBeLessThanOrEqual(140); // X-11

		// One row pluralizes for itself.
		const one = await submitForm(blocks, "coupons:apply-filter", { search: "fiveoff" });
		expect(String(one.find((b) => b.type === "context")?.text)).toMatch(/^1 coupon · /);

		// Zero states nothing — never `0 coupons`; the empty state says it in words.
		const none = await submitForm(blocks, "coupons:apply-filter", { search: "NOPE" });
		const zeroIntro = String(none.find((b) => b.type === "context")?.text);
		expect(zeroIntro).not.toMatch(/\d+ coupon/);
		expect(zeroIntro.startsWith("Search a coupon and open it.")).toBe(true);
	});

	test("INC-23: with 30 coupons behind a 25-row page, the count states the SET on both pages — never the page", async () => {
		const state = makeCouponsState();
		for (let i = 0; i < 30; i++) {
			state.coupons.push({
				id: `t-bulk-${String(i).padStart(2, "0")}`,
				code: `TBULK${String(i).padStart(2, "0")}`,
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
				createdAt: `2026-06-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
			});
		}
		await boot(state);
		const page1 = blocksOf(
			await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" }),
		);
		const intro1 = String(page1.find((b) => b.type === "context")?.text);
		// 32 rows in the set, 25 on the page: the count says 32, and without the
		// page-scoped suffix, which would now be an understatement.
		expect(intro1).toMatch(/^32 coupons · /);
		expect(intro1).not.toContain("on this page");
		expect(intro1.length).toBeLessThanOrEqual(140); // X-11
		const page2 = blocksOf(
			await sandbox!.invokeRoute("admin", {
				type: "block_action",
				action_id: "coupons:page",
				value: { cursor: tableOf(page1)?.next_cursor },
			}),
		);
		assertBlockContract(page2, { screen: "coupons", level: "list" });
		// Page 2 holds the remaining 7 rows and still captions the same 32 — the
		// claim keyset paging alone could never support.
		expect(String(page2.find((b) => b.type === "context")?.text)).toMatch(/^32 coupons · /);
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
		const fields = formFields(await openNewCouponScreen(), "coupons:create");
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

	test("the unfiltered TRUE-ZERO state shows `empty` (not the table), whose action opens the SAME create screen as the promoted button (E-2)", async () => {
		const state = { coupons: [] as CouponRow[] };
		await boot(state);
		const blocks = await loadList();
		expect(findBlock(blocks, "table")).toBeUndefined();
		const empty = findBlock(blocks, "empty") as
			| { title?: string; actions?: Array<Record<string, unknown>> }
			| undefined;
		expect(empty?.title).toMatch(/no coupons/i);
		const emptyButton = (empty?.actions ?? []).find((a) => a.action_id === "coupons:new");
		// One act, one verb, one wording — the empty state and the promoted
		// button fire the same action id and say the same words.
		expect(emptyButton?.label).toBe("New coupon");
		// No create form anywhere on the list itself, at any row count (INC-14:
		// L-8's bottom accordion is gone — the form lives on the drill-in).
		expect(formFor(blocks, "coupons:create")).toBeUndefined();

		const opened = await click(emptyButton);
		expect(headerTexts(opened)).toEqual(["New coupon"]);
		expect(formFor(opened, "coupons:create")).toBeDefined();
	});

	// -- INC-14: the create action is a button above the data ------------------

	test("INC-14: `New coupon` is a primary BUTTON emitted directly under the intro line, above the table — and no create accordion survives below it", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await loadList();
		// Block ORDER, at the top level: header · context · the create button ·
		// … · table. The button is above the data; the form is not on this
		// screen at all.
		const types = blocks.map((b) => String(b.type));
		expect(types.slice(0, 3)).toEqual(["header", "context", "actions"]);
		expect(types.indexOf("actions")).toBeLessThan(types.indexOf("table"));
		const createButton = buttons(blocks).find((b) => b.action_id === "coupons:new");
		expect(createButton?.type).toBe("button");
		expect(createButton?.label).toBe("New coupon");
		expect(createButton?.style).toBe("primary");
		// The old L-8 create group, in either of its two block_ids, is gone —
		// as is any accordion labelled like a create affordance.
		expect(group(blocks, "coupons:new")).toBeUndefined();
		expect(group(blocks, "coupons:new:opened")).toBeUndefined();
		expect(findBlocks(blocks, "accordion").map((a) => String(a.label))).not.toContain("New coupon");
		expect(openGroupIds(blocks)).toHaveLength(0); // X-18
	});

	test("INC-14: the create screen is a drill-in — header, a back control that returns to the list, and the create form", async () => {
		const state = makeCouponsState();
		await boot(state);
		const screen = await openNewCouponScreen();
		expect(headerTexts(screen)).toEqual(["New coupon"]);
		// The list is REPLACED, not pushed down: no table, no picker, no filter.
		expect(findBlock(screen, "table")).toBeUndefined();
		expect(formFor(screen, "coupons:open")).toBeUndefined();
		expect(formFor(screen, "coupons:apply-filter")).toBeUndefined();
		expect(formFor(screen, "coupons:create")).toBeDefined();
		// Nothing is pre-typed on a fresh create (only `type`, R-12b).
		expect(formInitialValues(screen, "coupons:create")).toEqual({ type: "fixed_amount" });

		const back = buttons(screen).find((b) => b.action_id === "coupons:cancel-new");
		expect(String(back?.label)).toMatch(/back to coupons/i);
		const list = await click(back);
		expect(headerTexts(list)).toEqual(["Coupons"]);
		expect(tableRows(list).map((r) => r.code)).toEqual(["SUMMER25", "FIVEOFF"]);
	});

	// THE PROPERTY THIS INCREMENT MUST NOT LOSE. Before INC-14 a create refusal
	// re-rendered the list and the operator's typed values survived only as
	// unsubmitted state in a form that happened to keep its block_id — which the
	// E-2 force-open path did NOT keep (`coupons:new:opened` → `coupons:new` is a
	// remount, and a remount discards it). The drill-in makes the guarantee
	// explicit and server-side: every refusal carries the submitted values back
	// as `initial_value` (DA-3a-i), so it holds no matter what the client does
	// with the tree.
	test("INC-14/DA-3a-i: a REFUSED create re-renders the create screen with every typed value put back, verbatim", async () => {
		const state = makeCouponsState();
		await boot(state);
		const screen = await openNewCouponScreen();
		// A percentage coupon with an unparseable rate — the refusal is about ONE
		// field, and the other five must not be retyped.
		const typed = {
			id: "summer26",
			code: "SUMMER26",
			type: "percentage",
			amount: "",
			currency: "",
			ratePercent: "ten percent",
			cap: "20.00",
		};
		const refused = await submitForm(screen, "coupons:create", typed);
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(refused)?.variant).toBe("error");
		// Still the create screen (not the list), and every value is back.
		expect(headerTexts(refused)).toEqual(["New coupon"]);
		expect(formInitialValues(refused, "coupons:create")).toEqual({
			id: "summer26",
			code: "SUMMER26",
			type: "percentage", // the SELECT survives too, so `condition` still reveals the rate fields
			ratePercent: "ten percent", // VERBATIM — never re-derived from a parse that failed
			cap: "20.00",
		});
		// Fixing the one field and resubmitting creates the coupon.
		const created = await submitForm(refused, "coupons:create", {
			...typed,
			ratePercent: "10",
		});
		expect(state.coupons.find((c) => c.code === "SUMMER26")?.rateBps).toBe(1000);
		expect(bannerOf(created)?.variant).toBe("default");
		// Success DROPS the draft and returns to the list.
		expect(headerTexts(created)).toEqual(["Coupons"]);
		expect(formFor(created, "coupons:create")).toBeUndefined();
	});

	test("INC-14/DA-3a-i: a SERVICE refusal (duplicate id/code) keeps the typed values too", async () => {
		const state = makeCouponsState();
		await boot(state);
		const screen = await openNewCouponScreen();
		const refused = await submitForm(screen, "coupons:create", {
			id: "c-five",
			code: "FIVEOFF",
			type: "fixed_amount",
			amount: "5.00",
			currency: "USD",
			ratePercent: "",
			cap: "",
		});
		expect(bannerOf(refused)?.variant).toBe("error");
		expect(headerTexts(refused)).toEqual(["New coupon"]);
		expect(formInitialValues(refused, "coupons:create")).toEqual({
			id: "c-five",
			code: "FIVEOFF",
			type: "fixed_amount",
			amount: "5.00",
			currency: "USD",
		});
		expect(state.coupons.filter((c) => c.code === "FIVEOFF")).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// The computed `Status` column and the `Min spend` money column.
//
// Status is DERIVED at render from the coupon's own window/use bound — the
// record carries no such field and neither does any form on this screen (G2:
// a value the domain owns is displayed, never given an input). These fixtures
// therefore express their boundaries RELATIVE to the render clock: a
// hard-coded `2026-09-01` fixture would quietly change its own expected status
// the day that date passes, which is a time bomb, not a test.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const ahead = (ms: number) => new Date(Date.now() + ms).toISOString();
/** The DAY an offset from the render clock falls on — what a `date_input`
 *  submits, expressed relative for the same reason the fixtures above are. */
const dayAhead = (ms: number) => ahead(ms).slice(0, 10);

/** A coupon row with the incidental fields filled in — the status fixtures
 *  differ only in their window / use bound, so everything else is noise.
 *  `createdAt` is passed explicitly per row to pin the list's newest-first
 *  ordering. */
function couponRow(over: Partial<CouponRow> & { id: string; code: string }): CouponRow {
	return {
		type: "percentage",
		amountCents: null,
		rateBps: 1000,
		capCents: null,
		currency: "USD",
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: null,
		maxUsesPerCustomer: null,
		usesCount: 0,
		createdAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

/** The audit seed's three shapes (`EXPIRED20` ended, `LAUNCH2026` not yet
 *  started, `SUMMER25` live) plus the three the seed does not carry: an
 *  unbounded coupon, an exhausted one, and a currency-agnostic minimum. */
function makeStatusCoupons(): { coupons: CouponRow[] } {
	return {
		coupons: [
			couponRow({ id: "c-expired", code: "EXPIRED20", expiresAt: ago(30 * DAY_MS) }),
			couponRow({ id: "c-launch", code: "LAUNCH2026", startsAt: ahead(14 * DAY_MS) }),
			couponRow({ id: "c-summer", code: "SUMMER25", expiresAt: ahead(21 * DAY_MS) }),
			couponRow({ id: "c-forever", code: "FOREVER" }), // no window at all
			couponRow({ id: "c-maxed", code: "MAXEDOUT", maxUses: 25, usesCount: 25 }),
			couponRow({ id: "c-welcome", code: "WELCOME10", maxUses: 500, usesCount: 1 }),
			couponRow({
				id: "c-save5",
				code: "SAVE5",
				type: "fixed_amount",
				amountCents: 500,
				rateBps: null,
				minSubtotalCents: 3000,
			}),
			// A percentage coupon carries no currency, so its minimum has none
			// either — it must render as a plain decimal, not an invented symbol.
			couponRow({ id: "c-noccy", code: "NOCURRENCY", currency: null, minSubtotalCents: 3500 }),
		],
	};
}

/**
 * A coupon with EVERY optional value set — the audit's `WELCOME10` (`PM §E3`):
 * cap, minimum spend, BOTH window bounds and both use bounds at once. It exists
 * to answer one question the two-coupon fixture above cannot, because every
 * coupon there leaves something blank: on a record where NOTHING is unset, does
 * the edit form render each current value as a real `initial_value` (safe), or
 * as a grey `placeholder` the browser submits as `""` (a data-loss bug)?
 *
 * The window bounds are clock-relative like the status fixtures, which buys a
 * second property for free: they carry a real sub-day TIME. A `date_input`
 * shows only the day, so an untouched save that preserved the day but rewrote
 * the time would still be a silent edit — and only an instant with a nonzero
 * time can catch it.
 */
function makeWelcomeState(): { coupons: CouponRow[] } {
	return {
		coupons: [
			couponRow({
				id: "c-welcome",
				code: "WELCOME10",
				currency: null, // a percentage coupon is currency-agnostic
				capCents: 2000, // cap 20.00 (PM §E3)
				minSubtotalCents: 5000, // min spend 50.00
				startsAt: ago(30 * DAY_MS),
				expiresAt: ahead(30 * DAY_MS),
				maxUses: 500, // max uses 500 (PM §E3)
				maxUsesPerCustomer: 2,
				usesCount: 7,
			}),
		],
	};
}

/**
 * A `fixed_amount` coupon carrying a STRAY `capCents` — a cap belongs to the
 * percentage family and this record has no business holding one, but nothing
 * upstream stops it: the service validates each column and never the pair.
 * Reachable through a direct API write, a partial migration, or a coupon whose
 * type was corrected in the database.
 *
 * It is a fixture rather than a curiosity because the edit form renders no
 * `cap` field for this type. Anything that fed the stray value back into the
 * save would trip the cross-type check and refuse EVERY save of this coupon
 * while naming a field the operator cannot see — a dead end with no console
 * escape, on a coupon that saved fine before.
 */
function makeStrayCapState(): { coupons: CouponRow[] } {
	return {
		coupons: [
			couponRow({
				id: "c-stray",
				code: "STRAY5",
				type: "fixed_amount",
				amountCents: 500,
				rateBps: null,
				capCents: 2000, // the stray — percentage-only, on a fixed_amount record
				currency: "USD",
			}),
		],
	};
}

/** The list table's rows keyed by `code` — the fixtures above are read by
 *  identity, never by row index. */
async function statusRowsByCode(): Promise<Map<string, Record<string, unknown>>> {
	const blocks = blocksOf(
		await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" }),
	);
	return new Map(tableRows(blocks).map((r) => [String(r.code), r]));
}

describe("admin Coupons console — computed Status + Min spend (workerd sandbox)", () => {
	test("Status is COMPUTED per row from the window and the use bound: expired / scheduled / active / used up", async () => {
		await boot(makeStatusCoupons());
		const rows = await statusRowsByCode();
		// The three the audit seeds, which today render identically to each
		// other — the whole reason this column exists.
		expect(rows.get("EXPIRED20")?.status).toBe("expired");
		expect(rows.get("LAUNCH2026")?.status).toBe("scheduled");
		expect(rows.get("SUMMER25")?.status).toBe("active");
		// No expiry at all is ACTIVE — never "unknown", never blank.
		expect(rows.get("FOREVER")?.status).toBe("active");
		expect(rows.get("MAXEDOUT")?.status).toBe("used up");
		expect(rows.get("WELCOME10")?.status).toBe("active"); // 1 of 500 — not exhausted
	});

	test("Status is never a form field anywhere on the list (G2) — no input, no filter, no create/edit field claims it", async () => {
		await boot(makeStatusCoupons());
		const blocks = blocksOf(
			await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" }),
		);
		const everyField = findBlocks(blocks, "form").flatMap((f) =>
			Array.isArray(f.fields) ? (f.fields as Array<Record<string, unknown>>) : [],
		);
		expect(everyField.length).toBeGreaterThan(0);
		expect(everyField.some((f) => String(f.action_id) === "status")).toBe(false);
		expect(everyField.some((f) => /status|expired|scheduled/i.test(String(f.label ?? "")))).toBe(
			false,
		);
	});

	test("Status renders as PLAIN TEXT: Block Kit's `format` is per COLUMN, so badging only the exceptions is unreachable and the happy path stays quiet (T-5/X-4)", async () => {
		await boot(makeStatusCoupons());
		const blocks = blocksOf(
			await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" }),
		);
		const table = tableOf(blocks) as
			| { columns?: Array<{ key: string; format?: string }> }
			| undefined;
		const status = (table?.columns ?? []).find((c) => c.key === "status");
		expect(status).toBeDefined();
		expect(status?.format).toBeUndefined();
		// A badge column would put an identical pill on every live coupon: the
		// renderer badges a whole column or none of it, and an emptied cell in a
		// badge column still draws the pill, only wordless.
		expect((table?.columns ?? []).some((c) => c.format === "badge")).toBe(false);
	});

	test("`Min spend` is money LAST, formatted, currency in the value and NOT repeated in the header; an absent minimum is `—`, never $0.00 or Free", async () => {
		await boot(makeStatusCoupons());
		const rows = await statusRowsByCode();
		expect(rows.get("SAVE5")?.minSpend).toBe("$30.00");
		// Absent ≠ zero: no minimum is an em dash.
		expect(rows.get("FOREVER")?.minSpend).toBe("—");
		expect(rows.get("SUMMER25")?.minSpend).toBe("—");
		// Nothing renders an absent minimum as a ZERO or as a word: the only
		// values on the column are "—" and real, formatted amounts.
		for (const row of rows.values()) {
			expect(String(row.minSpend)).not.toMatch(/^(free|unknown|none|null|\$?0(\.00)?)$/i);
		}
		// A currency-agnostic coupon's floor is an exact plain decimal — no
		// invented symbol, and never dropped to `—` (which would claim there is
		// no minimum when there is one).
		expect(rows.get("NOCURRENCY")?.minSpend).toBe("35.00");
	});

	test("`Uses` reads `N of M` / `N uses` with no `∞` glyph anywhere in the rendered list", async () => {
		await boot(makeStatusCoupons());
		const rows = await statusRowsByCode();
		expect(rows.get("WELCOME10")?.uses).toBe("1 of 500");
		expect(rows.get("MAXEDOUT")?.uses).toBe("25 of 25");
		expect(rows.get("FOREVER")?.uses).toBe("0 uses");
		expect(couponUsesSummary(1, null)).toBe("1 use"); // singular agreement
		const blocks = blocksOf(
			await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" }),
		);
		expect(JSON.stringify(blocks)).not.toContain("∞");
	});

	test("assertBlockContract holds on the Status/Min spend list render (§15 V-3)", async () => {
		await boot(makeStatusCoupons());
		assertBlockContract(
			blocksOf(await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" })),
			{ screen: "coupons", level: "list" },
		);
	});
});

// The boundaries, against an EXPLICIT `now` — the one place the console's
// answer must agree with `validateCoupon`'s to the instant, since an operator
// reading `active` on a coupon checkout has already started refusing is worse
// than no column at all.
describe("couponStatus — boundaries and precedence (mirrors the domain's validateCoupon)", () => {
	const NOW = "2026-07-31T12:00:00.000Z";
	const at = (over: Partial<Parameters<typeof couponStatus>[0]>) =>
		couponStatus({ startsAt: null, expiresAt: null, maxUses: null, usesCount: 0, ...over }, NOW);

	test("the end bound is EXCLUSIVE: expiring exactly now is already expired, a millisecond later is still active", () => {
		expect(at({ expiresAt: NOW })).toBe("expired");
		expect(at({ expiresAt: "2026-07-31T12:00:00.001Z" })).toBe("active");
	});

	test("the start bound is INCLUSIVE: starting exactly now is active, a millisecond later is scheduled", () => {
		expect(at({ startsAt: NOW })).toBe("active");
		expect(at({ startsAt: "2026-07-31T12:00:00.001Z" })).toBe("scheduled");
	});

	test("an expiry earlier TODAY is expired — the comparison is the instant, not the calendar day", () => {
		expect(at({ expiresAt: "2026-07-31T00:00:00.000Z" })).toBe("expired");
		expect(at({ expiresAt: "2026-07-31T23:59:59.000Z" })).toBe("active");
	});

	test("no bounds at all is active, not unknown", () => {
		expect(at({})).toBe("active");
	});

	test("the use bound only fires once it is REACHED (>= maxUses), and only inside the window", () => {
		expect(at({ maxUses: 500, usesCount: 499 })).toBe("active");
		expect(at({ maxUses: 500, usesCount: 500 })).toBe("used up");
		expect(at({ maxUses: 500, usesCount: 501 })).toBe("used up");
	});

	test("when two conditions hold the FIRST refusal wins, in the domain's own check order", () => {
		// Exhausted AND expired reads `expired`: that is the reason checkout gives.
		expect(at({ expiresAt: "2026-07-30T12:00:00.000Z", maxUses: 1, usesCount: 1 })).toBe("expired");
		// Exhausted AND not yet started reads `scheduled`, same reasoning.
		expect(at({ startsAt: "2026-08-01T12:00:00.000Z", maxUses: 1, usesCount: 1 })).toBe(
			"scheduled",
		);
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
		// §12.2's own picker vocabulary: `<code> · 20% off · 3 uses`.
		expect(option!.label).toBe("FIVEOFF · $5.00 off · 0 uses");
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
		// ...and no `Code` ROW either: the header asserted above already reads
		// `Coupon — FIVEOFF`. D-1a caps this strip at SIX entries, so the
		// duplicate is what pays for the `Status` entry that now leads it.
		expect(fields.has("Code")).toBe(false);
		expect(fields.get("Status")).toBe("active");
		expect(fields.get("Type")).toBe("fixed_amount");
		expect(fields.get("Discount")).toBe("$5.00 off");
		expect(fields.get("Uses")).toBe("0 uses");
		expect(fields.get("Currency")).toBe("USD");
		// M-6, console-wide since INC-10: the last raw wire instant in the console
		// is gone, and the label dropped `(UTC)` because the VALUE carries the zone.
		expect(fields.get("Created")).toBe("1 Jun 2026, 00:00 UTC");
		expect(fields.get("Minimum spend")).toBe("$35.00");
		expect(fields.get("Valid")).toBe("from 1 Jul 2026");
		expect(fields.get("Redemptions")).toBe("0");
		expect(fields.get("Max uses")).toBe("unlimited");
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

	test("SAFE BY DEFAULT: the Edit group renders CLOSED, so a screen opened to READ presents no loaded full-replace editor — and its label still carries the discount + window (D-6)", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		const editGroup = group(blocks, "coupons:c-five:edit");
		expect(editGroup).toBeDefined();
		// PM §E3b: an operator diagnosing a code was one stray Enter from
		// rewriting its expiry, cap and use bounds.
		expect(editGroup?.default_open).toBe(false);
		// The reading the operator came for is on the page WITHOUT opening it:
		// the group's own label (D-6) plus the Status field above it.
		expect(String(editGroup?.label)).toContain("Edit —");
		expect(String(editGroup?.label)).toContain("$5.00 off");
		expect(String(editGroup?.label).length).toBeLessThanOrEqual(60); // X-11
		// NOTHING is force-opened on a plain detail render (X-18).
		expect(openGroupIds(blocks)).toEqual([]);
	});

	test("the destructive full-replace warning outranks the field labels it warns about — a `banner`, not the `context` line it used to be", async () => {
		const state = makeCouponsState();
		await boot(state);
		const blocks = await openCoupon("FIVEOFF");
		const editGroup = group(blocks, "coupons:c-five:edit");
		const body = (editGroup?.blocks ?? []) as Blk[];
		const warning = body.find((b) => b.type === "banner");
		expect(warning, "the full-replace warning must be a banner").toBeDefined();
		expect(warning?.variant).toBe("alert"); // X-26: default|alert|error only
		expect(String(warning?.title)).toContain("replaces every field");
		expect(String(warning?.description)).toContain("saves as unset, not unchanged");
		expect(String(warning?.description).length).toBeLessThanOrEqual(240); // X-11
		// The old rendering was `context` — `text-sm text-kumo-subtle`, the same
		// weight as the labels below it. No context line may still carry the
		// warning's own claim.
		for (const ctx of body.filter((b) => b.type === "context")) {
			expect(String(ctx.text)).not.toContain("saves as unset");
		}
		// The end-of-day reading IS stated, and in the group the dates live in.
		const dateNote = body.find(
			(b) => b.type === "context" && String(b.text).includes("END of its expiry date"),
		);
		expect(dateNote, "the end-of-day reading must be stated").toBeDefined();
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
		// The window is a DATE element pre-filled with the DAY its stored instant
		// falls on — nobody hand-types an RFC 3339 timestamp with milliseconds.
		expect(byId.get("startsAt")?.type).toBe("date_input");
		expect(byId.get("startsAt")?.initial_value).toBe("2026-07-01");
		expect(byId.get("expiresAt")?.type).toBe("date_input");
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
			// `minSubtotal` sits behind the disclosure, and blanking a bound the
			// operator never opened is not an instruction — so a deliberate clear
			// carries the toggle they had to flip to reach the field.
			showLimits: true,
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
		expect(byId.get("expiresAt")?.type).toBe("date_input");
		expect(byId.get("expiresAt")?.initial_value).toBe("2026-09-01");
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
			// Three of these four sit behind the disclosure — a deliberate clear
			// carries the toggle the operator had to flip to reach them.
			showLimits: true,
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

	test("CHANGED semantics (percentage): edited rate/cap/expiry/use bounds PUT exact integers (bps, minor units), with a NEW expiry day resolved to the END of that day", async () => {
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
			// END of the chosen day. The domain's window is `[startsAt, expiresAt)`
			// — an exclusive end pinned to midnight would retire the code at the
			// START of the day the operator picked, a full day early and a day
			// earlier than the screen's own `Valid` reading claims.
			expiresAt: "2026-10-01T23:59:59.999Z",
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
		expect(fieldEntries(couponPanel)).toContain("Valid=from 1 Jul 2026");
		const redemptionsPanel = panel(blocks, "Redemptions");
		expect(fieldEntries(redemptionsPanel)).toContain("Redemptions=0");
	});

	// -- the leaf's own lifecycle reading ---------------------------------------

	test("the leaf leads with a computed `Status` field, in the SAME vocabulary as the list column — one definition, so a coupon cannot read `expired` here and `active` there", async () => {
		await boot(makeStatusCoupons());
		for (const [code, expected] of [
			["EXPIRED20", "expired"],
			["LAUNCH2026", "scheduled"],
			["MAXEDOUT", "used up"],
			["SUMMER25", "active"],
		] as const) {
			const blocks = await openCoupon(code);
			expect(detailFields(blocks).get("Status"), `${code}`).toBe(expected);
		}
	});

	test("BADGE THE EXCEPTIONS on the leaf: each non-active state raises one `alert` banner naming what checkout does; a live coupon raises none", async () => {
		await boot(makeStatusCoupons());
		for (const code of ["EXPIRED20", "LAUNCH2026", "MAXEDOUT"] as const) {
			const banners = topLevelBanners(await openCoupon(code));
			expect(banners, `${code} must be marked`).toHaveLength(1);
			expect(banners[0]?.variant).toBe("alert");
			// The word is already in the strip above — the banner spends its
			// emphasis on the CONSEQUENCE instead.
			expect(String(banners[0]?.description)).toContain("Checkout refuses this code");
			expect(String(banners[0]?.description).length).toBeLessThanOrEqual(240); // X-11
		}
		// The happy path stays completely quiet: a mark on every coupon would put
		// the screen's loudest ink on its least informative state (T-5).
		expect(topLevelBanners(await openCoupon("SUMMER25"))).toEqual([]);
	});

	test("Status is COMPUTED on the leaf, never a form field (G2 / ADR-0013) — no input on the detail claims a value the domain derives", async () => {
		await boot(makeStatusCoupons());
		const blocks = await openCoupon("EXPIRED20");
		expect(detailFields(blocks).get("Status")).toBe("expired");
		const everyField = findBlocks(blocks, "form").flatMap((f) =>
			Array.isArray(f.fields) ? (f.fields as Array<Record<string, unknown>>) : [],
		);
		expect(everyField.length).toBeGreaterThan(0);
		expect(everyField.some((f) => String(f.action_id) === "status")).toBe(false);
		expect(everyField.some((f) => /status|expired|scheduled/i.test(String(f.label ?? "")))).toBe(
			false,
		);
	});

	// -- the collapsed bounds ----------------------------------------------------

	test("the four rarely-touched bounds sit behind ONE closed disclosure inside the SAME form — never a second form, which a full-replace wire turns into a data-loss bug (F-5a)", async () => {
		await boot(makeWelcomeState());
		const blocks = await openCoupon("WELCOME10");
		const fields = formFields(blocks, "coupons:save");
		const byId = new Map(fields.map((f) => [String(f.action_id), f]));
		// The disclosure itself: a real toggle, closed on every render.
		expect(byId.get("showLimits")?.type).toBe("toggle");
		expect(byId.get("showLimits")?.initial_value).toBe(false);
		// The four bounds are gated on it...
		for (const gated of ["cap", "minSubtotal", "maxUses", "maxUsesPerCustomer"]) {
			expect(byId.get(gated)?.condition, gated).toEqual({ field: "showLimits", eq: true });
		}
		// ...and the discount + window are NOT — they are why the group is opened.
		for (const ungated of ["ratePercent", "startsAt", "expiresAt"]) {
			expect(byId.get(ungated)?.condition, ungated).toBeUndefined();
		}
		// ONE form still owns every editable field: splitting it is what would let
		// a "Discount" save silently null the window and the use bounds.
		expect(
			findBlocks(blocks, "form").filter((f) => formSubmitId(f) === "coupons:save"),
		).toHaveLength(1);
		// Four inputs drawn at rest, down from seven (DESIGNER §3's worst
		// proportion offender: seven stacked full-bleed inputs, five of them empty).
		const drawnAtRest = fields.filter((f) => f.condition === undefined);
		expect(drawnAtRest).toHaveLength(4);
	});

	test("nothing the disclosure hides is unreadable: every gated bound is already on the leaf as text, so collapsing the inputs hides no FACT", async () => {
		await boot(makeWelcomeState());
		const blocks = await openCoupon("WELCOME10");
		const shown = detailFields(blocks);
		expect(shown.get("Minimum spend")).toBe("50.00"); // currency-agnostic ⇒ plain decimal
		expect(shown.get("Max uses")).toBe("500");
		expect(shown.get("Max per customer")).toBe("2");
		// The cap rides in the discount summary, on the leaf and in the group label.
		expect(shown.get("Discount")).toBe("10.00% off (cap 20.00)");
	});

	test("SAFE BY DEFAULT: a bound that never reaches the submit at all keeps its current value — a collapsed disclosure cannot clear what it was hiding", async () => {
		const state = makeWelcomeState();
		const before = { ...state.coupons[0]! };
		await boot(state);
		const blocks = await openCoupon("WELCOME10");
		// Exactly what a renderer that DROPPED `condition`-hidden fields would
		// send. Today's pinned 0.31.1 submits them (`getInitialValues` reads every
		// field's `initial_value`), but that is an interaction between two upstream
		// implementation details — `carrier.ts` refuses to depend on it, and so
		// does this form: the current values ride in its `block_id` too.
		await submitForm(blocks, "coupons:save", {
			ratePercent: "10.00",
			startsAt: before.startsAt!.slice(0, 10),
			expiresAt: before.expiresAt!.slice(0, 10),
			showLimits: false,
		});
		const after = state.coupons.find((c) => c.id === "c-welcome");
		expect(after?.capCents).toBe(before.capCents);
		expect(after?.minSubtotalCents).toBe(before.minSubtotalCents);
		expect(after?.maxUses).toBe(before.maxUses);
		expect(after?.maxUsesPerCustomer).toBe(before.maxUsesPerCustomer);
	});

	test("...and BLANK still means unset: the fallback covers a field that never arrived, never one the operator deliberately emptied", async () => {
		const state = makeWelcomeState();
		const before = { ...state.coupons[0]! };
		await boot(state);
		const blocks = await openCoupon("WELCOME10");
		await submitForm(blocks, "coupons:save", {
			ratePercent: "10.00",
			startsAt: before.startsAt!.slice(0, 10),
			expiresAt: before.expiresAt!.slice(0, 10),
			showLimits: true,
			cap: "",
			minSubtotal: "",
			maxUses: "",
			maxUsesPerCustomer: "",
		});
		const after = state.coupons.find((c) => c.id === "c-welcome");
		expect(after?.capCents).toBeNull();
		expect(after?.minSubtotalCents).toBeNull();
		expect(after?.maxUses).toBeNull();
		expect(after?.maxUsesPerCustomer).toBeNull();
		expect(after?.rateBps).toBe(before.rateBps); // the one axis with no "unset"
	});

	test("re-submitting the DAY a bound already falls on is not an edit: the stored instant survives byte for byte, sub-day time included", async () => {
		const state = makeWelcomeState();
		const before = { ...state.coupons[0]! };
		await boot(state);
		// The fixture's instants carry a real time-of-day, which the `date_input`
		// never shows — so a save that rewrote them to midnight would still be a
		// silent edit of a value the operator never touched.
		expect(before.expiresAt).not.toMatch(/T00:00:00\.000Z$/);
		const blocks = await openCoupon("WELCOME10");
		await submitForm(blocks, "coupons:save", { ...formInitialValues(blocks, "coupons:save") });
		const after = state.coupons.find((c) => c.id === "c-welcome");
		expect(after?.startsAt).toBe(before.startsAt);
		expect(after?.expiresAt).toBe(before.expiresAt);
	});

	test("a CHANGED expiry day closes at the END of that day, so the domain's exclusive end bound does not retire the code a day early", async () => {
		const state = makeWelcomeState();
		await boot(state);
		const blocks = await openCoupon("WELCOME10");
		// THE SUBMITTED DAYS ARE RELATIVE TO THE RENDER CLOCK, for the same reason
		// the fixtures above are: `makeWelcomeState` expires at `ahead(30 days)`,
		// and a hard-coded day eventually IS that day — at which point
		// `resolveBound` correctly reads "unchanged, keep the stored instant" and
		// this test, whose whole subject is a CHANGE, no longer describes one. It
		// FAILS LOUDLY when that happens rather than passing vacuously: it fired
		// on 2026-08-01, when `2026-08-31` became now + 30 days, and took the
		// suite red on `main`. A 90/120-day offset cannot collide with ±30.
		const newStart = dayAhead(90 * DAY_MS);
		const newExpiry = dayAhead(120 * DAY_MS);
		await submitForm(blocks, "coupons:save", {
			...formInitialValues(blocks, "coupons:save"),
			startsAt: newStart,
			expiresAt: newExpiry,
		});
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put!.body).toMatchObject({
			startsAt: `${newStart}T00:00:00.000Z`, // a start OPENS its day
			expiresAt: `${newExpiry}T23:59:59.999Z`, // an expiry CLOSES its day
		});
		// A one-day coupon is now expressible: same day, start < expiry.
		const sameDay = await submitForm(blocks, "coupons:save", {
			...formInitialValues(blocks, "coupons:save"),
			startsAt: newStart,
			expiresAt: newStart,
		});
		expect(bannerOf(sameDay)?.variant).toBe("default");
	});

	// -- carried context is untrusted input --------------------------------------

	test("a fixed_amount coupon holding a STRAY cap still saves, and the save hard-nulls it — the carrier never carries a field the form does not render", async () => {
		const state = makeStrayCapState();
		await boot(state);
		const blocks = await openCoupon("STRAY5");
		// The cap has no field here — `cap` is percentage-only on this form...
		const byId = new Map(formFields(blocks, "coupons:save").map((f) => [String(f.action_id), f]));
		expect(byId.has("cap")).toBe(false);
		// ...so it must not ride in the carrier either. Carrying it would feed the
		// cross-type check a cap the operator cannot see, and EVERY save of this
		// coupon would be refused naming a field that is not on screen — with no
		// way out from the console.
		const carried = decodeCarrier(formFor(blocks, "coupons:save")!.block_id as string);
		expect(carried?.curCap).toBeUndefined();

		const outcome = await submitForm(
			blocks,
			"coupons:save",
			formInitialValues(blocks, "coupons:save"),
		);
		expect(bannerOf(outcome)?.variant).toBe("default");
		const put = stub!.requests.find((r) => r.method === "PUT");
		expect(put).toBeDefined();
		// The stray value is hard-nulled, exactly as it was before the carrier
		// existed: the inactive type's economics are inapplicable by construction.
		expect(put!.body).toMatchObject({ amountCents: 500, rateBps: null, capCents: null });
		expect(state.coupons.find((c) => c.id === "c-stray")?.capCents).toBeNull();
	});

	test("a TAMPERED carried instant is refused as a current value, not trusted into the record — `2026-02-30` parses, and would sort after every real February day", async () => {
		const state = makeWelcomeState();
		const before = { ...state.coupons[0]! };
		await boot(state);
		const blocks = await openCoupon("WELCOME10");
		const form = formFor(blocks, "coupons:save")!;
		const real = decodeCarrier(form.block_id as string)!;
		// A carrier is a DOM attribute: an operator can rewrite it. Only a string
		// that survives `parse → toISOString` unchanged is a real instant.
		for (const bogus of ["2026-02-30T00:00:00.000Z", "not-a-date", "2026-09-01"]) {
			const tampered = encodeCarrier("coupons:edit", {
				couponId: real.couponId!,
				code: real.code!,
				type: real.type!,
				curExpiresAt: bogus,
			});
			const outcome = blocksOf(
				await sandbox!.invokeRoute("admin", {
					type: "form_submit",
					action_id: "coupons:save",
					// The expiry field itself is NOT submitted, so the carried value is
					// the only thing that could reach the record.
					values: { ratePercent: "10.00", showLimits: false },
					block_id: tampered,
				}),
			);
			// Always a rendered outcome, never a throw (G5).
			expect(bannerOf(outcome)).toBeDefined();
			// The bogus instant never lands: an untrusted current reads as "no
			// current value", so the absent field clears rather than storing junk.
			expect(state.coupons.find((c) => c.id === "c-welcome")?.expiresAt).not.toBe(bogus);
		}
		expect(before.expiresAt).toBeDefined();
	});

	test("a submitted day that does not exist is REFUSED, not rolled forward — `2027-02-30` parses and would silently store as 2 March", async () => {
		const state = makeWelcomeState();
		const before = { ...state.coupons[0]! };
		await boot(state);
		const blocks = await openCoupon("WELCOME10");
		// `startsAt` is cleared so the start-before-expiry check CANNOT fire: this
		// must fail on the day being unreal, and on nothing else. (Pinned by
		// asserting the message, not just the field name — the two refusals for
		// this field read very differently.)
		const outcome = await submitForm(blocks, "coupons:save", {
			...formInitialValues(blocks, "coupons:save"),
			startsAt: "",
			expiresAt: "2027-02-30",
		});
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
		const banner = bannerOf(outcome);
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).toContain("Expires at must be a date like");
		expect(state.coupons.find((c) => c.id === "c-welcome")?.expiresAt).toBe(before.expiresAt);

		// The same hole on the START edge, which resolves to a different instant.
		const startOutcome = await submitForm(blocks, "coupons:save", {
			...formInitialValues(blocks, "coupons:save"),
			startsAt: "2027-04-31",
			expiresAt: "",
		});
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
		expect(String(bannerOf(startOutcome)?.description)).toContain("Starts at must be a date like");
	});

	test("a date field submitted as a NON-STRING is refused with a banner, never read as a silent 'unchanged'", async () => {
		const state = makeWelcomeState();
		await boot(state);
		const blocks = await openCoupon("WELCOME10");
		const outcome = await submitForm(blocks, "coupons:save", {
			...formInitialValues(blocks, "coupons:save"),
			expiresAt: null,
		});
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
		expect(bannerOf(outcome)?.variant).toBe("error");
		expect(String(bannerOf(outcome)?.description)).toContain("Expires at");
	});

	test("a BLANK arriving from a bound the operator never revealed is not a clear — it closes the 'renderer empties hidden fields' mutation", async () => {
		const state = makeWelcomeState();
		const before = { ...state.coupons[0]! };
		await boot(state);
		const blocks = await openCoupon("WELCOME10");
		// A renderer that cleared `condition`-hidden fields to "" instead of
		// dropping them would slip past the absent-key fallback. The disclosure
		// flag is what tells the two apart: the operator never opened it, so no
		// blank from behind it can be an instruction.
		await submitForm(blocks, "coupons:save", {
			ratePercent: "10.00",
			startsAt: before.startsAt!.slice(0, 10),
			expiresAt: before.expiresAt!.slice(0, 10),
			showLimits: false,
			cap: "",
			minSubtotal: "",
			maxUses: "",
			maxUsesPerCustomer: "",
		});
		const after = state.coupons.find((c) => c.id === "c-welcome");
		expect(after?.capCents).toBe(before.capCents);
		expect(after?.minSubtotalCents).toBe(before.minSubtotalCents);
		expect(after?.maxUses).toBe(before.maxUses);
		expect(after?.maxUsesPerCustomer).toBe(before.maxUsesPerCustomer);
	});

	test("X-31 HEADROOM: an exception coupon whose save fails carries BOTH the notice and the lifecycle banner — exactly the top-level budget, not over it", async () => {
		await boot(makeStatusCoupons());
		const blocks = await openCoupon("EXPIRED20");
		expect(topLevelBanners(blocks)).toHaveLength(1); // the lifecycle mark alone
		// A refused save adds the notice beside it — the screen's worst case.
		const outcome = await submitForm(blocks, "coupons:save", {
			...formInitialValues(blocks, "coupons:save"),
			ratePercent: "",
		});
		const banners = topLevelBanners(outcome);
		expect(banners).toHaveLength(2);
		expect(banners.map((b) => b.variant)).toEqual(["error", "alert"]);
		assertBlockContract(outcome, { screen: "coupons", level: "detail" });
	});

	// -- P0-CLASS CHECK (PM §E3) ------------------------------------------------
	// The failure this guards against: a form field that renders the coupon's
	// CURRENT value as a `placeholder` (grey ghost text the browser submits as
	// "") instead of an `initial_value` (a real value the browser submits back).
	// On a FULL-REPLACE wire that is silent data loss — the operator opens a
	// coupon to read it, presses Save, and the values they could see on screen
	// are written back as null.
	test("P0 (PM §E3): on a coupon with EVERY optional value set, each one renders as a real `initial_value` — never as a placeholder standing in for a set value", async () => {
		const state = makeWelcomeState();
		const before = { ...state.coupons[0]! };
		await boot(state);
		const blocks = await openCoupon("WELCOME10");
		const byId = new Map(formFields(blocks, "coupons:save").map((f) => [String(f.action_id), f]));
		// THIS LOOP IS NOT REDUNDANT WITH THE ROUND-TRIP TEST BELOW. That one
		// submits whatever the form prefilled and checks the record came back
		// unchanged — which is structurally blind to the placeholder hazard: a
		// value living in `placeholder` instead of `initial_value` is simply
		// absent from what the renderer posts, and an absent key now reads as
		// "unchanged" by design. The record would survive and the operator would
		// still be looking at ghost text. Only naming each field's
		// `initial_value` explicitly can catch it, so every set value gets a line
		// here — the window bounds included, as the DAY strings they render as.
		for (const [actionId, expected] of [
			["ratePercent", "10.00"],
			["cap", "20.00"],
			["minSubtotal", "50.00"],
			["maxUses", "500"],
			["maxUsesPerCustomer", "2"],
			["startsAt", before.startsAt!.slice(0, 10)],
			["expiresAt", before.expiresAt!.slice(0, 10)],
		] as const) {
			const field = byId.get(actionId);
			expect(field, `no field ${actionId}`).toBeDefined();
			expect(field?.initial_value, `${actionId} must carry its CURRENT value`).toBe(expected);
		}
		// A placeholder may only ever be a FORMAT EXAMPLE, never a set value
		// wearing ghost text: no field's placeholder may equal its own value.
		for (const field of byId.values()) {
			if (field.placeholder === undefined) continue;
			expect(String(field.placeholder)).not.toBe(String(field.initial_value ?? ""));
		}
	});

	test("P0 (PM §E3): submitting the untouched pre-fill of an all-values-set coupon persists EVERY value unchanged — nothing is silently unset", async () => {
		const state = makeWelcomeState();
		const before = { ...state.coupons[0]! };
		await boot(state);
		const blocks = await openCoupon("WELCOME10");
		// Exactly what the renderer submits for an untouched form: every field's
		// `initial_value`, and nothing for a field that has none
		// (`blocks/form.tsx`'s `getInitialValues`, verified in 0.31.1).
		await submitForm(blocks, "coupons:save", formInitialValues(blocks, "coupons:save"));
		const after = state.coupons.find((c) => c.id === "c-welcome");
		expect(after?.rateBps).toBe(before.rateBps);
		expect(after?.capCents).toBe(before.capCents);
		expect(after?.minSubtotalCents).toBe(before.minSubtotalCents);
		expect(after?.startsAt).toBe(before.startsAt);
		expect(after?.expiresAt).toBe(before.expiresAt);
		expect(after?.maxUses).toBe(before.maxUses);
		expect(after?.maxUsesPerCustomer).toBe(before.maxUsesPerCustomer);
	});

	// Every H-marked §13 anti-pattern this helper enforces (§15 V-3/V-3a) — one
	// call on the list (unfiltered non-empty, filtered, and true-zero) and one
	// per open record state, covering both coupon families and both the
	// deletable and the redeemed (delete-withheld) shapes.
	test("assertBlockContract holds on the list (populated, filtered, true-zero) and on every open record state (§15 V-3)", async () => {
		const state = makeCouponsState();
		await boot(state);
		assertBlockContract(
			blocksOf(await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" })),
			{ screen: "coupons", level: "list" },
		);
		assertBlockContract(
			blocksOf(
				await sandbox!.invokeRoute("admin", {
					type: "form_submit",
					action_id: "coupons:apply-filter",
					values: { search: "fiveoff" },
				}),
			),
			{ screen: "coupons", level: "list" },
		);
		// INC-14's two new list-level renders: the create screen, and the create
		// screen after a refusal (a banner plus a form full of prefilled values).
		const createScreen = await openNewCouponScreen();
		assertBlockContract(createScreen, { screen: "coupons", level: "list" });
		assertBlockContract(
			await submitForm(createScreen, "coupons:create", {
				id: "",
				code: "",
				type: "percentage",
				ratePercent: "nope",
				cap: "1.00",
			}),
			{ screen: "coupons", level: "list" },
		);
		// These detail sweeps now carry INC-13's rule too: X-13 absorbed the
		// standalone `assertNoRawTimestamps` in INC-10, and this screen — the one
		// that used to render `Created (UTC)` as a raw instant, and the reason the
		// rule shipped as a separate export at all — is the last one wired in.
		assertBlockContract(await openCoupon("FIVEOFF"), { screen: "coupons", level: "detail" }); // fixed_amount, deletable
		assertBlockContract(await openCoupon("SUMMER25"), { screen: "coupons", level: "detail" }); // percentage, redeemed (delete withheld)

		await sandbox!.close();
		await stub!.close();
		// The lifecycle-marked shapes: an exception detail carries a SECOND
		// top-level banner beside any notice, and the leaf whose optional values
		// are all set draws every field the edit group has.
		await boot(makeStatusCoupons());
		for (const code of ["EXPIRED20", "LAUNCH2026", "MAXEDOUT"]) {
			assertBlockContract(await openCoupon(code), { screen: "coupons", level: "detail" });
		}
		await sandbox!.close();
		await stub!.close();
		await boot(makeWelcomeState());
		assertBlockContract(await openCoupon("WELCOME10"), { screen: "coupons", level: "detail" });

		await sandbox!.close();
		await stub!.close();
		await boot({ coupons: [] });
		assertBlockContract(
			blocksOf(await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" })),
			{ screen: "coupons", level: "list" },
		); // true-zero, unfiltered — the `empty` branch
	});
});
