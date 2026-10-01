/**
 * Plinth's signature, carried into the bag: the object keeps its place.
 *
 * A bag line's picture and title carry the SAME per-product view-transition
 * names as the product page's first panel and title (`plinthTransitionName`),
 * so "Add to bag" on the product page lands the object in its line, and a
 * line's picture opens back into its product page — the card → product morph,
 * continued. views.css applies the names only under `prefers-reduced-motion:
 * no-preference`; no script.
 *
 * ONE NAME PER PAGE. A `view-transition-name` that two elements carry on one
 * page aborts the whole transition. Names are collision-resistant per product
 * (`plinthTransitionName` appends a 32-bit hash of the raw key), but a bag can still hold two
 * lines of one product (two SKUs of one object), and a grid can list one
 * product twice. So only the FIRST element that would carry a name gets it;
 * the rest morph as part of the page. The shop and home grids use
 * `firstOfEachKey` for the same rule.
 *
 * Pure: strings in, strings out.
 */
import { plinthTransitionName } from "./art.js";

/** For each key, whether it is the FIRST occurrence on the page — the one
 *  element allowed to carry that product's names. */
export function firstOfEachKey(keys: readonly string[]): boolean[] {
	const seen = new Set<string>();
	return keys.map((key) => {
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The inline custom properties naming each line for the morph (`--pl-vt-media`
 *  / `--pl-vt-title`), or `undefined` for a line that carries no name: one with
 *  no product page to morph to (`href === null`), or whose names an earlier line
 *  on the page already carries. */
export function lineTransitionStyles(
	lines: readonly { artKey: string; href: string | null }[],
): (string | undefined)[] {
	const taken = new Set<string>();
	return lines.map((line) => {
		if (line.href === null) return undefined;
		const media = plinthTransitionName(line.artKey, "media");
		if (taken.has(media)) return undefined;
		taken.add(media);
		return `--pl-vt-media: ${media}; --pl-vt-title: ${plinthTransitionName(line.artKey, "title")}`;
	});
}
