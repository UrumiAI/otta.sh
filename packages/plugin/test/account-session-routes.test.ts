/**
 * The session's own routes, run in process over a real document store: who the
 * session is (`storefront/account/me`, for the sign-in page's "signed in as" and
 * checkout's email prefill), and that the checkout's place route hands the
 * shopper's session to the client (so a signed-in order is theirs from birth).
 *
 * The client's own behaviour behind both — the owner resolved from the session,
 * never from an argument — is the commerce-client contract's; these cases pin
 * only the route layer: its input guard and its forwarding.
 */
import { email as toEmail } from "@otta-sh/domain";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import {
	ACCOUNT_LOGIN_PATH,
	createAccountMeHandler,
	type AccountMeResult,
} from "../src/storefront/account-routes.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;

beforeEach(async () => {
	if (harness === undefined) harness = await makeInProcessCommerce();
	else await harness.reset();
});

afterAll(async () => {
	await harness?.close();
});

async function me(input: unknown): Promise<AccountMeResult> {
	const handler = createAccountMeHandler();
	return (await handler(
		{ input: input as never, request: { method: "POST", url: "/route", headers: {} } },
		harness.ctx,
	)) as AccountMeResult;
}

describe("storefront/account/me", () => {
	test("a live session answers its own customer's email", async () => {
		const customer = await harness.stores.customerStore.create({
			email: toEmail("me@example.test"),
		});
		const session = await harness.stores.sessionStore.create(customer.id);
		expect(await me({ sessionToken: session.token })).toEqual({
			ok: true,
			email: "me@example.test",
		});
	});

	test("no session, a forged one or an oversized one answers signed-out — the login path, never an error", async () => {
		const signedOut = { ok: false, redirectTo: ACCOUNT_LOGIN_PATH };
		expect(await me({})).toEqual(signedOut);
		expect(await me({ sessionToken: "" })).toEqual(signedOut);
		expect(await me({ sessionToken: 42 })).toEqual(signedOut);
		expect(await me({ sessionToken: "not-a-session-token" })).toEqual(signedOut);
		expect(await me({ sessionToken: "x".repeat(513) })).toEqual(signedOut);
	});
});
