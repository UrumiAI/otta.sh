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
