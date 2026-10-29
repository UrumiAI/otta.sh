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
let listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject]> = [];

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
	run();
	return document.querySelector<HTMLElement>(".otta-star")!;
}

/** Runs the script as a page load would. It adds document and window listeners that a
 *  real navigation discards; they are recorded here and removed after the test, so a
 *  previous test's instance cannot answer an event meant for this one. */
function run(): void {
	const spies = [document, window].map((target) => {
		const add = target.addEventListener.bind(target);
		return vi.spyOn(target, "addEventListener").mockImplementation((type, listener, options) => {
			listeners.push([target, type, listener]);
			add(type, listener, options);
		});
	});
	new Function(SCRIPT)();
	for (const spy of spies) spy.mockRestore();
}

/** What leaving a page does to its listeners. */
function leavePage(): void {
	for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
	listeners = [];
}

const consume = (event: Event): void => event.preventDefault();

const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	sessionStorage.clear();
});

afterEach(() => {
	leavePage();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const escape = (target: Element): KeyboardEvent => {
	const event = new KeyboardEvent("keydown", {
		key: "Escape",
		bubbles: true,
		cancelable: true,
	});
	target.dispatchEvent(event);
	return event;
};

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

	test.each([
		["an input", '<input type="text" />', "input"],
		["a textarea", "<textarea></textarea>", "textarea"],
		["a select", "<select><option>a</option></select>", "select"],
		["an editable region", '<div contenteditable="true"><p>text</p></div>', "p"],
		["a listbox", '<ul role="listbox"><li role="option">a</li></ul>', "li"],
		["a combobox", '<div role="combobox" tabindex="0"><span>a</span></div>', "span"],
		["a menu", '<div role="menu"><button role="menuitem">a</button></div>', "button"],
	])("an Escape typed in %s leaves the card alone", (_, markup, inner) => {
		const root = page();
		const host = document.createElement("div");
		host.innerHTML = markup;
		document.body.append(host);
		vi.advanceTimersByTime(1800);
		escape(host.querySelector(inner)!);
		expect(root.dataset.state).toBe("card");
		expect(localStorage.getItem("otta-star:dismissed")).toBeNull();
	});

	test("an earlier page's handlers are gone: its open card does not answer this page's Escape", () => {
		page();
		vi.advanceTimersByTime(1800); // the earlier page's card is open
		leavePage();
		renderPrompt(); // the next page, whose script has not run
		escape(document.body);
		expect(localStorage.getItem("otta-star:dismissed")).toBeNull();
	});

	test("a focused field keeps its Escape even when the event is sent to the body", () => {
		const root = page();
		const input = document.createElement("input");
		document.body.append(input);
		vi.advanceTimersByTime(1800);
		input.focus();
		expect(document.activeElement).toBe(input);
		escape(document.body);
		expect(root.dataset.state).toBe("card");
	});

	test("an Escape another handler already consumed leaves the card alone", () => {
		const root = page();
		vi.advanceTimersByTime(1800);
		document.body.addEventListener("keydown", consume);
		escape(document.body);
		document.body.removeEventListener("keydown", consume);
		expect(root.dataset.state).toBe("card");
		expect(localStorage.getItem("otta-star:dismissed")).toBeNull();
	});

	test("contenteditable=false is not an editor", () => {
		const root = page();
		const host = document.createElement("div");
		host.innerHTML = '<div contenteditable="false"><span>x</span></div>';
		document.body.append(host);
		vi.advanceTimersByTime(1800);
		escape(host.querySelector("span")!);
		expect(root.dataset.state).toBe("pill");
	});

	test("Escape anywhere on the page dismisses the open card", () => {
		const root = page();
		vi.advanceTimersByTime(1800);
		document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(root.dataset.state).toBe("pill");
		expect(localStorage.getItem("otta-star:dismissed")).toBe("1");
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
		run();
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
