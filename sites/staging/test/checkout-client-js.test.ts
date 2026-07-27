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
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/pages");

/** Strip comments from an interpolation expression: the no-echo rule is about what
 *  the template RENDERS, so prose explaining why it doesn't leak is not a leak. */
const stripComments = (expr: string): string =>
	expr.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const PAY_PAGE = path.join(PAGES_DIR, "checkout/pay.astro");
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
 * Split an `.astro` file at its frontmatter fence.
 *
 * This is the boundary test 10c keys on, and it is a REAL one: everything above
 * the closing `---` is server-side TypeScript that never reaches the browser;
 * everything below is the template that becomes markup. A value can only be
 * rendered by appearing (or being interpolated) in the body.
 */
function splitAstro(source: string): { frontmatter: string; body: string } {
	const fence = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(source);
	if (fence === null) return { frontmatter: "", body: source };
	return { frontmatter: fence[1] ?? "", body: source.slice(fence[0].length) };
}

/** An executable `<script>` — i.e. NOT a data block like
 *  `type="application/ld+json"`, which carries no code. */
function hasExecutableScript(source: string): boolean {
	for (const match of source.matchAll(/<script\b([^>]*)>/g)) {
		const attrs = match[1] ?? "";
		if (/type\s*=\s*["']application\/(ld\+json|json)["']/.test(attrs)) continue;
		return true;
	}
	return false;
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
		expect(source).not.toMatch(/<script[^>]*define:vars/);

		const { body } = splitAstro(source);
		const scriptBlocks = [...body.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(
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
		expect(block).toMatch(/15 minutes/);
		expect(block).toContain("href={orderPath}");
	});

	test("the publishable key is read from the build-time module, never from a runtime env lookup on the page", () => {
		expect(source).toContain("stripe-config");
		expect(source).not.toContain("process.env");
		expect(source).not.toContain("import.meta.env.STRIPE");
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
