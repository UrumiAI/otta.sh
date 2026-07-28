/**
 * Nothing but a component's OWN scope key reaches its root element.
 *
 * Astro passes a parent component's scope key down to a child as a prop
 * (`data-astro-cid-<parent hash>: true`), and every component in this theme
 * ends its frontmatter with `...rest` and spreads it onto its root. Left alone,
 * that combination does two things:
 *
 *  - it ships `data-astro-cid-hpdoytsu="true"` on the root of every nested
 *    component, on every page — dead payload;
 *  - it makes the parent's own scoped rules MATCH the child's root, which is
 *    the cross-component styling this architecture is built to prevent and the
 *    exact failure MediaPanel's `dimmed` prop exists to route around.
 *
 * `src/lib/rest-props.ts` filters the key out. This suite is the check that it
 * is actually wired into every component, and it can only be done through a
 * PARENT fixture: rendered straight from the Container API a component has no
 * parent, so there is no key to inherit and the bug is invisible.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import { restProps } from "../src/lib/rest-props.js";
import ScopedHost from "./fixtures/ScopedHost.astro";

let container: AstroContainer;
let html: string;

beforeAll(async () => {
	container = await AstroContainer.create();
	html = await container.renderToString(ScopedHost, { props: {} });
});

/** Every element in the markup, as its tag and its raw attribute text. */
function elements(markup: string): { tag: string; attributes: string }[] {
	return [...markup.matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)].map(
		([, tag = "", attributes = ""]) => ({
			tag,
			attributes,
		}),
	);
}

/** The DISTINCT scope hashes on one element. */
function scopeKeys(attributes: string): string[] {
	return [
		...new Set([...attributes.matchAll(/data-astro-cid-([\da-z]+)/g)].map((m) => m[1] ?? "")),
	];
}

describe("a parent's scope key never reaches a child component's root", () => {
	test("the fixture really does nest the components — otherwise this proves nothing", () => {
		// The host has a <style> block, so it has a key of its own to leak, and
		// the components below it are rendered from its template.
		expect(
			elements(html).filter((el) => scopeKeys(el.attributes).length > 0).length,
		).toBeGreaterThan(10);
		expect(html).toContain('class="host"');
	});

	test("no element carries TWO scope keys — one of them would be a parent's", () => {
		// This is the whole invariant, and the thing that makes cross-component
		// descendant styling impossible: an element scoped to exactly one
		// component cannot be reached by another component's compiled rules.
		// Before `restProps`, every nested root carried its own key AND its
		// parent's — `data-astro-cid-hpdoytsu="true" data-astro-cid-7ogccymt`.
		for (const el of elements(html)) {
			const keys = scopeKeys(el.attributes);
			expect(
				keys.length,
				`<${el.tag}${el.attributes}> carries ${keys.join(" + ")}`,
			).toBeLessThanOrEqual(1);
		}
	});

	test("the only VALUED scope attributes are Astro's polymorphic headings", () => {
		// `const Heading = level` is how ProductCard and StateStamp take their
		// heading level as a prop (see StateStamp for why it is not called `as`).
		// Astro treats the capitalised identifier as a component, so it delivers
		// that element's key as a PROP rather than stamping it on directly,
		// which is why it renders `data-astro-cid-…="true"` instead of bare.
		//
		// It is the component's OWN key, it is what makes `.headline[cid]` match
		// its own <h2>, and it has nothing to do with the spread — neither
		// component passes `rest` to `<Heading>`. Attribute selectors ignore the
		// value, so it scopes identically. What must never appear is a valued
		// key anywhere else.
		for (const el of elements(html)) {
			if (!/data-astro-cid-[\da-z]+="/.test(el.attributes)) continue;
			expect(el.tag, `<${el.tag}> carries a valued scope key`).toMatch(/^h[1-6]$/);
		}
	});

	test("and that heading's key is its own component's, not something inherited", () => {
		// StateStamp's root and its <h2> must agree, or the headline is unstyled.
		const stamp = elements(html).find((el) => el.attributes.includes('class="stamp"'));
		const headline = elements(html).find((el) => el.attributes.includes('class="headline"'));
		expect(scopeKeys(stamp?.attributes ?? "")).toHaveLength(1);
		expect(scopeKeys(headline?.attributes ?? "")).toEqual(scopeKeys(stamp?.attributes ?? ""));
	});

	test("and the components still render — the filter drops nothing else", () => {
		expect(html).toContain("Urumi Tee");
		expect(html).toContain("$25.00");
		expect(html).toContain("URUMI-TEE-01");
		expect(html).toContain("Order confirmed.");
		expect(html).toContain("Prices are unavailable right now.");
		expect(html).toContain("data-hold");
		expect(html).toContain("Checkout progress");
	});
});

describe("restProps — the filter itself", () => {
	test("drops an inherited scope key, whatever its hash", () => {
		expect(restProps({ "data-astro-cid-hpdoytsu": true, id: "x" })).toEqual({ id: "x" });
		expect(restProps({ "data-astro-cid-7ogccymt": true })).toEqual({});
	});

	test("keeps every other attribute a page hands a component", () => {
		const props = {
			id: "payment-error",
			role: "alert",
			hidden: true,
			"aria-live": "polite",
			"data-testid": "sum",
			style: "margin-top:1rem",
		};
		expect(restProps(props)).toEqual(props);
	});

	test("keeps a data attribute that merely LOOKS like one", () => {
		// The prefix is the whole rule, so a real attribute must not be caught
		// by being adjacent to it.
		const props = { "data-astro": "x", "data-astro-cid": "x", "data-cid-astro": "x" };
		expect(restProps(props)).toEqual(props);
	});

	test("does not mutate what it was given", () => {
		const props = { "data-astro-cid-hpdoytsu": true, id: "x" };
		restProps(props);
		expect(Object.keys(props)).toHaveLength(2);
	});
});
