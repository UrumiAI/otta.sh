import { afterEach, describe, expect, test, vi } from "vitest";
import { CONSOLE_LOGGER } from "../src/logging/console-logger.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("CONSOLE_LOGGER", () => {
	for (const level of ["info", "warn", "error"] as const) {
		test(`${level} writes the message alone when there are no fields`, () => {
			const spy = vi.spyOn(console, level).mockImplementation(() => {});
			CONSOLE_LOGGER[level]("msg");
			expect(spy).toHaveBeenCalledExactlyOnceWith("msg");
		});

		test(`${level} passes the fields as a second argument`, () => {
			const spy = vi.spyOn(console, level).mockImplementation(() => {});
			CONSOLE_LOGGER[level]("msg", { a: 1 });
			expect(spy).toHaveBeenCalledExactlyOnceWith("msg", { a: 1 });
		});
	}
});
