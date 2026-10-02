/**
 * The shopper's own pages are never stored by a cache (QA U-7).
 *
 * /cart, /checkout, /checkout/pay and /orders/<id> render one shopper's cart,
 * order and email — and /checkout/pay the PaymentIntent's CLIENT SECRET — in the
 * HTML. They were sent with no Cache-Control at all, so a shared cache was free
 * to store them.
 *
 * Each now calls `keepPrivate(Astro)` (lib/no-store.ts), and the call is the
 * point, not a header alone: `Cache-Control: private, no-store` keeps the page
 * out of HTTP caches, but Astro's ROUTE cache (Workers Cache on Cloudflare)
 * ignores that header and reads only `cache.set` — middleware.ts's "TWO
 * CACHES". So the test asserts the route-cache opt-out as well as the header.
 *
 * The call is FIRST in each frontmatter, before any dispatch, cookie write or
 * early return, so no rendered branch — an error state, a busy 503 — goes out
 * without it. (A redirect is a different Response and does not carry it; a
 * redirect has no body to store.) Pinned by source text, like every `.astro`
 * page here (no render harness exists — issue #40).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { ACCOUNT_NO_STORE } from "../src/lib/account.js";
import { keepPrivate, PRIVATE_NO_STORE } from "../src/lib/no-store.js";
import { splitAstro } from "./astro-source.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (relative: string): string =>
	readFileSync(path.resolve(HERE, "../src", relative), "utf8");
const frontmatterOf = (relative: string): string =>
	splitAstro(read(`pages/${relative}`)).frontmatter;

/** Statements only: the doc comment and the import list name these too. */
function codeOf(frontmatter: string): string {
	return frontmatter
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/^import [\s\S]*?;$/gm, "");
}

describe.each([
	"cart/index.astro",
	"checkout/index.astro",
	"checkout/pay.astro",
	"orders/[orderId].astro",
	// The account pages render a customer's own orders and sign-in state. They
	// set the header by hand before, which left them in the route cache.
	"account/orders/index.astro",
	"account/orders/[id].astro",
	"account/login/index.astro",
	"account/verify/index.astro",
])("%s is private", (relative) => {
	const frontmatter = frontmatterOf(relative);

	test("it calls keepPrivate(Astro) — the header AND the route-cache opt-out", () => {
		expect(frontmatter).toMatch(
			/import \{[^}]*\bkeepPrivate\b[^}]*\} from "(\.\.\/)+lib\/no-store\.js";/,
		);
		expect(codeOf(frontmatter)).toContain("keepPrivate(Astro);");
		// No hand-set header beside it: keepPrivate is the one way in.
		expect(codeOf(frontmatter)).not.toMatch(/headers\.set\("Cache-Control"/);
	});

	test("before anything can return, dispatch or touch a cookie", () => {
		const code = codeOf(frontmatter);
		const at = code.indexOf("keepPrivate(Astro);");
		expect(at).toBeGreaterThan(-1);
		for (const marker of [
			"return ",
			"dispatchOttaRoute(",
			"readCheckoutStash(",
			"clearCheckoutCookie(",
			"forgetSpentCart(",
			"Astro.redirect(",
		]) {
			const first = code.indexOf(marker);
			if (first !== -1) expect(at, `${marker} comes first`).toBeLessThan(first);
		}
	});
});

describe("keepPrivate is what those pages get", () => {
	test("the header is private, no-store and the route cache is told no", () => {
		const headers = new Headers();
		const cacheCalls: unknown[] = [];
		keepPrivate({ response: { headers }, cache: { set: (options) => cacheCalls.push(options) } });
		expect(headers.get("Cache-Control")).toBe("private, no-store");
		expect(cacheCalls).toEqual([false]);
	});
});

describe("ONE private, no-store constant", () => {
	// Four modules each declared their own "private, no-store" (theme-preview.ts
	// has since been removed with the theme previews). They are now the
	// same binding, re-exported under the names their callers already use, so a
	// change to the policy is one edit.
	test("the account and middleware names are the no-store module's constant", () => {
		expect(ACCOUNT_NO_STORE).toBe(PRIVATE_NO_STORE);
		for (const [file, name] of [
			["lib/account.ts", "ACCOUNT_NO_STORE"],
			["middleware.ts", "PER_SHOPPER_NO_STORE"],
		] as const) {
			const source = read(file);
			expect(source, file).toMatch(
				new RegExp(
					`export \\{ PRIVATE_NO_STORE as ${name} \\} from "\\.\\.?/(lib/)?no-store\\.js";`,
				),
			);
			expect(source, file).not.toMatch(/=\s*"private, no-store"/);
		}
	});
});
