import { describe, expect, test } from "vitest";
import { tileName } from "../src/admin/reports-page.js";

/**
 * `tileName` — the Reports page's "which cards did not fit" naming — strips a
 * tile label's period and its trailing `(CUR)` parenthetical.
 *
 * WHY THIS FILE EXISTS (CodeQL js/polynomial-redos, alert #13). The strip used
 * to be `.replace(/\s*\([^)]*\)\s*$/, "")`: unanchored on the left, so the
 * engine retries it from every offset, and each retry can scan to the end —
 * quadratic on a long run of spaces or of `(`. It is now a linear hand parser.
 * This file pins two things: the parser accepts and rejects EXACTLY what the
 * regex did (an exhaustive differential over a small alphabet, the old regex as
 * the oracle), and the adversarial inputs CodeQL describes finish in linear time.
 */

/** The pre-fix implementation, verbatim, as the behavioural oracle. Only ever
 *  fed the short strings the exhaustive enumeration below produces. */
function oracle(label: string): string {
	return (label.split("—")[0] ?? label).replace(/\s*\([^)]*\)\s*$/, "").trim();
}

describe("tileName", () => {
	test.each([
		["Refunded (USD) — last 30 days", "Refunded"],
		["AOV (EUR) — last 7 days", "AOV"],
		["Orders — last 30 days", "Orders"],
		["Revenue (JPY)", "Revenue"],
		["AOV", "AOV"],
		["", ""],
		["Net (a (b)", "Net"],
		["Net (a) (b)", "Net (a)"],
		["Net (a) x", "Net (a) x"],
		["Net (a)) ", "Net (a))"],
		["(USD)", ""],
		[")", ")"],
		["Net (USD)\t\n ", "Net"],
		["Net (USD)", "Net"],
	])("%j → %j", (label, expected) => {
		expect(tileName(label)).toBe(expected);
		expect(oracle(label)).toBe(expected);
	});

	test("agrees with the old regex on every string up to length 7 over its significant characters", () => {
		const alphabet = [" ", "\t", "(", ")", "a", "—"];
		let mismatches: string[] = [];
		const walk = (prefix: string, depth: number): void => {
			if (tileName(prefix) !== oracle(prefix)) mismatches.push(prefix);
			if (depth === 0 || mismatches.length > 10) return;
			for (const char of alphabet) walk(prefix + char, depth - 1);
		};
		walk("", 7);
		mismatches = mismatches.map((value) => JSON.stringify(value));
		expect(mismatches).toEqual([]);
	});

	// The two pathological shapes CodeQL names: many repetitions of ' ', and a
	// string starting with '(' followed by many repetitions of '('. Each is
	// 50k characters; the quadratic regex took whole seconds on these.
	test.each([
		["50k spaces, no parenthetical", " ".repeat(50_000), ""],
		["'(' then 50k '(' — never closed", `(${"(".repeat(50_000)}`, `(${"(".repeat(50_000)}`],
		["50k spaces then '(x' — never closed", `${" ".repeat(50_000)}(x`, "(x"],
		["label, 50k spaces, a closed parenthetical", `Net${" ".repeat(50_000)}(USD)`, "Net"],
		["50k '(' then ')'", `${"(".repeat(50_000)})`, ""],
	])("completes in linear time: %s", (_name, label, expected) => {
		const started = performance.now();
		const result = tileName(label);
		const elapsed = performance.now() - started;
		expect(result).toBe(expected);
		expect(elapsed).toBeLessThan(50);
	});
});
