/**
 * Reading a wrangler config (JSONC) at BUILD time, shared by the two build
 * guards that parse one: `wrangler-pairing.ts` (compatibility flags vs D1
 * sessions) and `downloads-bucket.ts` (the private downloads bucket). Pure text
 * in, value or throw out. Kept as one module so a fix to the comment/trailing
 * comma handling lands in both guards at once (issue #447).
 */

/**
 * JSONC → JSON: drops `//` and block comments OUTSIDE strings (a URL in a string
 * keeps its `//`), then trailing commas. Enough for a wrangler config; anything
 * wrangler itself would reject may throw here too.
 */
export function jsoncToJson(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end === -1 ? text.length : end + 2;
		} else {
			out += ch;
			i++;
		}
	}
	return out.replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Parse the config's text — a leading UTF-8 BOM stripped (editors on Windows
 * write one; JSON.parse rejects it) — wrapping any parse error so it names the
 * file and what was being checked (`checking`, e.g. "its r2_buckets") instead of
 * a bare "Unexpected token". A non-object document reads as `{}`.
 */
export function parseWrangler(
	wranglerText: string,
	fileName: string,
	checking: string,
): Record<string, unknown> {
	const text = wranglerText.startsWith("\uFEFF") ? wranglerText.slice(1) : wranglerText;
	try {
		const parsed: unknown = JSON.parse(jsoncToJson(text));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
	} catch (error) {
		throw new Error(
			`${fileName} could not be parsed as JSONC while checking ${checking} ` +
				`(${error instanceof Error ? error.message : String(error)}).`,
			{ cause: error },
		);
	}
}
