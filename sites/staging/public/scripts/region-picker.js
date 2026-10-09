// ADR-0034: the checkout's ONE optional script. A country change refills its
// state list (data-region-target) from /checkout/regions and hides the no-JS
// Update (data-region-update); on any failure the no-JS page comes back.
const updaters = document.querySelectorAll("[data-region-update]");
const showUpdate = (show) => updaters.forEach((el) => (el.hidden = !show));
const listOf = (country) => document.getElementById(country.dataset.regionTarget ?? "");

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
	const keep = select.value; // e.g. an autofilled state that is this country's
	select.replaceChildren(select.options[0], ...options.map((o) => new Option(o.label, o.code)));
	select.value = options.some((o) => String(o.code) === keep) ? keep : "";
	select.dataset.regionCountry = wanted;
	select.removeAttribute("aria-invalid");
	select.closest("[data-region-field]")?.toggleAttribute("hidden", options.length === 0);
	return true;
}

const countries = [...document.querySelectorAll("select[data-region-target]")];
countries.forEach((country) => country.addEventListener("change", () => void fill(country)));
// A restored form may show another country than its list: sync, then hide Update.
Promise.all(
	countries.map((c) => (listOf(c)?.dataset.regionCountry === c.value ? true : fill(c))),
).then((ok) => showUpdate(!ok.every(Boolean)));
