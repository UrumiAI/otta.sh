/**
 * Step 5.9: the storefront account pages under the workerd-on-Node sandbox (not
 * trusted in-process — CLAUDE.md).
 *
 * WHAT INC-D3a CHANGED HERE. These routes used to reach a REAL service's
 * `/auth` + `/me` surface over `ctx.http`, and this suite stood that service up
 * on Postgres to answer them. The transport is gone — the routes run the
 * identity use-cases in process over `ctx.storage` — so there is no service to
 * start, no `commerceServiceBaseUrl` to hand the sandbox, and no Postgres in
 * this file at all. The document store IS the backend now, and the suite seeds
 * it through the same `@otta-sh/store-emdash` adapters the plugin composes.
 *
 * THE SUITE IS NO LONGER GATED, and that is deliberate rather than incidental:
 * a `PG_CONNECTION_STRING` gate is what let this file rot silently through a
 * whole retrofit, because a skipped suite is green.
 *
 * WHAT IS DRIVEN THROUGH THE SANDBOX: the whole login, the path a shopper
 * takes (issue #306). The plugin's own `login/request` route issues the
 * challenge AND emails the link through `CtxHttpEmailSender` over `ctx.http`;
 * the email lands on a recording stub standing in for the provider; the link
 * is read back out of that mail and redeemed through the plugin's own
 * `login/verify` route. Every session below was minted that way.
 *
 * EGRESS IS ASSERTED BY CONSTRUCTION: the ONLY allowed host is the email stub,
 * and the bundle's baked email URL points at it — so the stub's recorded
 * requests are the plugin's entire egress, and every one of them must be a mail.
 *
 * ── Platform-verified deviation from plan §4's session-cookie wording ──────
 * The bearer session token is threaded as route input (the theme's first-party
 * cookie layer, per the deviation documented in `account-routes.ts`).
 */
import {
	cents,
	currency,
	idempotencyKey,
	orderId as toOrderId,
	productId as toProductId,
	sku as toSku,
} from "@otta-sh/domain";
import {
	EmdashInventoryStore,
	EmdashOrderStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@otta-sh/store-emdash";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { OTTA_PLUGIN_CAPABILITIES } from "../src/manifest.js";
import { startStubHttpServer, type StubHttpServer } from "./helpers/stub-http-server.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";
import { storageBridge } from "./sandbox/storage-bridge.js";

/** A namespace no other suite writes under — the document store is
 *  process-scoped and shared by every sandbox suite in this process. */
const NS = "acct";

/** The provider endpoint the bundle's email URL is baked to. */
const EMAIL_PATH = "/email/send";
/** The site the shopper is on — the request URL the theme's in-process dispatch
 *  builds on its own `Astro.url`, and so the origin the emailed link must use. */
const SITE = "https://shop.example.test";
const SITE_REQUEST = {
	url: `${SITE}/_emdash/api/plugins/otta/storefront/account/login/request`,
};

let sandbox: SandboxHandle;
let stub: StubHttpServer;
let storage: StorageAccess;
let orderStore: EmdashOrderStore;

beforeAll(async () => {
	({ storage } = await storageBridge());
	stub = await startStubHttpServer();
	stub.respondWith("POST", (req) =>
		req.url === EMAIL_PATH
			? { status: 202, body: { queued: true } }
			: { status: 404, body: { error: "unexpected path" } },
	);
	orderStore = new EmdashOrderStore({
		storage,
		inventory: new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock }),
		idGen: uuidIdGen,
		clock: systemClock,
	});
	// The email stub is the ONLY allowed host — see the module doc's egress note.
	sandbox = await loadPluginInSandbox({
		allowedHosts: [stub.host],
		emailApiUrl: `${stub.baseUrl}${EMAIL_PATH}`,
		storage: true,
	});
}, 300_000);

afterAll(async () => {
	await sandbox?.close();
	await stub?.close();
});

interface CapturedMail {
	to: string;
	template: string;
	text: string;
	html: string;
	idempotencyKey: string;
}

/** Every login mail the provider stub received for `to`, in order. */
function mailsTo(to: string): CapturedMail[] {
	return stub.requests
		.filter((req) => req.method === "POST" && req.url === EMAIL_PATH)
		.map((req) => ({
			...(req.body as Omit<CapturedMail, "idempotencyKey">),
			idempotencyKey: String(req.headers["idempotency-key"] ?? ""),
		}))
		.filter((mail) => mail.to === to);
}

/** The link in a mail's plain-text body, split into what the verify page reads. */
function linkIn(mail: CapturedMail | undefined): { url: URL; challengeId: string; token: string } {
	if (mail === undefined) throw new Error("no mail captured");
	const match = /https?:\/\/\S+/.exec(mail.text);
	if (match === null) throw new Error(`no link in the mail: ${mail.text}`);
	const url = new URL(match[0]);
	const challengeId = url.searchParams.get("challenge");
	const token = url.searchParams.get("token");
	if (challengeId === null || token === null) throw new Error(`malformed link: ${url.href}`);
	return { url, challengeId, token };
}

async function requestLink(email: string): Promise<unknown> {
	return sandbox.invokeRoute("storefront/account/login/request", { email }, SITE_REQUEST);
}

interface VerifyResult {
	ok: boolean;
	reason?: string;
	redirectTo?: string;
	cookie?: {
		name: string;
		value: string;
		httpOnly: boolean;
		secure: boolean;
		sameSite: string;
		path: string;
		expiresAt: string;
	};
}

async function verify(challengeId: string, token: string): Promise<VerifyResult> {
	const outcome = await sandbox.invokeRoute("storefront/account/login/verify", {
		challengeId,
		token,
	});
	if (!("result" in outcome)) throw new Error(outcome.error);
	return outcome.result as VerifyResult;
}

/**
 * One GUEST order under `buyerRef=email`: it names an email and no customer,
 * which is the state every order is in until its buyer proves that inbox.
 * Logging in as the same address is what claims it, and that is the path the
 * ownership case below takes.
 */
async function createGuestOrder(input: { email: string; slug: string }): Promise<string> {
	const id = `order-${NS}-${input.slug}`;
	await orderStore.createFromCart({
		orderId: toOrderId(id),
		cartId: null,
		currency: currency("USD"),
		idempotencyKey: idempotencyKey(`seed-${id}`),
		holdExpiresAt: "2099-01-01T00:00:00.000Z",
		buyerRef: input.email,
		paymentMethod: "stripe",
		lines: [
			{
				productId: toProductId(`prod-${NS}-${input.slug}`),
				sku: toSku(`SKU-${NS}-${input.slug.toUpperCase()}`),
				title: "Item",
				unitPrice: cents(1500),
				currency: currency("USD"),
				quantity: 1,
				fulfillmentKind: "physical",
				reservationId: null,
			},
		],
		totals: { subtotal: cents(1500), total: cents(1500), currency: currency("USD") },
	});
	return id;
}

/** Drive the magic-link login THROUGH the plugin sandbox, exactly as a shopper
 *  does: request the link, read it out of the captured mail, redeem it via the
 *  plugin route. Returns the bearer token from the session-cookie descriptor. */
async function loginThroughSandbox(email: string): Promise<string> {
	const before = mailsTo(email).length;
	expect(await requestLink(email)).toEqual({ result: { ok: true } });
	const mails = mailsTo(email);
	expect(mails).toHaveLength(before + 1);
	const { challengeId, token } = linkIn(mails[mails.length - 1]);
	const result = await verify(challengeId, token);
	expect(result.ok).toBe(true);
	expect(result.cookie?.name).toBe("otta_session");
	return result.cookie!.value;
}

describe("the magic-link login, end to end (workerd sandbox)", () => {
	test("request → ONE mail with the link → verify once succeeds, a second use fails", async () => {
		const email = `${NS}-link@example.test`;
		const reply = await requestLink(email);
		// The generic answer, and nothing in it that could be a token.
		expect(reply).toEqual({ result: { ok: true } });

		const mails = mailsTo(email);
		expect(mails).toHaveLength(1);
		const mail = mails[0];
		expect(mail?.template).toBe("customer-login-link");
		const { url, challengeId, token } = linkIn(mail);
		// The link lands on the storefront verify page of the site that asked.
		expect(`${url.origin}${url.pathname}`).toBe(`${SITE}/account/verify`);
		expect(mail?.idempotencyKey).toBe(`login:${challengeId}`);

		const first = await verify(challengeId, token);
		expect(first.ok).toBe(true);
		expect(first.redirectTo).toBe("/account/orders");
		// The cookie descriptor the theme applies: HttpOnly, Secure, SameSite=Lax.
		expect(first.cookie).toMatchObject({
			name: "otta_session",
			httpOnly: true,
			secure: true,
			sameSite: "lax",
			path: "/",
		});
		expect(first.cookie?.value).toBeTruthy();
		expect(first.cookie?.value).not.toBe(token);

		// Single use.
		expect(await verify(challengeId, token)).toEqual({ ok: false, reason: "CONSUMED" });
	}, 120_000);

	test("a throttled request sends NO mail and answers identically", async () => {
		const email = `${NS}-throttle@example.test`;
		const replies: unknown[] = [];
		// The per-address cap is 3 live challenges; the fourth is throttled.
		for (let i = 0; i < 4; i += 1) replies.push(await requestLink(email));
		expect(replies).toEqual(Array.from({ length: 4 }, () => ({ result: { ok: true } })));
		expect(mailsTo(email)).toHaveLength(3);
	}, 120_000);

	test("logout ends the session: the same token no longer reads the account", async () => {
		const token = await loginThroughSandbox(`${NS}-logout@example.test`);
		const before = await sandbox.invokeRoute("storefront/account/orders", { sessionToken: token });
		expect(before).toMatchObject({ result: { ok: true } });

		const out = await sandbox.invokeRoute("storefront/account/logout", { sessionToken: token });
		expect(out).toEqual({
			result: { ok: true, clearCookie: { name: "otta_session", path: "/" }, redirectTo: "/" },
		});

		const after = await sandbox.invokeRoute("storefront/account/orders", { sessionToken: token });
		expect(after).toEqual({ result: { ok: false, redirectTo: "/account/login" } });
	}, 120_000);

	test("logout with no session, or an unknown one, is the same answer — idempotent", async () => {
		const expected = {
			result: { ok: true, clearCookie: { name: "otta_session", path: "/" }, redirectTo: "/" },
		};
		expect(await sandbox.invokeRoute("storefront/account/logout", {})).toEqual(expected);
		expect(
			await sandbox.invokeRoute("storefront/account/logout", { sessionToken: "not-a-session" }),
		).toEqual(expected);
	}, 120_000);

	test("every request the plugin made went to the email provider", () => {
		expect(stub.requests.length).toBeGreaterThan(0);
		for (const req of stub.requests) expect(`${req.method} ${req.url}`).toBe(`POST ${EMAIL_PATH}`);
	});
});

describe("storefront account pages (workerd sandbox)", () => {
	test("a logged-in customer sees only their own orders on /account/orders", async () => {
		const orderA = await createGuestOrder({ email: `${NS}-a@example.test`, slug: "a" });
		const orderB = await createGuestOrder({ email: `${NS}-b@example.test`, slug: "b" });

		const tokenA = await loginThroughSandbox(`${NS}-a@example.test`);
		await loginThroughSandbox(`${NS}-b@example.test`); // claims B's order

		const orders = await sandbox.invokeRoute("storefront/account/orders", { sessionToken: tokenA });
		expect("result" in orders).toBe(true);
		const body = (orders as { result: { ok: boolean; orders: Array<{ id: string }> } }).result;
		expect(body.ok).toBe(true);
		expect(body.orders.map((o) => o.id)).toEqual([orderA]);

		// B's order, by id, as A → NOT_FOUND (no existence leak), not the order.
		const foreign = await sandbox.invokeRoute("storefront/account/order", {
			sessionToken: tokenA,
			orderId: orderB,
		});
		expect(foreign).toEqual({ result: { ok: false, error: "NOT_FOUND" } });
	});

	test("an unauthenticated request to /account/orders redirects to /account/login", async () => {
		const noToken = await sandbox.invokeRoute("storefront/account/orders", {});
		expect(noToken).toEqual({ result: { ok: false, redirectTo: "/account/login" } });

		// A bogus/expired session token resolves to no customer → same redirect.
		const badToken = await sandbox.invokeRoute("storefront/account/orders", {
			sessionToken: "not-a-real-session",
		});
		expect(badToken).toEqual({ result: { ok: false, redirectTo: "/account/login" } });
	});

	test("the account pages add no new capability beyond network:request/allowedHosts", () => {
		// ADR-0005 holds in practice: the login mail goes out over `ctx.http`, and the
		// plugin declares no email:send — exactly the two capabilities. (`ctx.storage` needs
		// none: the host builds it ungated, ADR-0018.)
		expect([...OTTA_PLUGIN_CAPABILITIES]).toEqual(["content:read", "network:request"]);
	});
});
