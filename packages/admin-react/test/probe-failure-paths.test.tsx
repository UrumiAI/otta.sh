/**
 * What the console shows when the commerce data path REFUSES.
 *
 * The happy path is covered end to end by Playwright (`console-shell.spec.ts`
 * asserts a real HTTP 200 through a real session). The failure paths are not
 * reachable from that spec without breaking the stack on purpose, and they are
 * the ones an operator is actually going to meet: a session that expired in
 * another tab is a **401**, and a role that lost `plugins:manage` is a **403**.
 * Both come back from a route that is up and working, which is exactly why they
 * must not look like nothing happening.
 *
 * Rendered with `renderToStaticMarkup` rather than a DOM: `ProbePanel` takes the
 * probe as a prop, so there is no effect to flush, no network to intercept and
 * no jsdom to install. The file is `.tsx`, which is also the reason
 * `vitest.config.ts`'s include glob had to stop being `.ts`-only.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { ProbePanel, type Probe, describeProbe, probeOttaAdminRoute } from "../src/admin.js";

/** A probe as `probeOttaAdminRoute` would return it for a refusal: the request
 *  completed, so there is no `transportError` — only a non-2xx status. */
function refusal(status: number): Probe {
	return { ok: false, status, ms: 12, envelopeKeys: ["success", "error"], blockTypes: [] };
}

describe("a refusal renders as a refusal, not as a blank pane", () => {
	test.each([
		[401, "session expired in another tab"],
		[403, "role no longer carries plugins:manage"],
	])("HTTP %i (%s) reaches the screen", (status) => {
		const html = renderToStaticMarkup(<ProbePanel probe={refusal(status)} />);

		// Non-blank, and specifically non-blank ABOUT THE FAILURE — an empty
		// panel and a panel that renders only its own chrome are the same bug to
		// an operator.
		expect(html.length).toBeGreaterThan(0);
		expect(html).toContain(`HTTP ${status}`);
		expect(html).toContain("Commerce data path");

		// The region announces itself. The content arrives after mount, so
		// without this a screen-reader user already on the page is told nothing.
		expect(html).toContain('aria-live="polite"');

		// And the operator can retry without a full page reload.
		expect(html).toContain('data-testid="probe-retry"');
	});

	test("a transport failure says so instead of claiming a status", () => {
		// status 0 is not an HTTP status and must never be printed as one.
		const html = renderToStaticMarkup(
			<ProbePanel
				probe={{
					ok: false,
					status: 0,
					ms: 3,
					envelopeKeys: [],
					blockTypes: [],
					transportError: "Failed to fetch",
				}}
			/>,
		);
		expect(html).toContain("no response");
		expect(html).toContain("Failed to fetch");
		expect(html).not.toContain("HTTP 0");
	});

	test("the pending state is distinguishable from a failure", () => {
		const html = renderToStaticMarkup(<ProbePanel probe={null} />);
		expect(html).toContain("checking");
		expect(html).not.toContain("HTTP");
	});

	test("describeProbe never returns an empty string for any of these", () => {
		for (const probe of [null, refusal(401), refusal(403), refusal(500)]) {
			expect(describeProbe(probe).trim().length).toBeGreaterThan(0);
		}
	});
});

describe("probeOttaAdminRoute turns refusals into values, never throws", () => {
	test.each([401, 403])("HTTP %i is captured, not raised", async (status) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ success: false, error: { message: "nope" } }), {
				status,
				headers: { "Content-Type": "application/json" },
			}),
		);
		try {
			const probe = await probeOttaAdminRoute();
			expect(probe.ok).toBe(false);
			expect(probe.status).toBe(status);
			expect(probe.transportError).toBeUndefined();
			// The CSRF header `apiFetch` adds is what makes the call legal at all;
			// losing it would turn every run into a 403 that looks like an auth bug.
			const init = fetchSpy.mock.calls[0]?.[1];
			expect(new Headers(init?.headers).get("X-EmDash-Request")).toBe("1");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("a rejected fetch becomes a transportError, not an unhandled rejection", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Failed to fetch"));
		try {
			// G5's reasoning, React tier: an uncaught rejection here unmounts the
			// component and leaves the operator a blank pane.
			const probe = await probeOttaAdminRoute();
			expect(probe.transportError).toBe("Failed to fetch");
			expect(probe.ok).toBe(false);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	test("a non-JSON body does not blow up the panel", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("<html>gateway error</html>", { status: 502 }));
		try {
			const probe = await probeOttaAdminRoute();
			expect(probe.status).toBe(502);
			expect(probe.envelopeKeys).toEqual([]);
			expect(renderToStaticMarkup(<ProbePanel probe={probe} />)).toContain("HTTP 502");
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
