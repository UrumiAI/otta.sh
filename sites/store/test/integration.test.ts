/**
 * The `otta()` integration (ADR-0045): the routes it injects, the template
 * contract, the seed check and the public scripts. The config it contributes
 * (defines, fonts, guards) is pinned where it was before the move:
 * `fonts-config.test.ts` here, and `sites/staging/test/site-config.test.ts`,
 * `default-email.test.ts` and `build-path-leak.test.ts`, which run the real
 * hook through the staging site's config.
 */
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import otta, {
	assertLiveConfig,
	assertSeedFound,
	assertTemplateContract,
	OTTA_INTEGRATION_NAME,
	OTTA_SEED,
	OTTA_TEMPLATE_CONTRACT,
	packageRoot,
	assertNoPublicCollisions,
	PUBLIC_DIR,
	publicCollisions,
	publicFilesDevPlugin,
	publicFileFor,
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
			// Not pages: declaration and test files, and anything under a `_` name.
			writeFileSync(path.join(dir, "a", "types.d.ts"), "");
			writeFileSync(path.join(dir, "a", "x.test.ts"), "");
			writeFileSync(path.join(dir, "_helper.ts"), "");
			mkdirSync(path.join(dir, "_partials"));
			writeFileSync(path.join(dir, "_partials", "card.astro"), "");
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

	test("the static files pages and the seed name by URL are all shipped", () => {
		expect(readdirSync(path.join(PUBLIC_DIR, "scripts")).toSorted()).toEqual([
			"add-to-cart-key.js",
			"playground-star.js",
			"region-picker.js",
		]);
		// The sample products' photographs, which the seed's images point at.
		const seed = readFileSync(OTTA_SEED, "utf8");
		for (const src of seed.match(/\/playground-products\/[a-z-]+\.jpg/g) ?? []) {
			expect(publicFileFor(src), src).toBeDefined();
		}
		expect(seed).toContain("/playground-products/");
	});

	test("publicFileFor serves only files inside the package's public/", () => {
		expect(publicFileFor("/scripts/region-picker.js?v=1")).toBe(
			path.join(PUBLIC_DIR, "scripts", "region-picker.js"),
		);
		expect(publicFileFor("/scripts")).toBeUndefined();
		expect(publicFileFor("/scripts/nope.js")).toBeUndefined();
		expect(publicFileFor("/../package.json")).toBeUndefined();
		expect(publicFileFor("/%2e%2e/package.json")).toBeUndefined();
		expect(publicFileFor("/scripts/..%2f..%2fpackage.json")).toBeUndefined();
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

describe("assertLiveConfig", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const SITE_FILE = [
		'import { defineLiveCollection } from "astro:content";',
		'import { ottaLiveCollections } from "@urumi.ai/otta-store/live-config";',
		"export const collections = ottaLiveCollections(defineLiveCollection);",
	].join("\n");

	test("passes a site file that calls defineLiveCollection itself", () => {
		dir = mkdtempSync(path.join(tmpdir(), "otta-live-"));
		mkdirSync(path.join(dir, "src"));
		writeFileSync(path.join(dir, "src", "live.config.ts"), SITE_FILE);
		expect(() => assertLiveConfig(dir)).not.toThrow();
	});

	test("fails a missing file, and a re-export of finished collections, saying what to write", () => {
		dir = mkdtempSync(path.join(tmpdir(), "otta-live-"));
		mkdirSync(path.join(dir, "src"));
		expect(() => assertLiveConfig(dir)).toThrow(/ottaLiveCollections\(defineLiveCollection\)/);
		writeFileSync(
			path.join(dir, "src", "live.config.ts"),
			'export { collections } from "@urumi.ai/otta-store/live-config";',
		);
		expect(() => assertLiveConfig(dir)).toThrow(/defineLiveCollection to that file only/);
	});

	test("a commented-out call does not count", () => {
		dir = mkdtempSync(path.join(tmpdir(), "otta-live-"));
		mkdirSync(path.join(dir, "src"));
		for (const commented of [
			`// export const collections = ottaLiveCollections(defineLiveCollection);\nexport const collections = {};`,
			`/* export const collections = ottaLiveCollections(defineLiveCollection); */\nexport const collections = {};`,
		]) {
			writeFileSync(path.join(dir, "src", "live.config.ts"), commented);
			expect(() => assertLiveConfig(dir)).toThrow(/must define the store's live collections/);
		}
	});

	test("the store's module is NAMED live.config.ts: defineLiveCollection checks its caller's file", () => {
		const pkg = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")) as {
			exports: Record<string, string>;
			publishConfig: { exports: Record<string, unknown> };
		};
		expect(pkg.exports["./live-config"]).toBe("./src/live.config.ts");
		expect(pkg.publishConfig.exports["./live-config"]).toBe("./src/live.config.ts");
	});

	test("the store's own module never imports defineLiveCollection as a value", () => {
		const source = readFileSync(path.join(PKG, "src", "live.config.ts"), "utf8");
		expect(source).toMatch(/^import type \{ defineLiveCollection \} from "astro:content";$/m);
		expect(source).not.toMatch(/^import \{[^}]*defineLiveCollection[^}]*\} from "astro:content"/m);
	});
});

describe("text the package ships to a site that is not this repository", () => {
	test("no code line (comments aside) names sites/staging or sites/store", () => {
		const offenders: string[] = [];
		for (const dir of ["src", "scripts"]) {
			const root = path.join(PKG, dir);
			for (const file of readdirSync(root, { recursive: true }).map(String)) {
				if (!/\.(ts|astro)$/.test(file)) continue;
				readFileSync(path.join(root, file), "utf8")
					.split("\n")
					.forEach((line, index) => {
						const code = line.trim();
						if (/^(\*|\/\/|\/\*)/.test(code)) return;
						if (/sites\/(staging|store)\b/.test(code))
							offenders.push(`${dir}/${file}:${String(index + 1)}`);
					});
			}
		}
		expect(offenders).toEqual([]);
	});
});

describe("the package's public files never replace the site's", () => {
	let dir: string;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	test("a site public/ file at one of the store's paths is named and refused", () => {
		dir = mkdtempSync(path.join(tmpdir(), "otta-public-"));
		mkdirSync(path.join(dir, "scripts"));
		writeFileSync(path.join(dir, "scripts", "region-picker.js"), "mine");
		writeFileSync(path.join(dir, "scripts", "mine.js"), "mine");
		writeFileSync(path.join(dir, "favicon.ico"), "");
		expect(publicCollisions(dir)).toEqual(["scripts/region-picker.js"]);
		expect(() => assertNoPublicCollisions(dir)).toThrow(/\/scripts\/region-picker\.js/);
	});

	test("no site public/ (or no overlap) passes", () => {
		dir = mkdtempSync(path.join(tmpdir(), "otta-public-"));
		expect(() => assertNoPublicCollisions(path.join(dir, "nope"))).not.toThrow();
		writeFileSync(path.join(dir, "robots.txt"), "");
		expect(() => assertNoPublicCollisions(dir)).not.toThrow();
	});

	test("the build copy refuses to overwrite a file already in the client output", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "otta-client-"));
		const integration = otta({ template: 1, env: {} });
		const done = integration.hooks["astro:config:done"] as (o: unknown) => void;
		const buildDone = integration.hooks["astro:build:done"] as () => Promise<void>;
		done({ config: { build: { client: pathToFileURL(`${dir}/`) } } });
		await buildDone();
		expect(readFileSync(path.join(dir, "scripts", "region-picker.js"), "utf8")).toBe(
			readFileSync(path.join(PUBLIC_DIR, "scripts", "region-picker.js"), "utf8"),
		);
		// A second copy finds every file already there and must not overwrite it.
		writeFileSync(path.join(dir, "scripts", "region-picker.js"), "the site's own");
		await expect(buildDone()).rejects.toThrow(/already has \/\S+, which the store ships/);
		expect(readFileSync(path.join(dir, "scripts", "region-picker.js"), "utf8")).toBe(
			"the site's own",
		);
	});

	test("a copy error other than EEXIST is reported as itself, not as a collision", async () => {
		dir = mkdtempSync(path.join(tmpdir(), "otta-client-"));
		// A read-only scripts/ directory: mkdir succeeds (it exists), copyFile fails EACCES.
		const scripts = path.join(dir, "scripts");
		mkdirSync(scripts);
		chmodSync(scripts, 0o500);
		try {
			const integration = otta({ template: 1, env: {} });
			const done = integration.hooks["astro:config:done"] as (o: unknown) => void;
			const buildDone = integration.hooks["astro:build:done"] as () => Promise<void>;
			done({ config: { build: { client: pathToFileURL(`${dir}/`) } } });
			const error = await buildDone().then(
				() => undefined,
				(e: unknown) => e as NodeJS.ErrnoException,
			);
			expect(error?.code).toBe("EACCES");
			expect(error?.message).not.toMatch(/which the store ships itself/);
		} finally {
			chmodSync(scripts, 0o700);
		}
	});

	test("in dev, only GET and HEAD are answered from public/", () => {
		type Handler = (
			req: { url?: string; method?: string },
			res: { setHeader(n: string, v: string): void; end(b: Buffer): void },
			next: () => void,
		) => void;
		let handler: Handler | undefined;
		publicFilesDevPlugin().configureServer({
			middlewares: { use: (h: Handler) => (handler = h) },
		});
		const call = (method: string) => {
			const out = { next: false, body: undefined as Buffer | undefined, type: "" };
			handler?.(
				{ url: "/scripts/region-picker.js", method },
				{ setHeader: (_n, v) => (out.type = v), end: (b) => (out.body = b) },
				() => (out.next = true),
			);
			return out;
		};
		expect(call("POST").next).toBe(true);
		expect(call("PUT").next).toBe(true);
		const get = call("GET");
		expect(get.next).toBe(false);
		expect(get.type).toMatch(/^text\/javascript/);
		expect(get.body?.length).toBeGreaterThan(0);
		const head = call("HEAD");
		expect(head.next).toBe(false);
		expect(head.body?.length).toBe(0);
	});
});

describe("one copy of each runtime in a site (ADR-0045)", () => {
	const pkg = JSON.parse(readFileSync(path.join(PKG, "package.json"), "utf8")) as {
		dependencies?: Record<string, string>;
		peerDependencies: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	// The site installs these itself (EmDash's generated modules import them from
	// the project root). As dependencies, a site on another version would get a
	// second copy nested under this package: two EmDash runtimes in one Worker.
	const RUNTIMES = [
		"emdash",
		"@emdash-cms/cloudflare",
		"astro",
		"@astrojs/cloudflare",
		"@astrojs/react",
		"react",
		"react-dom",
		"@urumi.ai/otta-plugin",
		"@urumi.ai/otta-admin-react",
	];

	test("each is a peer, never a dependency, and the workspace still has it for its own build", () => {
		for (const name of RUNTIMES) {
			expect(pkg.peerDependencies[name], name).toBeDefined();
			expect(pkg.dependencies?.[name], name).toBeUndefined();
			expect(pkg.devDependencies[name], name).toBeDefined();
		}
	});

	test("EmDash and its Cloudflare package are pinned exactly; the rest to the tested minor", () => {
		expect(pkg.peerDependencies["emdash"]).toBe("1.3.1");
		expect(pkg.peerDependencies["@emdash-cms/cloudflare"]).toBe("1.3.1");
		for (const name of ["astro", "@astrojs/cloudflare", "@astrojs/react", "react", "react-dom"]) {
			expect(pkg.peerDependencies[name], name).toMatch(/^~\d+\.\d+\.\d+$/);
		}
		// pnpm publishes workspace:* as the exact version.
		expect(pkg.peerDependencies["@urumi.ai/otta-plugin"]).toBe("workspace:*");
		expect(pkg.peerDependencies["@urumi.ai/otta-admin-react"]).toBe("workspace:*");
	});
});
