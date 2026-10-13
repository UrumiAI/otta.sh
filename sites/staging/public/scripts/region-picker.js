// ADR-0034: the checkout's ONE optional script — a country change refills its state list
// from /checkout/regions; no-JS Update hides; any failure brings the no-JS page back.
const updaters = document.querySelectorAll("[data-region-update]");
const showUpdate = (show) => updaters.forEach((el) => (el.hidden = !show));
const listOf = (country) => document.getElementById(country.dataset.regionTarget ?? "");
const byFor = (attr, id) => document.querySelector(`[${attr}="${id}"]`);
// Options in their <optgroup>s (`group`: the top-level subdivision's name), in order.
const grouped = (options) => {
	const out = [];
	for (const o of options) {
		const option = new Option(o.label, o.code);
		const last = out.at(-1);
		if (!o.group) out.push(option);
		else if (last?.tagName === "OPTGROUP" && last.label === o.group) last.append(option);
		else {
			const group = document.createElement("optgroup");
			group.label = o.group;
			group.append(option);
			out.push(group);
		}
	}
	return out;
};
// `required` (and what says so) only where the store needs this country's region.
const markRequired = (select, need) => {
	select.required = need;
	if (need) select.setAttribute("aria-required", "true");
	else select.removeAttribute("aria-required");
	const field = select.closest("[data-region-field]");
	field?.querySelectorAll("[data-region-req]").forEach((el) => (el.hidden = !need));
	field?.querySelectorAll("[data-region-optional]").forEach((el) => (el.hidden = need));
};

async function fill(country) {
	const select = listOf(country);
	if (!select) return true;
	const wanted = country.value;
	if (select.dataset.regionCountry !== wanted) {
		select.replaceChildren(select.options[0]); // never pick from another country's list
		select.dataset.regionCountry = "";
		markRequired(select, false); // an empty list never blocks the form
	}
	let options = [];
	try {
		if (wanted !== "") {
			const v = encodeURIComponent(select.dataset.regionVersion ?? "");
			const res = await fetch(`/checkout/regions?country=${encodeURIComponent(wanted)}&v=${v}`);
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
	select.replaceChildren(select.options[0], ...grouped(options));
	select.value = options.some((o) => o.code === keep) ? keep : "";
	select.dataset.regionCountry = wanted;
	const record = byFor("data-region-list-for", select.id); // the list's country (server)
	if (record) record.value = wanted;
	select.removeAttribute("aria-invalid");
	const needs = (select.dataset.regionRequired ?? "").split(" ");
	markRequired(select, options.length > 0 && needs.includes(wanted));
	select.closest("[data-region-field]")?.toggleAttribute("hidden", options.length === 0);
	return true;
}

const countries = [...document.querySelectorAll("select[data-region-target]")];
countries.forEach((country) => country.addEventListener("change", () => void fill(country)));
Promise.all(
	countries.map((c) => (listOf(c)?.dataset.regionCountry === c.value ? true : fill(c))),
).then((ok) => showUpdate(!ok.every(Boolean)));
