// ADR-0034: the checkout's ONE optional script. A country change refills its
// state list (data-region-target) from /checkout/regions and hides the no-JS
// Update (data-region-update); on any failure the no-JS page comes back.
const updaters = document.querySelectorAll("[data-region-update]");
const showUpdate = (show) => updaters.forEach((el) => (el.hidden = !show));
const listOf = (country) => document.getElementById(country.dataset.regionTarget ?? "");
const byFor = (attr, id) => document.querySelector(`[${attr}="${id}"]`);

// The state to keep: the list's own, else an autofilled one (by code or name).
function pick(select) {
	const want = (select.value || byFor("data-region-autofill", select.id)?.value || "").trim();
	const hit = [...select.options].find(
		(o) => o.value !== "" && [o.value, o.text].some((v) => v.toLowerCase() === want.toLowerCase()),
	);
	select.value = hit?.value ?? "";
}

async function fill(country) {
	const select = listOf(country);
	if (!(select instanceof HTMLSelectElement)) return true;
	const wanted = country.value;
	let options = [];
	try {
		if (wanted !== "") {
			const res = await fetch(`/checkout/regions?country=${encodeURIComponent(wanted)}`);
			if (!res.ok) throw new Error(String(res.status));
			options = await res.json();
			if (!Array.isArray(options)) throw new Error("not a list");
		}
	} catch {
		return (showUpdate(true), false);
	}
	if (country.value !== wanted) return true; // a newer change owns the list
	const keep = select.value;
	select.replaceChildren(select.options[0], ...options.map((o) => new Option(o.label, o.code)));
	select.value = keep;
	pick(select);
	select.dataset.regionCountry = wanted;
	const record = byFor("data-region-list-for", select.id); // the list's country, for the server
	if (record instanceof HTMLInputElement) record.value = wanted;
	select.removeAttribute("aria-invalid");
	select.closest("[data-region-field]")?.toggleAttribute("hidden", options.length === 0);
	return true;
}

const countries = [...document.querySelectorAll("select[data-region-target]")];
countries.forEach((country) => country.addEventListener("change", () => void fill(country)));
document
	.querySelectorAll("[data-region-autofill]")
	.forEach((hint) =>
		hint.addEventListener("change", () =>
			pick(document.getElementById(hint.dataset.regionAutofill)),
		),
	);
// A restored form may show another country than its list: sync, then hide Update.
Promise.all(
	countries.map((c) => (listOf(c)?.dataset.regionCountry === c.value ? true : fill(c))),
).then((ok) => showUpdate(!ok.every(Boolean)));
