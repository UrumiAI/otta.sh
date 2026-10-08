/**
 * The sign-in email on a SANDBOXED host with no EmDash email provider
 * (ADR-0031). There the host always hands over `ctx.email` (the plugin declares
 * `email:send`), so the sender exists and the "no provider" answer comes from
 * the send itself — `EmailTransportUnavailableError`. The caller still gets the
 * identical generic success (ADR-0004), and the server says so ONCE, as a
 * deployment fact, rather than logging an error per request.
 *
 * A FILE OF ITS OWN because that line is logged once per isolate — module state.
 */
import { EmailTransportUnavailableError, type EmailSender } from "@otta-sh/domain";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

const VERIFY = "https://shop.example.test/account/verify";

describe("requestLoginLink when the host's send says there is no email provider", () => {
	let harness: InProcessCommerceHarness;
	let sends = 0;
	const noProvider: EmailSender = {
		send: () => {
			sends += 1;
			return Promise.reject(new EmailTransportUnavailableError());
		},
	};

	beforeAll(async () => {
		harness = await makeInProcessCommerce({ emailSender: noProvider });
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test("answers the same generic success, and warns once — never an error per request", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			for (const address of ["a@example.test", "b@example.test"]) {
				expect(await harness.client.requestLoginLink(address, { verifyPageUrl: VERIFY })).toEqual({
					ok: true,
				});
			}
			expect(sends).toBe(2);
			const unconfigured = warn.mock.calls.filter((call) =>
				String(call[0]).includes("no EmDash email provider"),
			);
			expect(unconfigured).toHaveLength(1);
			expect(error).not.toHaveBeenCalled();
			expect(harness.egressAttempts()).toBe(0);
		} finally {
			warn.mockRestore();
			error.mockRestore();
		}
	});
});
