/**
 * The `otta()` integration (ADR-0045): the routes it injects, the template
 * contract, the seed check and the public scripts. The config it contributes
 * (defines, fonts, guards) is pinned where it was before the move:
 * `fonts-config.test.ts` here, and `sites/staging/test/site-config.test.ts`,
 * `default-email.test.ts` and `build-path-leak.test.ts`, which run the real
 * hook through the staging site's config.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import otta, {
	assertSeedFound,
	assertTemplateContract,
	OTTA_INTEGRATION_NAME,
	OTTA_SEED,
	OTTA_TEMPLATE_CONTRACT,
	packageRoot,
	PUBLIC_SCRIPTS_DIR,
	storefrontRoutes,
} from "../src/integration.js";

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("storefrontRoutes", () => {
	test("one route per page file, at the pattern Astro's file router gave it", () => {
		const routes = storefrontRoutes();
		expect(routes.map((r) => r.pattern)).toEqual([
			"/",
			"/404",
			"/account",
			"/account/login",
			"/account/login/request",
			"/account/logout",
			"/account/orders",
			"/account/orders/[id]",
			"/account/verify",
			"/account/verify/confirm",
			"/cart",
			"/cart/add",
			"/cart/remove",
			"/cart/switch-currency",
			"/cart/update",
			"/checkout",
			"/checkout/new-cart",
			"/checkout/pay",
			"/checkout/place",
			"/checkout/regions",
			"/checkout/resume",
			"/checkout/resume/email",
			"/dev/tempered",
			"/orders/[orderId]",
			"/orders/[orderId]/download/[sku]",
			"/otta-admin/downloads/[productId]",
			"/products",
			"/products/[slug]",
			"/webhooks/stripe",
		]);
		for (const route of routes) {
			expect(path.isAbsolute(route.entrypoint)).toBe(true);
			expect(route.entrypoint.startsWith(path.join(PKG, "src", "pages"))).toBe(true);
		}
	});

	test("every file under src/pages is routed (no second list to forget)", () => {
		const files = readdirSync(path.join(PKG, "src", "pages"), { recursive: true })
			.map(String)
			.filter((f) => /\.(astro|ts)$/.test(f));
		expect(storefrontRoutes()).toHaveLength(files.length);
	});

	test("index files route to their directory; nested params are kept", () => {
		const dir = mkdtempSync(path.join(tmpdir(), "otta-pages-"));
		try {
			mkdirSync(path.join(dir, "a", "[id]"), { recursive: true });
			writeFileSync(path.join(dir, "index.astro"), "");
			writeFileSync(path.join(dir, "a", "index.ts"), "");
			writeFileSync(path.join(dir, "a", "[id]", "x.ts"), "");
			writeFileSync(path.join(dir, "a", "notes.md"), "");
			expect(storefrontRoutes(dir).map((r) => r.pattern)).toEqual(["/", "/a", "/a/[id]/x"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("the template contract", () => {
	test("is 1, and the matching number passes", () => {
		expect(OTTA_TEMPLATE_CONTRACT).toBe(1);
		expect(() => assertTemplateContract(1, "0.2.0")).not.toThrow();
	});

	test("any other value fails, naming both numbers, the upgrade notes and what keeps serving", () => {
		for (const given of [0, 2, undefined, "1"]) {
			expect(() => assertTemplateContract(given, "9.9.9")).toThrow(
				new RegExp(
					`@urumi\\.ai/otta-store 9\\.9\\.9 needs template contract 1, but astro\\.config\\.mjs ` +
						`passes otta\\(\\{ template: ${String(given)} \\}\\)[\\s\\S]*UPGRADING\\.md[\\s\\S]*` +
						`set template: 1[\\s\\S]*keeps serving the last version that built`,
				),
			);
		}
	});

	test("otta() checks it before anything else, while the config loads", () => {
		expect(() => otta({ template: 2, env: {} })).toThrow(/needs template contract 1/);
		expect(otta({ template: 1, env: {} }).name).toBe(OTTA_INTEGRATION_NAME);
	});
});

describe("build settings read while the config loads", () => {
	test("a leftover STRIPE_PUBLIC_KEY fails, never echoing the value (#498)", () => {
		expect(() => otta({ template: 1, env: { STRIPE_PUBLIC_KEY: "pk_test_SECRETISH" } })).toThrow(
			/no longer read.*Stripe publishable key/s,
		);
		expect(() =>
			otta({ template: 1, env: { STRIPE_PUBLIC_KEY: "pk_test_SECRETISH" } }),
		).not.toThrow(/SECRETISH/);
	});

	test("an option wins over the environment, and both are validated", () => {
		expect(() => otta({ template: 1, env: { OTTA_EXTRA_ALLOWED_HOSTS: "localhost" } })).toThrow(
			/OTTA_EXTRA_ALLOWED_HOSTS/,
		);
		expect(() =>
			otta({
				template: 1,
				extraAllowedHosts: "api.example.com",
				env: { OTTA_EXTRA_ALLOWED_HOSTS: "localhost" },
			}),
		).not.toThrow();
		expect(() => otta({ template: 1, emailFrom: "not-an-address", env: {} })).toThrow(
			/OTTA_EMAIL_FROM/,
		);
	});

	test("the playground never reads a sender", () => {
		expect(() =>
			otta({ template: 1, playground: true, env: { OTTA_EMAIL_FROM: "not-an-address" } }),
		).not.toThrow();
	});
});

describe("assertSeedFound", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("passes for package.json → emdash.seed, seed/seed.json or .emdash/seed.json", () => {
		dir = mkdtempSync(path.join(tmpdir(), "otta-seed-"));
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ emdash: { seed: path.relative(dir, OTTA_SEED) } }),
		);
		expect(() => assertSeedFound(dir)).not.toThrow();
		writeFileSync(path.join(dir, "package.json"), "{}");
		mkdirSync(path.join(dir, "seed"));
		writeFileSync(path.join(dir, "seed", "seed.json"), "{}");
		expect(() => assertSeedFound(dir)).not.toThrow();
	});

	test("fails, naming the fix, when EmDash would fall back to its own seed", () => {
		dir = mkdtempSync(path.join(tmpdir(), "otta-seed-"));
		writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ emdash: { seed: "nope.json" } }),
		);
		expect(() => assertSeedFound(dir)).toThrow(
			/no products collection[\s\S]*node_modules\/@urumi\.ai\/otta-store\/seed\/seed\.json/,
		);
	});
});

describe("package files", () => {
	test("packageRoot is this package, from src/ and from anywhere below it", () => {
		expect(packageRoot()).toBe(PKG);
		expect(packageRoot(path.join(PKG, "src", "lib"))).toBe(PKG);
	});

	test("the public scripts the pages load by URL are all shipped", () => {
		expect(readdirSync(PUBLIC_SCRIPTS_DIR).toSorted()).toEqual([
			"add-to-cart-key.js",
			"playground-star.js",
			"region-picker.js",
		]);
	});
});

describe("the runtime source a site's Vite build compiles from node_modules", () => {
	// Astro's env plugin scans each module's TEXT. One mention of import.meta.env
	// that is not a `.KEY` member read — comments included — makes it inline every
	// build variable whose name appears in that module into the Worker. The
	// build-time modules run in Node and are never bundled into the Worker.
	const BUILD_TIME_ONLY = new Set(["integration.ts", path.join("lib", "build-path-scrub.ts")]);

	test("names import.meta.env only as a `.KEY` member read, in code and comments", () => {
		const offenders: string[] = [];
		const src = path.join(PKG, "src");
		for (const file of readdirSync(src, { recursive: true }).map(String)) {
			if (!/\.(ts|astro)$/.test(file) || BUILD_TIME_ONLY.has(file)) continue;
			readFileSync(path.join(src, file), "utf8")
				.split("\n")
				.forEach((line, index) => {
					if (/import\.meta\.env(?!\.[A-Z_]+\b)/.test(line)) {
						offenders.push(`${file}:${String(index + 1)}`);
					}
				});
		}
		expect(offenders).toEqual([]);
	});
});
