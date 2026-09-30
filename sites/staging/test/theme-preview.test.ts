/**
 * The admin-only live theme preview (`src/lib/theme-preview.ts`, applied by
 * `src/middleware.ts`; ADR-0024 as amended 2026-09-30).
 *
 * The security property is one sentence — ONLY a signed-in, enabled ADMIN ever
 * gets a storefront response in a theme other than the stored one — and this
 * suite pins it from both ends: the pure decision, and the middleware that
 * applies it to a request (cookie, redirect, `Cache-Control`), driven with a
 * fake Astro context so the real module runs.
 */
import { afterEach, describe, expect, test, vi } from "vitest";
import type { PreviewUser } from "../src/lib/theme-preview.js";
import type { ThemeId } from "../src/themes/manifest.js";

vi.mock("astro:middleware", () => ({
	defineMiddleware: <T>(handler: T): T => handler,
}));

/* The rules below need more shipped themes than this build has (it ships
   Tempered alone), so the manifest gains neutral stand-in entries — ids no real
   theme uses — and the preview's decisions run against them as shipped ids. */
vi.mock("../src/themes/manifest.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("../src/themes/manifest.js")>();
	const standIns = ["alpha", "beta", "gamma", "delta", "epsilon"].map((id) => ({ id, label: id }));
	const STORE_THEMES = [...real.STORE_THEMES, ...standIns];
	return {
		...real,
		STORE_THEMES,
		isThemeId: (value: unknown) =>
			typeof value === "string" && STORE_THEMES.some((theme) => theme.id === value),
	};
});

const {
	canPreviewThemes,
	decideThemePreview,
	requestThemePreview,
	setRequestThemePreview,
	themePreviewExitHref,
	THEME_PREVIEW_COOKIE,
	THEME_PREVIEW_NO_STORE,
} = await import("../src/lib/theme-preview.js");
const { onRequest } = await import("../src/middleware.js");
const { activeTheme } = await import("../src/themes/resolve.js");

const ADMIN = { role: 50, disabled: false };
const EDITOR = { role: 40, disabled: false };
const DISABLED_ADMIN = { role: 50, disabled: true };

const url = (path: string): URL => new URL(path, "https://shop.example");

describe("who may preview", () => {
	test.each([
		["an admin", ADMIN, true],
		["a role above admin", { role: 60, disabled: false }, true],
		["an editor", EDITOR, false],
		["a disabled admin", DISABLED_ADMIN, false],
		["an anonymous visitor", undefined, false],
		["null", null, false],
	])("%s → %s", (_name, user, allowed) => {
		expect(canPreviewThemes(user)).toBe(allowed);
	});

	// Fails closed: only `disabled: false` exactly is an enabled user.
	test.each([
		["no disabled flag", { role: 50 }],
		["disabled: undefined", { role: 50, disabled: undefined }],
		["disabled: null", { role: 50, disabled: null }],
		['disabled: "false"', { role: 50, disabled: "false" }],
		["disabled: 0", { role: 50, disabled: 0 }],
	])("an admin with %s may not preview", (_name, user) => {
		expect(canPreviewThemes(user as unknown as PreviewUser)).toBe(false);
	});
});

describe("decideThemePreview", () => {
	test("an admin with ?preview_theme=<shipped id> previews it and sets the cookie", () => {
		expect(
			decideThemePreview({ url: url("/?preview_theme=alpha"), cookie: undefined, user: ADMIN }),
		).toEqual({ themeId: "alpha", cookie: { set: "alpha" }, exitTo: null, silent: false });
	});

	test.each([
		["anonymous", undefined],
		["an editor", EDITOR],
		["a disabled admin", DISABLED_ADMIN],
	])("%s with the parameter gets the stored theme", (_name, user) => {
		expect(
			decideThemePreview({ url: url("/?preview_theme=alpha"), cookie: undefined, user }).themeId,
		).toBeNull();
	});

	test.each([
		["anonymous", undefined],
		["an editor", EDITOR],
	])("%s with the COOKIE gets the stored theme, and the cookie is cleared", (_name, user) => {
		expect(decideThemePreview({ url: url("/products"), cookie: "alpha", user })).toEqual({
			themeId: null,
			cookie: "clear",
			exitTo: null,
			silent: false,
		});
	});

	test("an admin's cookie carries the preview across in-frame navigation", () => {
		expect(decideThemePreview({ url: url("/products/tee"), cookie: "beta", user: ADMIN })).toEqual({
			themeId: "beta",
			cookie: "keep",
			exitTo: null,
			silent: false,
		});
	});

	test("an unknown id is ignored — as a parameter and as a cookie", () => {
		expect(
			decideThemePreview({ url: url("/?preview_theme=nope"), cookie: undefined, user: ADMIN }),
		).toEqual({ themeId: null, cookie: "keep", exitTo: null, silent: false });
		expect(decideThemePreview({ url: url("/"), cookie: "nope", user: ADMIN })).toEqual({
			themeId: null,
			cookie: "clear",
			exitTo: null,
			silent: false,
		});
	});

	test("off clears for anyone and redirects to the same URL without the parameter", () => {
		for (const user of [ADMIN, undefined]) {
			expect(
				decideThemePreview({
					url: url("/products?page=2&preview_theme=off"),
					cookie: "beta",
					user,
				}),
			).toEqual({ themeId: null, cookie: "clear", exitTo: "/products?page=2", silent: false });
		}
	});

	test("off with silent=1 (the Themes screen's exit frame) asks for an empty answer", () => {
		expect(
			decideThemePreview({
				url: url("/?preview_theme=off&silent=1"),
				cookie: "beta",
				user: ADMIN,
			}),
		).toEqual({ themeId: null, cookie: "clear", exitTo: "/", silent: true });
	});

	test("off on a //host path exits to a same-site path, never protocol-relative", () => {
		// `new URL("//evil.com/…", base)` would parse the host, so build the
		// request URL a browser would send for a path that starts with `//`.
		const request = new URL("https://shop.example//evil.com/?preview_theme=off");
		expect(request.pathname).toBe("//evil.com/");
		const { exitTo } = decideThemePreview({ url: request, cookie: undefined, user: undefined });
		expect(exitTo).toBe("/evil.com/");
		expect(themePreviewExitHref(new URL("https://shop.example///evil.com/x"))).toBe(
			"/evil.com/x?preview_theme=off",
		);
	});

	test("the pill's exit link is this page with off", () => {
		expect(themePreviewExitHref(url("/products/tee?preview_theme=beta"))).toBe(
			"/products/tee?preview_theme=off",
		);
	});

	test("the pill's exit link drops silent, so Exit never lands on the empty exit response", () => {
		expect(themePreviewExitHref(url("/products/tee?silent=1&preview_theme=beta"))).toBe(
			"/products/tee?preview_theme=off",
		);
	});
});

// ── the middleware, applied ──────────────────────────────────────────────────

interface FakeCookies {
	jar: Map<string, string>;
	set: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
}

function context(
	path: string | URL,
	options: { user?: { role: number; disabled: boolean }; cookie?: string; method?: string } = {},
) {
	const jar = new Map<string, string>();
	if (options.cookie !== undefined) jar.set(THEME_PREVIEW_COOKIE, options.cookie);
	const cookies: FakeCookies & { get: (name: string) => { value: string } | undefined } = {
		jar,
		get: (name) => (jar.has(name) ? { value: jar.get(name) as string } : undefined),
		set: vi.fn((name: string, value: string) => jar.set(name, value)),
		delete: vi.fn((name: string) => jar.delete(name)),
	};
	const locals: Record<string, unknown> = {};
	if (options.user !== undefined) locals.user = options.user;
	const at = typeof path === "string" ? url(path) : path;
	return {
		request: new Request(at, { method: options.method ?? "GET" }),
		url: at,
		cookies,
		locals,
		cache: { set: vi.fn() },
		redirect: (to: string, status: number) =>
			new Response(null, { status, headers: { Location: to } }),
	};
}

type Handler = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
const run = onRequest as unknown as Handler;
const page = (): Promise<Response> =>
	Promise.resolve(
		new Response("<html></html>", { headers: { "Cache-Control": "public, max-age=60" } }),
	);

describe("the middleware", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("an admin's preview is recorded for the request, cookied, and sent private, no-store", async () => {
		const ctx = context("/?preview_theme=gamma", { user: ADMIN });
		const response = await run(ctx, page);
		expect(response.headers.get("Cache-Control")).toBe(THEME_PREVIEW_NO_STORE);
		// …and kept out of Astro's route cache, which Cache-Control does not reach.
		expect(ctx.cache.set).toHaveBeenCalledWith(false);
		expect(requestThemePreview(ctx.locals)).toBe("gamma");
		expect(ctx.cookies.set).toHaveBeenCalledWith(
			THEME_PREVIEW_COOKIE,
			"gamma",
			expect.objectContaining({ path: "/", httpOnly: true, sameSite: "lax" }),
		);
		const options = ctx.cookies.set.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(options.maxAge).toBeUndefined();
		expect(options.expires).toBeUndefined();
	});

	test.each([
		["outside dev", false, true],
		["in dev (plain-http localhost)", true, false],
	])("the cookie is Secure %s", async (_name, dev, secure) => {
		vi.stubEnv("DEV", dev);
		const ctx = context("/?preview_theme=gamma", { user: ADMIN });
		await run(ctx, page);
		const options = ctx.cookies.set.mock.calls[0]?.[2] as Record<string, unknown>;
		expect(options.secure).toBe(secure);
	});

	test("a page that sets a cache hint cannot re-enable the route cache for a preview", async () => {
		// Astro 7's `cache.set(options)` clears an earlier `set(false)`, and the
		// route cache reads the options after `next()` returns.
		const ctx = context("/?preview_theme=gamma", { user: ADMIN });
		await run(ctx, () => {
			ctx.cache.set({ maxAge: 60 });
			return page();
		});
		expect(ctx.cache.set.mock.calls.at(-1)).toEqual([false]);
	});

	test("the resolver renders the recorded preview, not the stored theme", async () => {
		const ctx = context("/", { user: ADMIN, cookie: "delta" });
		await run(ctx, page);
		expect(ctx.cache.set).toHaveBeenCalledWith(false);
		expect(await activeTheme({ url: ctx.url, locals: ctx.locals })).toBe("delta");
	});

	test.each([
		["anonymous, with the parameter", context("/?preview_theme=alpha")],
		["anonymous, with the cookie", context("/", { cookie: "alpha" })],
		["an editor, with both", context("/?preview_theme=alpha", { user: EDITOR, cookie: "alpha" })],
	])("%s: no preview, and the page's own caching is untouched", async (_name, ctx) => {
		const response = await run(ctx, page);
		expect(requestThemePreview(ctx.locals)).toBeNull();
		expect(response.headers.get("Cache-Control")).toBe("public, max-age=60");
		expect(ctx.cookies.set).not.toHaveBeenCalled();
		expect(ctx.cache.set).not.toHaveBeenCalled();
	});

	test("off redirects (303, no-store) and clears the cookie", async () => {
		const ctx = context("/products?preview_theme=off", { user: ADMIN, cookie: "beta" });
		const next = vi.fn(page);
		const response = await run(ctx, next);
		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe("/products");
		expect(response.headers.get("Cache-Control")).toBe(THEME_PREVIEW_NO_STORE);
		expect(ctx.cookies.delete).toHaveBeenCalledWith(THEME_PREVIEW_COOKIE, { path: "/" });
		expect(ctx.cache.set).toHaveBeenCalledWith(false);
		expect(next).not.toHaveBeenCalled();
	});

	test("a silent off answers an empty 200 — no redirect, no page render — and clears the cookie", async () => {
		const ctx = context("/?preview_theme=off&silent=1", { user: ADMIN, cookie: "beta" });
		const next = vi.fn(page);
		const response = await run(ctx, next);
		expect(response.status).toBe(200);
		expect(response.headers.get("Location")).toBeNull();
		expect(await response.text()).toBe("");
		expect(response.headers.get("Cache-Control")).toBe(THEME_PREVIEW_NO_STORE);
		expect(ctx.cookies.delete).toHaveBeenCalledWith(THEME_PREVIEW_COOKIE, { path: "/" });
		expect(ctx.cache.set).toHaveBeenCalledWith(false);
		expect(next).not.toHaveBeenCalled();
	});

	test("off on a //host path redirects to a same-site path", async () => {
		const ctx = context(new URL("https://shop.example//evil.com/?preview_theme=off"));
		const response = await run(ctx, page);
		expect(response.status).toBe(303);
		expect(response.headers.get("Location")).toBe("/evil.com/");
	});

	test("writes and the admin itself pass straight through", async () => {
		for (const ctx of [
			context("/cart/add?preview_theme=beta", { user: ADMIN, method: "POST" }),
			context("/_emdash/admin?preview_theme=beta", { user: ADMIN }),
		]) {
			await run(ctx, page);
			expect(requestThemePreview(ctx.locals)).toBeNull();
			expect(ctx.cookies.set).not.toHaveBeenCalled();
		}
	});

	test("a response with immutable headers is copied, never sent cacheable", async () => {
		const ctx = context("/?preview_theme=epsilon", { user: ADMIN });
		const frozen = Response.redirect("https://shop.example/products", 302);
		const response = await run(ctx, () => Promise.resolve(frozen));
		expect(response.headers.get("Cache-Control")).toBe(THEME_PREVIEW_NO_STORE);
	});

	test("setRequestThemePreview is per request", () => {
		const a = {};
		// A stand-in id (see the manifest mock above).
		setRequestThemePreview(a, "beta" as ThemeId);
		expect(requestThemePreview(a)).toBe("beta");
		expect(requestThemePreview({})).toBeNull();
	});
});
