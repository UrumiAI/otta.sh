import type { UpsertProductCommerceInput } from "./commerce-client.js";

/**
 * The raw, per-`action_id` field bag the "Product data" widget persists into
 * the content document's `commerce` JSON field (issue #81 rework). em-dash's
 * `BlockKitFieldWidget` decomposes the field value into per-element values
 * keyed by each element's `action_id` and recomposes on change
 * (`packages/admin/src/components/BlockKitFieldWidget.tsx` —
 * `onChange({ ...obj, [actionId]: value })`), so the shape here is exactly the
 * widget's `action_id`s. Every value is `unknown`: a `number_input` yields a
 * raw JS number that CAN be a float (em-dash's `Number(e.target.value)`), which
 * is precisely why money integrity is enforced HERE, at the derive boundary.
 *
 * `title` is deliberately NOT a member. It is not a widget field (the widget has
 * no title input, by design) and it does not live in this bag at all — it is a
 * CONTENT field, read from `content.data.title`. See `parseProductTitle`.
 */
export interface CommerceFieldBag {
	sku?: unknown;
	price?: unknown;
	currency?: unknown;
	onHand?: unknown;
	productKind?: unknown;
	taxClass?: unknown;
	weightGrams?: unknown;
	lengthMm?: unknown;
	widthMm?: unknown;
	heightMm?: unknown;
}

/** Mirrors `@urumi/service`'s `upsertProductCommerceBody.title` bound
 *  (`z.string().min(1).max(500)`) — the plugin declares no dependency on the
 *  service package, so the bound is restated here, not imported. */
const TITLE_MAX_LENGTH = 500;

/** The outcome of validating a product title: a value fit to send, or a
 *  human-readable reason it is not (which the caller LOGS — it never blocks the
 *  upsert; see `parseProductTitle`). */
export type ParsedProductTitle = { title: string } | { problem: string };

/**
 * Validate the product title an order line will snapshot.
 *
 * WHERE THE VALUE COMES FROM: `content.data.title`. em-dash's `ContentItem` has
 * NO top-level `title` — `mapRow()` copies every column that is not in
 * `SYSTEM_COLUMNS` into `data`, and `title` is an ordinary user-defined
 * collection field. The caller (`sync/hooks.ts`) owns that read; this function
 * owns the RULES, so the bound lives beside the money bound it mirrors.
 *
 * BEST-EFFORT BY DESIGN — the caller must never treat a `problem` as fatal. An
 * unusable title omits ONLY the title from the upsert; sku/price/stock still
 * sync. Vetoing the whole upsert would mean any collection whose title field is
 * absent or named something other than `title` silently loses ALL commerce sync
 * — a far worse failure than an untitled (and therefore unpurchasable) product.
 * Omitting is also safe against data loss: the store PRESERVES a stored title
 * when the field is absent from the body, so this can never blank a good one.
 *
 * Nor is the raw value ever sent as-is: `""` and an over-long string are both
 * 400s at the service, and a 400 is a TRANSPORT failure — which at
 * `content:afterPublish` fails closed and skips the activate. A content problem
 * must never masquerade as a transport problem.
 */
export function parseProductTitle(value: unknown): ParsedProductTitle {
	if (value === undefined || value === null) {
		return { problem: "no `title` field on the content record (expected `data.title`)" };
	}
	if (typeof value !== "string") {
		return { problem: `\`data.title\` is ${typeof value}, not a string` };
	}
	const title = value.trim();
	if (title.length === 0) return { problem: "`data.title` is empty/whitespace" };
	if (title.length > TITLE_MAX_LENGTH) {
		return {
			problem: `\`data.title\` is ${title.length} characters; the service accepts at most ${TITLE_MAX_LENGTH}`,
		};
	}
	return { title };
}

export interface ParsedCommerceFields {
	body: UpsertProductCommerceInput;
	errors: Record<string, string>;
}

/**
 * Boundary validation for the commerce field bag — the single, shared money +
 * shape guard (CLAUDE.md non-negotiable: money is integer minor units, NEVER a
 * float). Produces structured, per-field errors for everything the widget can
 * get wrong, and a clean `UpsertProductCommerceInput` for everything it got
 * right. The service's zod layer + branded `Cents` remain the authoritative
 * guards; this is the plugin-side pre-check so a float/invalid value is
 * rejected BEFORE it can reach a money field (a float price yields an
 * `errors.price`, never a `body.price`).
 *
 * Extracted verbatim from the retired button-era `product-commerce-route`'s
 * `validate()` so the `content:afterSave` derive path reuses the identical
 * rules (issue #81 rework — the widget's native Save persists the field JSON;
 * the afterSave hook derives `product_commerce` from it).
 */
export function parseCommerceFields(input: CommerceFieldBag): ParsedCommerceFields {
	const body: UpsertProductCommerceInput = {};
	const errors: Record<string, string> = {};

	if (input.sku !== undefined) {
		if (typeof input.sku === "string" && input.sku.length > 0) body.sku = input.sku;
		else errors["sku"] = "sku must be a non-empty string";
	}

	if (input.price !== undefined || input.currency !== undefined) {
		if (typeof input.price !== "number" || !Number.isSafeInteger(input.price) || input.price < 0) {
			errors["price"] = "price must be a non-negative integer in minor units (no floats)";
		} else if (typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)) {
			errors["currency"] = "currency must be an ISO-4217 alpha code (e.g. USD)";
		} else {
			body.price = { amount: input.price, currency: input.currency };
		}
	}

	if (input.onHand !== undefined) {
		if (
			typeof input.onHand === "number" &&
			Number.isSafeInteger(input.onHand) &&
			input.onHand >= 0
		) {
			body.initialOnHand = input.onHand;
		} else {
			errors["onHand"] = "stock must be a non-negative integer";
		}
	}

	if (input.productKind !== undefined) {
		if (input.productKind === "physical" || input.productKind === "digital") {
			body.productKind = input.productKind;
		} else {
			errors["productKind"] = "productKind must be physical or digital";
		}
	}

	if (input.taxClass !== undefined) {
		if (typeof input.taxClass === "string") body.taxClass = input.taxClass;
		else errors["taxClass"] = "taxClass must be a string";
	}

	const dims = [
		["weightGrams", input.weightGrams],
		["lengthMm", input.lengthMm],
		["widthMm", input.widthMm],
		["heightMm", input.heightMm],
	] as const;
	for (const [name, value] of dims) {
		if (value === undefined) continue;
		if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
			body[name] = value;
		} else {
			errors[name] = `${name} must be a non-negative integer`;
		}
	}

	return { body, errors };
}
