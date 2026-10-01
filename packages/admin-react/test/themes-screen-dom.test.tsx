/**
 * @vitest-environment happy-dom
 * @vitest-environment-options {"settings":{"disableIframePageLoading":true}}
 *
 * The Themes screen (ADR-0014 as amended 2026-09-30), over a stubbed
 * `apiFetch` — the console's one transport — so what is asserted is exactly
 * what the screen sends and how it renders what comes back.
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { ThemesScreen, orderThemes } = await import("../src/themes/themes-screen.js");

const THEMES = [
	{
		id: "tempered",
		label: "Tempered",
		description: "Condensed headlines.",
		preview: "/theme-previews/tempered.webp",
		previewUrl: "/?preview_theme=tempered",
	},
	{
		id: "plinth",
		label: "Plinth",
		description: null,
		preview: "/theme-previews/plinth.webp",
		previewUrl: "/?preview_theme=plinth",
	},
	{
		id: "pressing",
		label: "Pressing",
		description: null,
		preview: null,
		previewUrl: "/?preview_theme=pressing",
	},
];

function reply(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

const LIST = {
	ok: true,
	themes: THEMES,
	activeId: "plinth",
	exitPreviewUrl: "/?preview_theme=off&silent=1",
};

function sent(call: number): Record<string, unknown> {
	const init = apiFetch.mock.calls[call]?.[1];
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

async function settle(): Promise<void> {
	await React.act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

/** Fire the frame's `load` (this environment loads no frame pages). */
async function loaded(frame: HTMLIFrameElement): Promise<void> {
	await React.act(async () => {
		frame.dispatchEvent(new Event("load"));
	});
}

function cards(view: Mounted): string[] {
	return [...view.container.querySelectorAll<HTMLElement>('[data-testid="otta-theme-card"]')].map(
		(card) => `${card.dataset.theme ?? ""}${card.dataset.active === "true" ? "*" : ""}`,
	);
}

let view: Mounted | null = null;

beforeEach(() => {
	apiFetch.mockReset();
});

afterEach(async () => {
	await view?.unmount();
	view = null;
});

test("orderThemes puts the active theme first and keeps the site's order otherwise", () => {
	expect(orderThemes(THEMES, "pressing").map((t) => t.id)).toEqual([
		"pressing",
		"tempered",
		"plinth",
	]);
});

test("loads through the admin route and renders the active theme first, with a count", async () => {
	apiFetch.mockResolvedValueOnce(reply(LIST));
	view = await mount(<ThemesScreen />);
	await settle();
	expect(apiFetch.mock.calls[0]?.[0]).toBe("/_emdash/api/plugins/otta/admin");
	expect(sent(0)).toEqual({ type: "otta_console_read", resource: "themes.list" });
	expect(cards(view)).toEqual(["plinth*", "tempered", "pressing"]);
	expect(view.container.querySelector("h1")?.textContent).toBe("Themes");
	// The number, and for a screen reader "3 themes" — no aria-label on a span.
	const count = view.container.querySelector('[data-testid="otta-themes-count"]');
	expect(count?.textContent).toBe("3 themes");
	expect(count?.getAttribute("aria-label")).toBeNull();
	expect(count?.querySelector(".otta-sr-only")?.textContent).toBe(" themes");
	const active = view.container.querySelector('[data-theme="plinth"]');
	expect(active?.textContent).toContain("Active: Plinth");
	expect(active?.querySelector('[data-testid="otta-theme-activate"]')).toBeNull();
	// Every other theme offers Activate and a keyboard-reachable Live preview.
	const other = view.container.querySelector('[data-theme="tempered"]');
	expect(other?.querySelector('[data-testid="otta-theme-activate"]')?.textContent).toBe("Activate");
	expect(other?.querySelector("button[aria-label='Live preview of Tempered']")).not.toBeNull();
	expect(other?.querySelector("img")?.getAttribute("src")).toBe("/theme-previews/tempered.webp");
});

const ACTIVATED = reply({
	ok: true,
	activeId: "pressing",
	notice: { variant: "default", title: "Pressing is now your store's theme", description: "x" },
});

test("activating re-orders the grid, toasts, and sends the Settings radio's id", async () => {
	apiFetch.mockResolvedValueOnce(reply(LIST)).mockResolvedValueOnce(ACTIVATED.clone());
	view = await mount(<ThemesScreen />);
	await settle();
	// The status region is there, empty, BEFORE anything is announced into it.
	const status = view.container.querySelector('[data-testid="otta-themes-status"]');
	expect(status?.getAttribute("role")).toBe("status");
	expect(status?.textContent).toBe("");
	const button = view.container.querySelector<HTMLButtonElement>(
		'[data-theme="pressing"] [data-testid="otta-theme-activate"]',
	);
	await fire(button as HTMLButtonElement, "click");
	await settle();
	expect(sent(1)).toEqual({
		type: "otta_console_act",
		action_id: "themes:activate",
		value: { themeId: "pressing" },
	});
	expect(cards(view)).toEqual(["pressing*", "tempered", "plinth"]);
	const toast = view.container.querySelector('[data-testid="otta-theme-toast"]');
	expect(toast?.textContent).toContain("Pressing is now your store's theme");
	// Announced by swapping text into the SAME, already-mounted region.
	expect(view.container.querySelector('[data-testid="otta-themes-status"]')).toBe(status);
	expect(status?.textContent).toBe("Pressing is now your store's theme. x");
	// Focus is handed to the new active bar rather than dropped to <body>.
	expect(document.activeElement?.getAttribute("data-testid")).toBe("otta-theme-visit");
});

test("a refused activation keeps the grid as it was and says why", async () => {
	apiFetch
		.mockResolvedValueOnce(reply(LIST))
		.mockResolvedValueOnce(
			reply({ ok: false, title: "Theme not activated", description: "Nothing was changed." }),
		);
	view = await mount(<ThemesScreen />);
	await settle();
	await fire(
		view.container.querySelector(
			'[data-theme="tempered"] [data-testid="otta-theme-activate"]',
		) as Element,
		"click",
	);
	await settle();
	expect(cards(view)).toEqual(["plinth*", "tempered", "pressing"]);
	const toast = view.container.querySelector('[data-testid="otta-theme-toast"]');
	expect(toast?.getAttribute("role")).toBe("alert");
	expect(toast?.textContent).toContain("Theme not activated");
});

test("a failed load is a notice with Retry, never a blank pane", async () => {
	apiFetch.mockResolvedValueOnce(new Response("{}", { status: 403 }));
	view = await mount(<ThemesScreen />);
	await settle();
	const notice = view.container.querySelector('[data-testid="otta-themes-failure"]');
	expect(notice?.textContent).toContain("Themes are unavailable (HTTP 403)");
	expect(notice?.querySelector("button")?.textContent).toBe("Retry");
});

test("Live preview frames the plugin's preview URL; closing it ends the preview session", async () => {
	apiFetch.mockResolvedValueOnce(reply(LIST));
	view = await mount(<ThemesScreen />);
	await settle();
	await fire(
		view.container.querySelector("button[aria-label='Live preview of Tempered']") as Element,
		"click",
	);
	const frame = view.container.querySelector<HTMLIFrameElement>(
		'[data-testid="otta-theme-live-frame"]',
	);
	expect(frame?.getAttribute("src")).toBe("/?preview_theme=tempered");
	expect(
		view.container.querySelector('[data-testid="otta-theme-live-newtab"]')?.getAttribute("href"),
	).toBe("/?preview_theme=tempered");
	expect(
		view.container.querySelector('[data-testid="otta-theme-live-activate"]')?.textContent,
	).toBe("Activate Tempered");
	expect(view.container.querySelector('[data-testid="otta-theme-exit-frame"]')).toBeNull();

	await fire(
		view.container.querySelector('[data-testid="otta-theme-live-close"]') as Element,
		"click",
	);
	expect(view.container.querySelector('[data-testid="otta-theme-live-frame"]')).toBeNull();
	const exit = view.container.querySelector<HTMLIFrameElement>(
		'[data-testid="otta-theme-exit-frame"]',
	);
	expect(exit?.getAttribute("src")).toBe("/?preview_theme=off&silent=1");
	// Once the exit has landed, its frame goes.
	await loaded(exit as HTMLIFrameElement);
	expect(view.container.querySelector('[data-testid="otta-theme-exit-frame"]')).toBeNull();
});

test("Esc (the dialog's cancel) closes the preview and ends the session", async () => {
	apiFetch.mockResolvedValueOnce(reply(LIST));
	view = await mount(<ThemesScreen />);
	await settle();
	await fire(
		view.container.querySelector("button[aria-label='Live preview of Tempered']") as Element,
		"click",
	);
	const cancel = new Event("cancel", { cancelable: true });
	await React.act(async () => {
		view?.container.querySelector('[data-testid="otta-theme-live"]')?.dispatchEvent(cancel);
	});
	expect(cancel.defaultPrevented).toBe(true);
	expect(view.container.querySelector('[data-testid="otta-theme-live-frame"]')).toBeNull();
	expect(view.container.querySelector('[data-testid="otta-theme-exit-frame"]')).not.toBeNull();
});

test("a preview opened while the last exit is in flight waits for it before framing", async () => {
	apiFetch.mockResolvedValueOnce(reply(LIST));
	view = await mount(<ThemesScreen />);
	await settle();
	await fire(
		view.container.querySelector("button[aria-label='Live preview of Tempered']") as Element,
		"click",
	);
	await fire(
		view.container.querySelector('[data-testid="otta-theme-live-close"]') as Element,
		"click",
	);
	await fire(
		view.container.querySelector("button[aria-label='Live preview of Pressing']") as Element,
		"click",
	);
	// The dialog is open on Pressing, but its frame is not mounted: the exit's
	// clearing cookie must not land after Pressing's.
	expect(view.container.querySelector("#otta-live-title")?.textContent).toBe("Previewing Pressing");
	expect(view.container.querySelector('[data-testid="otta-theme-live-frame"]')).toBeNull();
	await loaded(
		view.container.querySelector('[data-testid="otta-theme-exit-frame"]') as HTMLIFrameElement,
	);
	expect(view.container.querySelector('[data-testid="otta-theme-exit-frame"]')).toBeNull();
	expect(
		view.container.querySelector('[data-testid="otta-theme-live-frame"]')?.getAttribute("src"),
	).toBe("/?preview_theme=pressing");
});

test.each([
	["its Live preview button", "button[aria-label='Live preview of Tempered']"],
	["its picture (which takes no focus)", '[data-theme="tempered"] .otta-theme-shot'],
])("closing a preview opened from %s returns focus to the card's Live preview", async (_n, sel) => {
	apiFetch.mockResolvedValueOnce(reply(LIST));
	view = await mount(<ThemesScreen />);
	await settle();
	const reveal = view.container.querySelector<HTMLElement>(
		"button[aria-label='Live preview of Tempered']",
	);
	await fire(view.container.querySelector(sel) as Element, "click");
	await fire(
		view.container.querySelector('[data-testid="otta-theme-live-close"]') as Element,
		"click",
	);
	expect(document.activeElement).toBe(reveal);
});

test("Activate in the preview moves focus to the new active card's View store", async () => {
	apiFetch.mockResolvedValueOnce(reply(LIST)).mockResolvedValueOnce(ACTIVATED.clone());
	view = await mount(<ThemesScreen />);
	await settle();
	await fire(
		view.container.querySelector("button[aria-label='Live preview of Pressing']") as Element,
		"click",
	);
	await fire(
		view.container.querySelector('[data-testid="otta-theme-live-activate"]') as Element,
		"click",
	);
	await settle();
	expect(view.container.querySelector('[data-testid="otta-theme-live-frame"]')).toBeNull();
	expect(cards(view)[0]).toBe("pressing*");
	expect(document.activeElement).toBe(
		view.container.querySelector('[data-theme="pressing"] [data-testid="otta-theme-visit"]'),
	);
});

test("previewing the active theme offers no Activate", async () => {
	apiFetch.mockResolvedValueOnce(reply(LIST));
	view = await mount(<ThemesScreen />);
	await settle();
	await fire(
		view.container.querySelector("button[aria-label='Live preview of Plinth']") as Element,
		"click",
	);
	expect(view.container.querySelector('[data-testid="otta-theme-live-activate"]')).toBeNull();
	expect(view.container.querySelector('[data-testid="otta-theme-live"]')?.textContent).toContain(
		"Active",
	);
});
