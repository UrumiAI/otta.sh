import { beforeEach, describe, expect, test, vi } from "vitest";
import type {
	ReportingSettingsSurface,
	RevenueBucketWire,
	TopProductWire,
} from "../src/admin/reporting-settings-surface.js";
import { createReportsPageHandler } from "../src/admin/reports-page.js";
import type { BlockResponse, PluginContext } from "../src/types.js";
import { findBlocks, type LooseBlock } from "./helpers/blocks.js";

/**
 * The units ranking is a full scan in the store, so the Reports page asks for it
 * only in a period with no single revenue currency, and a failure of it falls
 * back to re-sorting the revenue list instead of failing the page closed.
 */

const reporting = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("../src/admin/make-admin-clients.js", () => ({
	makeAdminClients: async () => ({ reporting: reporting.current }),
}));

const BY_REVENUE: TopProductWire[] = [
	{ productId: "a", titleSnapshot: "Atlas", qtySold: 1, revenueCents: 90_000 },
	{ productId: "b", titleSnapshot: "Bolt", qtySold: 5, revenueCents: 500 },
	{ productId: "c", titleSnapshot: "Cog", qtySold: 3, revenueCents: 100 },
];
// Deliberately NOT the re-sort of BY_REVENUE, so the source of the order shows.
const BY_UNITS: TopProductWire[] = [BY_REVENUE[2]!, BY_REVENUE[1]!, BY_REVENUE[0]!];

function bucket(currency: string, revenueCents = 1000): RevenueBucketWire {
	return {
		bucketStart: "2026-07-10T00:00:00.000Z",
		currency,
		revenueCents,
		refundedCents: 0,
		revenueOrderCount: 1,
	};
}

const SINGLE = [bucket("USD")];
const MULTI = [bucket("USD"), bucket("EUR")];

function fakeClient(
	revenue: RevenueBucketWire[],
	quantity: () => Promise<TopProductWire[]>,
): { client: ReportingSettingsSurface; quantityCalls: () => number } {
	let calls = 0;
	const client: ReportingSettingsSurface = {
		getRevenue: async () => revenue,
		getOrdersByStatus: async () => [{ status: "paid", orderCount: 2 }],
		getTopProducts: async (_range, metric) => {
			if (metric === "revenue") return BY_REVENUE;
			calls += 1;
			return quantity();
		},
		getLowStock: async () => [],
		getSettings: async () => ({ holdTtlMinutes: 15, lowStockThreshold: 5, currency: "USD" }),
		updateSettings: async () => {
			throw new Error("not used");
		},
	};
	return { client, quantityCalls: () => calls };
}

async function render(): Promise<BlockResponse> {
	const ctx = {
		kv: { get: async () => null },
	} as unknown as PluginContext;
	return (await createReportsPageHandler()(
		{ input: {}, request: { method: "POST", url: "/admin", headers: {} } },
		ctx,
	)) as BlockResponse;
}

function titles(res: BlockResponse): string[] {
	const chart = findBlocks(res.blocks as unknown as LooseBlock[], "chart").find(
		(b) => b.block_id === "reports:top-chart",
	) as { config?: { options?: { yAxis?: { data?: string[] } } } } | undefined;
	return chart?.config?.options?.yAxis?.data ?? [];
}

describe("Reports page: the units ranking is read only when needed", () => {
	beforeEach(() => {
		reporting.current = undefined;
	});

	test("a single-currency period never asks for the quantity ranking", async () => {
		const { client, quantityCalls } = fakeClient(SINGLE, async () => BY_UNITS);
		reporting.current = client;
		const res = await render();
		expect(quantityCalls()).toBe(0);
		expect(titles(res)).toEqual(["Atlas", "Bolt", "Cog"]);
	});

	test("a multi-currency period asks for it and draws its order", async () => {
		const { client, quantityCalls } = fakeClient(MULTI, async () => BY_UNITS);
		reporting.current = client;
		const res = await render();
		expect(quantityCalls()).toBe(1);
		expect(titles(res)).toEqual(["Cog", "Bolt", "Atlas"]);
	});

	test("a failing quantity read falls back to the re-sorted list, not the fail-closed banner", async () => {
		const { client, quantityCalls } = fakeClient(MULTI, async () => {
			throw new Error("scan page limit");
		});
		reporting.current = client;
		const res = await render();
		expect(quantityCalls()).toBe(1);
		expect(JSON.stringify(res)).not.toContain("Reports are unavailable");
		expect(titles(res)).toEqual(["Bolt", "Cog", "Atlas"]);
	});
});
