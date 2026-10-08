/**
 * The magic-link email (issue #306): `requestLoginLink` sends the link through
 * the plugin's email sender, and the answer a caller sees is IDENTICAL whatever
 * happened behind it — a new address, a known one, a throttled one, an
 * unconfigured deployment, a provider that refused the mail.
 *
 * The email egress is a RECORDING FAKE (`FakeEmailSender`), injected where the
 * composition root injects the real `CtxEmailSender` (ADR-0031); the document store
 * underneath is real (the shared in-process harness), so the challenge the mail
 * carries is one the real verifier will redeem.
 *
 * A FILE OF ITS OWN because the "unconfigured" warning is logged once per
 * isolate — module state — and a file is the unit vitest gives a fresh module
 * graph to.
 */
import { EmailSendTimeoutError } from "@otta-sh/domain";
import { DEFAULT_CHALLENGE_TTL_MS } from "@otta-sh/store-emdash";
import { FakeEmailSender } from "@otta-sh/domain/testing";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";
import { LOGIN_LINK_TTL_MS } from "../src/storefront/login-link.js";

/** The operator's configured sign-in page (`settings:loginLinkUrl`). */
const VERIFY = "https://shop.example.test/account/verify";

/** Pull `challenge` + `token` back out of the emailed link — the only place a
 *  shopper's token exists. */
function linkParts(loginUrl: unknown): { url: URL; challenge: string; token: string } {
	if (typeof loginUrl !== "string") throw new Error("the email carries no loginUrl");
	const url = new URL(loginUrl);
	const challenge = url.searchParams.get("challenge");
	const token = url.searchParams.get("token");
	if (challenge === null || token === null) throw new Error(`malformed link: ${loginUrl}`);
	return { url, challenge, token };
}

describe("requestLoginLink sends the magic link", () => {
	let harness: InProcessCommerceHarness;
	const sender = new FakeEmailSender();

	beforeAll(async () => {
		harness = await makeInProcessCommerce({ emailSender: sender });
	}, 120_000);
	afterEach(async () => {
		sender.reset();
		await harness.reset();
	});
	afterAll(async () => {
		await harness.close();
	});

	test("a never-seen address gets EXACTLY ONE email, and the reply carries no token", async () => {
		const reply = await harness.client.requestLoginLink("new@example.test", {
			verifyPageUrl: VERIFY,
		});

		expect(reply).toEqual({ ok: true });
		expect(sender.sends).toHaveLength(1);
		const [sent] = sender.sends;
		expect(sent).toMatchObject({ to: "new@example.test", template: "customer-login-link" });
		const { url, challenge, token } = linkParts(sent?.data["loginUrl"]);
		// The link is the configured sign-in page, and nothing request-derived.
		expect(`${url.origin}${url.pathname}`).toBe(VERIFY);
		// The token is in the email and NOWHERE in the reply.
		expect(JSON.stringify(reply)).not.toContain(token);
		// Idempotency-keyed on the challenge, so a provider can dedupe a retried send.
		expect(sent?.idempotencyKey).toBe(`login:${challenge}`);
		// The token travels only inside the link — not as a loose field a template
		// or a provider log could print on its own. Beside it, only the lifetime
		// the email states (QA U-3): the challenge TTL the verifier enforces.
		expect(Object.keys(sent?.data ?? {})).toEqual(["loginUrl", "expiresInMinutes"]);
		expect(sent?.data["expiresInMinutes"]).toBe(LOGIN_LINK_TTL_MS / 60_000);
		expect(LOGIN_LINK_TTL_MS).toBe(DEFAULT_CHALLENGE_TTL_MS);
		expect(sent?.data["expiresInMinutes"]).toBe(15);
	});

	test("the emailed link redeems once, and a known address gets exactly one email too", async () => {
		await harness.client.requestLoginLink("known@example.test", { verifyPageUrl: VERIFY });
		const first = linkParts(sender.sends[0]?.data["loginUrl"]);
		const verified = await harness.client.verifyLogin(first.challenge, first.token);
		expect(verified.ok).toBe(true);
		// Single use.
		expect(await harness.client.verifyLogin(first.challenge, first.token)).toEqual({
			ok: false,
			reason: "CONSUMED",
		});

		sender.reset();
		// The account now exists; the answer and the mail count must not change.
		expect(
			await harness.client.requestLoginLink("known@example.test", { verifyPageUrl: VERIFY }),
		).toEqual({ ok: true });
		expect(sender.sends).toHaveLength(1);
	});

	test("a THROTTLED request sends nothing and answers exactly as a sent one", async () => {
		const answers: unknown[] = [];
		// The per-address cap is 3 live challenges; the fourth is throttled.
		for (let i = 0; i < 4; i += 1) {
			answers.push(
				await harness.client.requestLoginLink("busy@example.test", { verifyPageUrl: VERIFY }),
			);
		}
		expect(sender.sends).toHaveLength(3);
		expect(answers).toEqual([{ ok: true }, { ok: true }, { ok: true }, { ok: true }]);
	});

	test("a malformed address sends nothing and answers the same generic success", async () => {
		expect(
			await harness.client.requestLoginLink("not-an-email", { verifyPageUrl: VERIFY }),
		).toEqual({
			ok: true,
		});
		expect(sender.sends).toHaveLength(0);
	});

	test("a provider failure is swallowed into the same answer, and the log never carries the token", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			sender.failNextSends(1);
			expect(
				await harness.client.requestLoginLink("flaky@example.test", { verifyPageUrl: VERIFY }),
			).toEqual({ ok: true });
			expect(sender.sends).toHaveLength(0);
			expect(errors).toHaveBeenCalled();
			// The failure is logged, but never with the link (and so never the token).
			expect(JSON.stringify(errors.mock.calls)).not.toMatch(/token=|\/account\/verify/);
		} finally {
			errors.mockRestore();
		}
	});

	test("with NO sign-in link URL configured: nothing issued, nothing sent, the same answer, logged ONCE", async () => {
		const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const challenges = harness.ctx.storage?.["login_challenges"];
			if (challenges === undefined) throw new Error("login_challenges is not declared");
			for (const address of ["nowhere@example.test", "elsewhere@example.test"]) {
				expect(await harness.client.requestLoginLink(address)).toEqual({ ok: true });
			}
			expect(sender.sends).toHaveLength(0);
			expect(await challenges.count()).toBe(0);
			const unconfigured = warns.mock.calls.filter((call) =>
				String(call[0]).includes("settings:loginLinkUrl"),
			);
			expect(unconfigured).toHaveLength(1);
		} finally {
			warns.mockRestore();
		}
	});
});

describe("requestLoginLink on a deployment with NO email configured", () => {
	let harness: InProcessCommerceHarness;

	beforeAll(async () => {
		harness = await makeInProcessCommerce();
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test("answers the same generic success, issues nothing, and logs ONCE server-side", async () => {
		const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const challenges = harness.ctx.storage?.["login_challenges"];
			if (challenges === undefined) throw new Error("login_challenges is not declared");
			for (const address of ["a@example.test", "b@example.test"]) {
				expect(await harness.client.requestLoginLink(address, { verifyPageUrl: VERIFY })).toEqual({
					ok: true,
				});
			}
			// A challenge nobody can receive is a throttle slot burned for nothing.
			expect(await challenges.count()).toBe(0);
			const unconfigured = warns.mock.calls.filter((call) =>
				String(call[0]).includes("login email is not configured"),
			);
			expect(unconfigured).toHaveLength(1);
			// It says what is missing (ADR-0031) and where the guide is.
			expect(String(unconfigured[0]?.[0])).toContain("no EmDash email provider");
			expect(String(unconfigured[0]?.[0])).toContain("docs/email-providers.md");
			// No egress was attempted — there is no sender to attempt it.
			expect(harness.egressAttempts()).toBe(0);
		} finally {
			warns.mockRestore();
		}
	});
});

/**
 * The login send's catch is GENERIC — any error from the sender is logged by
 * message and swallowed into the same answer — so the sweep's timeout error type
 * (`EmailSendTimeoutError`, which the sender now raises for its own abort) needs
 * no special case here. Pinned, because a catch that matched the old abort error
 * by name would let this one escape as a 500.
 */
describe("requestLoginLink with a login send that TIMES OUT", () => {
	let harness: InProcessCommerceHarness;
	const timingOut = {
		async send(): Promise<void> {
			throw new EmailSendTimeoutError(3000);
		},
	};

	beforeAll(async () => {
		harness = await makeInProcessCommerce({ emailSender: timingOut });
	}, 120_000);
	afterAll(async () => {
		await harness.close();
	});

	test("answers the same generic success and logs the timeout by message only", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(
				await harness.client.requestLoginLink("slow@example.test", { verifyPageUrl: VERIFY }),
			).toEqual({ ok: true });
			expect(errors).toHaveBeenCalled();
			expect(JSON.stringify(errors.mock.calls)).toContain("email send abandoned after 3000 ms");
			expect(JSON.stringify(errors.mock.calls)).not.toMatch(/token=|\/account\/verify/);
		} finally {
			errors.mockRestore();
		}
	});
});
