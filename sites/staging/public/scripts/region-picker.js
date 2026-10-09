// ADR-0034: the checkout's ONE optional script — a country change refills its state list
// from /checkout/regions; no-JS Update hides; any failure brings the no-JS page back.
const updaters = document.querySelectorAll("[data-region-update]");
const showUpdate = (show) => updaters.forEach((el) => (el.hidden = !show));
const listOf = (country) => document.getElementById(country.dataset.regionTarget ?? "");
const byFor = (attr, id) => document.querySelector(`[${attr}="${id}"]`);

// A state code NEVER carries over to another country (CA is Cádiz in Spain). The autofill
// catcher picks only with a value not yet applied; else the list keeps its own (same country).
function pick(select, keep) {
	const hint = byFor("data-region-autofill", select.id);
	const fresh = hint && hint.value !== (hint.dataset.applied ?? "") ? hint.value : "";
	const want = (fresh || keep || "").trim().toLowerCase();
	const hit = [...select.options].find(
		(o) => o.value !== "" && (o.value.toLowerCase() === want || o.text.toLowerCase() === want),
	);
	select.value = hit?.value ?? "";
	if (hint && hit && fresh) hint.dataset.applied = hint.value; // until the list arrives, wait
}

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
	const keep = select.dataset.regionCountry === wanted ? select.value : null;
	select.replaceChildren(select.options[0], ...options.map((o) => new Option(o.label, o.code)));
	pick(select, keep);
	select.dataset.regionCountry = wanted;
	const record = byFor("data-region-list-for", select.id); // the list's country (server)
	if (record) record.value = wanted;
	select.removeAttribute("aria-invalid");
	select.closest("[data-region-field]")?.toggleAttribute("hidden", options.length === 0);
	return true;
}

const countries = [...document.querySelectorAll("select[data-region-target]")];
countries.forEach((country) =>
	country.addEventListener("change", () => {
		const hint = byFor("data-region-autofill", country.dataset.regionTarget);
		if (hint && hint.value === (hint.dataset.applied ?? "")) hint.value = hint.dataset.applied = "";
		void fill(country);
	}),
);
for (const hint of document.querySelectorAll("[data-region-autofill]")) {
	const select = document.getElementById(hint.dataset.regionAutofill);
	hint.addEventListener("change", () => select && pick(select, select.value));
}
Promise.all(
	countries.map((c) => (listOf(c)?.dataset.regionCountry === c.value ? true : fill(c))),
).then((ok) => showUpdate(!ok.every(Boolean)));
