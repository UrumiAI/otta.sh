import { afterEach, describe, expect, test } from "vitest";
import { decodePath, encodePath } from "../src/admin/scaffold/index.js";
import {
	type RecordedRequest,
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

// The admin Coupons console under the REAL workerd-on-Node sandbox (admin-UX
// Increment 3, slice 4 — "coupon management"): a keyset-paged coupons list
// (search = case-insensitive EXACT code match) drilling into a per-coupon
// detail/edit leaf. Create; LWW FULL-REPLACE edit (the wire has no partial
// update: every editable field is submitted on every save, pre-filled with
// the current value, so "leave unchanged" = "don't touch the pre-fill" and
// "clear" = "blank the field" — asserted explicitly below); delete with the
// forbid-if-redeemed audit-trail conflict rendered honestly. Money is integer
// minor units via the shared money-input helper; percentage rates are integer
// basis points via the Tax console's exact-integer percent parser.

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

interface Blk extends Record<string, unknown> {
	type: string;
}
function blocksOf(outcome: unknown): Blk[] {
	if (!(typeof outcome === "object" && outcome !== null && "result" in outcome)) return [];
	const result = (outcome as { result: { blocks?: Blk[] } }).result;
	return result.blocks ?? [];
}
function tableOf(blocks: Blk[]) {
	return blocks.find((b) => b.type === "table") as
		| { rows?: Array<Record<string, unknown>>; next_cursor?: string; empty_text?: string }
		| undefined;
}
function tableRows(blocks: Blk[]): Array<Record<string, unknown>> {
	return tableOf(blocks)?.rows ?? [];
}
function bannerOf(blocks: Blk[]) {
	return blocks.find((b) => b.type === "banner") as
		| { variant?: string; title?: string; description?: string }
		| undefined;
}
function formFields(blocks: Blk[], submitActionId: string): Array<Record<string, unknown>> {
	const form = blocks.find(
		(b) => b.type === "form" && (b.submit as { action_id?: string })?.action_id === submitActionId,
	);
	return (form?.fields ?? []) as Array<Record<string, unknown>>;
}
function detailFields(blocks: Blk[]): Map<string, string> {
	const fields = blocks.find((b) => b.type === "fields") as
		| { fields?: Array<{ label: string; value: string }> }
		| undefined;
	return new Map((fields?.fields ?? []).map((f) => [f.label, f.value]));
}
function actionButtons(blocks: Blk[]): Array<Record<string, unknown>> {
	return blocks
		.filter((b) => b.type === "actions")
		.flatMap((b) => (b.elements as Array<Record<string, unknown>>) ?? []);
}
/** The open form's `target` select options — asserted to decode to a real
 *  NavPath rather than trusting a hand-encoded guess. */
function openTargetOptions(blocks: Blk[]): Array<{ value: string; label: string }> {
	const fields = formFields(blocks, "coupons:open");
	const targetField = fields.find((f) => f.action_id === "target");
	return (targetField?.options as Array<{ value: string; label: string }> | undefined) ?? [];
}
function headerTexts(blocks: Blk[]): string[] {
	return blocks.filter((b) => b.type === "header").map((b) => String(b.text));
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

/** The full edit-form value set for FIVEOFF exactly as its pre-fill renders
 *  it (the "untouched form" baseline of the unchanged-vs-clear tests). */
const FIVEOFF_PREFILL = {
	couponId: "c-five",
	code: "FIVEOFF",
	type: "fixed_amount",
	amount: "5.00",
	minSubtotal: "35.00",
	startsAt: "2026-07-01T00:00:00.000Z",
	expiresAt: "",
	maxUses: "",
	maxUsesPerCustomer: "",
};

describe("admin Coupons console — list level (workerd sandbox)", () => {
	test("page_load /coupons renders the list newest-first with honest discount/window/uses columns and forwards the kv-sourced admin token", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" });
		const blocks = blocksOf(outcome);
		expect(headerTexts(blocks)).toContain("Coupons");
		const listReq = stub!.requests.find((r) => r.url.startsWith("/admin/coupons"));
		expect(listReq?.headers["x-internal-token"]).toBe("admin-token-xyz");
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

	test("NO-TOKEN page_load /coupons fails closed with a GENERIC banner (no raw HTTP status/URL)", async () => {
		const state = makeCouponsState();
		await boot(state, "");
		const outcome = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" });
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|\/admin\/coupons|401/);
	});

	test("apply-filter searches by EXACT code, case-insensitively, and keeps the entered value in the filter form", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:apply-filter",
			values: { search: "fiveoff" },
		});
		const req = stub!.requests.find((r) => r.url.startsWith("/admin/coupons"));
		expect(req?.url).toContain("search=fiveoff");
		const blocks = blocksOf(outcome);
		expect(tableRows(blocks).map((r) => r.code)).toEqual(["FIVEOFF"]);
		const filterField = formFields(blocks, "coupons:apply-filter").find(
			(f) => f.action_id === "search",
		);
		expect(filterField?.initial_value).toBe("fiveoff");
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

	test("create (fixed_amount) POSTs EXACT integer minor units with every unset axis an explicit null, then re-lists with a success notice", async () => {
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
				ratePercent: "",
				cap: "",
				minSubtotal: "",
				startsAt: "",
				expiresAt: "",
				maxUses: "",
				maxUsesPerCustomer: "",
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

	test("create (percentage) POSTs exact basis points + cap, and NORMALIZES the window to ISO-8601 UTC (the domain compares date strings lexicographically)", async () => {
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
				minSubtotal: "50.00",
				startsAt: "2026-08-01",
				expiresAt: "2026-09-01T00:00:00Z",
				maxUses: "50",
				maxUsesPerCustomer: "2",
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
			minSubtotalCents: 5000,
			startsAt: "2026-08-01T00:00:00.000Z",
			expiresAt: "2026-09-01T00:00:00.000Z",
			maxUses: 50,
			maxUsesPerCustomer: 2,
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
				values: {
					id: "c-bad",
					code: "BAD",
					type: "fixed_amount",
					ratePercent: "",
					cap: "",
					minSubtotal: "",
					startsAt: "",
					expiresAt: "",
					maxUses: "",
					maxUsesPerCustomer: "",
					...overrides,
				},
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
					cap: "",
					minSubtotal: "",
					startsAt: "",
					expiresAt: "",
					maxUses: "",
					maxUsesPerCustomer: "",
				},
			});
			expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
			expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
		},
	);

	test("CROSS-TYPE honesty: filling a percentage-only field on a fixed_amount create (and vice versa) is an explicit error, never silently dropped", async () => {
		const state = makeCouponsState();
		await boot(state);
		const shared = {
			minSubtotal: "",
			startsAt: "",
			expiresAt: "",
			maxUses: "",
			maxUsesPerCustomer: "",
		};
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
				...shared,
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
				...shared,
			},
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(pctWithAmount))?.variant).toBe("error");
	});

	test("an expiry at-or-before the start is caught at the plugin boundary — no POST sent", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:create",
			values: {
				id: "c-w",
				code: "W1",
				type: "percentage",
				amount: "",
				currency: "",
				ratePercent: "10",
				cap: "",
				minSubtotal: "",
				startsAt: "2026-09-01T00:00:00Z",
				expiresAt: "2026-08-01T00:00:00Z",
				maxUses: "",
				maxUsesPerCustomer: "",
			},
		});
		expect(stub!.requests.some((r) => r.method === "POST")).toBe(false);
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("error");
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
				ratePercent: "",
				cap: "",
				minSubtotal: "",
				startsAt: "",
				expiresAt: "",
				maxUses: "",
				maxUsesPerCustomer: "",
			},
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.description)).not.toMatch(/HTTP \d|500/);
		expect(state.coupons.filter((c) => c.code === "FIVEOFF")).toHaveLength(1);
	});
});

describe("admin Coupons console — detail/edit leaf (workerd sandbox)", () => {
	test("opening a coupon drills to its detail via the open form's OWN encoded target, loading the FULL summary (incl. the window)", async () => {
		const state = makeCouponsState();
		await boot(state);
		const list = await sandbox!.invokeRoute("admin", { type: "page_load", page: "/coupons" });
		const option = openTargetOptions(blocksOf(list)).find(
			(o) => decodePath(o.value)?.[0] === "FIVEOFF",
		);
		expect(option).toBeDefined();
		stub!.requests.length = 0;

		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:open",
			values: { target: option!.value },
		});
		// The detail load is the exact-search list read — the only read that
		// carries startsAt/expiresAt (GET /admin/coupons/:code omits them, and
		// the full-replace edit form MUST pre-fill the window or saving would
		// silently clear it).
		const loadReq = stub!.requests.find((r) => r.url.startsWith("/admin/coupons?"));
		expect(loadReq?.url).toContain("search=FIVEOFF");
		const blocks = blocksOf(outcome);
		expect(headerTexts(blocks)).toContain("Coupon — FIVEOFF");
		const fields = detailFields(blocks);
		expect(fields.get("ID")).toBe("c-five");
		expect(fields.get("Type")).toBe("fixed_amount");
		expect(fields.get("Discount")).toBe("$5.00 off");
		expect(fields.get("Uses")).toBe("0 / ∞");
		expect(actionButtons(blocks).some((e) => e.action_id === "coupons:back")).toBe(true);
	});

	test("the edit form pre-fills EVERY editable field with the current value (unset ⇒ blank), so an untouched save cannot clear anything", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:open",
			values: { target: encodePath(["FIVEOFF"]) },
		});
		const fields = formFields(blocksOf(outcome), "coupons:save");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		expect(byId.get("couponId")?.initial_value).toBe("c-five");
		expect(byId.get("code")?.initial_value).toBe("FIVEOFF");
		expect(byId.get("type")?.initial_value).toBe("fixed_amount");
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
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:save",
			values: { ...FIVEOFF_PREFILL },
		});
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
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("default");
		expect(String(banner?.title)).toContain("saved");
		const coupon = state.coupons.find((c) => c.id === "c-five");
		expect(coupon?.minSubtotalCents).toBe(3500); // unchanged
		expect(coupon?.startsAt).toBe("2026-07-01T00:00:00.000Z"); // unchanged
	});

	test("CLEAR semantics: blanking a pre-filled field saves it as an explicit null, and the reloaded detail shows it cleared", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:save",
			values: { ...FIVEOFF_PREFILL, minSubtotal: "", startsAt: "" },
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
		const fields = formFields(blocksOf(outcome), "coupons:save");
		const byId = new Map(fields.map((f) => [f.action_id, f]));
		expect(byId.get("minSubtotal")?.initial_value).toBeUndefined();
		expect(bannerOf(blocksOf(outcome))?.variant).toBe("default");
	});

	test("a fixed_amount coupon cannot blank its amount — the one axis with no 'unset' (the domain requires it); no PUT sent", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:save",
			values: { ...FIVEOFF_PREFILL, amount: "" },
		});
		expect(stub!.requests.some((r) => r.method === "PUT")).toBe(false);
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		// still on the detail (the merchant's context is preserved)
		expect(headerTexts(blocksOf(outcome))).toContain("Coupon — FIVEOFF");
	});

	test("saving a coupon that no longer exists renders an honest not-found notice", async () => {
		const state = makeCouponsState();
		await boot(state);
		const outcome = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:save",
			values: { ...FIVEOFF_PREFILL, couponId: "c-gone", code: "GONE" },
		});
		const banner = bannerOf(blocksOf(outcome));
		expect(banner?.variant).toBe("error");
		expect(String(banner?.title)).toMatch(/not found/i);
	});

	test("an unredeemed coupon's detail offers delete with audit-trail danger copy; a REDEEMED coupon's detail withholds it honestly", async () => {
		const state = makeCouponsState();
		await boot(state);
		const deletable = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:open",
			values: { target: encodePath(["FIVEOFF"]) },
		});
		const deleteButton = actionButtons(blocksOf(deletable)).find(
			(e) => e.action_id === "coupons:delete",
		);
		expect(deleteButton).toBeDefined();
		const confirm = deleteButton!.confirm as { text?: string; style?: string };
		expect(confirm.style).toBe("danger");
		expect(String(confirm.text)).toMatch(/redeemed/i);
		expect(String(confirm.text)).toMatch(/audit trail/i);

		const redeemed = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:open",
			values: { target: encodePath(["SUMMER25"]) },
		});
		const redeemedBlocks = blocksOf(redeemed);
		expect(actionButtons(redeemedBlocks).some((e) => e.action_id === "coupons:delete")).toBe(false);
		const blockedNote = redeemedBlocks.find(
			(b) => b.type === "context" && /audit trail/i.test(String(b.text)),
		);
		expect(blockedNote).toBeDefined();
	});

	test("deleting an unredeemed coupon DELETEs, returns to the list with a 'deleted' notice; a repeat delete is an idempotent no-op", async () => {
		const state = makeCouponsState();
		await boot(state);
		const first = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "coupons:delete",
			value: { couponId: "c-five", code: "FIVEOFF" },
		});
		const del = stub!.requests.find((r) => r.method === "DELETE");
		expect(del?.url).toBe("/admin/coupons/c-five");
		const firstBlocks = blocksOf(first);
		expect(headerTexts(firstBlocks)).toContain("Coupons"); // back on the list
		const firstBanner = bannerOf(firstBlocks);
		expect(firstBanner?.variant).toBe("default");
		expect(String(firstBanner?.title)).toContain("deleted");
		expect(tableRows(firstBlocks).some((r) => r.code === "FIVEOFF")).toBe(false);

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
		const detail = await sandbox!.invokeRoute("admin", {
			type: "form_submit",
			action_id: "coupons:open",
			values: { target: encodePath(["FIVEOFF"]) },
		});
		const backValue = actionButtons(blocksOf(detail)).find((e) => e.action_id === "coupons:back")
			?.value as Record<string, string> | undefined;
		const back = await sandbox!.invokeRoute("admin", {
			type: "block_action",
			action_id: "coupons:back",
			value: backValue,
		});
		expect(headerTexts(blocksOf(back))).toContain("Coupons");
	});
});
