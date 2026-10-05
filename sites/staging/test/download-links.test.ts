/**
 * Which order lines get a Download link (issue #376, increment 3).
 *
 * THE NARROWEST HONEST SOURCE. The public order wire says which lines are
 * digital, but not whether a line is downloadable NOW: that needs the grant
 * (revoked on a full refund), the order's state, the product still being digital
 * and a file being attached — four facts the order read does not carry, and
 * exactly the four the plugin's `entitlements/download` gate checks. So a page
 * asks the gate once per DISTINCT digital sku, and only when the link could
 * possibly work: a DOWNLOADS binding is present and the order is in a
 * deliverable state. A link is drawn iff the gate authorizes, so the page never
 * offers a link the endpoint would refuse — and never for a physical line, which
 * is not even asked about.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ENTITLEMENT_DOWNLOAD_ROUTE, type EntitlementDownloadResult } from "@otta-sh/plugin";
import { downloadLinks } from "../src/lib/download-links.js";
import { splitAstro } from "./astro-source.js";

const SITE = new URL("http://localhost:4321/orders/o-1");
const ASSET = { key: "dl/p/01J", filename: "a.pdf", contentType: "application/pdf", size: 3 };

function makeGate(answer: (sku: string) => EntitlementDownloadResult | null) {
	const calls: { route: string; input: Record<string, unknown> }[] = [];
	const handler = async (_id: string, _m: string, routePath: string, request: Request) => {
		const input = (await request.json()) as Record<string, unknown>;
		calls.push({ route: routePath.replace(/^\//, ""), input });
		const result = answer(input["sku"] as string);
		return result === null ? { success: false } : { success: true, data: result };
	};
	return { handler: handler as never, calls };
}

const authorized = (sku: string): EntitlementDownloadResult => ({
	authorized: true,
	sku,
	asset: ASSET,
});
const notFound: EntitlementDownloadResult = { authorized: false, reason: "NOT_FOUND" };

const LINES = [
	{ sku: "EBOOK-01", fulfillmentKind: "digital" },
	{ sku: "TEE-01", fulfillmentKind: "physical" },
	{ sku: "EBOOK-02", fulfillmentKind: "digital" },
	{ sku: "EBOOK-01", fulfillmentKind: "digital" },
];

describe("downloadLinks", () => {
	test("a link for each entitled digital sku, asked once per distinct sku; physical lines never asked", async () => {
		const gate = makeGate((sku) => (sku === "EBOOK-01" ? authorized(sku) : notFound));
		const links = await downloadLinks({
			handler: gate.handler,
			bucketPresent: true,
			order: { id: "o-1", state: "paid", lines: LINES },
			baseUrl: SITE,
		});
		expect(links).toEqual(new Map([["EBOOK-01", "/orders/o-1/download/EBOOK-01"]]));
		expect(gate.calls).toEqual([
			{ route: ENTITLEMENT_DOWNLOAD_ROUTE, input: { orderId: "o-1", sku: "EBOOK-01" } },
			{ route: ENTITLEMENT_DOWNLOAD_ROUTE, input: { orderId: "o-1", sku: "EBOOK-02" } },
		]);
	});

	test.each(["pending", "expired", "failed", "cancelled", "refunded"])(
		"a %s order draws no link and asks nothing",
		async (state) => {
			const gate = makeGate(authorized);
			const links = await downloadLinks({
				handler: gate.handler,
				bucketPresent: true,
				order: { id: "o-1", state, lines: LINES },
				baseUrl: SITE,
			});
			expect(links.size).toBe(0);
			expect(gate.calls).toEqual([]);
		},
	);

	test.each(["paid", "processing", "shipped", "delivered", "completed"])(
		"a %s order asks the gate",
		async (state) => {
			const gate = makeGate(authorized);
			const links = await downloadLinks({
				handler: gate.handler,
				bucketPresent: true,
				order: { id: "o-1", state, lines: LINES },
				baseUrl: SITE,
			});
			expect([...links.keys()]).toEqual(["EBOOK-01", "EBOOK-02"]);
		},
	);

	test("no DOWNLOADS binding: no link, nothing asked", async () => {
		const gate = makeGate(authorized);
		const links = await downloadLinks({
			handler: gate.handler,
			bucketPresent: false,
			order: { id: "o-1", state: "paid", lines: LINES },
			baseUrl: SITE,
		});
		expect(links.size).toBe(0);
		expect(gate.calls).toEqual([]);
	});

	test("BUSY still draws the link (the endpoint re-checks); a failed dispatch draws none", async () => {
		const gate = makeGate((sku) =>
			sku === "EBOOK-01" ? { authorized: false, reason: "BUSY", retryable: true } : null,
		);
		const links = await downloadLinks({
			handler: gate.handler,
			bucketPresent: true,
			order: { id: "o-1", state: "paid", lines: LINES },
			baseUrl: SITE,
		});
		expect([...links.keys()]).toEqual(["EBOOK-01"]);
	});

	test("an order with no digital line asks nothing", async () => {
		const gate = makeGate(authorized);
		const links = await downloadLinks({
			handler: gate.handler,
			bucketPresent: true,
			order: { id: "o-1", state: "paid", lines: [{ sku: "TEE-01", fulfillmentKind: "physical" }] },
			baseUrl: SITE,
		});
		expect(links.size).toBe(0);
		expect(gate.calls).toEqual([]);
	});
});

/**
 * The two order pages draw the links from `downloadLinks` and nothing else.
 * Pinned by source text, like every `.astro` page here (no render harness —
 * issue #40); the browser pass clicks the real link.
 */
describe("the order pages wire it", () => {
	const HERE = path.dirname(fileURLToPath(import.meta.url));
	const frontmatter = (relative: string): string =>
		splitAstro(readFileSync(path.resolve(HERE, "../src/pages", relative), "utf8")).frontmatter;

	test.each(["orders/[orderId].astro", "account/orders/[id].astro"])(
		"%s asks downloadLinks with the bucket's presence, and puts the href on the row by sku",
		(relative) => {
			const source = frontmatter(relative);
			expect(source).toMatch(/import \{ downloadLinks \} from "(\.\.\/)+lib\/download-links\.js";/);
			expect(source).toMatch(
				/import \{ downloadsBucketFrom \} from "(\.\.\/)+lib\/download-delivery\.js";/,
			);
			expect(source).toMatch(/import \{ env \} from "virtual:emdash\/env";/);
			expect(source).toMatch(/bucketPresent: downloadsBucketFrom\(env\) !== undefined/);
			expect(source).toMatch(/downloadHref: (links|downloads)\.get\(line\.sku\)/);
		},
	);
});
