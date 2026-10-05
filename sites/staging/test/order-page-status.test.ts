/**
 * `/orders/<id>` answers with the status its copy states (issue #381).
 *
 * The page used to set 404 for EVERY failed read — so a storage or render fault
 * (`RENDER_FAILED`) came back as "404" while the page said "Something went wrong",
 * telling a crawler, a proxy and monitoring that a live order's address names
 * nothing. Only a genuine not-found is a 404 now; a fault is a 503, and BUSY keeps
 * #338's 503 + `Retry-After`.
 *
 * The decision is `orderReadOutcome` (pure, in `lib/order-view.ts`, because
 * `.astro` has no render harness here — issue #40); the source pins below keep
 * the page wired to it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { OrderRouteResult } from "@otta-sh/plugin";
import { describe, expect, test } from "vitest";
import { cartErrorMessage } from "../src/lib/error-messages.js";
import { orderReadOutcome } from "../src/lib/order-view.js";
import { BUSY_RETRY_AFTER_SECONDS, markBusy } from "../src/lib/otta-api.js";
import { splitAstro } from "./astro-source.js";
import { SRC } from "./theme-views.js";

const page = readFileSync(path.join(SRC, "pages/orders/[orderId].astro"), "utf8");
const frontmatter = splitAstro(page).frontmatter;

const FOUND = { ok: true, order: { id: "ord-1" } } as unknown as OrderRouteResult;
const NOT_FOUND: OrderRouteResult = { ok: false, reason: "ORDER_NOT_FOUND" };
const INVALID: OrderRouteResult = { ok: false, error: "INVALID_INPUT" };
const RENDER_FAILED: OrderRouteResult = { ok: false, error: "RENDER_FAILED" };
const BUSY_RESULT: OrderRouteResult = { ok: false, error: "BUSY", retryable: true };

describe("orderReadOutcome — the order page's status and failure copy", () => {
	test("a found order is a 200 with no failure copy", () => {
		expect(orderReadOutcome(FOUND)).toEqual({ status: 200, failure: null });
	});

	test("an unknown order is a 404 that says 'not found'", () => {
		expect(orderReadOutcome(NOT_FOUND)).toEqual({ status: 404, failure: "ORDER_NOT_FOUND" });
	});

	test("a malformed call (INVALID_INPUT) is the same 404 — never 'something went wrong'", () => {
		// Not reachable from a URL today (the route answers ORDER_NOT_FOUND for any
		// string that cannot be an id), but if it ever arrives it names no order:
		// the same sentence as an unknown one, so the 404 leaks nothing either way.
		expect(orderReadOutcome(INVALID)).toEqual(orderReadOutcome(NOT_FOUND));
	});

	test("RENDER_FAILED (a storage or render fault) is a 503, not a 404", () => {
		expect(orderReadOutcome(RENDER_FAILED)).toEqual({
			status: 503,
			failure: "SERVICE_UNAVAILABLE",
		});
	});

	test("an unreachable plugin (dispatch answered nothing) is the same 503", () => {
		expect(orderReadOutcome(null)).toEqual(orderReadOutcome(RENDER_FAILED));
	});

	test("BUSY is still a 503 with the busy copy", () => {
		expect(orderReadOutcome(BUSY_RESULT)).toEqual({ status: 503, failure: "BUSY" });
	});

	test("the copy matches the status: a 404 never says 'unavailable', a 503 never says 'not found'", () => {
		const notFoundCopy = cartErrorMessage("ORDER_NOT_FOUND");
		for (const result of [NOT_FOUND, INVALID]) {
			const { status, failure } = orderReadOutcome(result);
			expect(status).toBe(404);
			expect(cartErrorMessage(failure ?? "")).toBe(notFoundCopy);
		}
		for (const result of [RENDER_FAILED, BUSY_RESULT, null]) {
			const { status, failure } = orderReadOutcome(result);
			expect(status).toBe(503);
			expect(cartErrorMessage(failure ?? "")).not.toBe(notFoundCopy);
			expect(cartErrorMessage(failure ?? "")).not.toMatch(/not be found/i);
		}
	});
});

describe("the order page is wired to it", () => {
	test("its status and failure copy come from orderReadOutcome — no 404-for-any-failure of its own", () => {
		expect(frontmatter).toContain("orderReadOutcome(result)");
		expect(frontmatter).toMatch(/Astro\.response\.status = outcome\.status/);
		expect(frontmatter).toMatch(/failureMessage:[^,]*outcome\.failure/);
		// The pre-#381 rule: any `!result.ok` became a 404.
		expect(frontmatter).not.toMatch(/!result\.ok \? 404/);
	});

	test("BUSY still adds Retry-After on top of the 503 (#338); a fault does not", () => {
		expect(frontmatter).toMatch(/if \(busy\) markBusy\(Astro\.response\)/);
		// markBusy is what carries the header — and only BUSY reaches it.
		const response = { status: 200, headers: new Headers() };
		markBusy(response);
		expect(response.status).toBe(503);
		expect(response.headers.get("Retry-After")).toBe(String(BUSY_RETRY_AFTER_SECONDS));
		// No header of the page's own: a fault does not get a retry time it cannot know.
		expect(frontmatter).not.toMatch(/headers\.set\(\s*"Retry-After"/);
	});
});
