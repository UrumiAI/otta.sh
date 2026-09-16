/**
 * The Reports page's fail-closed promise, checked at the one point that used to
 * escape it: a failure raised while the reporting SURFACE is being constructed,
 * before any read is attempted (work order 02, INC-B10c-ii, review round).
 *
 * WHY THIS NEEDS ITS OWN FILE RATHER THAN A CASE IN THE SANDBOX SUITE. The
 * failure is reachable only on the IN-PROCESS branch — `makeAdminClients` builds
 * every commerce adapter over `ctx.storage` there and throws by name when the
 * context has none — and the workerd harness always injects a document store, so
 * the sandbox suite cannot produce a context that lacks one. The http branch's
 * constructor cannot fail at all, which is precisely why the call sat OUTSIDE the
 * try until this round.
 *
 * TRANSITIONAL, like everything else that reads the mode flag: this file goes
 * with the http branch at INC-D3b, when the only remaining question is whether
 * the page catches a store failure, not which branch raised it.
 */

import { afterEach, describe, expect, test } from "vitest";
import { MISSING_STORAGE_MESSAGE } from "../src/commerce/in-process-commerce-stores.js";
import { createReportsPageHandler } from "../src/admin/reports-page.js";
import type { BlockResponse, PluginContext } from "../src/types.js";

/** The compile-time define the plugin reads through `resolveCommerceMode()`. A
 *  bundler injects it in a real build; under vitest the identifier resolves
 *  through the scope chain to `globalThis`, so setting it here is the same seam
 *  without a bundler in the loop. */
const MODE_GLOBAL = "__OTTA_COMMERCE_MODE__";

function setMode(mode: string | undefined): void {
	const g = globalThis as unknown as Record<string, unknown>;
	if (mode === undefined) delete g[MODE_GLOBAL];
	else g[MODE_GLOBAL] = mode;
}

afterEach(() => {
	setMode(undefined);
});

/**
 * A context with `http` and `kv` but NO document store — the shape the in-process
 * composition refuses. `http.fetch` refuses outright: if this page ever reached
 * egress on the in-process branch the case would fail rather than pass quietly.
 */
function makeStorelessCtx(): PluginContext {
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
	};
}

async function renderReports(ctx: PluginContext): Promise<BlockResponse> {
	const handler = createReportsPageHandler();
	return (await handler(
		{ input: {}, request: { method: "POST", url: "/admin", headers: {} } },
		ctx,
	)) as BlockResponse;
}

describe("Reports page — a construction-time in-process failure", () => {
	test("the storeless context really does make the surface throw at construction", async () => {
		// The premise of the case below: without it, a future change that made
		// construction lazy would leave the assertion passing for the wrong reason.
		setMode("in-process");
		const { makeAdminClients } = await import("../src/admin/make-admin-clients.js");
		await expect(makeAdminClients(makeStorelessCtx())).rejects.toThrow(MISSING_STORAGE_MESSAGE);
	});

	test("renders the E-7 fail-closed banner instead of escaping into the host", async () => {
		setMode("in-process");
		const res = await renderReports(makeStorelessCtx());

		expect(res.blocks[0]).toEqual({ type: "header", text: "Acme — Reports" });
		expect(res.blocks[1]).toMatchObject({
			type: "banner",
			variant: "error",
			title: "Reports are unavailable",
		});
		expect(res.toast).toEqual({ message: "Could not load reports", type: "error" });
	});

	test("the banner never leaks the construction failure's own message", async () => {
		// E-7's copy names no single cause on purpose, and the raw message names an
		// internal descriptor fix no operator can act on from this screen.
		setMode("in-process");
		const res = await renderReports(makeStorelessCtx());
		expect(JSON.stringify(res)).not.toContain("document store");
	});
});
