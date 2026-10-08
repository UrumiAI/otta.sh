/**
 * The one ordering of a pick list's options: by label, in `locale`'s collation
 * (as `localeCompare(…, locale)`), equal labels comparing 0. A locale the
 * runtime refuses falls back to plain code-unit order rather than throwing.
 * Shared by the country and the state/province lists.
 */
export function byLabel(locale: string): (a: { label: string }, b: { label: string }) => number {
	let collator: Intl.Collator | null;
	try {
		collator = new Intl.Collator(locale);
	} catch {
		collator = null;
	}
	return (a, b) =>
		collator !== null
			? collator.compare(a.label, b.label)
			: a.label < b.label
				? -1
				: a.label > b.label
					? 1
					: 0;
}
