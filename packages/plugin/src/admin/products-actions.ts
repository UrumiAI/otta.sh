/**
 * The Pricing & inventory WRITE path, as structured actions (ADR-0015 Decision 2).
 *
 * WHAT THIS REPLACES, and why the replacement was a rewrite rather than a
 * deletion. Until this module existed, the React console did not have a write
 * path of its own: it constructed the Block Kit Pricing & inventory page
 * handler, MINTED A `block_id` CARRIER so a browser payload would look like the
 * `form_submit` that handler read, forwarded the write through it, and then
 * SCRAPED the outcome back out of the rendered block tree — the banner off the
 * render, and an empty tree read as "nothing applied". The Block Kit renderer
 * was therefore load-bearing for the screen that replaced it. Each action below
 * is that write, re-expressed as a function returning a
 * {@link ProductsActionResult}: the applied/refused flag and the notice. No page
 * handler, no synthesized interaction, no carrier, no notice-scraping.
 *
 * THE FORM FIELDS ARE PLAIN ARGUMENTS NOW. Orders was entirely buttons, so its
 * console forwarded a click verbatim; four of this screen's five writes were
 * Block Kit FORMS whose context (`productId`, `expectedUpdatedAt`, `onHand`)
 * rode invisibly in a carrier rather than as visible fields. That mechanism
 * existed so an operator was never asked to "pick" a `productId` from a
 * single-option select — a rendering concern, and it retires with the renderer.
 * The console sends one flat payload and each action reads the keys it needs.
 *
 * THE STALE-WATERMARK REFUSAL (DA-3a) GUARDS THE REMOVAL, AND MOVED INTO THE
 * STORE. The `onHand` the operator SAW travels with a removal as the domain's
 * `expectedOnHand`, and the inventory store refuses a mismatch inside the same
 * compare-and-set as the decrement — including the case where there is NO
 * inventory record at all, which gets its own sentence rather than being
 * reported as a count nobody took. It used to be a re-read HERE, before the
 * write; a re-read before the write runs before the idempotency ledger, so a
 * retry of a removal that already landed re-read the count that removal produced
 * and was told "stock changed". `onHand` is the AVAILABLE count, so checkout
 * traffic can make a removal stale too — accepted, and said so in the copy. A
 * RESTOCK is not pinned (an add is commutative; pinning it would refuse an
 * honest add through every sale), as before. An ABSENT or unparseable watermark
 * still refuses fail-closed for both, before anything is sent: see
 * {@link parseOnHand}. The EDIT path carries
 * its own watermark, `expectedUpdatedAt`, guarded on the SAME terms — absent or
 * blank refuses here, before anything is sent — and re-checked by the service's
 * optimistic concurrency behind it. Both watermarks are guarded at THIS tier,
 * deliberately: two watermarks in one module guarded on two different tiers is a
 * trap for whoever changes either tier next, even while the looser of them
 * happens to fail closed downstream.
 *
 * MONEY IS INTEGER MINOR UNITS. Nothing here parses money with a float:
 * {@link parsePriceMinorUnits} reads an exact decimal string into integer minor
 * units and refuses anything else, including a non-positive amount (the domain's
 * own `price > 0` invariant — a free product is "unpriced", not priced at 0).
 * A blank compare-at or unit cost is an explicit CLEAR (`null`), never a zero,
 * and a blank price is omitted from the wire rather than sent as one.
 *
 * A STOCK MOVEMENT'S KEY IS PER-INTENT: A NONCE THE CONSOLE MINTS PER CLICK
 * (superseding F-2a's "no nonce" for movements; an edit's key is still a content
 * hash of the submitted wire plus `expectedUpdatedAt`, which is sound there
 * because a save is idempotent by content). F-2a keyed a movement on
 * `${productId}:${direction}:${onHandAtRender}:${qty}` so a double-submit of one
 * rendered form would dedupe with no client state — but a movement is NOT
 * idempotent by content: Add 2 at 7, Remove 2, Add 2 at 7 is three decisions,
 * and the third derived the first's key and was dropped while the card said it
 * was done. Two tabs that saw the same count and added the same amount collided
 * the same way. Only the caller knows which submits are the same decision, so it
 * says so: every click mints a fresh nonce, and the only re-send is the
 * console's explicit "Retry this change" after a lost answer, which the ledger
 * answers once. A click is never taken for a retry because it looks like one —
 * that would drop a genuine repeat move. When the ledger does answer, the store
 * says so (`replayed`), and this module reports "already applied", never a
 * fresh movement: see {@link replayedNotice}.
 *
 * A CALLER WITHOUT A NONCE (a tab rendered by the previous release) keeps the
 * F-2a key for one release, so its double-submit still dedupes, and is made
 * HONEST rather than correct: a removal's watermark refuses a stale count, and
 * an answer the store marks as a ledger replay is reported as "this submit
 * changed nothing", never as done. See {@link replayedNotice}. Remove the
 * fallback, and make the nonce mandatory, in the release after this one.
 *
 * EVERY FIELD ARRIVING HERE IS UNTRUSTED operator-round-tripped input, exactly
 * as a decoded carrier was: closed sets are re-checked, watermarks are
 * re-checked for PRESENCE as well as for equality, and nothing is coerced.
 *
 * `products:remove-stock-review` IS GONE, LEFT UNPORTED AS UNREACHED SURFACE.
 * It was DA-3 state 1 → state 2 for the Block Kit screen: it staged a parsed
 * quantity server-side so a second render could draw a confirm button, because
 * a Block Kit form cannot show a dialog over the values just typed. React can,
 * so the React screen composes its own confirm and posts
 * {@link ACTION_REMOVE_STOCK} directly — which is why the console's gate has
 * excluded the review id since INC-21, and why nothing reachable has ever
 * called it. Its own checks went with it, and only one of them was a check the
 * reachable path lacks: the **DA-3c bound check** (`qty` against the on-hand
 * just re-read). That gap is not new and is not widened here — the console
 * could never reach that step — and an over-removal is refused by the SERVICE's
 * guarded decrement as `insufficient_stock`, which {@link removeStockNotice}
 * renders by name. Re-introducing a server-side two-step confirm means WRITING
 * that check against the shape of the new flow, not restoring it.
 */
import {
	ADD_STOCK_INVALID_QTY,
	DIGITAL_WITH_FILE,
	DIGITAL_WITH_FILE_TITLE,
	NO_TAX_CLASS,
	PRODUCT_DELETED_SINCE_LOADED,
	PRODUCT_NOT_FOUND_TITLE,
	parseOnHandWatermark,
	parseStockQty as parseStockQtyShared,
	unitWord,
} from "@otta-sh/admin-presentation";
import {
	type AdminProductsSurface,
	type ProductEditWire,
	type RestockResult,
	type StockRemovalResult,
} from "./admin-products-surface.js";
import { parseMinorUnitsInput } from "./money-input.js";
import { readString, screenActions, type Notice } from "./scaffold/index.js";

/** This screen's namespaced action ids. */
const PRODUCTS_ACTIONS = screenActions("products");
/** The three split edit-form submits (F-5a) — one per sibling group. The split
 *  is legal here, and ONLY here among the console's PUT/PATCH forms, because
 *  `updateProduct` is a verified sparse PATCH at every layer: a field absent
 *  from the payload is omitted from the wire, never nulled. */
const ACTION_SAVE_IDENTITY = PRODUCTS_ACTIONS.custom("save-identity");
const ACTION_SAVE_PRICE = PRODUCTS_ACTIONS.custom("save-price");
const ACTION_SAVE_SHIPPING = PRODUCTS_ACTIONS.custom("save-shipping");
/** The product editor's Pricing & stock cards (ADR-0014, amendment
 *  2026-10-01) has ONE Save, so it sends every field it owns in one write —
 *  the same sparse save, the same watermark, the same idempotency key. */
const ACTION_SAVE = PRODUCTS_ACTIONS.custom("save");
/** The product editor's Download file card (issue #376, increment 4): after the
 *  site's upload endpoint has put the bytes in the private bucket and answered a
 *  descriptor, the card saves that descriptor here — the console's one data path
 *  for every product write (ADR-0014 Decision 3, amended by ADR-0029 for the
 *  upload alone). */
const ACTION_ATTACH_DOWNLOAD = PRODUCTS_ACTIONS.custom("attach-download");
/** Restock stays DA-4: one-shot, no staging, no confirm. */
const ACTION_RESTOCK = PRODUCTS_ACTIONS.custom("restock");
/** The screen's ONE destructive act (DA-5's second exception: a removal is
 *  reversible only by a separate, forgettable manual operation). The surface
 *  confirms it for itself before this ever runs. */
const ACTION_REMOVE_STOCK = PRODUCTS_ACTIONS.custom("remove-stock");

/**
 * What a write returns instead of a block tree.
 *
 * `ok: true` means the request was UNDERSTOOD and dispatched, not that anything
 * was written — a refusal is a `notice` with `variant: "error"`, which is the
 * shape the operator reads either way. `notice: null` is the quiet success the
 * Block Kit screen expressed as "re-render with no banner".
 *
 * THERE IS NO STAGED OR DRAFT MEMBER. Both existed for the retired
 * `remove-stock-review` step: a staged outcome carried the parsed quantity plus
 * the watermark into a server-rendered state 2, and a draft carried the
 * operator's raw text back into a server-rendered refusal. A surface that
 * composes its own confirm holds the operator's input the whole time and never
 * needs either handed back.
 */
export interface ProductsActionResult {
	readonly ok: true;
	readonly notice: Notice | null;
	/**
	 * WHICH FIELD THE OUTCOME IS ABOUT, when it is about exactly one — the only
	 * machine-readable member of this result. A refusal an operator can only fix
	 * by changing one input belongs BESIDE that input, and the surface cannot
	 * work that out from the sentence without re-deriving the copy, which is the
	 * one thing that must not happen twice. Absent (the common case) means the
	 * outcome is about the record as a whole and reports at the top of the
	 * screen, exactly as every outcome did before.
	 */
	readonly field?: "sku";
	/**
	 * THE RECORD MOVED UNDER THE WRITE — someone else saved first. Present only
	 * on that refusal, so a surface can show the latest values (as the notice
	 * promises) without matching on the sentence; every other refusal declined a
	 * value and the merchant's typing should stay.
	 */
	readonly recordMoved?: true;
	/**
	 * THIS STOCK MOVE WAS ANSWERED FROM THE IDEMPOTENCY LEDGER — an earlier call
	 * with the same key moved the units and this one moved nothing. Present only
	 * then, so a surface that composes its own receipt (the Pricing & stock
	 * cards) never reports a replay as a fresh "Added N" — and never has to match
	 * on the notice's sentence to tell. The notice still says it in words.
	 */
	readonly replayed?: true;
}

/** A write's payload: the flat string record the caller carried. Untrusted,
 *  exactly as a decoded Block Kit carrier was. */
export type ProductsActionPayload = Readonly<Record<string, string>>;

type ProductsAction = (
	client: AdminProductsSurface,
	payload: ProductsActionPayload,
) => Promise<ProductsActionResult>;

/** The refusal/unreadable-payload notice shared by every action on this screen
 *  whose payload fails to read (DA-3b): "nothing was changed", never a silent
 *  redirect and never a quiet success. */
const UNREADABLE: Notice = {
	variant: "error",
	title: "Not changed",
	description:
		"That action could not be read — nothing was changed. Reload the product and try again.",
};

/** The one outcome constructor. A refusal is an `error`-variant notice, not a
 *  different shape — see {@link ProductsActionResult}. `field` is set only by an
 *  outcome about a single input, and omitted (not `undefined`) otherwise, so the
 *  wire carries the member only when it means something. */
const applied = (notice: Notice | null, field?: "sku"): ProductsActionResult =>
	field === undefined ? { ok: true, notice } : { ok: true, notice, field };

// -- money input parsing (NO float arithmetic — CLAUDE.md) --------------------
// The exact-integer-string parse lives in `./money-input.js`, SHARED with the
// Shipping console; the one behavioral fork (whether zero is a valid amount) is
// that module's explicit `allowZero` parameter. Prices are strictly positive
// (the domain's own `price > 0` invariant: a free product is "unpriced", not
// priced at 0).

/** Parse a merchant-entered decimal price into integer MINOR UNITS; null for
 *  any non-conforming or NON-POSITIVE input (never throws). Exported for its
 *  own unit test. */
export function parsePriceMinorUnits(input: string): number | null {
	return parseMinorUnitsInput(input, { allowZero: false });
}

/** Parse a merchant-entered stock quantity into a POSITIVE WHOLE number.
 *
 *  RE-EXPORTED from `@otta-sh/admin-presentation`: the React screen checks the
 *  quantity in the browser before it opens the remove-stock confirm, so a second
 *  parser here would let an operator read a dialog for a quantity the write then
 *  refuses. */
export const parseStockQty = parseStockQtyShared;

/** Read the `onHand` watermark out of an untrusted payload — a plain
 *  non-negative integer string, or `null` for anything else (B-2: money and
 *  count watermarks never cross as floats or negatives).
 *
 *  A MISSING WATERMARK IS AN UNREADABLE PAYLOAD, NOT A REASON TO SKIP DA-3a.
 *  Every stock control carries the count the operator saw, so an absent one has
 *  exactly two sources and refusing is right for both: a payload edited in
 *  devtools, or a browser tab rendered before the watermark existed — which is
 *  precisely the stale view DA-3a is for. Tolerating it would write with no
 *  staleness check at all. */
function parseOnHand(value: unknown): number | null {
	return parseOnHandWatermark(readString(value));
}

// -- the guarded commerce edit (split three ways, F-5a) -----------------------

type BuildEditResult = { ok: true; wire: ProductEditWire } | { ok: false; message: string };

/**
 * Assemble a validated {@link ProductEditWire} from ONE of the three split
 * forms' submitted values — whichever submitted, since a stateless submit only
 * ever carries the ONE form's own fields (the other two forms' keys are simply
 * absent from the payload, which this function already treats as "field not in
 * the form ⇒ preserve"). So this single function serves all three; no per-form
 * variant is needed.
 *
 * NO `title` AND NO `active`, STRUCTURALLY (G2 / ADR-0013). Both fields are
 * CMS-owned: `product_commerce.title` is a single-writer cache the sync upserts
 * on every publish, and `active` is the CMS's publish gate. `ProductEditWire`
 * has no member for either, so nothing below can put one on the wire however
 * hostile the payload is.
 *
 * Boundary validation (mirrors the service's zod + the domain's `price > 0`):
 * a bad price/currency/dimension is a per-field message, never an opaque save.
 */
function buildEditWire(
	values: Readonly<Record<string, unknown>>,
	expectedUpdatedAt: string,
): BuildEditResult {
	const wire: ProductEditWire = { expectedUpdatedAt };

	const sku = readString(values.sku)?.trim();
	if (sku !== undefined && sku.length > 0) wire.sku = sku;

	// The row currency (shared by price / compare-at / cost). Parsed ONCE so all
	// three money fields agree by construction.
	const currencyStr = readString(values.currency)?.trim().toUpperCase();
	const currency =
		currencyStr !== undefined && /^[A-Z]{3}$/.test(currencyStr) ? currencyStr : undefined;

	const priceStr = readString(values.price)?.trim();
	if (priceStr !== undefined && priceStr.length > 0) {
		const minorUnits = parsePriceMinorUnits(priceStr);
		if (minorUnits === null) {
			return {
				ok: false,
				message: "Price must be a positive amount like 19.99 (up to two decimal places).",
			};
		}
		if (currency === undefined) {
			return { ok: false, message: "Currency must be a 3-letter ISO-4217 code like USD." };
		}
		wire.price = { amount: minorUnits, currency };
	}

	// compare-at / unit cost: a BLANK entry clears the field (null); a value is
	// parsed to minor units and MUST carry the row currency.
	for (const [field, key] of [
		["compareAt", "compareAtPrice"],
		["unitCost", "unitCost"],
	] as const) {
		const raw = readString(values[field]);
		if (raw === undefined) continue; // field not in the form ⇒ preserve.
		const trimmed = raw.trim();
		if (trimmed.length === 0) {
			wire[key] = null; // explicit clear.
			continue;
		}
		const minorUnits = parsePriceMinorUnits(trimmed);
		if (minorUnits === null) {
			return {
				ok: false,
				message: `${field === "compareAt" ? "Compare-at price" : "Unit cost"} must be a positive amount like 29.99, or blank to clear.`,
			};
		}
		const rowCurrency = currency ?? (wire.price !== undefined ? wire.price.currency : undefined);
		if (rowCurrency === undefined) {
			return {
				ok: false,
				message:
					"Set the product's price and currency before adding a compare-at price or unit cost.",
			};
		}
		wire[key] = { amount: minorUnits, currency: rowCurrency };
	}

	const productKind = readString(values.productKind);
	if (productKind === "physical" || productKind === "digital") wire.productKind = productKind;

	// taxClass: the sentinel `NO_TAX_CLASS` (or a blank) clears it (null); any
	// other value is the chosen `TaxClass.id`.
	const taxClass = readString(values.taxClass);
	if (taxClass !== undefined) {
		const trimmed = taxClass.trim();
		wire.taxClass = trimmed.length === 0 || trimmed === NO_TAX_CLASS ? null : trimmed;
	}

	// weight/dims: blank ⇒ preserve (omit); present ⇒ a non-negative whole number.
	const numericFields = ["weightGrams", "lengthMm", "widthMm", "heightMm"] as const;
	for (const field of numericFields) {
		const raw = readString(values[field])?.trim();
		if (raw === undefined || raw.length === 0) continue;
		if (!/^\d+$/.test(raw)) {
			return { ok: false, message: `${field} must be a non-negative whole number.` };
		}
		const n = Number.parseInt(raw, 10);
		if (!Number.isSafeInteger(n)) return { ok: false, message: `${field} is too large.` };
		wire[field] = n;
	}

	return { ok: true, wire };
}

/** Stable content-derived idempotency key for an edit save (F-2a, `Edit /
 *  save` row: "content hash of the submitted wire + `expectedUpdatedAt`").
 *  FNV-1a twice with independent seeds — dependency-free and sandbox-safe.
 *
 *  KNOWN FOOTGUN, INHERITED VERBATIM AND UNREACHABLE TODAY. `?? null`
 *  canonicalises an ABSENT field and an EXPLICIT `null` identically, so "clear
 *  the compare-at" and "leave the compare-at alone" hash to the same key. That
 *  cannot bite across the three forms this screen ships: each carries its
 *  clearable fields in every submit, so a form that can send `null` never omits
 *  the field, and one that omits it can never send `null`. A FOURTH form that
 *  submits a clearable field only sometimes would collide the two — and, under a
 *  once-only store, silently drop the second write. Whoever adds one must
 *  distinguish the cases here (an absent sentinel, not `null`) rather than
 *  assume this holds. */
function deriveEditIdempotencyKey(productId: string, wire: ProductEditWire): string {
	const canonical = JSON.stringify([
		productId,
		wire.expectedUpdatedAt,
		wire.sku ?? null,
		wire.price ?? null,
		// No `title` component — the wire cannot carry one (ADR-0013).
		wire.taxClass ?? null,
		wire.compareAtPrice ?? null,
		wire.unitCost ?? null,
		wire.weightGrams ?? null,
		wire.lengthMm ?? null,
		wire.widthMm ?? null,
		wire.heightMm ?? null,
		wire.productKind ?? null,
	]);
	return `${productId}:edit:${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x01234567)}`;
}

function fnv1a(input: string, seed: number): string {
	let hash = seed >>> 0;
	for (let i = 0; i < input.length; i++) {
		hash ^= input.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36);
}

/**
 * The three split forms' Save handler (F-5a — one handler serves all three
 * submits). Reads `productId`/`expectedUpdatedAt` off the payload, validates,
 * then PATCHes under the optimistic-concurrency watermark.
 *
 * THE WATERMARK IS MANDATORY, AND BLANK COUNTS AS ABSENT. An absent or empty
 * `expectedUpdatedAt` refuses before anything is sent, rather than PATCHing
 * without a usable one — a save with no watermark is a clobber of whatever
 * landed since the form was drawn. The empty case is refused HERE, on the same
 * terms {@link parseOnHand} refuses a blank on-hand, rather than being left to
 * the service: this screen has two watermarks, and two watermarks guarded
 * asymmetrically in one module is a trap even while the looser one happens to
 * fail closed downstream.
 */
const saveAction: ProductsAction = async (client, payload) => {
	const productId = readString(payload["productId"]);
	const expectedUpdatedAt = readString(payload["expectedUpdatedAt"]);
	if (
		productId === undefined ||
		expectedUpdatedAt === undefined ||
		expectedUpdatedAt.trim().length === 0
	) {
		return applied(UNREADABLE);
	}
	const built = buildEditWire(payload, expectedUpdatedAt);
	if (!built.ok) {
		return applied({
			variant: "error",
			title: "Check the highlighted value",
			description: built.message,
		});
	}
	const key = deriveEditIdempotencyKey(productId, built.wire);
	const result = await client.updateProduct(productId, built.wire, key);
	// The surface re-reads the product after every write, so a stale save leaves
	// the operator looking at the latest row — and the OTHER two split forms
	// remount with it, which is the sibling-discard hazard the screen warns about.
	return editOutcome(result);
};

// -- attaching an uploaded download file (issue #376, increment 4) ------------

/** A byte count as the card sends it: a plain non-negative whole-number string.
 *  Anything else is an unreadable payload — never coerced. */
const BYTE_COUNT = /^(0|[1-9][0-9]{0,15})$/;

/**
 * Save the descriptor of a file the site's upload endpoint just stored.
 *
 * The four descriptor fields arrive flat, as every console write's do, exactly
 * as the endpoint answered them: the key it minted, the filename and type it
 * coerced, the byte count it stored. This action RE-CHECKS nothing about their
 * values itself — the domain's `validateDownloadAsset` does, on the write, and
 * a refusal names the sub-field — but refuses a payload it cannot read (no
 * watermark, a missing field, a size that is not a whole number) before
 * anything is sent, on the same terms as {@link saveAction}.
 *
 * THE EDIT IS SPARSE: only `downloadAsset` is on the wire, so the price, sku and
 * the rest are preserved, and the store refuses a file on a physical product
 * inside the same compare-and-set. The key is content-derived (the product, the
 * watermark, the descriptor), so a re-send of the same attach — a double click,
 * or a retry after a lost answer — writes once, while a different file on the
 * same watermark is a stale refusal.
 */
const attachDownloadAction: ProductsAction = async (client, payload) => {
	const productId = readString(payload["productId"]);
	const expectedUpdatedAt = readString(payload["expectedUpdatedAt"]);
	const key = readString(payload["key"]);
	const filename = readString(payload["filename"]);
	const contentType = readString(payload["contentType"]);
	const size = readString(payload["size"]);
	if (
		productId === undefined ||
		expectedUpdatedAt === undefined ||
		expectedUpdatedAt.trim().length === 0 ||
		key === undefined ||
		key.length === 0 ||
		filename === undefined ||
		contentType === undefined ||
		size === undefined ||
		!BYTE_COUNT.test(size)
	) {
		return applied(UNREADABLE);
	}
	const bytes = Number(size);
	if (!Number.isSafeInteger(bytes)) return applied(UNREADABLE);
	const wire: ProductEditWire = {
		expectedUpdatedAt,
		downloadAsset: { key, filename, contentType, size: bytes },
	};
	const canonical = JSON.stringify([
		productId,
		expectedUpdatedAt,
		key,
		filename,
		contentType,
		bytes,
	]);
	const idempotencyKey = `${productId}:download:${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x01234567)}`;
	const result = await client.updateProduct(productId, wire, idempotencyKey);
	if (result.ok) {
		return applied({
			variant: "default",
			title: "File attached",
			description: `Buyers' download links now serve ${filename}.`,
		});
	}
	if (result.reason === "invalid" && (result.field ?? "").startsWith("downloadAsset")) {
		return applied({
			variant: "error",
			title: "This file wasn't attached",
			description: downloadRefusal(result.field ?? "downloadAsset"),
		});
	}
	return editOutcome(result);
};

/** The sentence for a refused descriptor, by the sub-field the domain named. */
function downloadRefusal(field: string): string {
	switch (field) {
		case "downloadAsset":
			return "Only a Digital product can have a download file. Set the product type to Digital and save, then upload the file again.";
		case "downloadAsset.filename":
			return "The file's name can't be used. Rename the file and upload it again.";
		case "downloadAsset.contentType":
			return "The file's type can't be used. Upload it again; it will be stored as a plain download.";
		case "downloadAsset.size":
			return "The file's size could not be read. Upload it again.";
		default:
			return "The upload did not match this product. Upload the file again from this product's page.";
	}
}

/** A sku as it appears INSIDE a sentence: quoted, so a sku with a space or a
 *  trailing character is still copyable exactly; or a plain phrase when the
 *  service named none, because an empty pair of quotes reads as a sku called
 *  nothing. */
function namedSku(value: string | null, fallback: string): string {
	return value === null ? fallback : `"${value}"`;
}

/**
 * Map an edit outcome to what the operator reads — the notice, and the field it
 * belongs beside when the refusal is about exactly one.
 *
 * THIS IS THE ONLY PLACE THESE SENTENCES ARE WRITTEN. The service answers a
 * machine code plus operands (both skus, or the sku and how many holds); the
 * console renders what comes back verbatim. A second copy of any sentence on the
 * React side would be free to drift from this one, and the operator would have
 * no way to tell which of the two they were reading.
 */
function editOutcome(
	result: Awaited<ReturnType<AdminProductsSurface["updateProduct"]>>,
): ProductsActionResult {
	if (result.ok) {
		return applied({
			variant: "default",
			title: "Saved",
			description: "The product's commerce fields were updated.",
		});
	}
	switch (result.reason) {
		case "stale":
			return {
				...applied({
					variant: "error",
					title: "This product changed since you opened it",
					description:
						"Your edit was NOT applied — the latest values are shown below. Re-apply your changes and save again.",
				}),
				recordMoved: true,
			};
		case "currency_mismatch":
			return applied({
				variant: "error",
				title: "Currency cannot be changed here",
				description: `This product is priced in ${result.currency ?? "its existing currency"}. A price edit keeps the same currency; re-currencying a product is not supported on this page.`,
			});
		case "sku_taken":
			return applied(
				{
					variant: "error",
					title: "SKU already in use",
					description: `SKU "${result.sku ?? ""}" is already used by another live product. Choose a different SKU.`,
				},
				"sku",
			);
		// THE TWO RENAME REFUSALS. Both name the sku(s) so the sentence can be acted
		// on without opening a database, and both say NOTHING MOVED out loud: the
		// rename and the stock carry are one transaction, so a refusal leaves the
		// product on its old sku with its units where they were.
		case "sku_stock_conflict": {
			const from = namedSku(result.fromSku, "this product's SKU");
			const to = namedSku(result.toSku, "the SKU you asked for");
			return applied(
				{
					variant: "error",
					title: "That SKU already has stock of its own",
					// The sku is never the first word of a sentence: a fallback phrase
					// would arrive lower-case there, and a real sku would arrive with
					// whatever case the merchant typed. Both read as a typo.
					description: `Nothing was changed. Stock is never merged between SKUs, and ${to} already has its own inventory record — so ${from} was not renamed onto it. Rename to a SKU that has never held stock, or move the units under ${to} elsewhere first.`,
				},
				"sku",
			);
		}
		case "sku_held_stock": {
			const held = namedSku(result.sku, "this SKU");
			// THE WHOLE SENTENCE AGREES WITH THE COUNT — subject, verb, and the
			// pronoun the advice refers back with. Assembling a pluralised noun and
			// leaving anything downstream of it fixed is how "1 live reservation still
			// hold units … once those have been paid" ships, and ONE is the commonest
			// count there is.
			const one = result.liveHolds === 1;
			const holds =
				result.liveHolds === null
					? `live reservations still hold units of ${held}`
					: one
						? `1 live reservation still holds units of ${held}`
						: `${String(result.liveHolds)} live reservations still hold units of ${held}`;
			const settled = one ? "it has" : "those have";
			return applied(
				{
					variant: "error",
					title: "This SKU has reservations in flight",
					description: `Nothing was changed: ${holds}, and a reservation cannot follow a rename — its units would return to the old SKU when the cart or order finishes. Try the rename again once ${settled} been paid, cancelled or expired, usually a few minutes.`,
				},
				"sku",
			);
		}
		case "invalid":
			// The store refuses switching a product that has a download file to
			// Physical (the product owner's rule: a file is replaced, never removed,
			// so past buyers never lose access). Never the price/measurement copy.
			if ((result.field ?? "").startsWith("downloadAsset")) {
				return applied({
					variant: "error",
					title: DIGITAL_WITH_FILE_TITLE,
					description: `Nothing was saved. ${DIGITAL_WITH_FILE}`,
				});
			}
			return applied({
				variant: "error",
				title: "Invalid value",
				description: `The field "${result.field ?? "input"}" is out of range — price must be greater than zero and measurements must be non-negative whole numbers.`,
			});
		case "not_found":
			return applied({
				variant: "error",
				title: PRODUCT_NOT_FOUND_TITLE,
				description: PRODUCT_DELETED_SINCE_LOADED,
			});
		default:
			return applied({
				variant: "error",
				title: "Save failed",
				description: "The change could not be saved — retry in a moment.",
			});
	}
}

// -- merchant stock movements -------------------------------------------------

/** A caller-minted nonce: 32 hex characters from `mintMovementNonce` (the
 *  console), or a UUID (the staging demo seed). The shape is checked so a key is
 *  never built from arbitrary operator-round-tripped text, and is loose enough
 *  to admit any opaque id of comparable entropy. */
const NONCE_PATTERN = /^[A-Za-z0-9-]{16,64}$/;

type ReadNonce = { kind: "absent" } | { kind: "ok"; value: string } | { kind: "bad" };

/** Read the per-click nonce. ABSENT selects the one-release legacy key; PRESENT
 *  but malformed refuses — falling back to the legacy key would quietly reopen
 *  the replay-collision this nonce exists to close. */
function readNonce(value: unknown): ReadNonce {
	const raw = readString(value);
	if (raw === undefined) return { kind: "absent" };
	return NONCE_PATTERN.test(raw) ? { kind: "ok", value: raw } : { kind: "bad" };
}

/** The movement's idempotency key: per-intent when the caller sent a nonce, and
 *  F-2a's content-derived key otherwise (the legacy fallback, one release). The
 *  `nonce:` segment keeps the two shapes from ever colliding. */
function stockMovementKey(
	productId: string,
	direction: "restock" | "removal",
	onHand: number,
	qty: number,
	nonce: string | undefined,
): string {
	return nonce === undefined
		? `${productId}:${direction}:${onHand}:${qty}`
		: `${productId}:${direction}:nonce:${nonce}`;
}

/** What one movement needs, read and checked off the payload. */
type MovementInput =
	| { ok: true; productId: string; onHand: number; qty: number; nonce: string | undefined }
	| { ok: false; notice: Notice };

/**
 * Read a movement's payload. Every field is re-checked for PRESENCE as well as
 * shape, and an absent watermark refuses here, before anything is sent (see
 * `parseOnHand`). A bad restock QUANTITY gets the field-level add-stock line; a
 * bad removal quantity gets the payload-level refusal, because the surface
 * parses it with the same shared `parseStockQty` before it opens its confirm, so
 * an unparseable one arriving here was hand-made rather than mistyped.
 */
function readMovement(
	payload: ProductsActionPayload,
	direction: "restock" | "removal",
): MovementInput {
	const productId = readString(payload["productId"]);
	// TODO(next release, with the legacy fallback): a restock with a nonce needs
	// no `onHand` — it is unpinned, and the count is only the legacy key's
	// component. Drop the restock requirement when `stockMovementKey`'s content
	// branch goes; a removal keeps it, as its watermark.
	const onHand = parseOnHand(payload["onHand"]);
	const nonce = readNonce(payload["nonce"]);
	if (productId === undefined || onHand === null || nonce.kind === "bad") {
		return { ok: false, notice: UNREADABLE };
	}
	const qty = parseStockQty(readString(payload["qty"]));
	if (qty === null) {
		return {
			ok: false,
			notice: direction === "restock" ? { variant: "error", ...ADD_STOCK_INVALID_QTY } : UNREADABLE,
		};
	}
	return {
		ok: true,
		productId,
		onHand,
		qty,
		nonce: nonce.kind === "ok" ? nonce.value : undefined,
	};
}

/**
 * A REPLAYED MOVEMENT IS REPORTED AS ONE. The store says when its answer came
 * from the idempotency ledger (`replayed`): an earlier call with this key moved
 * the units, and this one moved nothing. Reporting it as a fresh "Added 8" is
 * the same lie the original bug told.
 *
 * WITH A NONCE the replay is this decision's own retry (a lost response, then
 * the console's explicit Retry), so it is "already applied", with the count
 * RE-READ now — the recorded one is the count that earlier call produced, and
 * the shelf may have moved since.
 *
 * WITHOUT ONE (the legacy key, one release), a replay is EITHER a double-submit
 * OR a different later move of the same shape that derived an earlier one's key
 * (Add 2, Remove 2, Add 2), and nothing — not even the live count, which a sale
 * can move either way — tells the two apart reliably. So it says only what is
 * certain: this submit changed nothing. "Reload" is the way out, not a figure of
 * speech: a reload fetches the console that sends a nonce, while retrying in the
 * old tab re-derives the very same key.
 */
async function replayedNotice(
	client: AdminProductsSurface,
	productId: string,
	nonce: string | undefined,
): Promise<Notice> {
	if (nonce === undefined) {
		return {
			variant: "error",
			title: "Nothing changed",
			description:
				"This submit changed nothing — an identical earlier change was already applied; if you meant a second change, reload and try again.",
		};
	}
	const live = await client.getProduct(productId).catch(() => null);
	const liveOnHand = live === null ? null : live.onHand;
	return {
		variant: "default",
		title: "Already applied",
		description:
			liveOnHand === null
				? "This change was already applied."
				: `This change was already applied — stock is now ${liveOnHand}.`,
	};
}

/**
 * The restock handler (DA-4 — one-shot, no staging, no confirm; restocking is
 * not the destructive act on this screen). NOT PINNED to the count the operator
 * saw: an add is commutative, so two tabs that both saw 4 and both add 3 end at
 * 10 — two clicks, two decisions, two nonces — and an honest "Add 10" is never
 * refused because a shopper checked out meanwhile. Lost-response safety is the
 * nonce's job: the console re-sends the SAME nonce until it gets an answer.
 * `onHand` is still read (and still required) because it is the legacy key's
 * component for a caller that sends no nonce.
 */
const restockAction: ProductsAction = async (client, payload) => {
	const input = readMovement(payload, "restock");
	if (!input.ok) return applied(input.notice);
	const { productId, onHand, qty, nonce } = input;
	const key = stockMovementKey(productId, "restock", onHand, qty, nonce);
	const result = await client.restock(productId, qty, key);
	if (result.ok && result.replayed === true) {
		return { ...applied(await replayedNotice(client, productId, nonce)), replayed: true };
	}
	return applied(restockNotice(result, qty));
};

/** A removal refused on the stock-changed-since-render path (DA-3a).
 *
 *  THE SENTENCE DOES NOT BLAME ANOTHER ADMIN. The watermark is the AVAILABLE
 *  count, so a shopper's reservation moves it as surely as a colleague's
 *  removal; "orders or another change" sends the operator to the count, not
 *  looking for a person.
 *
 *  `null` is its own sentence, never a count: there is NO inventory record for
 *  the sku (INC-23 — the wire says that now instead of calling it zero), and
 *  "changed to 0" would be a count nobody took. */
function stockChangedNotice(liveOnHand: number | null): Notice {
	const title = "Stock changed — nothing was removed";
	if (liveOnHand === null) {
		return {
			variant: "error",
			title,
			description:
				"This SKU no longer has an inventory record, so there is no count to remove from. Reload the product to see it as it stands now.",
		};
	}
	return {
		variant: "error",
		title,
		description: `Stock changed to ${liveOnHand} (orders or another change) — nothing was removed; check and try again.`,
	};
}

/**
 * The stock-removing write — the screen's one destructive act, which the surface
 * confirms for itself before this runs. It is the ONLY removal handler: the
 * `-review` step that used to precede it is not ported, so every guard a removal
 * gets is in this function or in the store behind it.
 *
 * DA-3a, MANDATORY, AND NOW ATOMIC: the watermark rides with the movement and the
 * store refuses a mismatch in the same write (see the module header for why it
 * is no longer a re-read here). Operator A opens a confirm for 5 units; operator
 * B removes 12; A's dialog still says "Remove 5 units" against a count that is
 * already false, and A's removal is refused with the count as it is.
 *
 * THE STORE APPLIES A GUARDED DECREMENT, so removing more than is on hand is
 * refused cleanly (never a negative and never an oversell) — the backstop the
 * retired review step's bound check has left behind.
 */
const removeStockAction: ProductsAction = async (client, payload) => {
	const input = readMovement(payload, "removal");
	if (!input.ok) return applied(input.notice);
	const { productId, onHand, qty, nonce } = input;
	const key = stockMovementKey(productId, "removal", onHand, qty, nonce);
	const result = await client.removeStock(productId, qty, key, onHand);
	if (result.ok && result.replayed === true) {
		return { ...applied(await replayedNotice(client, productId, nonce)), replayed: true };
	}
	return applied(removeStockNotice(result, qty));
};

/** Map a restock outcome to the notice shown above the reloaded detail. The
 *  count is the one the movement itself produced — never worked out here. */
function restockNotice(result: RestockResult, qty: number): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Stock added",
			description: `Added ${qty} ${unitWord(qty)}. Available is now ${result.onHand}.`,
		};
	}
	return stockFailureNotice(result.reason);
}

/** Map a stock-removal outcome to the notice. */
function removeStockNotice(result: StockRemovalResult, qty: number): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Stock removed",
			description: `Removed ${qty} ${unitWord(qty)}. Available is now ${result.onHand}.`,
		};
	}
	if (result.reason === "stale_on_hand") return stockChangedNotice(result.onHand);
	if (result.reason === "insufficient_stock") {
		return {
			variant: "error",
			title: "Not enough stock to remove",
			description: `Only ${result.onHand} ${unitWord(result.onHand)} on hand — you cannot remove ${qty}.`,
		};
	}
	// The operator confirmed against a count, so they saw a record: its absence
	// now is a change since render, and keeps DA-3a's own sentence rather than
	// the "re-save the SKU" advice a restock gets for a record that never was.
	if (result.reason === "no_inventory_row") return stockChangedNotice(null);
	return stockFailureNotice(result.reason);
}

/** Shared mapping for the non-success stock-movement reasons common to both
 *  restock and removal (no_sku / no_inventory_row / invalid / not_found /
 *  error). */
function stockFailureNotice(
	reason: "not_found" | "no_sku" | "no_inventory_row" | "invalid" | "error",
): Notice {
	switch (reason) {
		case "no_sku":
			return {
				variant: "error",
				title: "No SKU set",
				description:
					"This product has no SKU yet, so it has no stock to manage. Set a SKU on Identity above first.",
			};
		case "no_inventory_row":
			// SHOULD NEVER HAPPEN since PR 1a: a stock record is created the moment
			// a product gets a SKU, on both write paths (this edit form and the
			// integrator PUT) — including a SKU rename, since the seed follows the
			// row's resulting sku. Kept as defence for the two cases still able to
			// reach it: a product priced BEFORE 1a (there is no backfill), and a
			// write that bypasses the use-case. Re-saving the SKU here fixes both.
			return {
				variant: "error",
				title: "No stock record yet",
				description:
					"This product has a SKU but no stock record, so there is nothing to add to or remove from. Re-save the SKU on Identity above to create one.",
			};
		case "invalid":
			return {
				variant: "error",
				title: "Invalid quantity",
				description: "The quantity must be a positive whole number.",
			};
		case "not_found":
			return {
				variant: "error",
				title: PRODUCT_NOT_FOUND_TITLE,
				description: PRODUCT_DELETED_SINCE_LOADED,
			};
		default:
			return {
				variant: "error",
				title: "Stock change failed",
				description: "The change could not be saved — retry in a moment.",
			};
	}
}

// -- dispatch -----------------------------------------------------------------

/**
 * Every Pricing & inventory write, keyed by the action id that names it.
 *
 * ONE HANDLER SERVES THE THREE SAVES, exactly as the Block Kit screen's did: a
 * submit carries only its own form's fields, and an absent key means "preserve"
 * rather than "clear", so the split is a rendering arrangement rather than three
 * different writes.
 *
 * An id here that NO control can send is dead surface, which is why
 * `products:remove-stock-review` is absent: the React screen composes its own
 * confirm and has never had a staged step to render into.
 */
const PRODUCTS_ACTIONS_BY_ID: Readonly<Record<string, ProductsAction>> = {
	[ACTION_SAVE_IDENTITY]: saveAction,
	[ACTION_SAVE_PRICE]: saveAction,
	[ACTION_SAVE_SHIPPING]: saveAction,
	[ACTION_SAVE]: saveAction,
	[ACTION_ATTACH_DOWNLOAD]: attachDownloadAction,
	[ACTION_RESTOCK]: restockAction,
	[ACTION_REMOVE_STOCK]: removeStockAction,
};

/**
 * The action ids this screen recognizes (MOD-2), read straight off the dispatch
 * table so the gate and the table cannot disagree about what exists.
 */
export const PRODUCTS_ACTION_IDS: ReadonlySet<string> = new Set(
	Object.keys(PRODUCTS_ACTIONS_BY_ID),
);

/**
 * Run one Pricing & inventory write.
 *
 * `undefined` means the id is not one this screen offers — a stale tab after a
 * deploy that renamed one, or a caller bug. It is deliberately NOT an outcome:
 * reporting an unknown action as a quiet success is how a stock movement that
 * never happened gets rendered as done.
 */
export async function dispatchProductsAction(
	actionId: string,
	payload: ProductsActionPayload,
	client: AdminProductsSurface,
): Promise<ProductsActionResult | undefined> {
	const action = PRODUCTS_ACTIONS_BY_ID[actionId];
	if (action === undefined) return undefined;
	return await action(client, payload);
}
