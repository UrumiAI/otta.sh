import { afterEach, describe, expect, test } from "vitest";
import { buildProductDataElements, productDataWidget } from "../src/admin/product-data-widget.js";
import { URUMI_PLUGIN_CAPABILITIES } from "../src/manifest.js";
import {
	startStubCommerceServer,
	type StubCommerceServer,
} from "./helpers/stub-commerce-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

let sandbox: SandboxHandle | undefined;
let stub: StubCommerceServer | undefined;

afterEach(async () => {
	await sandbox?.close();
	sandbox = undefined;
	await stub?.close();
	stub = undefined;
});

describe('"Product data" widget + save route (plan §6 step 8)', () => {
	test("the widget declares Block Kit elements (no React) with the commercial field layout (plan §5)", () => {
		expect(productDataWidget.name).toBe("product-data");
		expect(Array.isArray(productDataWidget.elements)).toBe(true);
		// No React entry — sandboxed widgets render from `elements`, never `entry`
		// (the local `FieldWidgetConfig` type has no `entry` field at all).
		expect("entry" in productDataWidget).toBe(false);

		const enabled = buildProductDataElements({ hasProductId: true, commerce: null });
		const actionIds = enabled.map((el) => el.action_id);
		expect(actionIds).toEqual(
			expect.arrayContaining([
				"sku",
				"price",
				"currency",
				"onHand",
				"productKind",
				"taxClass",
				"weightGrams",
				"lengthMm",
				"widthMm",
				"heightMm",
				"save",
			]),
		);
	});

	test("new product (no id) renders every field disabled with a create-then-price notice, and offers no save action", () => {
		const disabled = buildProductDataElements({ hasProductId: false });
		for (const el of disabled) {
			expect(el.disabled).toBe(true);
		}
		const save = disabled.find((el) => el.action_id === "save");
		expect(save).toBeDefined();
		expect(save?.disabled).toBe(true);
		expect((save as { label: string }).label).toMatch(/save the product first/i);
	});

	test("once a sku exists, the Stock field becomes disabled (create-only — plan §5/§8 Risk 4)", () => {
		const beforeSku = buildProductDataElements({ hasProductId: true, commerce: null });
		const onHandBefore = beforeSku.find((el) => el.action_id === "onHand");
		expect(onHandBefore?.disabled).toBeFalsy();

		const afterSku = buildProductDataElements({
			hasProductId: true,
			commerce: {
				productId: "prod-1",
				sku: "SKU-1",
				price: null,
				taxClass: null,
				weightGrams: null,
				lengthMm: null,
				widthMm: null,
				heightMm: null,
				productKind: "physical",
				active: false,
				deletedAt: null,
				createdAt: "x",
				updatedAt: "x",
			},
		});
		const onHandAfter = afterSku.find((el) => el.action_id === "onHand");
		expect(onHandAfter?.disabled).toBe(true);
	});

	test("the panel-state route serves the disabled tree for a new product and the enabled tree once a row exists — under the sandbox", async () => {
		stub = await startStubCommerceServer();
		stub.respondWith("GET", (req) =>
			req.url === "/products/prod-1/commerce"
				? {
						status: 200,
						body: {
							productId: "prod-1",
							sku: "SKU-1",
							price: { amount: 500, currency: "USD" },
							taxClass: null,
							weightGrams: null,
							lengthMm: null,
							widthMm: null,
							heightMm: null,
							productKind: "physical",
							active: false,
							deletedAt: null,
							createdAt: "x",
							updatedAt: "x",
						},
					}
				: { status: 200, body: null },
		);
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		const newProduct = await sandbox.invokeRoute("product-data/panel-state", {});
		expect(newProduct).toMatchObject({
			result: { elements: expect.arrayContaining([expect.objectContaining({ disabled: true })]) },
		});

		const existingProduct = await sandbox.invokeRoute("product-data/panel-state", {
			productId: "prod-1",
		});
		if (!("result" in existingProduct)) throw new Error("expected a result");
		const elements = (existingProduct.result as { elements: Array<{ action_id: string }> })
			.elements;
		expect(elements.some((el) => el.action_id === "save")).toBe(true);
	});

	test("panel save action posts to the product-commerce route and upserts via the service — under the sandbox", async () => {
		stub = await startStubCommerceServer();
		let putBody: unknown;
		let putHeaders: Record<string, string | string[] | undefined> = {};
		stub.respondWith("PUT", (req) => {
			putBody = req.body;
			putHeaders = req.headers;
			return {
				status: 200,
				body: {
					productId: "prod-2",
					sku: "SKU-2",
					price: { amount: 1000, currency: "USD" },
					taxClass: null,
					weightGrams: null,
					lengthMm: null,
					widthMm: null,
					heightMm: null,
					productKind: "physical",
					active: false,
					deletedAt: null,
					createdAt: "x",
					updatedAt: "x",
				},
			};
		});
		sandbox = await loadPluginInSandbox({
			allowedHosts: [stub.host],
			commerceServiceBaseUrl: stub.baseUrl,
		});

		// The posted payload is the ENTIRE captured Block Kit form state, keyed
		// by action_id (plan §8 Risk 5) — no content:read re-read needed.
		const outcome = await sandbox.invokeRoute("product-commerce", {
			productId: "prod-2",
			sku: "SKU-2",
			price: 1000,
			currency: "USD",
			productKind: "physical",
			onHand: 20,
		});

		expect(outcome).toMatchObject({
			result: { ok: true, productCommerce: { productId: "prod-2" } },
		});
		expect(putBody).toEqual({
			sku: "SKU-2",
			price: { amount: 1000, currency: "USD" },
			productKind: "physical",
			initialOnHand: 20,
		});
		expect(putHeaders["idempotency-key"]).toBeTruthy();
	});

	test("sandbox-clean guard: the manifest declares EXACTLY content:read + network:request, no storage/db surface", () => {
		expect(URUMI_PLUGIN_CAPABILITIES).toEqual(["content:read", "network:request"]);
		expect(URUMI_PLUGIN_CAPABILITIES).not.toContain("network:request:unrestricted");
		expect(URUMI_PLUGIN_CAPABILITIES).not.toContain("content:write");
		for (const cap of URUMI_PLUGIN_CAPABILITIES) {
			expect(cap.startsWith("storage")).toBe(false);
			expect(cap.startsWith("kv")).toBe(false);
			expect(cap.startsWith("db")).toBe(false);
		}
		// The complementary static guard — no DB/storage/filesystem import
		// anywhere in packages/plugin/src — is the `plugin-is-sandbox-clean`
		// dependency-cruiser rule, wired into `pnpm lint` (.dependency-cruiser.cjs).
	});
});
