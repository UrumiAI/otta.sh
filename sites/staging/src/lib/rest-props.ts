/**
 * What a component may spread onto its own root element.
 *
 * Every component in this theme ends its frontmatter with `...rest` and spreads
 * it, so a page can hand one an `id`, an `aria-*` or a `data-*` without the
 * component enumerating every attribute HTML has. Astro puts exactly one thing
 * in that object that did NOT come from the page: when a component is rendered
 * inside another component's template, the PARENT's scope key arrives as a prop
 * — `data-astro-cid-<parent hash>: true`.
 *
 * Spreading it back out does two things, and the second is the reason this
 * module exists:
 *
 *  1. Every nested component's root ships a dead attribute
 *     (`data-astro-cid-hpdoytsu="true"`) on every page. Payload, not meaning.
 *  2. It quietly re-enables the cross-component styling this architecture
 *     forbids. Astro compiles a parent's `.card .card-media` to
 *     `.card[data-astro-cid-P] .card-media[data-astro-cid-P]`, which CANNOT
 *     match a child component's root — that element carries the child's own
 *     key. Unless the parent's key has been spread onto it too, at which point
 *     it matches perfectly. That is the failure MediaPanel's `dimmed` prop
 *     exists to route around, and it would come back with nobody writing a
 *     line of CSS.
 *
 * Astro never adds a parent's key to a child's root by itself — a child that
 * does not spread `...rest` renders with its own key and nothing else. The key
 * only ever arrives through the spread, so dropping it here is the whole job.
 *
 * ── THE `class` TRAP, which is the same rule seen from the other side ───────
 *
 * Every page and component in this theme points here, so the convention it
 * implies is written down here too:
 *
 *   **A `class` handed to a component lands on an element the caller's own CSS
 *   can never match.** Not "should not" — cannot.
 *
 * `<Notice class="alert" />` really does render `class="u-notice alert"`, so
 * the attribute is there in the HTML and looks like it works. But the caller's
 * `.alert { margin-bottom: 1.5rem }` compiles to
 * `.alert[data-astro-cid-CALLER]`, and that root element carries
 * `data-astro-cid-NOTICE` instead — the child's key, because `restProps` above
 * strips the parent's. The rule ships, matches nothing, and the spacing simply
 * does not appear. Nothing warns: Astro cannot know the selector was aimed at
 * a child, and `oxlint` and `astro check` do not look at CSS at all.
 *
 * So there are exactly three ways to affect how a component looks from
 * outside, and every one of them is used somewhere in `src/pages`:
 *
 *  1. **A wrapper element the caller owns.** `<div class="alert"><Notice
 *     …/></div>`. This is the default answer and it is why the pages are full
 *     of single-purpose wrappers with names like `.notice-slot`, `.steps`,
 *     `.art` and `.totals`. They are not decoration — they are the only
 *     element in reach. Reach for this for anything OUTSIDE the component:
 *     margin, width, grid placement.
 *  2. **A prop.** Anything about what the component IS rather than where it
 *     sits: `MediaPanel`'s `dimmed`, `PriceTag`'s `soldOut`, `ratio`. The
 *     first cut of `ProductCard` tried to dim from the parent's stylesheet and
 *     the dimming was dead on arrival; `component-css.test.ts`'s "does not
 *     style THROUGH a child component" guard exists because of it.
 *  3. **A global class from `tokens.css`.** `.u-mono`, `.u-label`, `.u-btn`
 *     are unscoped on purpose, so they work on any element anywhere — a
 *     component's root included. That is the escape hatch, and it is
 *     deliberately narrow: it carries the theme's shared vocabulary and
 *     nothing situational.
 *
 * What NEVER works, and looks like it should: a page rule that reaches through
 * a component (`.card .card-media`), and a `class` on a component root that
 * the page then styles. Both compile, ship, and do nothing.
 */

/** Astro's scoped-style attribute prefix (`scopedStyleStrategy: "attribute"`,
 *  the default). The hash that follows is per component file. */
const SCOPE_KEY_PREFIX = "data-astro-cid-";

/**
 * The pass-through attributes, minus any inherited scope key.
 *
 * The cast is not a widening: the scope keys are never part of `T`'s declared
 * surface — no component's `Props` mentions them — so the value that comes out
 * satisfies exactly the type that went in.
 */
export function restProps<T extends object>(props: T): T {
	return Object.fromEntries(
		Object.entries(props).filter(([key]) => !key.startsWith(SCOPE_KEY_PREFIX)),
	) as T;
}
