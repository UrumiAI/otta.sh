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
 * The page must read MORE than the ten products it shows. On several currencies
 * the store's revenue order sums minor units across currencies, so a cheap best
 * seller sits outside its first ten; the page can only rank by units if it was
 * handed the whole list. The fake store below answers like the real one: every
 * product ranked by revenue, then sliced to the limit asked for.
 */

const reporting = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("../src/admin/make-admin-clients.js", () => ({
	makeAdminClients: async () => ({ reporting: reporting.current }),
}));

const CATALOGUE: TopProductWire[] = [
	...Array.from({ length: 12 }, (_, i) => ({
		productId: `p${i}`,
		titleSnapshot: `Premium ${i}`,
		qtySold: 1,
		revenueCents: 90_000 - i * 100,
	})),
	{ productId: "bolt", titleSnapshot: "Bolt", qtySold: 500, revenueCents: 500 },
];

function bucket(currency: string): RevenueBucketWire {
	return {
		bucketStart: "2026-07-10T00:00:00.000Z",
		currency,
		revenueCents: 1000,
		refundedCents: 0,
		revenueOrderCount: 1,
	};
}

function fakeClient(revenue: RevenueBucketWire[]): {
	client: ReportingSettingsSurface;
	limits: number[];
} {
	const limits: number[] = [];
	const client: ReportingSettingsSurface = {
		getRevenue: async () => revenue,
		getOrdersByStatus: async () => [{ status: "paid", orderCount: 2 }],
		getTopProducts: async (_range, _metric, limit) => {
			limits.push(limit);
			return CATALOGUE.toSorted((a, b) => b.revenueCents - a.revenueCents).slice(0, limit);
		},
		getLowStock: async () => [],
		getSettings: async () => ({ holdTtlMinutes: 15, lowStockThreshold: 5, currency: "USD" }),
		updateSettings: async () => {
			throw new Error("not used");
		},
	};
	return { client, limits };
}

async function render(): Promise<BlockResponse> {
	const ctx = { kv: { get: async () => null } } as unknown as PluginContext;
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

describe("Reports page: the top-products read is wider than the ten shown", () => {
	beforeEach(() => {
		reporting.current = undefined;
	});

	test("several currencies: a cheap best seller outside the revenue top ten leads the units chart", async () => {
		const { client, limits } = fakeClient([bucket("USD"), bucket("EUR")]);
		reporting.current = client;
		const shown = titles(await render());
		expect(limits).toHaveLength(1);
		expect(limits[0]).toBeGreaterThan(10);
		expect(shown).toHaveLength(10);
		expect(shown[0]).toBe("Bolt");
	});

	test("one currency: the revenue ten, from the same single read", async () => {
		const { client, limits } = fakeClient([bucket("USD")]);
		reporting.current = client;
		const shown = titles(await render());
		expect(limits).toHaveLength(1);
		expect(shown).toEqual(CATALOGUE.slice(0, 10).map((p) => p.titleSnapshot));
	});
});
