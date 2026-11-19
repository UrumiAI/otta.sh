/**
 * `unhandled` is the runtime half of every outcome switch's exhaustiveness
 * check: an outcome this build does not know (a newer plugin) is refused as
 * INTERNAL_ERROR, and its message names the unexpected kind or reason — not
 * "undefined", which is what passing the bare reason string used to print.
 */
import { expect, test } from "vitest";
import { ToolError } from "../src/index.js";
import { unhandled } from "../src/tools/unhandled.js";

function thrown(run: () => unknown): ToolError {
	try {
		run();
	} catch (error) {
		return error as ToolError;
	}
	throw new Error("did not throw");
}

test("a whole outcome: the message names its kind, or its reason", () => {
	const byKind = thrown(() => unhandled({ kind: "brand_new" } as never));
	expect(byKind).toBeInstanceOf(ToolError);
	expect(byKind.code).toBe("INTERNAL_ERROR");
	expect(byKind.message).toBe("Unhandled operation outcome: brand_new.");
	expect(thrown(() => unhandled({ ok: false, reason: "odd" } as never)).message).toBe(
		"Unhandled operation outcome: odd.",
	);
});

test("a discriminant checked against never, with the outcome passed beside it", () => {
	const outcome = { ok: false, reason: "threshold_moved" };
	expect(thrown(() => unhandled(outcome.reason as never, outcome)).message).toBe(
		"Unhandled operation outcome: threshold_moved.",
	);
});
