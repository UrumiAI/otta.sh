/**
 * The fail-closed promise of the four rules-backed admin screens — Coupons,
 * Reports, Shipping and Tax — checked on `page_load`, the interaction an
 * operator reaches them by.
 *
 * WHY THIS NEEDS ITS OWN NON-SANDBOX FILE. Each screen used to be covered by a
 * "NO-TOKEN page_load" case in its sandbox suite: the case withheld the kv admin
 * token, the stub service answered 401, and the screen's `onError` arm rendered
 * the banner. INC-D3a deleted the tokens and the service with them, so that
 * input can no longer be expressed — and the workerd harness always injects a
 * WORKING document store, so the sandbox tier can no longer induce a failed read
 * at all. Those cases were deleted, and the copy they pinned promptly went stale
 * unnoticed (it still told operators to check a service connection and a
 * Settings field this increment removes). This file restores the coverage at the
 * tier that can still produce the input: a context whose document store is
 * present (so the in-process composition constructs) but whose every read
 * rejects.
 *
 * IT ASSERTS THE COPY, not just the shape. The banner is the only thing an
 * operator gets from this path, so the exact description is the contract — and
 * each case additionally pins the ABSENCE of the retired "check the service
 * connection / the admin token in Settings" instruction, so a revert of that
 * copy fails here rather than shipping.
 *
 * Structure and the storeless-context idea are borrowed from
 * `reports-page-construction-failure.test.ts`, which covers the neighbouring
 * failure (a throw at CONSTRUCTION, before any read).
 */

import { describe, expect, test } from "vitest";
import { createCouponsPageHandler } from "../src/admin/coupons-page.js";
import { createReportsPageHandler } from "../src/admin/reports-page.js";
import { createShippingPageHandler } from "../src/admin/shipping-page.js";
import { createTaxPageHandler } from "../src/admin/tax-page.js";
import type {
	BannerBlock,
	BlockResponse,
	PluginContext,
	RouteHandler,
	StorageAccess,
	StorageCollection,
} from "../src/types.js";

const READ_FAILED = "storage is unreachable";

/** Every collection the adapters ask for, answering every method with the same
 *  rejection. A Proxy rather than a fixture map on purpose: the set of
 *  collections is the adapters' business, and a test that enumerated them would
 *  start passing for the wrong reason the day one is added. */
function makeFailingStorage(): StorageAccess {
	const collection = new Proxy(
		{},
		{
			get() {
				return () => Promise.reject(new Error(READ_FAILED));
			},
		},
	) as StorageCollection;
	return new Proxy({} as StorageAccess, { get: () => collection });
}

/**
 * A context whose document store is PRESENT — so `makeAdminClients` constructs
 * every adapter without complaint — and whose reads all fail. `http.fetch`
 * refuses outright: there is no service left to reach, and a screen that somehow
 * reached egress would fail here rather than pass quietly.
 */
function makeFailingReadCtx(): PluginContext {
	const kv = new Map<string, unknown>([["settings:storeDisplayName", "Acme"]]);
	return {
		http: {
			fetch(): Promise<Response> {
				throw new Error("the in-process branch must not reach ctx.http");
			},
		},
		kv: {
			async get<T>(k: string): Promise<T | null> {
				return kv.has(k) ? (kv.get(k) as T) : null;
			},
			async set(k: string, v: unknown): Promise<void> {
				kv.set(k, v);
			},
			async delete(k: string): Promise<boolean> {
				return kv.delete(k);
			},
			async list(): Promise<Array<{ key: string; value: unknown }>> {
				return [...kv].map(([key, value]) => ({ key, value }));
			},
		},
		storage: makeFailingStorage(),
	};
}

/** Every screen here is a `RouteHandler` over its OWN input type, and the
 *  four types have nothing in common — a bare `page_load` carries no action and
 *  no target, so the cases are driven through this widened shape rather than
 *  four near-identical blocks. */
type PageLoadHandler = RouteHandler<Record<string, unknown>>;

/** A bare `page_load`: no action, no target — the root level of the screen, the
 *  shape em-dash's admin shell sends when the operator opens the page. */
async function pageLoad(handler: PageLoadHandler): Promise<BlockResponse> {
	return (await handler(
		{ input: {}, request: { method: "POST", url: "/admin", headers: {} } },
		makeFailingReadCtx(),
	)) as BlockResponse;
}

function bannerOf(res: BlockResponse): BannerBlock | undefined {
	return res.blocks.find((b): b is BannerBlock => b.type === "banner");
}

/** The retired instruction, in every spelling the deleted copy used. Asserting
 *  its ABSENCE is what makes these cases fail against the pre-fix strings. */
const RETIRED_REMEDY_RE = /service connection|admin token|service token|in Settings/i;

interface FailClosedCase {
	screen: string;
	handler: () => PageLoadHandler;
	header: string;
	title: string;
	description: string;
	toast: string;
}

const CASES: readonly FailClosedCase[] = [
	{
		screen: "/coupons",
		handler: () => createCouponsPageHandler() as unknown as PageLoadHandler,
		header: "Coupons",
		title: "Coupons are unavailable",
		description:
			"Coupons could not be loaded. Retry in a moment; if it keeps failing, this is a fault in the console itself — not your data.",
		toast: "Could not load coupons",
	},
	{
		screen: "/reports",
		handler: () => createReportsPageHandler() as unknown as PageLoadHandler,
		header: "Acme — Reports",
		title: "Reports are unavailable",
		description:
			"Reports could not be loaded. Retry in a moment; if it keeps failing, this is a fault in the console itself — not your data.",
		toast: "Could not load reports",
	},
	{
		screen: "/shipping",
		handler: () => createShippingPageHandler() as unknown as PageLoadHandler,
		header: "Shipping zones",
		title: "Shipping zones are unavailable",
		description:
			"Shipping zones could not be loaded. Retry in a moment; if it keeps failing, this is a fault in the console itself — not your data.",
		toast: "Could not load shipping zones",
	},
	{
		screen: "/tax",
		handler: () => createTaxPageHandler() as unknown as PageLoadHandler,
		header: "Tax classes",
		title: "Tax classes are unavailable",
		description:
			"Tax classes could not be loaded. Retry in a moment; if it keeps failing, this is a fault in the console itself — not your data.",
		toast: "Could not load tax classes",
	},
];

describe.each(CASES)("page_load $screen with every read failing", (c) => {
	test("fails CLOSED with E-7's banner rather than escaping into the host", async () => {
		const res = await pageLoad(c.handler());

		expect(res.blocks[0]).toEqual({ type: "header", text: c.header });
		expect(bannerOf(res)).toEqual({
			type: "banner",
			variant: "error",
			title: c.title,
			description: c.description,
		});
		expect(res.toast).toEqual({ message: c.toast, type: "error" });
	});

	test("the banner neither leaks the failure's own message nor names the retired remedy", async () => {
		// Two regressions in one: E-7 forbids a raw status/URL/adapter message
		// reaching the UI, and INC-D3a retired the service connection, the admin
		// token and the Settings group they lived in — copy that names any of them
		// sends an operator to a screen that no longer has the field.
		const rendered = JSON.stringify(await pageLoad(c.handler()));
		expect(rendered).not.toContain(READ_FAILED);
		expect(rendered).not.toMatch(RETIRED_REMEDY_RE);
	});
});
