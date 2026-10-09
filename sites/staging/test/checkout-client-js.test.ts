/**
 * C10 (storefront-checkout plan §3) — source-text pins for the security-relevant
 * rendering decisions ADR-0012 makes, in the `json-ld-xss.test.ts` style.
 *
 * There is no render/DOM harness in this package (plan §7.3 / issue #40), so
 * anything stated in the design and not asserted here WILL drift. Everything in
 * this file is a property of the SOURCE, chosen so it can be checked reliably:
 * the client-JS fence, the `no-referrer` meta, and — structurally, not by
 * naive substring search — the rule that Stripe's redirect parameters never
 * reach the rendered markup.
 */
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { hasExecutableScript, splitAstro } from "./astro-source.js";
import { viewCases } from "./theme-views.js";

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src");
const PAGES_DIR = path.join(SRC_DIR, "pages");
const COMPONENTS_DIR = path.join(SRC_DIR, "components");

/** Strip comments from an interpolation expression: the no-echo rule is about what
 *  the template RENDERS, so prose explaining why it doesn't leak is not a leak. */
const stripComments = (expr: string): string =>
	expr.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const PAY_RELATIVE = path.join("checkout", "pay.astro");
const PAY_PAGE = path.join(PAGES_DIR, PAY_RELATIVE);
const ORDER_PAGE = path.join(PAGES_DIR, "orders/[orderId].astro");

function listPages(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...listPages(full));
		else if (entry.name.endsWith(".astro")) out.push(full);
	}
	return out;
}

/**
 * The modules a file imports that can carry components, resolved to absolute
 * paths: every `.astro` import, AND every relative TypeScript module (a `.js`
 * specifier in this tree is a `.ts` file).
 *
 * One level is not enough: a page importing a component that imports a scripted
 * one ships the script just the same, so this is walked transitively below.
 *
 * The `.ts` half is load-bearing since the theme system. Every page renders
 * through `layouts/Storefront.astro`, which reaches the theme views through
 * `themes/registry.ts` — a TypeScript module importing `.astro` files. A walk
 * that only followed `.astro` imports would stop at the registry and never see
 * a theme view, which is exactly where a second theme's first script would
 * land. Type-only imports erase at build time and are not followed.
 *
 * An unresolved specifier THROWS rather than being filtered out. A fence that
 * silently drops what it cannot resolve is a fence that a rename turns off, and
 * it turns off in the safe-looking direction — everything passes.
 */
function componentImports(file: string): string[] {
	const source = readFileSync(file, "utf8");
	const unresolved = (specifier: string): Error =>
		new Error(
			`the client-JS fence cannot resolve "${specifier}" imported by ${path.relative(SRC_DIR, file)} — ` +
				"fix the path, or the fence stops covering this page",
		);
	const astro = [...source.matchAll(/^import\s+\w+\s+from\s+["']([^"']+\.astro)["'];?$/gm)].map(
		(m) => {
			const resolved = path.resolve(path.dirname(file), m[1] ?? "");
			if (!existsSync(resolved)) throw unresolved(m[1] ?? "");
			return resolved;
		},
	);
	const modules = [
		...source.matchAll(/^import\s+(?!type\b)[^;]*?\sfrom\s+["'](\.{1,2}\/[^"']+)\.js["'];?$/gm),
	].map((m) => {
		const resolved = path.resolve(path.dirname(file), `${m[1] ?? ""}.ts`);
		if (!existsSync(resolved)) throw unresolved(`${m[1] ?? ""}.js`);
		return resolved;
	});
	return [...astro, ...modules];
}

/** Every module this one pulls in, transitively — `.astro` and `.ts` alike. */
function componentClosure(entry: string): string[] {
	const seen = new Set<string>();
	const queue = componentImports(entry);
	while (queue.length > 0) {
		const next = queue.pop();
		if (next === undefined || seen.has(next)) continue;
		seen.add(next);
		queue.push(...componentImports(next));
	}
	return [...seen];
}

/**
 * WHERE CLIENT JAVASCRIPT IS ALLOWED TO REACH A PAGE — the whole list
 * (ADR-0012 decision 2, as amended 2026-07-28, and ADR-0034).
 *
 * A named allowlist rather than a predicate, so that widening it is a diff
 * someone has to write and defend. Each entry is `page → component`, relative
 * to `src/pages` and by basename.
 */
const PERMITTED_CLIENT_JS: ReadonlyArray<readonly [string, string]> = [
	// The theme spec (§6) postdates ADR-0012 and makes the hold countdown a
	// ticking timer a shopper times a decision against — information, not
	// decoration, and it cannot be server-rendered without going stale in one
	// second. See the ADR's 2026-07-28 amendment.
	//
	// RENAMED, not widened (storefront themes, Phase 3): the pair was
	// `cart/index.astro → HoldRibbon.astro` while the ribbon's markup and its
	// script were one component. Theme views now draw the ribbon, and a view
	// is reached through the registry every page imports — so a view importing
	// a scripted ribbon would make EVERY page an offender. The script was split
	// out into `HoldClock.astro` (script only, no markup), which the cart PAGE
	// renders; `HoldRibbon.astro` is markup only. Still one page, still one
	// component, still exactly this pair.
	[path.join("cart", "index.astro"), "HoldClock.astro"],
	// ADR-0034 (supersedes ADR-0012 in part): the THIRD and last exception —
	// the review's optional state/province script. One external, first-party
	// file (`public/scripts/region-picker.js`, no inline code, no framework),
	// pure progressive enhancement: the page works unchanged without it.
	[path.join("checkout", "index.astro"), "RegionPicker.astro"],
];

/** The dev styleguide renders every component in every state and 404s outside
 *  dev (`dev-route-guard.test.ts`), so it is not a shipped surface. */
const STYLEGUIDE = path.join("dev", "tempered.astro");

/**
 * Every `page → component` pair through which browser code reaches a page,
 * under an arbitrary `pages` directory.
 *
 * `/checkout/pay` and the dev styleguide are excluded by identity, not by
 * allowlist: the first IS the sanctioned page (decision 1) and the second 404s
 * outside dev (`dev-route-guard.test.ts`).
 */
function clientJsRoutes(pagesDir: string): string[] {
	return listPages(pagesDir)
		.filter((file) => path.relative(pagesDir, file) !== PAY_RELATIVE)
		.filter((file) => path.relative(pagesDir, file) !== STYLEGUIDE)
		.flatMap((file) => {
			const relative = path.relative(pagesDir, file);
			const own = hasExecutableScript(readFileSync(file, "utf8"))
				? [`${relative} → (its own template)`]
				: [];
			const viaImports = componentClosure(file)
				.filter((component) => component.endsWith(".astro"))
				.filter((component) => hasExecutableScript(readFileSync(component, "utf8")))
				.map((component) => `${relative} → ${path.basename(component)}`);
			return [...own, ...viaImports];
		})
		.toSorted();
}

const PERMITTED = PERMITTED_CLIENT_JS.map(
	([page, component]) => `${page} → ${component}`,
).toSorted();

/**
 * A throwaway copy of `src/` with some files added or replaced, for asking the
 * fence about a tree that does not exist yet. Torn down by the OS; nothing is
 * written inside the repo.
 */
function scratchTree(files: Record<string, string>): string {
	const root = mkdtempSync(path.join(tmpdir(), "otta-fence-"));
	cpSync(SRC_DIR, root, { recursive: true });
	for (const [relative, contents] of Object.entries(files)) {
		const target = path.join(root, relative);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, contents);
	}
	return root;
}

describe("10a — the client-JS fence (ADR-0012 decision 2)", () => {
	const source = readFileSync(PAY_PAGE, "utf8");

	test("/checkout/pay is the ONLY page carrying an executable <script>", () => {
		const offenders = listPages(PAGES_DIR)
			.filter((file) => file !== PAY_PAGE)
			.filter((file) => hasExecutableScript(readFileSync(file, "utf8")))
			.map((file) => path.relative(PAGES_DIR, file));
		expect(offenders).toEqual([]);
		expect(hasExecutableScript(source)).toBe(true);
	});

	test("client JS reaches EXACTLY the pages ADR-0012 names, and through the components it names", () => {
		// The first cut of increment 5 put the confirmation page's poll sweep on
		// `HoldRibbon`, whose bundled countdown Astro then emitted onto
		// /orders/<id> — a page ADR-0012 specifies as carrying none. The page's
		// own source was spotless, so the file-level check above saw nothing.
		// Browser code arrives through IMPORTS too, and this is that half.
		//
		// EQUALITY, not a subset. A subset check only ever asks "is every route
		// permitted?" and never "is every permission still earned?" — so an
		// entry whose page stopped importing the component would rot open,
		// pre-approving a pair nobody uses until something re-introduces it by
		// accident. Both directions are faults, so both fail. (This was a
		// subset while the themed cart was still on its own branch and this
		// tree carried the pre-theme page importing nothing; that page has
		// since merged, so the allowlist is now exactly the tree.)
		expect(clientJsRoutes(PAGES_DIR)).toEqual(PERMITTED);
	});

	test("the scripted components are named, so growing one is a decision", () => {
		// `HoldClock` is the cart's §6 countdown SCRIPT and the only component
		// that runs anything (`HoldRibbon` is its markup, with no script).
		// `PollRibbon` exists precisely so the confirmation page can have the
		// same ribbon without it.
		const scripted = readdirSync(COMPONENTS_DIR)
			.filter((name) => name.endsWith(".astro"))
			.filter((name) => hasExecutableScript(readFileSync(path.join(COMPONENTS_DIR, name), "utf8")))
			.toSorted();
		expect(scripted).toEqual(["HoldClock.astro", "RegionPicker.astro"]);
	});

	test("the walk sees THROUGH the theme registry, into every view and the shared form", () => {
		// Page → Storefront.astro → themes/registry.ts → themes/<id>/*.astro. If
		// the `.ts` hop were dropped, every theme view would sit outside the
		// fence while the equality check above still passed.
		const closure = componentClosure(path.join(PAGES_DIR, "index.astro")).map((file) =>
			path.relative(SRC_DIR, file).split(path.sep).join("/"),
		);
		expect(closure).toEqual(
			expect.arrayContaining([
				"layouts/Storefront.astro",
				"themes/registry.ts",
				"themes/tempered/Layout.astro",
				"themes/tempered/HomeView.astro",
				"themes/tempered/ShopView.astro",
				"themes/tempered/ProductView.astro",
				"themes/tempered/CartView.astro",
				"themes/tempered/CheckoutView.astro",
				"themes/tempered/PayView.astro",
				"themes/tempered/OrderView.astro",
				"themes/tempered/AccountLoginView.astro",
				"themes/tempered/AccountVerifyView.astro",
				"themes/tempered/AccountOrdersView.astro",
				"themes/tempered/AccountOrderView.astro",
				"components/HoldRibbon.astro",
				"forms/AddToCartFields.astro",
			]),
		);
	});

	test("no theme and no shared form ships client JS — a theme script is a decision, not a drift", () => {
		// Every theme renders on every page type, so a script here would reach
		// pages ADR-0012 keeps free of client JavaScript. A future theme that
		// needs one must name it in PERMITTED_CLIENT_JS, page by page.
		const scripted = ["themes", "forms"].flatMap((dir) =>
			listPages(path.join(SRC_DIR, dir))
				.filter((file) => hasExecutableScript(readFileSync(file, "utf8")))
				.map((file) => path.relative(SRC_DIR, file)),
		);
		expect(scripted).toEqual([]);
	});

	test("an unresolvable import FAILS the fence rather than being skipped", () => {
		// A fence that silently drops what it cannot resolve is a fence a rename
		// switches off — and it switches off in the direction where everything
		// passes.
		const tree = scratchTree({
			"pages/ghost.astro": '---\nimport Gone from "../components/Gone.astro";\n---\n<Gone />',
		});
		expect(() => clientJsRoutes(path.join(tree, "pages"))).toThrow(/cannot resolve/);
	});
	test("it references EXACTLY ONE external script origin, and that origin is Stripe's", () => {
		const origins = new Set(
			[...source.matchAll(/https?:\/\/[^"'\s)]+/g)]
				.map((m) => new URL(m[0]).origin)
				.filter((origin) => origin !== "http://localhost:4321"),
		);
		expect([...origins]).toEqual(["https://js.stripe.com"]);
	});

	test("the client secret is passed as a data- attribute (HTML-escaped by Astro), NEVER injected into the script", () => {
		expect(source).toMatch(/data-client-secret=\{/);
		// `define:vars` is Astro's mechanism for baking a server value into a
		// script tag — i.e. exactly "the secret becomes a JS literal". Forbidden:
		// the script reads what it needs from the DOM instead, where Astro's own
		// attribute escaping applies.
		expect(source).not.toMatch(/<script[^>]*define:vars/i);

		const { body } = splitAstro(source);
		const scriptBlocks = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script[^>]*>/gi)].map(
			(m) => m[1] ?? "",
		);
		expect(scriptBlocks.length).toBeGreaterThan(0);
		// No string-template assembly inside the script either.
		for (const block of scriptBlocks) expect(block).not.toContain("${");
		// And the secret genuinely arrives through the DOM.
		expect(scriptBlocks.join("\n")).toMatch(/dataset\.clientSecret/);
	});

	test("a <noscript> block explains the one step that genuinely needs JS, and links onward", () => {
		const block = /<noscript>([\s\S]*?)<\/noscript>/.exec(source)?.[1] ?? "";
		expect(block.length).toBeGreaterThan(0);
		// A recoverable, linked state — not a broken form. It must say WHY
		// (the card number never touches this site), that the order is held,
		// and give a way onward.
		expect(block).toMatch(/JavaScript/i);
		// The hold is the ORDER's own deadline (QA U-14), not a fixed "15 minutes":
		// a resumed payment has less left than that.
		expect(block).toMatch(/model\.holdNote\.lead/);
		expect(block).toMatch(/reserved for a limited time/);
		expect(block).toContain("href={orderPath}");
	});

	test("the publishable key is read from the build-time module, never from a runtime env lookup on the page", () => {
		expect(source).toContain("stripe-config");
		expect(source).not.toContain("process.env");
		expect(source).not.toContain("import.meta.env.STRIPE");
	});
});

/**
 * The fence, aimed at trees other than the working copy.
 *
 * Increment 5 and the cart increment are being built on separate branches, so
 * the interesting question — "does this fence red-line the tree we are about to
 * merge?" — cannot be asked of `src/` alone. These build a scratch copy and ask
 * it there. Synthesised rather than read out of a sibling worktree on purpose:
 * the SHAPE is what matters, and a test that reaches into another checkout
 * passes or fails for reasons that have nothing to do with this repo's state.
 */
describe("10a′ — the fence against a merged tree", () => {
	test("the cart's §6 countdown is permitted, and named", () => {
		// This is what lands when the cart branch merges: `/cart` renders the
		// countdown, so HoldClock's module ships with it. ADR-0012's
		// 2026-07-28 amendment allows exactly this pair, and the allowlist entry
		// is what stops it being a surprise.
		const tree = scratchTree({
			"pages/cart/index.astro":
				'---\nimport HoldClock from "../../components/HoldClock.astro";\n---\n<HoldClock />',
		});
		expect(clientJsRoutes(path.join(tree, "pages"))).toEqual(PERMITTED);
	});

	test("…and the SAME component on an UNNAMED page is still an offender", () => {
		// The allowlist is `page → component` pairs, not "these components are
		// fine anywhere". Without that, the amendment would have quietly
		// re-opened every page to the countdown.
		const tree = scratchTree({
			"pages/cart/index.astro":
				'---\nimport HoldClock from "../../components/HoldClock.astro";\n---\n<HoldClock />',
			"pages/rogue.astro":
				'---\nimport HoldClock from "../components/HoldClock.astro";\n---\n<HoldClock />',
		});
		const routes = clientJsRoutes(path.join(tree, "pages"));
		expect(routes).toContain("rogue.astro → HoldClock.astro");
		expect(routes).not.toEqual(PERMITTED);
	});

	test("a THEME VIEW that imports the scripted countdown is an offender on every page", () => {
		// Why the countdown is split. Every page reaches every theme view through
		// the registry, so the script must be rendered by the cart PAGE and never
		// by a view — here is the tree where a view forgets that.
		const tree = scratchTree({
			"themes/tempered/CartView.astro":
				'---\nimport HoldClock from "../../components/HoldClock.astro";\n---\n<HoldClock />',
		});
		const routes = clientJsRoutes(path.join(tree, "pages"));
		expect(routes).toContain("index.astro → HoldClock.astro");
		expect(routes).toContain(`${path.join("orders", "[orderId].astro")} → HoldClock.astro`);
		expect(routes).not.toEqual(PERMITTED);
	});

	test("a page that hydrates a framework component is an offender too", () => {
		// Nothing in this theme uses a `client:*` directive today, which is
		// exactly why the fence should notice the first one.
		const tree = scratchTree({
			"pages/island.astro": "---\n---\n<SomeIsland client:load />",
		});
		expect(clientJsRoutes(path.join(tree, "pages"))).toContain("island.astro → (its own template)");
	});
});

describe("10b — the confirmation page does not leak the secret Stripe puts in OUR url", () => {
	const source = readFileSync(ORDER_PAGE, "utf8");

	test('carries <meta name="referrer" content="no-referrer">', () => {
		// Stripe appends payment_intent_client_secret to our return_url (ADR-0012
		// decision 6). This meta is the only thing between that and a subresource
		// Referer leak, and it is specified in three places — so it is asserted
		// once, here, rather than trusted to survive an edit.
		expect(source).toMatch(/<meta[^>]*name="referrer"[^>]*content="no-referrer"[^>]*>/);
	});
});

describe("10c — Stripe's redirect parameters are read, never rendered", () => {
	const source = readFileSync(ORDER_PAGE, "utf8");
	const { frontmatter, body } = splitAstro(source);
	const PARAMS = ["payment_intent_client_secret", "payment_intent", "redirect_status"] as const;

	test("the file really does have a frontmatter fence (otherwise the split below proves nothing)", () => {
		expect(frontmatter.length).toBeGreaterThan(0);
		expect(body.length).toBeGreaterThan(0);
		expect(body).not.toContain(frontmatter);
	});

	test.each(PARAMS)(
		"%s appears ONLY in the frontmatter (server-side), never in the template body",
		(param) => {
			// STRUCTURAL, not a substring scan of the whole file: a naive
			// "the file doesn't contain the value" regex passes trivially and would
			// miss the real shape of the bug — a frontmatter variable holding the
			// parameter, interpolated into the body below. Astro's frontmatter /
			// template split is exactly the boundary "does this reach the markup?"
			// turns on, so the assertion keys on that.
			expect(body).not.toContain(param);
		},
	);

	test("the body interpolates no variable whose name suggests it holds one of those parameters", () => {
		// SCOPE, honestly: this is a NAMING-CONVENTION pin, not a dataflow analysis.
		// A frontmatter variable holding one of these params under an innocuous name
		// (`const x = searchParams.get("payment_intent_client_secret")`, then `{x}`)
		// defeats it. Today nothing does — only the boolean `returnedFromStripe`
		// reaches the body — and that is what the frontmatter/body split above pins.
		// Treat this as defence in depth against the obvious spelling, not a proof.
		// The other half of the same rule: catch `{clientSecret}` / `{paymentIntent}`
		// in the template even when the literal parameter name stays upstairs.
		// Comments inside an expression block are stripped first — the rule is
		// about what the template RENDERS, and prose explaining why it doesn't is
		// not a leak.
		const interpolations = [...body.matchAll(/\{([^}]*)\}/g)].map((m) => stripComments(m[1] ?? ""));
		const leaking = interpolations.filter((expr) =>
			/client_?secret|payment_?intent|redirect_?status/i.test(expr),
		);
		expect(leaking).toEqual([]);
	});

	test("they are read for copy selection only — the page never treats redirect_status as proof of payment", () => {
		// The webhook is the sole pending→paid authority (ADR-0012 decision 5).
		expect(frontmatter).not.toMatch(
			/redirect_?[sS]tatus\s*===?\s*["']succeeded["']\s*\?\s*["']paid/,
		);
		expect(source).not.toMatch(/state\s*=\s*["']paid["']/);
	});
});

/**
 * 10c, where the markup went. Since Phase 3 the confirmation's markup is a
 * theme view (each theme's own, or Tempered's fallback); the page hands it a
 * model that carries the COPY the redirect parameters chose and never the
 * parameters. The same structural assertions, over every theme's view.
 */
describe.each(viewCases("order"))(
	"10c — the order view %s never renders them either",
	(_label, { source }) => {
		const { frontmatter, body } = splitAstro(source);
		const PARAMS = ["payment_intent_client_secret", "payment_intent", "redirect_status"] as const;

		test("the file really does have a frontmatter fence (otherwise the split below proves nothing)", () => {
			expect(frontmatter.length).toBeGreaterThan(0);
			expect(body.length).toBeGreaterThan(0);
			expect(body).not.toContain(frontmatter);
		});

		test.each(PARAMS)("%s appears nowhere in the view — not even its frontmatter", (param) => {
			// Stricter than the page's rule on purpose: a view has no business
			// reading the request at all (themes-boundary.test.ts), so the name has
			// no reason to be in the file.
			expect(source).not.toContain(param);
		});

		test("the body interpolates no variable whose name suggests it holds one of those parameters", () => {
			const interpolations = [...body.matchAll(/\{([^}]*)\}/g)].map((m) =>
				stripComments(m[1] ?? ""),
			);
			const leaking = interpolations.filter((expr) =>
				/client_?secret|payment_?intent|redirect_?status/i.test(expr),
			);
			expect(leaking).toEqual([]);
		});

		test("it never treats anything as proof of payment itself", () => {
			expect(source).not.toMatch(/state\s*=\s*["']paid["']/);
			expect(source).not.toMatch(/redirect_?[sS]tatus/);
		});
	},
);

describe("ADR-0034 — the checkout's region script is exactly what it says", () => {
	const component = readFileSync(path.join(COMPONENTS_DIR, "RegionPicker.astro"), "utf8");
	const script = readFileSync(path.resolve(SRC_DIR, "../public/scripts/region-picker.js"), "utf8");

	test("ONE external, first-party <script src>: no inline code", () => {
		const tags = [...component.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
		expect(tags).toHaveLength(1);
		expect(tags[0]![1]).toMatch(/\bsrc="\/scripts\/region-picker\.js"/);
		expect(tags[0]![2]!.trim()).toBe("");
	});

	test("small, frameworkless, and only about the region list", () => {
		expect(script.split("\n").length).toBeLessThanOrEqual(60);
		expect(script).not.toMatch(/\bimport\b|\brequire\(/);
		// It reads one first-party endpoint and nothing else.
		expect([...script.matchAll(/fetch\(/g)]).toHaveLength(1);
		expect(script).toContain("/checkout/regions?country=");
		expect(script).not.toMatch(/https?:\/\//);
	});
});
