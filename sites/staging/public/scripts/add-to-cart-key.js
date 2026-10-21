// ADR-0039 (issue #37): each add-to-cart SUBMISSION posts a key of its own, so pressing
// Add to cart again adds again. The same submission sent twice in one page life (a
// double-click, a press while the first is in flight) keeps its key and replays. No
// script, or no crypto.randomUUID: the form posts the key the server rendered.
let fresh = 0; // bumped by a history-cache restore: whatever was sent before is done
for (const form of document.querySelectorAll('form[action="/cart/add"]')) {
	const key = form.querySelector('input[name="idempotencyKey"]');
	if (!key) continue;
	let sent = null; // the submission (form body without the key) its key was minted for
	form.addEventListener("submit", () => {
		if (typeof globalThis.crypto?.randomUUID !== "function") return;
		const fields = [...new FormData(form)].filter(([name]) => name !== "idempotencyKey");
		const body = `${fresh}?${new URLSearchParams(fields)}`;
		if (body === sent) return; // the same submission again: keep its key
		key.value = globalThis.crypto.randomUUID();
		sent = body;
	});
}
addEventListener("pageshow", (event) => {
	if (event.persisted) fresh += 1;
});
