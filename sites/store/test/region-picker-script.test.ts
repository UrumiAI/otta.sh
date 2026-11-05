/**
 * @vitest-environment happy-dom
 *
 * The checkout's one optional script (ADR-0034, `public/scripts/region-picker.js`),
 * run in a DOM: it builds the server's `<optgroup>`s from `/checkout/regions`,
 * sends the list version as `&v=`, and keeps `required` in step with the country
 * — never leaving an empty or failed list required.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test, vi } from "vitest";

const SCRIPT = readFileSync(
	path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/scripts/region-picker.js"),
	"utf8",
);

const LISTS: Record<string, unknown> = {
	US: [
		{ code: "CA", label: "California" },
		{ code: "NY", label: "New York" },
	],
	ES: [
		{ code: "CE", label: "Ceuta" },
		{ code: "CN", label: "Canary Islands", group: "Canary Islands" },
		{ code: "GC", label: "Las Palmas", group: "Canary Islands" },
		{ code: "TF", label: "Santa Cruz de Tenerife", group: "Canary Islands" },
		{ code: "MD", label: "Madrid", group: "Madrid" },
		{ code: "M", label: "Madrid Province", group: "Madrid" },
	],
};

function page(): { country: HTMLSelectElement; region: HTMLSelectElement; urls: string[] } {
	document.body.innerHTML = `
		<select id="c" data-region-target="r">
			<option value="US" selected>US</option><option value="ES">ES</option><option value="IN">IN</option>
		</select>
		<div data-region-field>
			<label for="r">State<span data-region-req>required</span></label>
			<select id="r" data-region-country="US" data-region-required="ES US" data-region-version="abc" required aria-required="true">
				<option value="">Choose…</option><option value="CA">California</option>
			</select>
			<span data-region-optional hidden>Leave blank</span>
		</div>
		<input type="hidden" data-region-list-for="r" value="US" />
		<button data-region-update>Update</button>`;
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			urls.push(url);
			const country = new URL(url, "http://x").searchParams.get("country") ?? "";
			if (country === "IN") throw new Error("offline");
			return new Response(JSON.stringify(LISTS[country] ?? []), { status: 200 });
		}),
	);
	// happy-dom has no `Option` constructor; the browser's is this.
	vi.stubGlobal("Option", function Option(label: string, value: string) {
		const option = document.createElement("option");
		option.textContent = label;
		option.value = value;
		return option;
	});
	// The script is a classic file with no imports: run it as the page would.
	new Function(SCRIPT)();
	return {
		country: document.getElementById("c") as HTMLSelectElement,
		region: document.getElementById("r") as HTMLSelectElement,
		urls,
	};
}

const settle = async (): Promise<void> => {
	for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

const change = async (select: HTMLSelectElement, value: string): Promise<void> => {
	await settle(); // the script's own first pass, as on a real page load
	select.value = value;
	select.dispatchEvent(new Event("change"));
	await settle(); // the fetch, its JSON and the fill
};

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("region-picker.js", () => {
	test("a nested country's list comes back in the server's <optgroup>s, requested with the list version", async () => {
		const { country, region, urls } = page();
		await change(country, "ES");
		expect(urls.at(-1)).toBe("/checkout/regions?country=ES&v=abc");
		const children = [...region.children].map((el) =>
			el.tagName === "OPTGROUP"
				? `[${(el as HTMLOptGroupElement).label}: ${[...el.children].map((o) => (o as HTMLOptionElement).value).join(" ")}]`
				: (el as HTMLOptionElement).value,
		);
		expect(children).toEqual(["", "CE", "[Canary Islands: CN GC TF]", "[Madrid: MD M]"]);
		expect(region.value).toBe("");
	});

	test("required follows the country: ES and US need a region, the marker and hint follow", async () => {
		const { country, region } = page();
		await change(country, "ES");
		expect(region.required).toBe(true);
		expect(region.getAttribute("aria-required")).toBe("true");
		expect((document.querySelector("[data-region-req]") as HTMLElement).hidden).toBe(false);
		expect((document.querySelector("[data-region-optional]") as HTMLElement).hidden).toBe(true);
	});

	test("a failed fetch leaves an EMPTY list that is NOT required, and brings the no-JS Update back", async () => {
		const { country, region } = page();
		await change(country, "IN");
		expect(region.options).toHaveLength(1);
		expect(region.required).toBe(false);
		expect(region.hasAttribute("aria-required")).toBe(false);
		expect((document.querySelector("[data-region-optional]") as HTMLElement).hidden).toBe(false);
		expect((document.querySelector("[data-region-update]") as HTMLElement).hidden).toBe(false);
	});
});
