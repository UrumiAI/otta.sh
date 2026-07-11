/**
 * Minimal .env support for astro.config.ts (review item: VERIFIED that
 * Astro does NOT load .env into process.env for the config module itself —
 * an .env-only COMMERCE_SERVICE_URL reached dist/server/.dev.vars but the
 * define/allowedHosts silently got the placeholder). Vite's canonical
 * `loadEnv` is not resolvable from this package under pnpm isolation
 * (vite is a transitive dep), so this is a deliberately tiny, pure
 * KEY=VALUE parser — one variable, no dotenv dependency.
 */

/** Parse KEY=VALUE lines; ignores comments/blank lines; strips one layer
 *  of matching single/double quotes. Last occurrence wins. */
export function parseDotEnv(content: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line.length === 0 || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = line.slice(eq + 1).trim();
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		out[key] = value;
	}
	return out;
}
