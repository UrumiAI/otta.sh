// The playground's GitHub star prompt (src/lib/playground-star.ts renders the markup).
// The page arrives showing the pill. On a visitor's first page of the session the card
// takes its place after a moment; dismissing it, or starring, goes back to the pill for
// good (localStorage). The count comes from the same-origin /_otta/stars after load and
// is kept for the session, so later pages do not ask again. No script: the pill stays.
const root = document.querySelector(".otta-star");
const DISMISSED = "otta-star:dismissed";
const SEEN = "otta-star:seen";
const COUNT = "otta-star:count";
const OWN_ESCAPE = 'input, textarea, select, [role="listbox"], [role="menu"], [role="combobox"]';
const NO_COUNT = "-"; // remembered too, so a rate-limited count is not asked for on every page

function read(storage, key) {
	try {
		return globalThis[storage].getItem(key);
	} catch {
		return null;
	}
}

function write(storage, key, value) {
	try {
		globalThis[storage].setItem(key, value);
	} catch {
		// Private mode or blocked storage: the prompt still works for this page.
	}
}

function showCount(label) {
	for (const el of root.querySelectorAll("[data-otta-star-label]")) el.textContent = label;
	for (const el of root.querySelectorAll("[data-otta-star-count]")) el.hidden = false;
}

async function loadCount() {
	const cached = read("sessionStorage", COUNT);
	if (cached === NO_COUNT) return;
	if (cached) return showCount(cached);
	try {
		const response = await fetch("/_otta/stars", { headers: { accept: "application/json" } });
		if (!response.ok) return;
		const { label } = await response.json();
		if (typeof label !== "string" || label === "") {
			write("sessionStorage", COUNT, NO_COUNT);
			return;
		}
		write("sessionStorage", COUNT, label);
		showCount(label);
	} catch {
		// No count is fine: the prompt reads "Star" without one.
	}
}

// EmDash's own playground toolbar is fixed at the bottom centre and, on narrow screens,
// spans the width. Sit above it whenever it would reach the prompt's corner.
// The card's width and right offset in src/lib/playground-star.ts, plus breathing room.
const CARD_SPAN = 304 + 20 + 12;
function clearToolbar() {
	const bar = document.getElementById("emdash-playground-toolbar");
	const box = bar?.getBoundingClientRect();
	const overlaps = box && box.height > 0 && box.right > innerWidth - CARD_SPAN;
	root.style.bottom = overlaps ? `${Math.round(innerHeight - box.top + 12)}px` : "";
}

if (root) {
	loadCount();
	clearToolbar();
	addEventListener("resize", clearToolbar);
	const bar = document.getElementById("emdash-playground-toolbar");
	if (bar && typeof ResizeObserver === "function") new ResizeObserver(clearToolbar).observe(bar);
	let timer = null;
	const done = () => {
		clearTimeout(timer);
		write("localStorage", DISMISSED, "1");
		if (root.dataset.state !== "card") return;
		const hadFocus = root.contains(document.activeElement);
		root.classList.add("otta-star-fresh");
		root.dataset.state = "pill";
		if (hadFocus) root.querySelector(".otta-star-pill")?.focus();
	};
	const onActivate = (event) => {
		if (event.type === "auxclick" && event.button !== 1) return; // middle-click only
		if (event.target.closest("[data-otta-star-dismiss], .otta-star-cta")) done();
	};
	root.addEventListener("click", onActivate);
	root.addEventListener("auxclick", onActivate);
	document.addEventListener("keydown", (event) => {
		if (event.key !== "Escape" || root.dataset.state !== "card" || event.defaultPrevented) return;
		// An Escape meant for an admin dialog or menu is not a no to the prompt, nor is one
		// that closes a select, clears a field or dismisses the editor's slash menu.
		// composedPath() sees through shadow roots, where event.target is retargeted.
		const path = event.composedPath().filter((node) => node instanceof Element);
		for (const from of [...path, document.activeElement]) {
			if (!(from instanceof Element)) continue;
			if (from.isContentEditable || from.matches(OWN_ESCAPE)) return;
			const owner = from.closest('[role="dialog"], [aria-modal="true"]');
			if (owner && !root.contains(owner)) return;
		}
		done();
	});
	if (read("localStorage", DISMISSED) !== "1" && read("sessionStorage", SEEN) !== "1") {
		timer = setTimeout(() => {
			write("sessionStorage", SEEN, "1");
			root.dataset.state = "card";
		}, 1800);
	}
}
