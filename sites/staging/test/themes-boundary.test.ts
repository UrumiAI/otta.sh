/**
 * The theme boundary — what a file under `src/themes/**` may and may not do.
 *
 * Themes are presentation. Pages keep every decision with a consequence: data
 * loading, BUSY → 503 (`markBusy`), 404/503 status, redirects, cookies, the
 * origin guard, the return path. If a theme could reach any of those, a second
 * theme would be a second copy of the store's logic, drifting from the first
 * one release at a time. So the sweep is over WHATEVER IS ON DISK under
 * `src/themes/`, not a list — a theme added tomorrow is covered the moment it
 * lands:
 *
 *  - no import of `lib/otta-api`, `origin-guard`, `cart-cookie`,
 *    `checkout-cookie`;
 *  - no `Astro.redirect`, `Astro.cookies`, `Astro.response` anywhere, and no
 *    `Astro.url` in a theme template (a view prints the model, it does not
 *    read the request);
 *  - no `<style>` block and no side-effect CSS import: the registry imports
 *    every theme statically, so either would ship one theme's CSS on every
 *    theme's pages. A theme's Layout LINKS its sheets through `?url`.
 *
 * And the registry is held to the manifest, which is the single theme list
 * (it once fed the admin's theme picker too; that picker is gone).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { DEFAULT_THEME_ID, isThemeId, STORE_THEMES } from "../src/themes/manifest.js";
import { THEMES } from "../src/themes/registry.js";
import { COMMERCE_VIEW_FILES } from "./theme-views.js";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const THEMES_DIR = path.join(SRC, "themes");

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const full = path.join(dir, name);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

const rel = (file: string): string => path.relative(SRC, file).split(path.sep).join("/");
const FILES = walk(THEMES_DIR).map(rel).toSorted();
const CODE = FILES.filter((file) => /\.(astro|ts)$/.test(file));
const TEMPLATES = FILES.filter((file) => file.endsWith(".astro"));
const read = (file: string): string => readFileSync(path.join(SRC, file), "utf8");

/**
 * Comments out — prose explaining a rule must be free to name what it bans.
 * Each removed comment becomes a space, not "", so removing one can never splice
 * its neighbours into a new comment opener that hides code from the checks.
 */
const code = (file: string): string =>
	read(file)
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, " ")
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.replace(/<!--[\s\S]*?-->/g, " ")
		.replace(/^\s*\/\/.*$/gm, "");

const THEME_DIRS = readdirSync(THEMES_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.map((entry) => entry.name)
	.toSorted();

test("the sweep found the themes — an empty list would pass every case below", () => {
	expect(THEME_DIRS).toContain("tempered");
	expect(TEMPLATES).toEqual(
		expect.arrayContaining([
			"themes/tempered/Layout.astro",
			"themes/tempered/HomeView.astro",
			"themes/tempered/ShopView.astro",
			"themes/tempered/ProductView.astro",
			...Object.values(COMMERCE_VIEW_FILES).map((file) => `themes/tempered/${file}`),
		]),
	);
	expect(CODE).toEqual(expect.arrayContaining(["themes/registry.ts", "themes/resolve.ts"]));
});

describe("themes are presentation — no store logic reaches src/themes/**", () => {
	const BANNED_MODULES = ["otta-api", "origin-guard", "cart-cookie", "checkout-cookie"];

	test.each(CODE)("%s imports none of the page-logic modules", (file) => {
		for (const name of BANNED_MODULES) {
			expect(code(file), `${file} imports lib/${name}`).not.toMatch(
				new RegExp(`from\\s+["'][^"']*\\b${name}(\\.js|\\.ts)?["']`),
			);
			expect(code(file), `${file} dynamically imports lib/${name}`).not.toMatch(
				new RegExp(`import\\(\\s*["'][^"']*\\b${name}`),
			);
		}
	});

	test.each(CODE)("%s never redirects, touches cookies or sets the response", (file) => {
		expect(code(file)).not.toMatch(/Astro\.(redirect|cookies|response)\b/);
	});

	test.each(TEMPLATES)(
		"%s does not read the request URL — the model carries the answer",
		(file) => {
			expect(code(file)).not.toMatch(/Astro\.url\b/);
			expect(code(file)).not.toMatch(/searchParams/);
		},
	);

	test.each(TEMPLATES)("%s carries no <style> block", (file) => {
		expect(code(file)).not.toMatch(/<style[\s>]/);
	});

	test.each(CODE)("%s imports no stylesheet for its side effect", (file) => {
		// `import "./x.css"` would join EVERY page's CSS through the registry.
		expect(code(file)).not.toMatch(/^\s*import\s+["'][^"']+\.css["']/m);
		// A stylesheet import must be the `?url` form, whose value is linked.
		for (const [, specifier] of code(file).matchAll(/from\s+["']([^"']+\.css[^"']*)["']/g)) {
			expect(specifier, `${file}: ${specifier}`).toMatch(/\.css\?url$/);
		}
	});
});

describe("the theme list has one source", () => {
	test("the manifest's default is registered, and is Tempered", () => {
		expect(DEFAULT_THEME_ID).toBe("tempered");
		expect(isThemeId(DEFAULT_THEME_ID)).toBe(true);
	});

	test("ids are unique and every entry has a label", () => {
		const ids = STORE_THEMES.map((theme) => theme.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const theme of STORE_THEMES) expect(theme.label.trim().length).toBeGreaterThan(0);
	});

	test("the registry maps exactly the manifest's ids — no more, no fewer", () => {
		expect(Object.keys(THEMES).toSorted()).toEqual(
			STORE_THEMES.map((theme) => theme.id).toSorted(),
		);
		for (const [id, theme] of Object.entries(THEMES)) expect(theme.id, id).toBe(id);
	});

	test("every manifest theme has a directory, and every theme directory is in the manifest", () => {
		expect(THEME_DIRS).toEqual(STORE_THEMES.map((theme) => theme.id).toSorted());
	});

	test("the manifest is pure data — it may import nothing", () => {
		expect(code("themes/manifest.ts")).not.toMatch(/^\s*import\s/m);
	});
});

/**
 * What every theme's Layout owes the shell. These are the rules that would
 * silently break a page on ONE theme only.
 */
describe.each(THEME_DIRS)("the %s theme's Layout", (id) => {
	const layout = code(`themes/${id}/Layout.astro`);

	test("stamps the active theme id on <html>", () => {
		expect(layout).toMatch(/<html[^>]*\sdata-theme-id=\{chrome\.themeId\}/);
	});

	test("links its own token sheet through a ?url import", () => {
		expect(layout).toMatch(/import (\w+) from "\.\/theme\.css\?url"/);
		const name = /import (\w+) from "\.\/theme\.css\?url"/.exec(layout)?.[1] ?? "";
		expect(layout).toContain(`<link rel="stylesheet" href={${name}} />`);
	});

	test("renders the page in the default slot and forwards <head> additions", () => {
		expect(layout).toMatch(/<slot \/>/);
		expect(layout).toContain('<slot name="head" />');
	});

	test("emits only its OWN faces, from its own font namespace", () => {
		for (const [, variable] of layout.matchAll(/<Font cssVariable="([^"]+)"/g)) {
			expect(variable).toMatch(new RegExp(`^--f-${id}-`));
		}
	});
});

/**
 * The `--u-*` contract. Unported pages (cart, checkout, pay, orders, account,
 * 404) are styled with nothing but these names, so a theme that forgets one
 * leaves a hole in every one of those pages. The contract is every `--u-*`
 * Tempered's token sheet declares in its `:root` block.
 */
const rootBlock = (css: string): string => /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
const declared = (css: string): string[] =>
	[...rootBlock(css).matchAll(/(--u-[\w-]+)\s*:/g)].map((m) => m[1] ?? "").toSorted();

describe("every theme's theme.css defines the --u-* contract", () => {
	const CONTRACT = declared(read("themes/tempered/theme.css"));

	test("the contract parsed", () => {
		expect(CONTRACT).toEqual(
			expect.arrayContaining(["--u-ink", "--u-surface", "--u-display", "--u-body", "--u-data"]),
		);
	});

	test.each(THEME_DIRS)("%s", (id) => {
		expect(declared(read(`themes/${id}/theme.css`))).toEqual(expect.arrayContaining(CONTRACT));
	});
});

/**
 * The commerce views (Phase 3). Tempered ships all eight and is every theme's
 * fallback; any other theme wires a view exactly when it ships the file for it.
 * `test/theme-views.ts` resolves "which file renders X for theme Y" from the
 * files on disk for the source-pin suites — this is what keeps that resolution
 * equal to the registry's.
 */
describe("the commerce views — the registry wires exactly what is on disk", () => {
	const registry = read("themes/registry.ts");
	const themeBlock = (id: string): string =>
		new RegExp(`const ${id} = \\{([\\s\\S]*?)\\n\\} satisfies`).exec(registry)?.[1] ?? "";

	test("Tempered ships every commerce view", () => {
		for (const file of Object.values(COMMERCE_VIEW_FILES)) {
			expect(existsSync(path.join(THEMES_DIR, "tempered", file)), file).toBe(true);
		}
	});

	test.each(THEME_DIRS)("%s wires a commerce view if and only if it ships the file", (id) => {
		const block = themeBlock(id);
		expect(block, `no \`const ${id} = { … } satisfies\` in registry.ts`).not.toBe("");
		for (const [key, file] of Object.entries(COMMERCE_VIEW_FILES)) {
			const ships = existsSync(path.join(THEMES_DIR, id, file));
			expect(new RegExp(`\\b${key}:`).test(block), `${id}: views.${key} vs ${file}`).toBe(ships);
		}
	});

	test("an unported view falls back to Tempered's, and its sheet comes with it", () => {
		// `viewFor` is the fallback; `fallbackSheetFor` links Tempered's
		// commerce sheet whenever the view about to render IS Tempered's —
		// under Tempered or under a theme that has not ported it — and never
		// through a side-effect import.
		expect(registry).toContain("return theme.views[view] ?? tempered.views[view];");
		expect(registry).toContain('import temperedCommerceHref from "./tempered/commerce.css?url";');
		expect(registry).toMatch(
			/viewFor\(theme, view\) === tempered\.views\[view\] \? temperedCommerceHref : null/,
		);
		const shell = readFileSync(path.join(SRC, "layouts/Storefront.astro"), "utf8");
		expect(shell).toContain("fallbackSheetFor(theme, props.view)");
		expect(shell).toContain('<link rel="stylesheet" href={viewSheet} slot="head" />');
	});

	test("only a theme that renders the bag's lines in its chrome opts into the cart-lines read", () => {
		// `ThemeModule.chrome.cartLines` makes the shell pay one cart read on every
		// non-checkout page. A theme that sets it must actually DRAW the lines — its
		// Layout takes `chrome.bag` and it, or a theme component it imports, reads
		// the bag's `lines` (e.g. a bag drawer or a bag strip) — and
		// every theme that does not draw them must not set it (it would pay a read
		// for nothing). The scan goes ONE import deep (the Layout and the theme
		// components it imports directly); a theme that read the lines two
		// components down would need this widened.
		for (const id of THEME_DIRS) {
			const block = themeBlock(id);
			const layout = read(`themes/${id}/Layout.astro`);
			const opts = /chrome:\s*\{\s*cartLines:\s*true\s*\}/.test(block);
			const imported = [...code(`themes/${id}/Layout.astro`).matchAll(/from\s+"\.\/(\w+)\.astro"/g)]
				.map((match) => `themes/${id}/${match[1] ?? ""}.astro`)
				.map((file) => code(file))
				.join("\n");
			const draws =
				/chrome\.bag\b/.test(layout) &&
				/\bbag\.lines\b/.test(code(`themes/${id}/Layout.astro`) + imported);
			expect(opts, `${id}: chrome.cartLines vs drawing chrome.bag's lines`).toBe(draws);
		}
		// No theme this repo ships draws the lines today (Tempered's chrome shows a
		// count), so nothing in the registry sets it; the read itself is pinned
		// with an in-test fixture theme in bag.test.ts.
		expect(registry.match(/cartLines\s*:/g)).toBeNull();
	});

	test("the shell reads the bag only for an opted-in theme, off the checkout flow", () => {
		const shell = readFileSync(path.join(SRC, "layouts/Storefront.astro"), "utf8");
		// Opted in, not a checkout-flow view, and a cart link in the chrome to
		// hang the bag on — all three, or no read.
		expect(shell).toMatch(
			/const drawsBag =\s*theme\.chrome\?\.cartLines === true && !BAGLESS_VIEWS\.has\(props\.view \?\? ""\) && hasCartLink;/,
		);
		expect(shell).toMatch(
			/const hasCartLink = withAccountLink\(navItems\)\.some\(\(item\) => isCartLink\(item\.url\)\);/,
		);
		expect(shell).toMatch(/const bagPending = drawsBag\s*\?\s*readBag\(/);
		expect(shell).toContain('new Set(["cart", "checkout", "pay", "order"])');
		// Started before the settings read is awaited, so the two run together.
		expect(shell.indexOf("const bagPending")).toBeLessThan(shell.indexOf("await settingsRead"));
		// One call site, no other commerce read in the shell.
		expect(shell.match(/readBag\(/g)).toHaveLength(1);
		expect(shell).not.toMatch(/dispatchOttaRoute/);
		expect(shell).not.toMatch(/markBusy/);
	});
});
