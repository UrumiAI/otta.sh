/**
 * The Tax console's "Tax options" screen (PR 2a, ADR-0031) — WooCommerce's Tax
 * tab: tax on/off, prices entered with or without tax, what tax is based on, the
 * shop's base address, the shipping tax class, rounding, and how cart and
 * checkout show tax. A drill-in from the classes registry, like the create
 * screens; the options are saved whole.
 *
 * THE EDIT GUARD is a compare on the VALUE the form loaded, exactly like a tax
 * rate's `expectedRateBps`: the loaded options' digest rides in the form's
 * carrier, and a save over options that changed since is refused `stale` with
 * the current options shown — never a clobber.
 */
import type { Block, FormBlock, SelectOption } from "../types.js";
import {
	type AdminRulesSurface,
	type TaxClassWire,
	type TaxSettingsRead,
	type TaxSettingsWire,
	taxSettingsDigest,
} from "./admin-rules-surface.js";
import {
	backButton,
	carriedForm,
	customAction,
	noticeBanner,
	readBoolean,
	readCarrier,
	readString,
	type Notice,
} from "./scaffold/index.js";

/** The Tax screen's action ids for this screen (its namespace is claimed once, there). */
export interface TaxOptionsActions {
	show: string;
	save: string;
	/** "← Back to tax classes" — the Tax screen's own leave-a-drill-in verb. */
	back: string;
}

/** The fields as submitted — raw operator text, re-rendered after a refusal. */
interface OptionsDraft {
	enabled: boolean;
	pricesIncludeTax: string;
	basedOn: string;
	baseCountry: string;
	baseRegion: string;
	shippingTaxClass: string;
	roundAtSubtotal: boolean;
	displayCart: string;
	totalsDisplay: string;
}

/** "Tax options" — the registry's way in, under its intro line. */
export function optionsButtonBlock(ids: TaxOptionsActions): Block {
	return {
		type: "actions",
		elements: [{ type: "button", action_id: ids.show, label: "Tax options" }],
	};
}

/**
 * "Tax is switched off" — for a store that HAS rates but charges none (review 2a
 * A m3): a new store's first rate leaves tax off, as WooCommerce's does, and
 * nothing else on the Tax pages would say so. `null` when there is nothing to say.
 */
export function taxOffBanner(read: Pick<TaxSettingsRead, "settings" | "hasRates">): Block | null {
	if (read.settings.enabled || !read.hasRates) return null;
	return {
		type: "banner",
		variant: "alert",
		title: "Tax is switched off",
		description:
			"This store has tax rates, but checkout charges no tax while tax is off. Turn on “Enable tax rates and calculations” in Tax options to charge them.",
	};
}

/**
 * "Based on shop base address" with no base address set (review 2a B5): the quote
 * then taxes by the customer's shipping address (ADR-0031 §5). Said on the screen
 * rather than left silent; `null` when it does not apply.
 */
function missingBaseAddressNote(current: TaxSettingsWire): Block | null {
	if (current.basedOn !== "base" || current.baseAddress !== null) return null;
	return {
		type: "context",
		text: "Note: tax is set to the shop base address, but no base address is set — until one is, tax is calculated from the customer's shipping address.",
	};
}

export function showOptionsAction(ids: TaxOptionsActions) {
	return customAction<AdminRulesSurface>(async ({ client }) => {
		const [read, classes] = await Promise.all([client.getTaxSettings(), client.listTaxClasses()]);
		return {
			blocks: optionsScreen(ids, read.settings, read.hasRates, classes, draftOf(read.settings)),
		};
	});
}

export function saveOptionsAction(ids: TaxOptionsActions) {
	return customAction<AdminRulesSurface>(async ({ input, client, showList }) => {
		const expected = readCarrier(input)?.expected;
		if (expected === undefined) return showList();
		const values = input.values ?? {};
		const draft: OptionsDraft = {
			enabled: readBoolean(values.enabled) ?? false,
			pricesIncludeTax: readString(values.pricesIncludeTax) ?? "",
			basedOn: readString(values.basedOn) ?? "",
			baseCountry: (readString(values.baseCountry) ?? "").trim(),
			baseRegion: (readString(values.baseRegion) ?? "").trim(),
			shippingTaxClass: readString(values.shippingTaxClass) ?? "",
			roundAtSubtotal: readBoolean(values.roundAtSubtotal) ?? false,
			displayCart: readString(values.displayCart) ?? "",
			totalsDisplay: readString(values.totalsDisplay) ?? "",
		};
		const result = await client.updateTaxSettings(settingsOf(draft), {
			expected,
			// One key per save attempt, never shared by two different saves (B5).
			idempotencyKey: `tax-options-${crypto.randomUUID()}`,
		});
		if (result.ok) {
			return showList(undefined, {
				variant: "default",
				title: "Tax options saved",
				description:
					"New quotes and orders use these options. Orders already placed keep the tax they were charged.",
			});
		}
		const [classes, read] = await Promise.all([client.listTaxClasses(), client.getTaxSettings()]);
		if (result.reason === "stale") {
			return {
				blocks: optionsScreen(
					ids,
					result.current,
					read.hasRates,
					classes,
					draftOf(result.current),
					{
						variant: "error",
						title: "Tax options changed since you loaded them — reload",
						description:
							"Your change was NOT applied — the current options are shown below. Re-apply your change and save again.",
					},
				),
			};
		}
		return {
			blocks: optionsScreen(ids, read.settings, read.hasRates, classes, draft, {
				variant: "error",
				title: "Tax options not saved",
				description: problemText(result.field),
			}),
		};
	});
}

function problemText(field: string): string {
	if (field === "tax.baseAddress") {
		return "The shop address needs a two-letter country code (like GB or US) and, if given, a region code of that country (like NY).";
	}
	return "One of the options is not valid — check it and save again.";
}

/** The submitted text → the block the domain validates (it refuses what is wrong). */
function settingsOf(d: OptionsDraft): unknown {
	const shippingTaxClass =
		d.shippingTaxClass === "inherit" || d.shippingTaxClass === "legacy"
			? { kind: d.shippingTaxClass }
			: d.shippingTaxClass.startsWith("fixed:")
				? { kind: "fixed", taxClassId: d.shippingTaxClass.slice("fixed:".length) }
				: null;
	return {
		enabled: d.enabled,
		pricesIncludeTax: d.pricesIncludeTax === "incl",
		basedOn: d.basedOn,
		baseAddress:
			d.baseCountry === "" ? null : { country: d.baseCountry, region: d.baseRegion || null },
		shippingTaxClass,
		roundAtSubtotal: d.roundAtSubtotal,
		displayCart: d.displayCart,
		totalsDisplay: d.totalsDisplay,
	};
}

function draftOf(s: TaxSettingsWire): OptionsDraft {
	const cls = s.shippingTaxClass;
	return {
		enabled: s.enabled,
		pricesIncludeTax: s.pricesIncludeTax ? "incl" : "excl",
		basedOn: s.basedOn,
		baseCountry: s.baseAddress?.country ?? "",
		baseRegion: s.baseAddress?.region ?? "",
		shippingTaxClass: cls.kind === "fixed" ? `fixed:${cls.taxClassId}` : cls.kind,
		roundAtSubtotal: s.roundAtSubtotal,
		displayCart: s.displayCart,
		totalsDisplay: s.totalsDisplay,
	};
}

/** A two-way select: the "excl" option first, as WooCommerce lists it. */
function yesNo(incl: string, excl: string): SelectOption[] {
	return [
		{ label: excl, value: "excl" },
		{ label: incl, value: "incl" },
	];
}

/** `initial_value` only when it is one of the options (X-23). */
function selected(options: SelectOption[], value: string): { initial_value?: string } {
	return options.some((o) => o.value === value) ? { initial_value: value } : {};
}

function optionsScreen(
	ids: TaxOptionsActions,
	current: TaxSettingsWire,
	hasRates: boolean,
	classes: TaxClassWire[],
	draft: OptionsDraft,
	notice?: Notice,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "Tax options" },
		{
			type: "context",
			text: "How this store charges and shows tax. Otta ships no tax rates — you set your own classes and rates.",
		},
		backButton(ids.back, "← Back to tax classes"),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	const off = taxOffBanner({ settings: current, hasRates });
	if (off !== null) blocks.push(off);
	const baseNote = missingBaseAddressNote(current);
	if (baseNote !== null) blocks.push(baseNote);
	blocks.push(optionsForm(ids, current, classes, draft));
	return blocks;
}

function optionsForm(
	ids: TaxOptionsActions,
	current: TaxSettingsWire,
	classes: TaxClassWire[],
	d: OptionsDraft,
): FormBlock {
	const shippingClassOptions: SelectOption[] = [
		{ label: "Based on cart items", value: "inherit" },
		// Offered only to a store that is ON it: it is how a store with rates before
		// these options kept charging exactly what it did (DECISIONS 4).
		...(current.shippingTaxClass.kind === "legacy"
			? [
					{
						label: "As before: the class of the last rate that applies to shipping",
						value: "legacy",
					},
				]
			: []),
		...classes.map((c) => ({ label: c.name, value: `fixed:${c.id}` })),
	];
	const pricesOptions = yesNo("Yes, I enter prices with tax", "No, I enter prices without tax");
	const basedOnOptions: SelectOption[] = [
		{ label: "Customer shipping address", value: "shipping" },
		{ label: "Shop base address", value: "base" },
	];
	const displayOptions = yesNo("Including tax", "Excluding tax");
	const totalsOptions: SelectOption[] = [
		{ label: "Itemized — one row per tax", value: "itemized" },
		{ label: "As a single total", value: "single" },
	];
	return carriedForm({
		namespace: "tax:options",
		context: { expected: taxSettingsDigest(current) },
		form: {
			type: "form",
			fields: [
				{
					type: "toggle",
					action_id: "enabled",
					label: "Enable tax rates and calculations",
					initial_value: d.enabled,
				},
				{
					type: "select",
					action_id: "pricesIncludeTax",
					label: "Prices entered with tax",
					options: pricesOptions,
					...selected(pricesOptions, d.pricesIncludeTax),
				},
				{
					type: "select",
					action_id: "basedOn",
					label: "Calculate tax based on",
					options: basedOnOptions,
					...selected(basedOnOptions, d.basedOn),
				},
				{
					type: "text_input",
					action_id: "baseCountry",
					label:
						"Shop base address — country (e.g. GB). Carts with only digital goods are taxed here; leave blank to leave them untaxed.",
					initial_value: d.baseCountry,
				},
				{
					type: "text_input",
					action_id: "baseRegion",
					label: "Shop base address — region (optional, e.g. NY)",
					initial_value: d.baseRegion,
				},
				{
					type: "select",
					action_id: "shippingTaxClass",
					label: "Shipping tax class (shipping costs are entered without tax)",
					options: shippingClassOptions,
					...selected(shippingClassOptions, d.shippingTaxClass),
				},
				{
					type: "toggle",
					action_id: "roundAtSubtotal",
					label: "Round tax at subtotal level, instead of per line",
					initial_value: d.roundAtSubtotal,
				},
				{
					type: "select",
					action_id: "displayCart",
					label: "Display prices during cart and checkout",
					options: displayOptions,
					...selected(displayOptions, d.displayCart),
				},
				{
					type: "select",
					action_id: "totalsDisplay",
					label: "Display tax totals",
					options: totalsOptions,
					...selected(totalsOptions, d.totalsDisplay),
				},
			],
			submit: { label: "Save tax options", action_id: ids.save },
		},
	});
}
