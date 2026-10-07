/**
 * The document `<title>` — the page's own title, then the store's name.
 *
 * Pure, so the rule is tested rather than trusted in the shell's frontmatter.
 *
 * Only a page whose title IS the store's name (the home page, which titles
 * itself with it) goes unsuffixed. The shell used to skip the suffix whenever
 * the title merely CONTAINED the name, and a store's products are routinely
 * named after the store — the seed's are "Otta Mug", "Otta Tee" — so every
 * product page lost the suffix every other page carries.
 */
export function documentTitle(pageTitle: string, siteTitle: string): string {
	const site = siteTitle.trim();
	if (site === "" || pageTitle.trim() === site) return pageTitle;
	return `${pageTitle} — ${site}`;
}
