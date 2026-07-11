import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import { requireBearerToken, tokenMatches } from "../src/auth.js";

// `tokenMatches` moved from routes/carts.ts to auth.ts (shared by the
// X-Internal-Token gate and the new Bearer gate) — behavior preserved.
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
	app.use("*", requireBearerToken(token));
	app.get("/health", (c) => c.json({ ok: true }));
	app.get("/read", (c) => c.json({ ok: true, read: true }));
	app.post("/write", (c) => c.json({ ok: true, wrote: true }));
	return app;
}

describe("requireBearerToken middleware", () => {
	test("token unset: everything passes through untouched (today's behavior)", async () => {
		const app = appWith(undefined);
		expect((await app.request("/write", { method: "POST" })).status).toBe(200);
		expect((await app.request("/read")).status).toBe(200);
	});

	test("token set: a non-GET without Authorization is 401 with WWW-Authenticate: Bearer", async () => {
		const app = appWith("tok");
		const res = await app.request("/write", { method: "POST" });
		expect(res.status).toBe(401);
		expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
		expect(await res.json()).toEqual({ ok: false, error: "unauthorized" });
	});

	test("token set: a non-Bearer scheme is 401", async () => {
		const app = appWith("tok");
		const res = await app.request("/write", {
			method: "POST",
			headers: { Authorization: "Basic tok" },
		});
		expect(res.status).toBe(401);
	});

	test("token set: a wrong Bearer token is 401", async () => {
		const app = appWith("tok");
		const res = await app.request("/write", {
			method: "POST",
			headers: { Authorization: "Bearer not-tok" },
		});
		expect(res.status).toBe(401);
	});

	test("token set: the correct Bearer token reaches the route", async () => {
		const app = appWith("tok");
		const res = await app.request("/write", {
			method: "POST",
			headers: { Authorization: "Bearer tok" },
		});
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, wrote: true });
	});

	test("token set: GET and HEAD stay open (Hono serves HEAD via GET handlers)", async () => {
		const app = appWith("tok");
		expect((await app.request("/read")).status).toBe(200);
		expect((await app.request("/read", { method: "HEAD" })).status).toBe(200);
		expect((await app.request("/health")).status).toBe(200);
	});
});
