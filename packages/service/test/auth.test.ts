import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { requireServiceToken, tokenMatches } from "../src/auth.js";

// `tokenMatches` moved from routes/carts.ts to auth.ts (shared by the
// X-Internal-Token gate and the X-Service-Token write gate) — behavior preserved.
describe("tokenMatches", () => {
	test("an exact match is accepted", () => {
		expect(tokenMatches("secret", "secret")).toBe(true);
	});

	test("a mismatch of equal length is rejected", () => {
		expect(tokenMatches("secreta", "secretb")).toBe(false);
	});

	test("a length-differing candidate is rejected (no length leak — hashed compare)", () => {
		expect(tokenMatches("secret-longer", "secret")).toBe(false);
		expect(tokenMatches("s", "secret")).toBe(false);
	});

	test("an absent candidate is rejected", () => {
		expect(tokenMatches(undefined, "secret")).toBe(false);
	});
});

function appWith(token: string | undefined): Hono {
	const app = new Hono();
	app.use("*", requireServiceToken(token));
	app.get("/health", (c) => c.json({ ok: true }));
	app.get("/read", (c) => c.json({ ok: true, read: true }));
	app.post("/write", (c) => c.json({ ok: true, wrote: true }));
	return app;
}

describe("requireServiceToken middleware", () => {
	test("token unset: everything passes through untouched (today's behavior)", async () => {
		const app = appWith(undefined);
		expect((await app.request("/write", { method: "POST" })).status).toBe(200);
		expect((await app.request("/read")).status).toBe(200);
	});

	test("token set: a non-GET without X-Service-Token is 401 and carries NO WWW-Authenticate challenge", async () => {
		const app = appWith("tok");
		const res = await app.request("/write", { method: "POST" });
		expect(res.status).toBe(401);
		// The machine token no longer uses the Bearer scheme — no challenge header,
		// byte-identical to the X-Internal-Token gate's 401.
		expect(res.headers.get("WWW-Authenticate")).toBeNull();
		expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
	});

	test("token set: a wrong X-Service-Token is 401", async () => {
		const app = appWith("tok");
		const res = await app.request("/write", {
			method: "POST",
			headers: { "X-Service-Token": "not-tok" },
		});
		expect(res.status).toBe(401);
	});

	test("token set: the correct X-Service-Token reaches the route", async () => {
		const app = appWith("tok");
		const res = await app.request("/write", {
			method: "POST",
			headers: { "X-Service-Token": "tok" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, wrote: true });
	});

	test("token set: the gate IGNORES Authorization — a matching Bearer token is still 401", async () => {
		// Authorization: Bearer is owned SOLELY by customer session auth now; the
		// write gate reads ONLY X-Service-Token (ADR-0007). A request whose only
		// credential is `Authorization: Bearer <serviceToken>` must NOT pass.
		const app = appWith("tok");
		const res = await app.request("/write", {
			method: "POST",
			headers: { Authorization: "Bearer tok" },
		});
		expect(res.status).toBe(401);
	});

	test("token set: GET and HEAD stay open (Hono serves HEAD via GET handlers)", async () => {
		const app = appWith("tok");
		expect((await app.request("/read")).status).toBe(200);
		expect((await app.request("/read", { method: "HEAD" })).status).toBe(200);
		expect((await app.request("/health")).status).toBe(200);
	});
});
