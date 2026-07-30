import {
	email as toEmail,
	requestLogin,
	verifyLogin,
	type Clock,
	type CustomerCredentialVerifier,
	type CustomerStore,
	type EmailSender,
	type OrderStore,
	type SessionStore,
} from "@otta-sh/domain";
import { Hono } from "hono";
import { loginRequestBody, loginVerifyBody } from "../schemas.js";
import { bearerToken } from "./session-auth.js";

export interface AuthRoutesDeps {
	credentialVerifier: CustomerCredentialVerifier;
	customerStore: CustomerStore;
	sessionStore: SessionStore;
	orderStore: OrderStore;
	emailSender: EmailSender;
	clock: Clock;
	/** Base URL of the storefront where the magic link lands (for the emailed
	 *  link). Absent ⇒ the email carries the raw challengeId/token. */
	storefrontBaseUrl?: string;
}

/**
 * Storefront customer auth (Phase 5 §7). Magic-link only (§4 draft ADR):
 *  - `POST /auth/login/request` — issue a challenge and email the link. Returns
 *    an **identical** response whether or not an account exists (§9 Risk 4: no
 *    enumeration oracle) — a first-ever login creates the account on verify.
 *  - `POST /auth/login/verify` — redeem the token → a session token in the body
 *    (not a Set-Cookie; the plugin's first-party layer owns the cookie, §4).
 *  - `POST /auth/logout` — revoke the bearer session (idempotent).
 */
export function authRoutes(deps: AuthRoutesDeps): Hono {
	const app = new Hono();

	app.post("/login/request", async (c) => {
		const parsed = loginRequestBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		let email;
		try {
			email = toEmail(parsed.data.email);
		} catch {
			return c.json({ error: "invalid email" }, 400);
		}
		const issued = await requestLogin({ credentialVerifier: deps.credentialVerifier }, { email });
		if (issued.ok) {
			const { challengeId, token } = issued;
			const loginUrl =
				deps.storefrontBaseUrl === undefined
					? undefined
					: `${deps.storefrontBaseUrl.replace(/\/$/, "")}/account/login?challengeId=${encodeURIComponent(challengeId)}&token=${encodeURIComponent(token)}`;
			await deps.emailSender.send({
				to: email,
				template: "customer-login-link",
				data: { challengeId, token, ...(loginUrl !== undefined ? { loginUrl } : {}) },
				idempotencyKey: `login:${challengeId}`,
			});
		}
		// Identical response regardless of account existence AND regardless of
		// rate limiting (review round H1): a THROTTLED issue sends no email and
		// inserts no challenge, but the caller must not be able to tell — else
		// the limiter itself becomes a probing oracle (§9 Risk 4).
		return c.json({ ok: true, message: "If an account exists, we've sent a sign-in link." }, 200);
	});

	app.post("/login/verify", async (c) => {
		const parsed = loginVerifyBody.safeParse(await readJson(c));
		if (!parsed.success) return c.json({ error: "invalid request body" }, 400);
		const result = await verifyLogin(deps, {
			challengeId: parsed.data.challengeId,
			token: parsed.data.token,
		});
		if (!result.ok) {
			// A stale/invalid/consumed challenge → 401, never customer detail.
			return c.json({ ok: false, reason: result.reason }, 401);
		}
		return c.json(
			{ ok: true, sessionToken: result.sessionToken, expiresAt: result.expiresAt },
			200,
		);
	});

	app.post("/logout", async (c) => {
		const token = bearerToken(c);
		if (token !== null) await deps.sessionStore.revoke(token);
		return c.json({ ok: true }, 200);
	});

	return app;
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}
