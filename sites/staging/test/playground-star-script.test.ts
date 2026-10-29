/**
 * @vitest-environment happy-dom
 *
 * The playground's star prompt script (`public/scripts/playground-star.js`),
 * run in a DOM over the markup `starPrompt()` renders: the card opens once a
 * session, dismissing it is remembered, focus is not lost, and the count is
 * filled from `/_otta/stars` without ever being required.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { starPrompt } from "../src/lib/playground-star.js";

const SCRIPT = readFileSync(
	path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"../public/scripts/playground-star.js",
	),
	"utf8",
);

let urls: string[] = [];

/** The prompt's markup without its `<script src>`: the test runs the file itself, and
 *  happy-dom does not load scripts. Parsed in an inert template, so nothing fetches. */
function renderPrompt(): void {
	const template = document.createElement("template");
	template.innerHTML = starPrompt();
	for (const script of template.content.querySelectorAll("script")) script.remove();
	document.body.replaceChildren(template.content);
}

function page(answer: () => Promise<Response> = async () => Response.json({ label: "57" })) {
	// The script is run below as the page would; happy-dom does not fetch files.
	renderPrompt();
	urls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			urls.push(url);
			return answer();
		}),
	);
	new Function(SCRIPT)();
	return document.querySelector<HTMLElement>(".otta-star")!;
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("playground-star.js", () => {
	test("opens the card after a moment on the first page of a session", () => {
		const root = page();
		expect(root.dataset.state).toBe("pill");
		vi.advanceTimersByTime(1800);
		expect(root.dataset.state).toBe("card");
	});

	test("later pages of the session stay on the pill", () => {
		page();
		vi.advanceTimersByTime(1800);
		const root = page();
		vi.advanceTimersByTime(5000);
		expect(root.dataset.state).toBe("pill");
	});

	test("Not now goes back to the pill for good and keeps focus in the prompt", () => {
		let root = page();
		vi.advanceTimersByTime(1800);
		const later = root.querySelector<HTMLButtonElement>(".otta-star-later")!;
		later.focus();
		later.click();
		expect(root.dataset.state).toBe("pill");
		expect(document.activeElement).toBe(root.querySelector(".otta-star-pill"));
		sessionStorage.clear(); // a new session
		root = page();
		vi.advanceTimersByTime(5000);
		expect(root.dataset.state).toBe("pill");
	});

	test("Escape anywhere on the page dismisses the open card", () => {
		const root = page();
		vi.advanceTimersByTime(1800);
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(root.dataset.state).toBe("pill");
		expect(localStorage.getItem("otta-star:dismissed")).toBe("1");
	});

	test("an Escape meant for another dialog leaves the card alone", () => {
		const root = page();
		const dialog = document.createElement("div");
		dialog.setAttribute("role", "dialog");
		dialog.innerHTML = "<button>Close</button>";
		document.body.append(dialog);
		vi.advanceTimersByTime(1800);
		dialog.querySelector("button")!.focus();
		document.activeElement!.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		);
		expect(root.dataset.state).toBe("card");
		expect(localStorage.getItem("otta-star:dismissed")).toBeNull();
	});

	test("right-click on the star link does not dismiss, middle-click does", () => {
		const root = page();
		vi.advanceTimersByTime(1800);
		const cta = root.querySelector(".otta-star-cta")!;
		cta.dispatchEvent(new MouseEvent("auxclick", { button: 2, bubbles: true }));
		expect(root.dataset.state).toBe("card");
		cta.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true }));
		expect(root.dataset.state).toBe("pill");
	});

	test("starring from the card counts as dismissing it", () => {
		const root = page();
		vi.advanceTimersByTime(1800);
		root.querySelector<HTMLAnchorElement>(".otta-star-cta")!.click();
		expect(root.dataset.state).toBe("pill");
	});

	test("fills the count once and reuses it for the session", async () => {
		let root = page();
		await settle();
		expect(urls).toEqual(["/_otta/stars"]);
		const counts = root.querySelectorAll<HTMLElement>("[data-otta-star-count]");
		expect([...counts].every((el) => !el.hidden)).toBe(true);
		expect(root.querySelector("[data-otta-star-label]")!.textContent).toBe("57");
		root = page();
		await settle();
		expect(urls).toEqual([]);
		expect(root.querySelector("[data-otta-star-label]")!.textContent).toBe("57");
	});

	test("sits above EmDash's playground toolbar only when it reaches the corner", () => {
		let box = { height: 70, top: 674, right: 374 }; // phone width: the toolbar wraps and spans
		vi.stubGlobal("innerWidth", 390);
		vi.stubGlobal("innerHeight", 760);
		renderPrompt();
		const bar = document.createElement("div");
		bar.id = "emdash-playground-toolbar";
		bar.getBoundingClientRect = () => box as DOMRect;
		document.body.append(bar);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ label: null })),
		);
		new Function(SCRIPT)();
		const root = document.querySelector<HTMLElement>(".otta-star")!;
		expect(root.style.bottom).toBe("98px");
		box = { height: 38, top: 706, right: 895 }; // desktop: centred, clear of the corner
		vi.stubGlobal("innerWidth", 1280);
		dispatchEvent(new Event("resize"));
		expect(root.style.bottom).toBe("");
	});

	test("no count leaves the prompt reading Star", async () => {
		const root = page(async () => Response.json({ stars: null, label: null }));
		await settle();
		const counts = root.querySelectorAll<HTMLElement>("[data-otta-star-count]");
		expect([...counts].every((el) => el.hidden)).toBe(true);
		page(async () => Response.json({ stars: null, label: null }));
		await settle();
		expect(urls).toEqual([]); // "no count" is remembered for the session too
		sessionStorage.clear();
		const offline = page(async () => {
			throw new TypeError("offline");
		});
		await settle();
		expect(offline.querySelector<HTMLElement>("[data-otta-star-count]")!.hidden).toBe(true);
	});
});
