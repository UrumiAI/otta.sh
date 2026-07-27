import type { UpsertProductCommerceInput } from "./commerce-client.js";

/**
 * The raw, per-`action_id` field bag the "Product data" widget persists into
 * the content document's `commerce` JSON field (issue #81 rework). em-dash's
 * `BlockKitFieldWidget` decomposes the field value into per-element values
 * keyed by each element's `action_id` and recomposes on change
 * (`packages/admin/src/components/BlockKitFieldWidget.tsx` —
 * `onChange({ ...obj, [actionId]: value })`), so the shape here is exactly the
 * widget's `action_id`s — plus `title`, the one member that is NOT a widget
 * field (see its own doc). Every value is `unknown`: a `number_input` yields a
 * raw JS number that CAN be a float (em-dash's `Number(e.target.value)`), which
 * is precisely why money integrity is enforced HERE, at the derive boundary.
 */
export interface CommerceFieldBag {
	sku?: unknown;
	price?: unknown;
	currency?: unknown;
	/** NOT a widget `action_id` — the widget deliberately has no title input
	 *  (a second place to type a product name would drift from the storefront
	 *  heading). The caller injects the CMS content's own `title` column here,
	 *  which is why it is validated in this shared guard alongside money. */
	title?: unknown;
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

	// The order-line snapshot. A row with a NULL title is UNPURCHASABLE — the
	// domain's `createOrderFromCart` rejects it with `PRODUCT_NOT_PRICED`, which
	// reaches the buyer as a checkout failure — so an unusable title is a LOUD
	// rejection here rather than a silent omission (which would leave the row
	// NULL and the failure invisible until a buyer hit checkout) or a `""` sent
	// on the wire (which the service 400s, turning a data problem into a
	// TRANSPORT failure — at publish that fails closed and skips the activate).
	// Trimmed, because the trimmed value is what an order line should carry.
	// The upper bound mirrors the service's zod schema (`z.string().min(1).max(500)`)
	// for the same reason: an over-long title would be a 400, i.e. a TRANSPORT
	// failure, and the derive must only ever hand the service a body it accepts.
	if (input.title !== undefined) {
		const title = typeof input.title === "string" ? input.title.trim() : "";
		if (title.length === 0) {
			errors["title"] = "title must be a non-empty string (an order line snapshots it)";
		} else if (title.length > TITLE_MAX_LENGTH) {
			errors["title"] = `title must be at most ${TITLE_MAX_LENGTH} characters`;
		} else {
			body.title = title;
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
