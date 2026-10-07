/**
 * `renderGuard` — the catch-all every PUBLIC storefront route runs inside.
 *
 * Storage pressure is not a render failure. A compare-and-set budget that ran out
 * (`StorageContentionError`) or a retryable host serialization abort means the
 * refused step wrote nothing and the call is safe to try again, so it must reach
 * the site as its own `BUSY` token (which the site answers with a 503 and
 * `Retry-After`) — never flattened into `RENDER_FAILED`'s "something went wrong".
 * Every other throw keeps collapsing to the message-free `RENDER_FAILED`.
 */
import { StorageContentionError } from "@otta-sh/store-emdash";
import { afterEach, describe, expect, test, vi } from "vitest";
import { renderGuard, type RenderGuardFailure } from "../src/storefront/pdp-route.js";

afterEach(() => {
	vi.restoreAllMocks();
});

function quietConsole(): void {
	vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(console, "warn").mockImplementation(() => {});
}

/** Compiles only while the union is exactly these two members. */
function describeFailure(failure: RenderGuardFailure): string {
	switch (failure.error) {
		case "RENDER_FAILED":
			return "render";
		case "BUSY":
			return failure.retryable ? "busy" : "never";
	}
}

describe("renderGuard", () => {
	test("a successful render passes through untouched", async () => {
		await expect(renderGuard("r", async () => ({ ok: true as const, n: 1 }))).resolves.toEqual({
			ok: true,
			n: 1,
		});
	});

	test("an exhausted compare-and-set budget becomes the retryable BUSY token, not RENDER_FAILED", async () => {
		quietConsole();
		const result = await renderGuard("storefront/cart/lines/add", async () => {
			throw new StorageContentionError("reserve", 24);
		});
		expect(result).toEqual({ ok: false, error: "BUSY", retryable: true });
	});

	test("a retryable serialization abort that arrives as a PLAIN object (sandbox bridge) is BUSY too", async () => {
		quietConsole();
		const result = await renderGuard("storefront/product", async () => {
			// oxlint-disable-next-line no-throw-literal -- the bridge shape IS a plain object
			throw { code: "STORAGE_SERIALIZATION_FAILURE", retryable: true, message: "40001" };
		});
		expect(result).toEqual({ ok: false, error: "BUSY", retryable: true });
	});

	test("BUSY carries no internals: no operation name, attempt count or message", async () => {
		quietConsole();
		const result = await renderGuard("r", async () => {
			throw new StorageContentionError("reserveCartLine:secret-sku", 24);
		});
		expect(JSON.stringify(result)).not.toMatch(/secret-sku|24|compare-and-set/);
	});

	test("any other throw still collapses to the message-free RENDER_FAILED", async () => {
		quietConsole();
		for (const thrown of [
			new RangeError("cents() got 1.5"),
			{ code: "STORAGE_SERIALIZATION_FAILURE", retryable: false },
			new Error("wrapped", { cause: new StorageContentionError("reserve", 24) }),
		]) {
			const result = await renderGuard("r", async () => {
				throw thrown;
			});
			expect(result).toEqual({ ok: false, error: "RENDER_FAILED" });
		}
	});

	test("the failure union is exactly RENDER_FAILED | BUSY", () => {
		expect(describeFailure({ ok: false, error: "BUSY", retryable: true })).toBe("busy");
		expect(describeFailure({ ok: false, error: "RENDER_FAILED" })).toBe("render");
	});
});
