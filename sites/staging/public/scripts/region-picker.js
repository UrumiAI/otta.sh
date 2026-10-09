// ADR-0034: the checkout's ONE optional script. When a country select changes,
// its state/province list (data-region-target) is refilled from
// /checkout/regions, and the no-JS Update controls (data-region-update) hide.
// Without it, Update does the same on the server; on any failure the page is
// left as the server drew it, Update included.
const updaters = document.querySelectorAll("[data-region-update]");
const showUpdate = (show) => updaters.forEach((el) => (el.hidden = !show));

async function fill(country) {
	const select = document.getElementById(country.dataset.regionTarget ?? "");
	if (!(select instanceof HTMLSelectElement)) return;
	let options = [];
	try {
		if (country.value !== "") {
			const res = await fetch(`/checkout/regions?country=${encodeURIComponent(country.value)}`);
			if (!res.ok) throw new Error(String(res.status));
			options = await res.json();
		}
	} catch {
		showUpdate(true);
		return;
	}
	select.replaceChildren(select.options[0], ...options.map((o) => new Option(o.label, o.code)));
	select.value = "";
	select.removeAttribute("aria-invalid");
	const field = select.closest("[data-region-field]");
	if (field instanceof HTMLElement) field.hidden = options.length === 0;
}

document.querySelectorAll("select[data-region-target]").forEach((country) => {
	country.addEventListener("change", () => void fill(country));
});
showUpdate(false);
