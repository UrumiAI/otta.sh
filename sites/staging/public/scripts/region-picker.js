// ADR-0034: the checkout's ONE optional script — a country change refills its state list
// from /checkout/regions; no-JS Update hides; any failure brings the no-JS page back.
const updaters = document.querySelectorAll("[data-region-update]");
const showUpdate = (show) => updaters.forEach((el) => (el.hidden = !show));
const listOf = (country) => document.getElementById(country.dataset.regionTarget ?? "");
const byFor = (attr, id) => document.querySelector(`[${attr}="${id}"]`);

async function fill(country) {
	const select = listOf(country);
	if (!select) return true;
	const wanted = country.value;
	let options = [];
	try {
		if (wanted !== "") {
			const res = await fetch(`/checkout/regions?country=${encodeURIComponent(wanted)}`);
			options = res.ok ? await res.json() : null;
			if (!Array.isArray(options)) throw new Error("no list");
		}
	} catch {
		return (showUpdate(true), false);
	}
	if (country.value !== wanted) return true; // a newer change owns the list
	// A state code NEVER carries over to another country (CA is Cádiz in Spain): a
	// new country's list starts empty; a refill for the same country keeps its pick.
	const keep = select.dataset.regionCountry === wanted ? select.value : "";
	select.replaceChildren(select.options[0], ...options.map((o) => new Option(o.label, o.code)));
	select.value = options.some((o) => o.code === keep) ? keep : "";
	select.dataset.regionCountry = wanted;
	const record = byFor("data-region-list-for", select.id); // the list's country (server)
	if (record) record.value = wanted;
	select.removeAttribute("aria-invalid");
	select.closest("[data-region-field]")?.toggleAttribute("hidden", options.length === 0);
	return true;
}

const countries = [...document.querySelectorAll("select[data-region-target]")];
countries.forEach((country) => country.addEventListener("change", () => void fill(country)));
Promise.all(
	countries.map((c) => (listOf(c)?.dataset.regionCountry === c.value ? true : fill(c))),
).then((ok) => showUpdate(!ok.every(Boolean)));
