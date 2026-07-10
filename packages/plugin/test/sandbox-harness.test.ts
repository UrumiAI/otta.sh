import { afterEach, describe, expect, test } from "vitest";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;

afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

describe("workerd-on-Node sandbox harness (plan §6 step 1)", () => {
	test("loads @urumi/plugin under workerd-on-Node and reaches a stub service only via ctx.http", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({ status: 200, body: null }));

		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		// Any route that calls CommerceClient.get exercises ctx.http.fetch
		// end-to-end through a REAL workerd process, not trusted in-process.
		const outcome = await sandbox.invokeRoute("product-data/panel-state", { productId: "prod-1" });
		expect(outcome).toMatchObject({ result: { elements: expect.any(Array) } });
		expect(stub.requests.some((r) => r.method === "GET")).toBe(true);
	});

	test("a fetch to a host NOT in allowedHosts is rejected by the sandbox's ctx.http bridge", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", () => ({ status: 200, body: null }));

		// commerceServiceBaseUrl points at the real stub, but allowedHosts
		// deliberately omits it — ctx.http.fetch must reject before any request
		// reaches the stub.
		sandbox = await loadPluginInSandbox({
			allowedHosts: ["definitely-not-the-stub.example"],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const outcome = await sandbox.invokeRoute("product-data/panel-state", { productId: "prod-1" });
		expect("error" in outcome).toBe(true);
		if ("error" in outcome) {
			expect(outcome.error).toMatch(/not allowed to fetch/i);
		}
		expect(stub.requests).toHaveLength(0);
	});

	test("an unknown hook/route name resolves to a 404-shaped result, not a crash", async () => {
		stub = await startStubCommerceServer();
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const hookOutcome = await sandbox.invokeHook("content:doesNotExist", {});
		expect(hookOutcome).toEqual({ error: "unknown hook: content:doesNotExist" });

		const routeOutcome = await sandbox.invokeRoute("does-not-exist", {});
		expect(routeOutcome).toEqual({ error: "unknown route: does-not-exist" });
	});
});
