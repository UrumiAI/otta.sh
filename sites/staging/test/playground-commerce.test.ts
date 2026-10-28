/**
 * The playground prices the seeded sample products. EmDash's playground
 * seed does not fire Otta's publish hook, so without this pass the shop
 * lists three products that cannot be bought.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { injectBanner } from "../src/lib/playground-banner.js";
import {
	PLAYGROUND_PRODUCT_PHOTOS,
	contentImageSrc,
	shouldAttachPlaygroundPhoto,
} from "../src/lib/playground-photos.js";
import { productImage } from "../src/lib/products.js";
import {
	PLAYGROUND_MAX_ATTEMPTS,
	isPlaygroundAdminHome,
	isPlaygroundBoot,
	isPlaygroundDocument,
	itemsFromListResult,
	planPlaygroundNavigation,
	playgroundAttempt,
	playgroundRouteCaller,
	playgroundWaitPath,
	prepareDemoCommerce,
	withPlaygroundCreatedAt,
	type PlaygroundPorts,
} from "../src/lib/playground-commerce.js";
import { DEMO_PRICING, type ExistingCommerce } from "../scripts/seed-demo-commerce.js";

const TITLES: Record<string, string> = {
	"otta-tee": "Otta Tee",
	"otta-mug": "Otta Mug",
	"otta-stickers": "Otta Sticker Pack",
};

function catalog(): unknown[] {
	return Object.keys(DEMO_PRICING).map((slug, index) => ({
		id: `id-${index}`,
		slug,
		data: { title: TITLES[slug] },
	}));
}

function row(over: Partial<ExistingCommerce> = {}): ExistingCommerce {
	return { sku: null, active: true, updatedAt: "2026-01-01T00:00:00.000Z", onHand: 0, ...over };
}

function ports(opts: {
	items?: unknown[];
	commerce: Map<string, ExistingCommerce | null>;
	published?: string[];
	actions?: Array<{ actionId: string; value: Record<string, string> }>;
	renamed?: { count: number };
}): PlaygroundPorts {
	return {
		listItems: async () => opts.items ?? catalog(),
		publish: async (id) => {
			opts.published?.push(id);
		},
		read: async (id) => {
			const existing = opts.commerce.get(id);
			if (existing === undefined || existing === null) return { ok: false };
			return { ok: true, product: existing };
		},
		act: async (actionId, value) => {
			opts.actions?.push({ actionId, value });
			const current = opts.commerce.get(value["productId"] ?? "");
			if (actionId === "products:save-identity" && current !== undefined && current !== null) {
				opts.commerce.set(value["productId"] ?? "", { ...current, sku: value["sku"] ?? null });
			}
			if (actionId === "products:restock" && current !== undefined && current !== null) {
				opts.commerce.set(value["productId"] ?? "", {
					...current,
					onHand: current.onHand === null ? null : current.onHand + Number(value["qty"]),
				});
			}
		},
		renameSite: async () => {
			if (opts.renamed !== undefined) opts.renamed.count += 1;
		},
	};
}

describe("prepareDemoCommerce", () => {
	test("publishes products that have no commerce row and waits for the hook", async () => {
		const published: string[] = [];
		const actions: Array<{ actionId: string }> = [];
		const result = await prepareDemoCommerce(
			ports({
				commerce: new Map(),
				published,
				actions: actions as Array<{ actionId: string; value: Record<string, string> }>,
			}),
		);
		expect(result).toEqual({ kind: "pending" });
		expect(published).toEqual(["id-0", "id-1", "id-2"]);
		expect(actions).toEqual([]);
	});

	test("prices and stocks a row the publish hook has already created", async () => {
		const commerce = new Map<string, ExistingCommerce | null>([
			["id-0", row()],
			["id-1", row()],
			["id-2", row()],
		]);
		const actions: Array<{ actionId: string; value: Record<string, string> }> = [];
		const renamed = { count: 0 };
		const result = await prepareDemoCommerce(ports({ commerce, actions, renamed }));
		expect(result).toEqual({ kind: "ready" });
		expect(actions.map((action) => action.actionId)).toEqual([
			"products:save-identity",
			"products:restock",
			"products:save-identity",
			"products:restock",
			"products:save-identity",
			"products:restock",
		]);
		expect(actions[0]?.value["price"]).toBe("32.00");
		expect(actions[1]?.value["nonce"]).toBe("playground-restock-otta-tee");
		expect(actions[1]?.value["qty"]).toBe("25");
		expect(renamed.count).toBe(1);
		expect(commerce.get("id-0")?.onHand).toBe(25);
	});

	test("leaves a product that already has a SKU and stock alone", async () => {
		const commerce = new Map<string, ExistingCommerce | null>(
			Object.keys(DEMO_PRICING).map((slug, index) => [
				`id-${index}`,
				row({ sku: DEMO_PRICING[slug]?.sku ?? null, onHand: 4 }),
			]),
		);
		const actions: Array<{ actionId: string }> = [];
		const renamed = { count: 0 };
		const result = await prepareDemoCommerce(
			ports({
				commerce,
				actions: actions as Array<{ actionId: string; value: Record<string, string> }>,
				renamed,
			}),
		);
		expect(result).toEqual({ kind: "ready" });
		expect(actions).toEqual([]);
		expect(renamed.count).toBe(1);
	});

	test("restocks a priced sample left at zero, once, with a stable nonce", async () => {
		const commerce = new Map<string, ExistingCommerce | null>([
			["id-0", row({ sku: "OTTA-TEE", onHand: 0 })],
			["id-1", row({ sku: "OTTA-MUG", onHand: 3 })],
			["id-2", row({ sku: "OTTA-STICKERS", onHand: 1 })],
		]);
		const actions: Array<{ actionId: string; value: Record<string, string> }> = [];
		const result = await prepareDemoCommerce(ports({ commerce, actions }));
		expect(result.kind).toBe("ready");
		expect(actions).toHaveLength(1);
		expect(actions[0]?.actionId).toBe("products:restock");
		expect(actions[0]?.value["nonce"]).toBe("playground-restock-otta-tee");
	});

	test("does not restock a sample the visitor took off sale", async () => {
		const commerce = new Map<string, ExistingCommerce | null>(
			Object.keys(DEMO_PRICING).map((slug, index) => [
				`id-${index}`,
				row({ sku: DEMO_PRICING[slug]?.sku ?? null, active: false, onHand: 0 }),
			]),
		);
		const actions: unknown[] = [];
		const result = await prepareDemoCommerce(
			ports({
				commerce,
				actions: actions as Array<{ actionId: string; value: Record<string, string> }>,
			}),
		);
		expect(result.kind).toBe("ready");
		expect(actions).toEqual([]);
	});

	test("fails closed when the CMS is missing a sample product", async () => {
		const result = await prepareDemoCommerce(
			ports({ items: catalog().slice(0, 2), commerce: new Map() }),
		);
		expect(result.kind).toBe("failed");
		if (result.kind === "failed") expect(result.message).toMatch(/otta-stickers/);
	});
});

describe("planPlaygroundNavigation", () => {
	test("the boot admin request opens the shop once prices exist", () => {
		expect(isPlaygroundAdminHome("/_emdash/admin")).toBe(true);
		expect(isPlaygroundAdminHome("/_emdash/admin/")).toBe(true);
		expect(isPlaygroundAdminHome("/_emdash/admin/content")).toBe(false);
		expect(
			planPlaygroundNavigation({
				pathname: "/_emdash/admin",
				attempt: 0,
				boot: true,
				prepare: { kind: "ready" },
			}),
		).toEqual({ type: "redirect", location: "/products" });
		expect(
			planPlaygroundNavigation({
				pathname: "/_emdash/admin/",
				attempt: 0,
				boot: true,
				prepare: { kind: "ready" },
			}),
		).toEqual({ type: "redirect", location: "/products" });
	});

	test("a later visit to the admin is not redirected", () => {
		expect(
			planPlaygroundNavigation({
				pathname: "/_emdash/admin",
				attempt: 0,
				boot: false,
				prepare: { kind: "ready" },
			}),
		).toEqual({ type: "render" });
		expect(
			planPlaygroundNavigation({
				pathname: "/_emdash/admin/content",
				attempt: 0,
				boot: false,
				prepare: { kind: "ready" },
			}),
		).toEqual({ type: "render" });
	});

	test("a pending catalog reloads, then stops", () => {
		expect(
			planPlaygroundNavigation({
				pathname: "/_emdash/admin",
				attempt: 1,
				boot: true,
				prepare: { kind: "pending" },
			}),
		).toEqual({ type: "wait", attempt: 2 });
		const stuck = planPlaygroundNavigation({
			pathname: "/_emdash/admin",
			attempt: PLAYGROUND_MAX_ATTEMPTS,
			boot: true,
			prepare: { kind: "pending" },
		});
		expect(stuck.type).toBe("stuck");
	});

	test("a priced boot still opens the shop, and a priced shop reload only drops the wait query", () => {
		expect(
			planPlaygroundNavigation({
				pathname: "/_emdash/admin",
				attempt: 2,
				boot: true,
				prepare: { kind: "ready" },
			}),
		).toEqual({ type: "redirect", location: "/products" });
		expect(
			planPlaygroundNavigation({
				pathname: "/products",
				attempt: 2,
				boot: true,
				prepare: { kind: "ready" },
			}),
		).toEqual({ type: "redirect", location: "/products" });
	});
});

describe("playground request shape", () => {
	test("only document navigations wait", () => {
		expect(isPlaygroundDocument("GET", "/products", "text/html", "document")).toBe(true);
		expect(isPlaygroundDocument("GET", "/_emdash/admin", "text/html", null)).toBe(true);
		expect(
			isPlaygroundDocument("GET", "/_emdash/api/content/products", "application/json", "empty"),
		).toBe(false);
		expect(isPlaygroundDocument("GET", "/playground", "text/html", "document")).toBe(false);
		expect(isPlaygroundDocument("POST", "/products", "text/html", "document")).toBe(false);
		expect(isPlaygroundDocument("GET", "/_astro/app.css", "text/css", "style")).toBe(false);
	});

	test("boot is the playground referrer or the wait query", () => {
		expect(isPlaygroundBoot("https://try.otta.sh", "https://try.otta.sh/playground", false)).toBe(
			true,
		);
		expect(isPlaygroundBoot("https://try.otta.sh", "https://try.otta.sh/products", false)).toBe(
			false,
		);
		expect(isPlaygroundBoot("https://try.otta.sh", "https://evil.example/playground", false)).toBe(
			false,
		);
		expect(isPlaygroundBoot("https://try.otta.sh", null, true)).toBe(true);
	});

	test("the wait path only adds the boot counter", () => {
		expect(playgroundWaitPath("/_emdash/admin", 2)).toBe("/_emdash/admin?otta_pg=2");
		expect(playgroundAttempt("2")).toBe(2);
		expect(playgroundAttempt("nope")).toBe(0);
		expect(playgroundAttempt("99")).toBe(PLAYGROUND_MAX_ATTEMPTS);
	});
});

describe("playgroundRouteCaller", () => {
	test("fills createdAt when the playground admin has none", () => {
		const caller = playgroundRouteCaller({
			id: "playground-admin",
			email: "playground@emdashcms.com",
			name: "Playground User",
			role: 50,
		});
		expect(caller?.id).toBe("playground-admin");
		expect(caller?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	test("keeps a timestamp the session already has", () => {
		expect(
			playgroundRouteCaller({
				id: "playground-admin",
				email: "playground@emdashcms.com",
				name: null,
				role: 50,
				createdAt: "2026-10-24T21:35:43.995Z",
			})?.createdAt,
		).toBe("2026-10-24T21:35:43.995Z");
		expect(playgroundRouteCaller({ id: "playground-admin", role: 50 })).toBeNull();
	});
});

describe("withPlaygroundCreatedAt", () => {
	test("returns a copy with the createdAt the admin console route needs", () => {
		const shared = Object.freeze({
			id: "playground-admin",
			email: "playground@emdashcms.com",
			name: "Playground User",
			role: 50,
		});
		const user = withPlaygroundCreatedAt(shared) as Record<string, unknown>;
		expect(user).not.toBe(shared);
		expect(user).toMatchObject(shared);
		expect(user["createdAt"]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(shared).not.toHaveProperty("createdAt");
	});

	test("returns a user with a usable timestamp as it is, and replaces an invalid one", () => {
		const stamped = { createdAt: "2026-10-24T21:35:43.995Z" };
		expect(withPlaygroundCreatedAt(stamped)).toBe(stamped);
		const dated = { createdAt: new Date("2026-10-24T21:35:43.995Z") };
		expect(withPlaygroundCreatedAt(dated)).toBe(dated);

		const invalid = withPlaygroundCreatedAt({ createdAt: new Date("not a date") });
		expect(typeof (invalid as { createdAt: unknown }).createdAt).toBe("string");
	});

	test("passes a missing user through", () => {
		expect(withPlaygroundCreatedAt(undefined)).toBeUndefined();
		expect(withPlaygroundCreatedAt(null)).toBeNull();
	});
});

describe("itemsFromListResult", () => {
	test("reads a success envelope and refuses a failure", () => {
		expect(
			itemsFromListResult({ success: true, data: { items: [{ id: "1" }], nextCursor: "c" } }),
		).toEqual({
			items: [{ id: "1" }],
			nextCursor: "c",
		});
		expect(() => itemsFromListResult({ success: false, error: { message: "no table" } })).toThrow(
			/no table/,
		);
	});
});

describe("playground product photographs", () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

	test("the seed points each sample product at a JPEG in the repo", () => {
		const seed = JSON.parse(readFileSync(path.join(root, "seed/seed.json"), "utf8")) as {
			content: {
				products: { id: string; slug: string; data: { title: string; images: unknown } }[];
			};
		};
		const slugs = seed.content.products.map((entry) => entry.slug);
		expect(slugs).toEqual(Object.keys(PLAYGROUND_PRODUCT_PHOTOS));
		for (const entry of seed.content.products) {
			const photo = PLAYGROUND_PRODUCT_PHOTOS[entry.slug];
			expect(photo).toBeDefined();
			expect(entry.data.images).toEqual(photo);
			expect(
				productImage({
					id: entry.id,
					slug: entry.slug,
					title: entry.data.title,
					images: entry.data.images as { src: string },
				}),
			).toBe(photo?.src);
			const relative = (photo?.src ?? "").replace(/^\//, "");
			const file = readFileSync(path.join(root, "public", relative));
			expect(file.subarray(0, 3).toString("hex")).toBe("ffd8ff");
		}
	});

	test("a visitor's own picture is kept, and the shipped file's old alt is refreshed", () => {
		const photo = PLAYGROUND_PRODUCT_PHOTOS["otta-tee"];
		expect(photo).toBeDefined();
		if (photo === undefined) return;
		expect(contentImageSrc(undefined)).toBeNull();
		expect(contentImageSrc({ images: null })).toBeNull();
		expect(contentImageSrc({ images: { src: "/somewhere-else.jpg" } })).toBe("/somewhere-else.jpg");
		expect(shouldAttachPlaygroundPhoto(undefined, photo)).toBe(true);
		expect(shouldAttachPlaygroundPhoto({ images: null }, photo)).toBe(true);
		expect(shouldAttachPlaygroundPhoto({ images: { src: "/somewhere-else.jpg" } }, photo)).toBe(
			false,
		);
		expect(
			shouldAttachPlaygroundPhoto(
				{ images: { ...photo, alt: "A white cotton t-shirt on a hanger" } },
				photo,
			),
		).toBe(true);
		expect(shouldAttachPlaygroundPhoto({ images: photo }, photo)).toBe(false);
	});
});

describe("injectBanner", () => {
	test("opens under the body tag and does not repeat", () => {
		const once = injectBanner('<html><body class="x"><p>Hi</p></body></html>');
		expect(once).toContain("otta-playground-note");
		expect(once).toContain("Card payments are not connected");
		expect(once).not.toMatch(/pay-per-crawl|x402|\bMCP\b/);
		expect(injectBanner(once)).toBe(once);
	});
});
