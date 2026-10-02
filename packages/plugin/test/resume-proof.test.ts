/**
 * The email proof for resuming an order's payment (QA U-2): the typed email is
 * compared with the order's buyer server-side, trimmed and case-folded, through
 * equal-length digests so the comparison's time does not depend on where the two
 * first differ.
 */
import { describe, expect, test } from "vitest";
import {
	RESUME_EMAIL_MAX_ATTEMPTS,
	RESUME_EMAIL_WINDOW_MS,
	emailMatchesBuyer,
} from "../src/commerce/resume-proof.js";

describe("emailMatchesBuyer", () => {
	test("the same address, however it is cased or padded, matches", async () => {
		expect(await emailMatchesBuyer("  Jane.Doe@EXAMPLE.com ", "jane.doe@example.com")).toBe(true);
		expect(await emailMatchesBuyer("jane.doe@example.com", "Jane.Doe@Example.com")).toBe(true);
	});

	test("anything else does not — a prefix, a suffix, an empty string", async () => {
		expect(await emailMatchesBuyer("jane.doe@example.co", "jane.doe@example.com")).toBe(false);
		expect(await emailMatchesBuyer("jane.doe@example.comm", "jane.doe@example.com")).toBe(false);
		expect(await emailMatchesBuyer("", "jane.doe@example.com")).toBe(false);
		expect(await emailMatchesBuyer("   ", "")).toBe(false);
	});
});

describe("the email throttle's bounds", () => {
	test("five tries per order per fifteen minutes", () => {
		expect(RESUME_EMAIL_MAX_ATTEMPTS).toBe(5);
		expect(RESUME_EMAIL_WINDOW_MS).toBe(15 * 60 * 1000);
	});
});
