import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import type {
	ActionsBlock,
	AdminPageConfig,
	BannerBlock,
	Block,
	ButtonElement,
	FieldsBlock,
	FormBlock,
	MeterBlock,
	RouteHandler,
	SelectOption,
	TableBlock,
	TabPanel,
} from "../types.js";
import {
	AdminRulesClient,
	type CouponEdit,
	type CouponsListFilter,
	type CouponSummaryWire,
	type RulesCreateResult,
	type RulesDeleteResult,
	type RulesUpdateResult,
} from "./admin-rules-client.js";
import { formatMinorUnitsInput, parseMinorUnitsInput } from "./money-input.js";
import { formatBpsAsPercent, parsePercentToBps } from "./percent-input.js";
import {
	asRecord,
	backButton,
	carriedForm,
	clearFiltersButton,
	createListDetailHandler,
	customAction,
	decodePath,
	encodePath,
	failClosedResponse,
	filterPanel,
	filterSummary,
	leafLevel,
	listIntroLine,
	listLevel,
	listResult,
	noticeBanner,
	PATH_FIELD,
	readAdminTokens,
	readString,
	screenActions,
	type CustomActionApi,
	type ListDetailInput,
	type NavPath,
	type Notice,
	type ScreenActions,
} from "./scaffold/index.js";

/**
 * The admin Coupons console — built against `docs/admin/ADMIN-CONSOLE.md`
 * §12.2, pattern-matched on the reference screen (`orders-page.ts`, §11).
 * A 2-level scaffold screen (list → leaf detail/edit) over `AdminRulesClient`.
 *
 * THE SHAPE, in one paragraph. The list is `header` + one `context` + an
 * optional notice `banner` + an INLINE one-field search (L-2: 1 field renders
 * directly, no accordion) + the table — nothing else above the data (P-1).
 * The detail is `header` + back + notice + a lifecycle `banner` on the
 * exceptions only + the 6-entry identity strip (D-1a's cap; `Status` leads it
 * and the redundant `Code` row is gone — the header already carries the code),
 * then TWO task-named panels — `Coupon` · `Redemptions` (D-2, D-2a: a would-be
 * `History` panel would hold only Created, which lives in the identity strip
 * instead) — whose one named group (`Edit`) is a CLOSED `accordion`.
 *
 * WHY THIS SCREEN HAS NO RENDER-STATE CHANNEL FOR DA-3. Every destructive/
 * risky write here is DA-2 (delete: no input, forbid-if-redeemed) or DA-4
 * (create/save: plain forms, no confirm) — there is no free-text-or-typed-
 * amount flow that would need DA-3's stage/confirm shape, so this screen
 * carries none of Orders' refusal machinery. It DOES use the render-state
 * channel, for a NON-DA-3 purpose the spec also assigns it (E-2): saying that
 * THIS render is the create screen rather than the list, and — on a refusal —
 * carrying back what the operator typed into it. See {@link CouponsRenderState}.
 *
 * CREATING IS A DRILL-IN, NOT A GROUP AT THE BOTTOM (INC-14). "New coupon" is
 * a `primary` BUTTON emitted directly under the intro line, above the data;
 * clicking it renders the create screen in place of the list (header · back ·
 * notice · context · form), the same button-drill-in idiom Tax and Shipping
 * already use for "View rates" (§12.7). L-8's create `accordion` at the very
 * bottom is GONE from this screen: it put the one action an empty console
 * needs last, below the picker, rendered as a link the eye reads as another
 * row affordance. Nothing about what a create SUBMITS changed.
 *
 * THE F-5a TRAP THIS SCREEN IS BUILT TO AVOID. `updateCoupon` sends a PUT
 * (`admin-rules-client.ts:493-496`) and the service coerces every omitted key
 * to `null` unconditionally (`rules-admin.ts:434-443`) — there is no partial
 * update on the wire. So the edit form is NEVER split into sibling forms
 * (F-5a forbids it here: splitting would let an operator saving a "Discount"
 * form silently wipe `startsAt`/`expiresAt`/`maxUses`/`maxUsesPerCustomer`).
 * It stays ONE form, kept inside budget by `condition`-gating the type-
 * specific economics fields (F-5b) and by F-5c's full-replace exemption
 * (cap 8; this form is F-5c's one named instance — 6 fields for a
 * `fixed_amount` coupon, 7 for `percentage`).
 *
 * B-3's CHANGE TOKEN, WITHOUT A SECOND HASH. `CouponSummaryWire` has no
 * `updatedAt`, so the edit form's `block_id` needs SOME value that changes
 * when the coupon's mutable fields do. Rather than hand-rolling a second
 * digest, this screen relies on {@link carriedForm}'s OWN prefill digest
 * (`__v`, B-3a) — it is already a hash of every field's `initial_value` in
 * order, which for this form IS exactly the coupon's mutable economics/window/
 * use-bound fields. B-3a's own text says this is not belt-and-braces; adding a
 * second hand-rolled hash alongside it would be exactly that.
 *
 * L-7's PICKER IS A `combobox`, NEVER A `select`. The option value is an
 * encoded drill path (opaque, not a human word) — a `select` would render
 * that raw value in its trigger (R-17a, X-22); `combobox` renders the label
 * (R-17b).
 *
 * `type`, `code` and `couponId` are IMMUTABLE identity/kind (F-2): none is a
 * form field anywhere on this screen. They ride invisibly in a form's
 * `block_id` carrier (edit) or a button's `value` (delete).
 */
export const COUPONS_PAGE: AdminPageConfig = { path: "/coupons", label: "Coupons", icon: "tag" };

/** This screen's namespaced action ids. */
const COUPON_ACTIONS: ScreenActions = screenActions("coupons");
const ACTION_CREATE = COUPON_ACTIONS.custom("create");
const ACTION_SAVE = COUPON_ACTIONS.custom("save");
const ACTION_DELETE = COUPON_ACTIONS.custom("delete");
/** Fired by the "New coupon" button — the promoted one above the table, and
 *  the empty state's own (E-2). Both render the create screen. Not a DA-3
 *  verb; see the module doc. */
const ACTION_NEW = COUPON_ACTIONS.custom("new");
/** The create screen's "← Back to coupons" — re-lists with NO render state,
 *  which is what makes the create screen go away. */
const ACTION_CANCEL_NEW = COUPON_ACTIONS.custom("cancel-new");

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the
 * Coupons console (DA-6's discipline applied generally: an id that is not
 * here is an id the dispatcher cannot mis-route to).
 */
export const COUPONS_ACTION_IDS: ReadonlySet<string> = COUPON_ACTIONS.actionIds(
	"create",
	"save",
	"delete",
	"new",
	"cancel-new",
);

/** The em-dash BlockInteraction envelope this page consumes. */
export type CouponsPageInput = ListDetailInput;

/** The list's filter form: `search` is the ONLY axis the service ships — a
 *  case-insensitive EXACT match on `code`, never a substring. */
interface CouponsFilterForm {
	search?: string;
}

/** A `combobox`/`select` sentinel meaning "nothing selected". NEVER `""`
 *  (F-6a) — the trigger renders the raw value and an empty one renders blank
 *  (R-17a). */
const NONE = "none";

/**
 * THIS SCREEN'S RENDER STATE (DA-3a-iii's channel, generalized beyond DA-3 —
 * see the module doc for why Coupons has no staged/refusal flow at all).
 * One member, read in exactly one place ({@link couponsBlocks}): render the
 * create screen instead of the list.
 *
 * `draft` IS WHY THE CHANNEL CARRIES MORE THAN A `kind`. A create refusal
 * re-renders this screen, and DA-3a-i's rule for every refusal render is
 * "state 1 again, with the submitted values prefilled" — so the operator who
 * mistyped a rate does not retype the other six fields. It carries RAW
 * OPERATOR TEXT, never parsed minor units (DA-3a-iii property 5): the most
 * common refusal here IS an unparseable amount, and a rejected `19,99` cannot
 * be reconstructed from cents that were never derived. Within-request only —
 * nothing is stored, and it reaches the client only as `initial_value`.
 */
type CouponsRenderState = { kind: "new-coupon"; draft?: CouponDraft };

/** The create form's seven fields exactly as they were submitted — see
 *  {@link CouponsRenderState}. `type` is a `select` value, so
 *  {@link createCouponForm} still resolves it against its own options before
 *  prefilling (X-23 forbids an `initial_value` absent from `options`). */
interface CouponDraft {
	id: string;
	code: string;
	type: string;
	amount: string;
	currency: string;
	ratePercent: string;
	cap: string;
}

/** Matches the service's default page size (`couponsListQuery` limit default). */
const PAGE_LIMIT = 25;

/** §1's prose budgets, as named constants so copy can be measured against
 *  them rather than eyeballed. */
const LABEL_BUDGET = 60;

export function createCouponsPageHandler(): RouteHandler<CouponsPageInput> {
	return createListDetailHandler<CouponsRenderState>({
		actions: COUPON_ACTIONS,
		async createClient(ctx) {
			const tokens = await readAdminTokens(ctx);
			return new AdminRulesClient({
				fetch: ctx.http.fetch,
				baseUrl: COMMERCE_SERVICE_BASE_URL,
				...tokens,
			});
		},
		// The "Open coupon" picker carries the ENCODED one-deep target path
		// (`[code]`) in `values.target` — the code, not the id, because the only
		// read that returns the full editable projection (incl. the validity
		// window) is the exact-code list search (see `couponDetailLevel().load`).
		parseOpen(input) {
			const encoded = readString(input.values?.target);
			if (encoded === undefined || encoded === NONE) return undefined;
			// `decodePath` returns `null` (not `undefined`) on a malformed token —
			// e.g. a hand-edited devtools value — normalized to `undefined` here so
			// it falls back to the root list rather than throwing.
			const targetPath = decodePath(encoded);
			return targetPath === null ? undefined : { targetPath };
		},
		levels: [couponsListLevel(), couponDetailLevel()],
		customActions: {
			[ACTION_CREATE]: createCouponAction(),
			[ACTION_SAVE]: saveCouponAction(),
			[ACTION_DELETE]: deleteCouponAction(),
			[ACTION_NEW]: newCouponAction(),
			[ACTION_CANCEL_NEW]: cancelNewCouponAction(),
		},
	});
}

// -- display summaries (pure; exported for their own unit test) ----------------

/**
 * One-line discount summary, rendered honestly: fixed_amount through the
 * symbol-bearing money formatter in the coupon's own currency; percentage as
 * the EXACT bps-derived percent with a currency-AGNOSTIC cap (a percentage
 * coupon has no currency, so its cap renders as a plain decimal — no invented
 * symbol); unset economics say "(unset)" instead of a garbage "null off"; an
 * unknown type renders verbatim rather than guessing its arithmetic.
 */
export function couponDiscountSummary(
	c: Pick<CouponSummaryWire, "type" | "amountCents" | "rateBps" | "capCents" | "currency">,
): string {
	if (c.type === "fixed_amount") {
		if (c.amountCents === null) return "fixed amount (unset)";
		return `${formatCentsForDisplay(c.amountCents, c.currency)} off`;
	}
	if (c.type === "percentage") {
		if (c.rateBps === null) return "percentage (unset)";
		const cap = c.capCents === null ? "" : ` (cap ${formatCentsForDisplay(c.capCents, null)})`;
		return `${formatBpsAsPercent(c.rateBps)}% off${cap}`;
	}
	return c.type;
}

/** The validity window as the merchant reads it — the UTC date part of the
 *  stored ISO bound (no timezone math), `[startsAt, expiresAt)` per the
 *  domain's `validateCoupon`. */
export function couponWindowSummary(startsAt: string | null, expiresAt: string | null): string {
	const from = startsAt === null ? null : startsAt.slice(0, 10);
	const until = expiresAt === null ? null : expiresAt.slice(0, 10);
	if (from === null && until === null) return "always";
	if (from === null) return `until ${until}`;
	if (until === null) return `from ${from}`;
	return `${from} → ${until}`;
}

/**
 * Redemptions as words: `3 of 100` against a bound, `0 uses` without one.
 * `usesCount` doubles as the cheap "has this been redeemed" indicator
 * (deletion is blocked once it is nonzero).
 *
 * The former `0 / ∞` is gone. `∞` is a glyph, not a word: it does not
 * localize, it is the only mathematical notation anywhere on these screens,
 * and it says "unbounded" to a reader who already knows that is what it
 * means. `N of M` is also how this screen's own Redemptions meter already
 * reads (`custom_value`), and `<code> · 20% off · 3 uses` is §12.2's own
 * picker vocabulary — so this brings the three renderings of one fact into
 * one wording rather than inventing a fourth.
 */
export function couponUsesSummary(usesCount: number, maxUses: number | null): string {
	if (maxUses !== null) return `${usesCount} of ${maxUses}`;
	return `${usesCount} use${usesCount === 1 ? "" : "s"}`;
}

/** The four lifecycle words this screen speaks. COMPUTED at render from the
 *  coupon's own window and use bound — never stored, never a form field
 *  (G2/F-2b: a value the domain derives is displayed, never given an input,
 *  because an input would be a second, disagreeing home for it). */
export type CouponStatus = "active" | "scheduled" | "expired" | "used up";

/**
 * The coupon's lifecycle state, decided the way the DOMAIN decides it and in
 * the domain's own order — window first (`[startsAt, expiresAt)`), then the
 * use bound — mirroring `validateCoupon`
 * (`packages/domain/src/pricing/validate-coupon.ts`, the `startsAt`/
 * `expiresAt`/`maxUses` checks) check for check, including its LEXICOGRAPHIC
 * comparison of ISO-UTC instants. Two consequences worth stating:
 *
 * - The end bound is EXCLUSIVE, so a coupon whose `expiresAt` is exactly
 *   `now` is already `expired` — the same instant at which checkout starts
 *   refusing it. A console that rounded that boundary the other way would tell
 *   an operator a coupon is live while the storefront rejects it.
 * - When two conditions hold at once the FIRST refusal wins: an exhausted
 *   coupon that also expired reads `expired`, because that is the reason
 *   checkout would give.
 *
 * `now` is a parameter, never the clock read from inside: the render path
 * supplies one instant per response, so no two rows of one table can disagree
 * about which side of a boundary the render happened on — and every boundary
 * is testable without faking time.
 */
export function couponStatus(
	c: Pick<CouponSummaryWire, "startsAt" | "expiresAt" | "maxUses" | "usesCount">,
	now: string,
): CouponStatus {
	if (c.startsAt !== null && now < c.startsAt) return "scheduled";
	if (c.expiresAt !== null && now >= c.expiresAt) return "expired";
	if (c.maxUses !== null && c.usesCount >= c.maxUses) return "used up";
	return "active";
}

/**
 * The minimum cart subtotal a coupon needs, as the list renders it.
 *
 * An ABSENT minimum is `—`, never `$0.00` and never "Free": "this coupon has
 * no floor" and "this coupon's floor is nothing" are different claims, and
 * rendering the first as the second invents a number the record does not
 * carry. A present one goes through `formatMoney` in the coupon's own currency
 * (M-1), and the formatted string is where the currency is stated — which is
 * M-2 ("stated once, not per row"): what that rule forbids is a `Currency`
 * COLUMN, and a currency in the header would be the worse option here, since
 * coupons genuinely mix currencies across rows and `Min spend (USD)` becomes a
 * lie the first time a EUR coupon lands. A percentage coupon carries no
 * currency at all, so its floor renders as the same plain exact decimal its
 * cap already does — no invented symbol.
 */
function couponMinSpendSummary(
	c: Pick<CouponSummaryWire, "minSubtotalCents" | "currency">,
): string {
	if (c.minSubtotalCents === null) return "—";
	return formatCentsForDisplay(c.minSubtotalCents, c.currency);
}

/** Display-format minor units: symbol-bearing when the coupon carries a
 *  currency; a PLAIN exact decimal when it does not (percentage coupons are
 *  currency-agnostic); a `CUR amount` fallback if the branding constructors
 *  reject the wire value (never throws into the render path). */
function formatCentsForDisplay(minorUnits: number, currencyCode: string | null): string {
	if (currencyCode === null) return formatMinorUnitsInput(minorUnits);
	try {
		return formatMoney(toCents(minorUnits), toCurrency(currencyCode), "en-US");
	} catch {
		return `${currencyCode} ${formatMinorUnitsInput(minorUnits)}`;
	}
}

// -- level 0: the coupons list -------------------------------------------------

function couponsListLevel() {
	return listLevel<AdminRulesClient, CouponsFilterForm, CouponSummaryWire, CouponsRenderState>({
		limit: PAGE_LIMIT,
		filterFromValues(values) {
			const search = readString(values.search)?.trim();
			return search !== undefined && search.length > 0 ? { search } : {};
		},
		async fetchPage(client, _path, filter, opts) {
			const page = await client.listCoupons(toClientFilter(filter), {
				limit: opts.limit,
				...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
			});
			return { items: page.coupons, nextCursor: page.nextCursor };
		},
		render({ actions, path, filter, items, nextToken, firstPage, notice, renderState }) {
			return couponsBlocks(actions, path, filter, items, nextToken, firstPage, notice, renderState);
		},
		onError: () => couponsFailClosed(),
	});
}

/** The standing half of the list's intro line — the row count goes in front of
 *  it ({@link listIntroLine}). 78 chars; the longest count line this screen can
 *  produce (`25 coupons on this page`) puts the whole line at 104 ≤ 140 (X-11). */
const LIST_INTRO = "Search a coupon and open it. Discounts apply to the cart subtotal at checkout.";

function toClientFilter(form: CouponsFilterForm): CouponsListFilter {
	return form.search !== undefined ? { search: form.search } : {};
}

/**
 * §12.2's list skeleton: `header` · one `context` (≤140) · the "New coupon"
 * BUTTON (INC-14) · notice `banner` · the INLINE one-field search (L-2: at 1
 * field it renders directly, no accordion) · the active-filter `section` ·
 * THE DATA (table, or `empty` in its place) · the "Open coupon" drill-in.
 *
 * The create button is the one addition INC-14 makes to P-1/L-1's whitelist,
 * and it is deliberately the whole addition: a BUTTON is one row tall and
 * carries no input, so "data inside the first screenful" survives it, which
 * the create FORM sitting up here would not. The form is a drill-in
 * ({@link newCouponScreen}) precisely so that it never renders above the data.
 *
 * When the render state says the operator asked for that screen, this function
 * returns it INSTEAD of the list — the level has already fetched a page by
 * then and it is dropped, which is one wasted read on a deliberate click and
 * buys the create screen the same fail-closed containment every other render
 * on this level has.
 */
function couponsBlocks(
	actions: ScreenActions,
	path: NavPath,
	filter: CouponsFilterForm,
	coupons: CouponSummaryWire[],
	nextToken: string | undefined,
	firstPage: boolean,
	notice: Notice | undefined,
	renderState: CouponsRenderState | undefined,
): Block[] {
	if (renderState?.kind === "new-coupon") return newCouponScreen(renderState.draft, notice);
	// ONE part for the screen's one authored filter field (L-3).
	const activeFilters = [filter.search !== undefined && `code: ${filter.search}`];
	const summary = filterSummary(activeFilters);
	const result = listResult({
		actions,
		path,
		count: coupons.length,
		filtered: summary !== undefined,
		firstPage,
		nextToken,
		noun: { one: "coupon", other: "coupons" },
		empty: {
			title: "No coupons yet",
			description: "Create one to start discounting carts.",
			blockId: "coupons:empty",
			// E-2's way IN: the SAME verb and the SAME words as the promoted button
			// above, because they are the same act and reach the same screen.
			actions: [{ type: "button", action_id: ACTION_NEW, label: "New coupon", value: {} }],
		},
		noMatch: {
			title: "No coupon matches that code",
			// The way IN is already on screen (the promoted "New coupon" button sits
			// above), so this state offers only the undo — one act per state.
			description: "Nothing came back for that search. Clear it to go back to every coupon.",
			blockId: "coupons:no-match",
			emptyText: "No coupon matches that code.",
		},
	});
	const blocks: Block[] = [
		{ type: "header", text: "Coupons", block_id: "coupons:hdr" },
		listIntroLine(result.countLine, LIST_INTRO),
		createCouponButton(),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));

	blocks.push(
		filterPanel({
			form: searchForm(actions, path, filter),
			blockId: "coupons:filters",
			activeFilters,
			// 1 field ≤ the default inline threshold (2) — renders directly, no
			// accordion (L-2).
		}),
	);
	if (summary !== undefined) {
		blocks.push({
			type: "section",
			text: summary,
			// The path rides in `value`, NOT `block_id` — a button echoes no
			// `block_id` (L-6, B-1).
			accessory: clearFiltersButton(actions, path),
			block_id: "coupons:filter-summary",
		});
	}

	// E-2: at zero the table is OMITTED and `empty` renders in its place. WHICH
	// state this is — no coupons at all, or a search that matched none with its own
	// undo attached — was decided once, in `listResult`.
	if (result.emptyBlock !== undefined) {
		blocks.push(result.emptyBlock);
	} else {
		blocks.push(couponsTable(coupons, nextToken, result.emptyText));
		if (result.scanNote !== undefined) blocks.push(result.scanNote);
	}
	if (coupons.length > 0) blocks.push(openCouponForm(actions, path, coupons));
	return blocks;
}

/** INC-14's promoted create affordance: `primary`, one row tall, directly
 *  under the intro line. It carries no `value` — the create screen it opens
 *  is the root list's own, so there is no path to carry (L-6 binds at depth
 *  ≥ 1). */
function createCouponButton(): ActionsBlock {
	return {
		type: "actions",
		block_id: "coupons:create-action",
		elements: [{ type: "button", action_id: ACTION_NEW, label: "New coupon", style: "primary" }],
	};
}

/**
 * The create screen (INC-14): what "New coupon" drills into. Shaped like every
 * other non-list level on the console — `header` · back · notice · context ·
 * the form — so the way out is where an operator already looks for it.
 *
 * The banner sits ABOVE the form on purpose: it is a refusal ("Coupon not
 * created"), and it explains the values the form below has just put back.
 */
function newCouponScreen(draft: CouponDraft | undefined, notice: Notice | undefined): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "New coupon", block_id: "coupons:new:hdr" },
		// No path: this screen belongs to the ROOT list, and the cancel verb
		// re-lists the level the operator came from.
		backButton(ACTION_CANCEL_NEW, "← Back to coupons"),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push({
		type: "context",
		// 108 chars ≤ 140 (§1 — the page-level line on this screen).
		text: "ID, code, type and currency are fixed at creation — to change them, retire this coupon and issue a new code.",
	});
	blocks.push(createCouponForm(draft));
	return blocks;
}

/**
 * The list table: identity first and money last (T-2), in SIX columns — which
 * EXCEEDS T-1's 5-column guidance for a list screen and sits exactly at its
 * hard maximum of 6. A director-ratified exemption, not a reading of the rule:
 * INC-07 mandates both `Status` and `Min spend` while `Code` / `Discount` /
 * `Valid` keep their semantics, which is six. T-1's rule text is reconciled in
 * a docs follow-up.
 *
 * `Status` ANSWERS THE QUESTION THE SCREEN EXISTS FOR. Without it the only
 * signal that `EXPIRED20` ended a month ago and `LAUNCH2026` has not started
 * is the raw date text in `Valid`, which makes an operator do date arithmetic
 * across every row of a screen whose whole purpose is "which discounts are
 * live right now". It is computed here, per render, from the coupon's own
 * fields — see {@link couponStatus}.
 *
 * `Status` IS PLAIN TEXT, NOT A BADGE, and that is a decision rather than an
 * omission. The right rendering is "badge the exceptions, leave the happy path
 * quiet" — an `expired` mark that pulls the eye, and nothing at all on the
 * live rows. Block Kit cannot express it: `format` is a property of the
 * COLUMN, not of a cell (the renderer's `formatCell` reads `col.format`), so a
 * table badges every row of a column or none of them. Blanking the happy-path
 * cell to fake the split is worse than either end — the renderer's `Badge`
 * draws its pill from padding and a radius alone, so an empty cell in a badge
 * column is a solid mark with no word in it, i.e. the loudest possible
 * rendering of "nothing to report". So the choice is all rows badged or none,
 * and none wins: a pill on every live coupon spends the screen's heaviest ink
 * on its least informative value (exactly T-5's "never badge a property that
 * is near-constant across rows"), while the WORD `expired` already retires the
 * arithmetic this column was added to kill. Badging only the exceptions needs
 * per-value control the renderer does not have, and belongs to the
 * console-wide badge policy rather than to this screen alone.
 */
function couponsTable(
	coupons: CouponSummaryWire[],
	nextToken: string | undefined,
	emptyText: string | undefined,
): TableBlock {
	// ONE instant for the whole response, so no two rows of one table can be
	// judged against different clocks (see `couponStatus`).
	const now = new Date().toISOString();
	return {
		type: "table",
		block_id: "coupons:list",
		columns: [
			{ key: "code", label: "Code", format: "code" }, // identity first (T-2)
			{ key: "status", label: "Status" }, // computed, plain text — see above
			// `Type` column DELETED (T-5): `Discount` already reads `20% off` /
			// `$5.00 off`, so a badge repeating `fixed_amount`/`percentage` would be
			// a second, redundant lifecycle-shaped column.
			{ key: "discount", label: "Discount" },
			{ key: "window", label: "Valid" },
			{ key: "uses", label: "Uses" },
			{ key: "minSpend", label: "Min spend" }, // money LAST, pre-formatted (T-2, M-1)
		],
		rows: coupons.map((c) => ({
			code: c.code,
			status: couponStatus(c, now),
			discount: couponDiscountSummary(c),
			window: couponWindowSummary(c.startsAt, c.expiresAt),
			uses: couponUsesSummary(c.usesCount, c.maxUses),
			minSpend: couponMinSpendSummary(c),
		})),
		page_action_id: COUPON_ACTIONS.page,
		...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
		// OMITTED when another page remains behind a zero-row one: the renderer
		// short-circuits such a table to a bare `<p>` and takes `Load more` with it
		// (see `listResult`, outcome 3).
		...(emptyText !== undefined ? { empty_text: emptyText } : {}),
	};
}

/**
 * The one-field search (L-2 ⇒ inline, no accordion), built by `carriedForm`
 * LAST so its digest matches — `filterPanel` recomputes it and throws on an
 * absent or stale one (B-3a).
 */
function searchForm(actions: ScreenActions, path: NavPath, filter: CouponsFilterForm): FormBlock {
	return carriedForm({
		namespace: "coupons:filter",
		context: { [PATH_FIELD]: encodePath(path) },
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "search",
					label: "Code (exact match, case-insensitive)",
					placeholder: "e.g. SUMMER25",
					...(filter.search !== undefined ? { initial_value: filter.search } : {}),
				},
			],
			submit: { label: "Search", action_id: actions.applyFilter },
		},
	});
}

/**
 * The drill-in picker (L-7). ALWAYS a `combobox`, never a `select`: the option
 * VALUE is an encoded drill path (opaque, not a readable word), and a `select`
 * would render that raw value in its trigger (R-17a, X-22) — `combobox`
 * renders the label instead (R-17b). Never prefills (R-12a), so `combobox` is
 * safe at any row count.
 */
function openCouponForm(
	actions: ScreenActions,
	path: NavPath,
	coupons: CouponSummaryWire[],
): FormBlock {
	return carriedForm({
		namespace: "coupons:open",
		context: { [PATH_FIELD]: encodePath(path) },
		form: {
			type: "form",
			fields: [
				{
					type: "combobox",
					action_id: "target",
					label: "Open coupon",
					placeholder: "Choose a coupon…",
					options: [
						{ value: NONE, label: "Choose a coupon…" },
						...coupons.map((c) => ({
							value: encodePath([c.code]),
							label: `${c.code} · ${couponDiscountSummary(c)} · ${couponUsesSummary(c.usesCount, c.maxUses)}`,
						})),
					],
					initial_value: NONE,
				},
			],
			submit: { label: "View / edit", action_id: actions.open },
		},
	});
}

/**
 * The create form: 3 unconditional fields (id, code, type) + 2
 * `condition`-gated economics fields per type (F-5b) = 5 VISIBLE at once. Both
 * branches' fields are always PRESENT in the JSON (so the operator's live
 * `type` selection can reveal/hide them with no round trip); the server-side
 * parser still validates cross-type contamination explicitly (never trusts
 * that a hidden branch's fields are empty).
 *
 * Five fields that used to live here — `Starts at`, `Expires at`,
 * `Minimum spend`, `Max uses`, `Max uses per customer` — are GONE: all
 * five already have a home in the detail's edit form, a coupon created
 * without them is valid immediately/forever/unlimited/unrestricted (the
 * common case), and keeping them off this form is what holds it to 5 visible
 * instead of 8.
 *
 * `draft` IS THE REFUSAL PATH (DA-3a-i). Every value the operator submitted
 * comes back as this field's `initial_value`, VERBATIM — including the ones
 * the refusal was not about. `type` is resolved against the options first
 * (X-23), which also decides which economics branch `condition` reveals, so a
 * refused percentage coupon comes back as a percentage coupon.
 */
function createCouponForm(draft?: CouponDraft): FormBlock {
	const typeOptions: SelectOption[] = [
		{ value: "fixed_amount", label: "Fixed amount off" },
		{ value: "percentage", label: "Percentage off" },
	];
	const type = typeOptions.some((o) => o.value === draft?.type)
		? (draft?.type ?? "fixed_amount")
		: "fixed_amount";
	return carriedForm({
		namespace: "coupons:create",
		// No hidden context to carry — `id`/`code` are this form's own VISIBLE
		// fields, unlike edit's immutable couponId/code/type. Still routed through
		// `carriedForm` (empty context) rather than a hand-set block_id: the
		// `type` field's fixed `initial_value` makes this a "prefilling" form by
		// shape (B-3a's own test cannot distinguish a static default from a
		// record-derived one), so it needs the same `__v` digest every other
		// prefilling form carries.
		form: {
			type: "form",
			fields: [
				{
					type: "text_input",
					action_id: "id",
					label: "Coupon ID",
					placeholder: "e.g. summer25",
					...prefill(draft?.id),
				},
				{
					type: "text_input",
					action_id: "code",
					label: "Code",
					placeholder: "e.g. SUMMER25",
					...prefill(draft?.code),
				},
				{
					type: "select",
					action_id: "type",
					label: "Type",
					options: typeOptions,
					initial_value: type, // required for `condition` to evaluate (R-12b)
				},
				{
					type: "text_input",
					action_id: "amount",
					label: "Amount off",
					placeholder: "5.00",
					condition: { field: "type", eq: "fixed_amount" },
					...prefill(draft?.amount),
				},
				{
					type: "text_input",
					action_id: "currency",
					label: "Currency (ISO-4217)",
					placeholder: "USD",
					condition: { field: "type", eq: "fixed_amount" },
					...prefill(draft?.currency),
				},
				{
					type: "text_input",
					action_id: "ratePercent",
					label: "Rate (%)",
					placeholder: "7.25",
					condition: { field: "type", eq: "percentage" },
					...prefill(draft?.ratePercent),
				},
				{
					type: "text_input",
					action_id: "cap",
					label: "Discount cap (optional)",
					placeholder: "20.00",
					condition: { field: "type", eq: "percentage" },
					...prefill(draft?.cap),
				},
			],
			submit: { label: "Create coupon", action_id: ACTION_CREATE },
		},
	});
}

/** A text field's draft prefill, or nothing. An EMPTY draft value renders no
 *  `initial_value` at all rather than `""`: that is what an untouched field
 *  looks like to `blocks/form.tsx`, and it keeps the B-3a digest of a blank
 *  form identical to the digest of a form nobody has submitted yet. */
function prefill(value: string | undefined): { initial_value?: string } {
	return value !== undefined && value.length > 0 ? { initial_value: value } : {};
}

function couponsFailClosed() {
	return failClosedResponse({
		header: "Coupons",
		title: "Coupons are unavailable",
		// E-7's normative blockquote, verbatim — never a single named cause (X-42).
		description:
			"Coupons could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		toast: "Could not load coupons",
	});
}

// -- level 1: a coupon's detail/edit leaf --------------------------------------

function couponDetailLevel() {
	return leafLevel<AdminRulesClient, CouponSummaryWire>({
		// The detail load is the exact-code LIST search, not `GET /coupons/:code`
		// — deliberately: the point-lookup serialization omits `startsAt`/
		// `expiresAt`, and a full-replace edit form that cannot pre-fill the
		// window would silently CLEAR it on every save. `search` is an exact
		// case-insensitive match, so 0-or-1 rows is the norm; the exact-code
		// find guards the theoretical case-variant collision.
		async load(client, _path, code) {
			const page = await client.listCoupons({ search: code }, { limit: 2 });
			return page.coupons.find((c) => c.code === code) ?? page.coupons[0] ?? null;
		},
		render({ actions, path, id, detail, notice }) {
			return detailBlocks(actions, path, id, detail, notice);
		},
		notFound({ actions, path, id }) {
			return [
				{ type: "header", text: "Coupon not found" },
				backButton(actions.back, "← Back to coupons", path),
				{
					type: "banner",
					variant: "error",
					title: "Coupon not found",
					description: `No coupon matches "${id}" — it may have been deleted.`,
				},
			];
		},
		onError: () => couponFailClosed(),
	});
}

function couponFailClosed() {
	return failClosedResponse({
		header: "Coupon",
		title: "This coupon is unavailable",
		description:
			"This coupon could not be loaded. Check the service connection and the admin token in Settings; if both look right, this is a fault in the console itself — not your data.",
		toast: "Could not load the coupon",
	});
}

/**
 * §12.2's detail skeleton: `header` · back · notice · the lifecycle banner (on
 * the exceptions only) · the identity strip · TWO constant task-named panels —
 * `Coupon` · `Redemptions` (D-2).
 *
 * THE EDIT GROUP IS CLOSED. Coupons have no reconcile/fulfilment concept, so
 * D-5's rank-3 "named primary edit group" is the only rank that can fire here,
 * and it used to fire on every render — a screen operators open to READ
 * ("is this code live?") presented a loaded full-replace editor, one stray
 * Enter from rewriting the coupon's expiry, cap and use bounds (`PM §E3b`).
 * A rank that always fires is not a rank; the group now renders
 * `default_open: false` (a render-time call, exactly as Orders' Filters ships,
 * NOT a programmatic close), and the reading the operator came for is answered
 * above it — by `Status`, by the exception banner, and by the group's own
 * D-6 label.
 */
function detailBlocks(
	actions: ScreenActions,
	path: NavPath,
	code: string,
	detail: CouponSummaryWire,
	notice: Notice | undefined,
): Block[] {
	// ONE instant for the whole response (see `couponStatus`), so the summary
	// field and the banner below it cannot land on opposite sides of a boundary.
	const status = couponStatus(detail, new Date().toISOString());
	const blocks: Block[] = [
		// M-10: the coupon's CODE is its human handle, so it is the header — the
		// internal `id` never needs its own display row.
		{ type: "header", text: `Coupon — ${code}` },
		backButton(actions.back, "← Back to coupons", path),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	const exception = statusBanner(status);
	if (exception !== undefined) blocks.push(exception);
	blocks.push(
		fields("coupons:identity", [
			// FIRST, because it is the question the screen exists to answer (E3):
			// `EXPIRED20` and a live `SUMMER25` were the same row shape, and the
			// only signal was a date the operator had to compare to today. Computed
			// at render by the SAME {@link couponStatus} the list column uses — one
			// definition, so a coupon cannot read `expired` here and `active` there.
			//
			// It takes the slot the old `Code` row held rather than growing the
			// strip. `Code` duplicated the header two blocks above it — M-10 is the
			// reason: the code IS this screen's human handle, which is why it is
			// the header — and D-1a caps this strip at SIX entries (§12.2 pins the
			// set). So the strip pays for its new first entry with its redundant
			// one, and stays even in `fields`' row-major 2-column grid.
			["Status", status],
			["Discount", couponDiscountSummary(detail)],
			["Type", detail.type],
			["Uses", couponUsesSummary(detail.usesCount, detail.maxUses)],
			["Currency", detail.currency ?? "— (currency-agnostic)"],
			["Created (UTC)", utc(detail.createdAt)],
		]),
	);
	const panels: TabPanel[] = [
		{ label: "Coupon", blocks: couponPanel(detail) },
		{ label: "Redemptions", blocks: redemptionsPanel(detail) },
	];
	blocks.push({
		type: "tab",
		block_id: `coupons:${detail.id}:tabs`, // STABLE (B-4)
		default_tab: 0, // ALWAYS (D-4)
		panels,
	});
	return blocks;
}

/**
 * BADGE THE EXCEPTIONS — at a surface that has no badge.
 *
 * `Status` is a `fields` entry, and `FieldsBlock` carries no `format`: Block
 * Kit's only badge is a TABLE COLUMN's, which is why INC-07 could not badge
 * the list's exceptions either. On the leaf there is exactly ONE coupon, so
 * the split IS expressible — the emphasis lever is a `banner`, the only
 * primitive here that outranks a field label (`context` and a `fields` label
 * are both `text-sm text-kumo-subtle`).
 *
 * `active` deliberately gets NOTHING. A live coupon has nothing to report, and
 * a mark on every coupon would spend the screen's loudest ink on its least
 * informative state (T-5) — the same reasoning INC-07 applied to the column.
 * Each exception names the CONSEQUENCE rather than restating the word already
 * in the strip above: what checkout does with the code is what the operator
 * opened this screen to learn (`PM §E3`).
 */
function statusBanner(status: CouponStatus): BannerBlock | undefined {
	if (status === "active") return undefined;
	const description =
		status === "scheduled"
			? "Checkout refuses this code until its start date."
			: status === "expired"
				? "Checkout refuses this code — its expiry date has passed."
				: "Checkout refuses this code — it has reached its maximum number of uses.";
	return {
		type: "banner",
		variant: "alert",
		title: `This coupon is ${status}`,
		description,
	};
}

// -- panel "Coupon" -------------------------------------------------------------

function couponPanel(detail: CouponSummaryWire): Block[] {
	return [
		// D-2a: the would-be `History` panel holds only Created (already in the
		// identity strip), so these two round out the first panel's own `fields`
		// instead of getting a panel of their own.
		fields("coupons:more", [
			[
				"Minimum spend",
				detail.minSubtotalCents === null
					? "— (none)"
					: formatCentsForDisplay(detail.minSubtotalCents, detail.currency),
			],
			["Valid", couponWindowSummary(detail.startsAt, detail.expiresAt)],
		]),
		editGroup(detail),
	];
}

/**
 * The Edit group — ONE full-replace form (F-5c, cap 8; F-5a forbids splitting
 * here — see the module doc). `condition`-gated on the coupon's immutable
 * `type` is inert on THIS form (only one branch's fields are ever authored,
 * because `type` cannot change post-creation and is not itself a form field
 * here — it rides in the carrier), so no `condition` is attached; the server
 * decides the branch once, the same way `createCouponForm`'s `condition`
 * decides it reactively on create.
 */
function editGroup(detail: CouponSummaryWire): Block {
	return {
		type: "accordion",
		block_id: `coupons:${detail.id}:edit`,
		// D-6: the label carries the answer that makes opening it unnecessary —
		// which is what makes shipping this group CLOSED cost the reader nothing.
		label: fitLabel(
			`Edit — ${couponDiscountSummary(detail)} · ${couponWindowSummary(detail.startsAt, detail.expiresAt)}`,
		),
		// CLOSED — see {@link detailBlocks}. A render-time `default_open: false`,
		// not a programmatic close: there is no open/close signal to read, and
		// forcing a mounted group shut would mean changing its `block_id`, which
		// remounts it and discards whatever the operator had typed.
		default_open: false,
		blocks: [
			// HIGHER EMPHASIS THAN THE LABELS IT WARNS ABOUT. This was a `context`
			// line — `text-sm text-kumo-subtle`, the same weight as the field
			// labels below and quieter than their values — which is the wrong
			// ranking for the one sentence that says a blank field DESTROYS a set
			// value. A `banner` is the only primitive in this group that outranks
			// them (icon + variant + title). It is nested inside the accordion, so
			// it does not count against §2's top-level banner budget (X-31).
			{
				type: "banner",
				variant: "alert",
				title: "Saving replaces every field below",
				// 118 chars ≤ 240 (X-11).
				description:
					"This is a full replace: a blank optional field saves as unset, not unchanged. Values shown are the current ones.",
			},
			{
				type: "context",
				// 140 chars ≤ 200. The end-of-day reading is NOT cosmetic — the
				// domain's window is `[startsAt, expiresAt)`, so a date that meant
				// midnight would retire the code a whole day before its stated expiry.
				text: "Dates are UTC. A coupon becomes valid at the start of its start date and stops at the END of its expiry date. Blank either one for no bound.",
			},
			editCouponForm(detail),
		],
	};
}

/** The disclosure gating the four rarely-touched bounds — a `toggle` inside the
 *  form, NOT a second `accordion`: an accordion would need a second FORM, and
 *  F-5a forbids splitting this one, because on a wire with no partial update
 *  saving one half silently nulls the other. See {@link editCouponForm}. */
const LIMITS_TOGGLE = "showLimits";

/**
 * The full-replace edit form. Three properties carry this screen's safety.
 *
 * (1) EVERY SET VALUE RIDES AS `initial_value`, NEVER AS A `placeholder`. A
 * placeholder is grey ghost text the browser submits as `""`; on a wire with no
 * partial update, a set value rendered as one is a silent unset of something
 * the operator could SEE on screen when they pressed Save (`PM §E3` — the
 * P0-class check this increment is gated on). A `placeholder` here may only be
 * a FORMAT EXAMPLE on a field that is genuinely empty, and the window fields no
 * longer need even that: a `date_input` IS its own format.
 *
 * (2) THE FOUR BOUNDS ARE COLLAPSED, AND THE FORM IS STILL ONE FORM. Seven
 * full-bleed inputs stacked — five of them empty on a typical coupon — is the
 * worst proportion offender in the console (`DESIGNER §3`), and the fix is to
 * put the rarely-touched bounds behind a closed disclosure. It CANNOT be a
 * second `accordion`, because an accordion holds blocks and a form's fields are
 * not blocks: a second group would mean a second FORM, which F-5a forbids here
 * for the same reason this whole increment exists (saving the "Discount" half
 * would null the window and the use bounds). A `toggle` + `condition` gets the
 * same collapsed shape inside ONE submit. Nothing is hidden by it that the leaf
 * does not already show as read-only text: the cap rides in `Discount`, the
 * floor in `Minimum spend`, and both use bounds in the Redemptions panel.
 *
 * (3) A FIELD THAT NEVER REACHED THE SUBMIT KEEPS ITS CURRENT VALUE. Today a
 * `condition`-hidden field's value DOES arrive — `blocks/form.tsx` seeds its
 * state from every field's `initial_value` and posts that state whole, while
 * its render pass returns `null` for the hidden ones. But that is an
 * interaction between two upstream implementation details, and `carrier.ts`
 * REJECTS relying on it as a hidden-context channel precisely because a future
 * release could legitimately change it. Depending on it for data PRESERVATION
 * would leave every collapsed bound one upstream refactor away from the exact
 * loss this increment retires. So the form ALSO carries each current value in
 * its `block_id`, and the parsers treat an ABSENT key as "unchanged" while a
 * PRESENT BLANK one stays the explicit unset the group's banner promises. The
 * two answers differ only under a renderer that drops hidden fields — and there
 * the carrier is the safe one.
 *
 * `couponId`/`code`/`type` ride invisibly in the same carrier (F-2); B-3's
 * change token is `carriedForm`'s own prefill digest (`__v`, B-3a) — a second,
 * hand-rolled hash would be belt-and-braces B-3a already says not to add.
 */
function editCouponForm(detail: CouponSummaryWire): FormBlock {
	const editFields: FormBlock["fields"] = [];
	if (detail.type === "fixed_amount") {
		editFields.push({
			type: "text_input",
			action_id: "amount",
			label: `Amount off (${detail.currency ?? "?"})`,
			...(detail.amountCents !== null
				? { initial_value: formatMinorUnitsInput(detail.amountCents) }
				: {}),
		});
	} else {
		editFields.push({
			type: "text_input",
			action_id: "ratePercent",
			label: "Rate (%)",
			...(detail.rateBps !== null ? { initial_value: formatBpsAsPercent(detail.rateBps) } : {}),
		});
	}
	// THE WINDOW, AS DATE ELEMENTS. `date_input` renders a native
	// `<input type="date">` (verified in the pinned 0.31.1 renderer), so nobody
	// hand-types `2026-08-01T00:00:00Z` — and nobody mistypes it into a silent
	// parse failure either. It speaks DAYS, not instants; {@link resolveBound}
	// decides which instant each edge of a day means.
	editFields.push(dateField("startsAt", "Starts at (optional, UTC)", detail.startsAt));
	editFields.push(dateField("expiresAt", "Expires at (optional, UTC)", detail.expiresAt));
	// CLOSED on every render (the `false` is unconditional — the values it hides
	// are all readable above it). A toggle's `description` is dropped by the
	// renderer, so the label alone has to say what it reveals.
	editFields.push({
		type: "toggle",
		action_id: LIMITS_TOGGLE,
		label: "Edit spend and use limits",
		initial_value: false,
	});
	if (detail.type === "percentage") {
		editFields.push(
			limitField(
				"cap",
				"Discount cap (optional)",
				detail.capCents === null ? undefined : formatMinorUnitsInput(detail.capCents),
			),
		);
	}
	editFields.push(
		limitField(
			"minSubtotal",
			"Minimum spend (optional)",
			detail.minSubtotalCents === null ? undefined : formatMinorUnitsInput(detail.minSubtotalCents),
		),
	);
	editFields.push(
		limitField(
			"maxUses",
			"Max uses (optional)",
			detail.maxUses === null ? undefined : String(detail.maxUses),
		),
	);
	editFields.push(
		limitField(
			"maxUsesPerCustomer",
			"Max uses per customer (optional)",
			detail.maxUsesPerCustomer === null ? undefined : String(detail.maxUsesPerCustomer),
		),
	);
	return carriedForm({
		namespace: "coupons:edit",
		context: {
			couponId: detail.id,
			code: detail.code,
			type: detail.type,
			...currentContext(detail),
		},
		form: {
			type: "form",
			fields: editFields,
			submit: { label: "Save coupon", action_id: ACTION_SAVE },
		},
	});
}

/** A window bound as a `date_input`, pre-filled with the DAY its stored instant
 *  falls on — the granularity this screen has always DISPLAYED the window at
 *  (`couponWindowSummary` slices the same ten characters). */
function dateField(
	actionId: string,
	label: string,
	iso: string | null,
): FormBlock["fields"][number] {
	return {
		type: "date_input",
		action_id: actionId,
		label,
		...(iso !== null ? { initial_value: iso.slice(0, 10) } : {}),
	};
}

/** One of the four bounds behind {@link LIMITS_TOGGLE} — money as its exact
 *  decimal string (never a `number_input`, which hands back a float), counts as
 *  plain integers, and `undefined` for a bound that is genuinely unset. */
function limitField(
	actionId: string,
	label: string,
	value: string | undefined,
): FormBlock["fields"][number] {
	return {
		type: "text_input",
		action_id: actionId,
		label,
		condition: { field: LIMITS_TOGGLE, eq: true },
		...(value !== undefined ? { initial_value: value } : {}),
	};
}

/**
 * The coupon's CURRENT optional values, as the carrier's flat string record —
 * the fallback behind property (3) of {@link editCouponForm}.
 *
 * Money crosses this boundary as its integer MINOR-UNIT string, which is
 * `carrier.ts`'s own rule and not a local choice: a decimal here would be one
 * more place a coupon's amount could pick up float drift. A null value is an
 * ABSENT key rather than a magic empty string, so "no current value" and "a
 * current value of nothing" stay different claims on the wire too.
 */
function currentContext(detail: CouponSummaryWire): Record<string, string> {
	return {
		// GATED ON TYPE, exactly as the `cap` FIELD is. A `fixed_amount` coupon
		// has no cap field on this form, and nothing upstream stops it holding a
		// stray `capCents` — the service validates each column, never the pair.
		// Carrying one unconditionally would feed `parseEconomics` a cap the
		// operator cannot see, and its cross-type check would then refuse EVERY
		// save of that coupon while naming a field that is not on screen: an
		// unescapable dead end where the previous code silently hard-nulled the
		// stray value on the next save.
		...(detail.type === "percentage" && detail.capCents !== null
			? { curCap: String(detail.capCents) }
			: {}),
		...(detail.minSubtotalCents !== null
			? { curMinSubtotal: String(detail.minSubtotalCents) }
			: {}),
		...(detail.maxUses !== null ? { curMaxUses: String(detail.maxUses) } : {}),
		...(detail.maxUsesPerCustomer !== null
			? { curMaxUsesPerCustomer: String(detail.maxUsesPerCustomer) }
			: {}),
		...(detail.startsAt !== null ? { curStartsAt: detail.startsAt } : {}),
		...(detail.expiresAt !== null ? { curExpiresAt: detail.expiresAt } : {}),
	};
}

/**
 * A carried window instant, or `null` if it is not one.
 *
 * The money and count keys are already validated on the way back in, and these
 * get the same treatment rather than being trusted for looking date-shaped: a
 * carrier round-trips through the operator's browser (`carrier.ts`: "treat
 * every decoded value as untrusted input"), the service only length-checks
 * these columns, and the domain compares them LEXICOGRAPHICALLY — so a value
 * that is merely parseable rather than canonical would sort wrong forever and
 * silently mis-decide `validateCoupon`.
 *
 * The test is a ROUND TRIP, not a parse: `Date.parse` accepts `2026-02-30` and
 * rolls it into March, so "it parsed" proves nothing about what would be
 * stored. Only a string that survives `parse → toISOString` unchanged is the
 * canonical ISO-UTC instant this field is allowed to hold.
 */
function carriedInstant(raw: string | undefined): string | null {
	return raw !== undefined && isCanonicalInstant(raw) ? raw : null;
}

// -- panel "Redemptions" --------------------------------------------------------

function redemptionsPanel(detail: CouponSummaryWire): Block[] {
	const remaining =
		detail.maxUses === null ? "unlimited" : String(Math.max(0, detail.maxUses - detail.usesCount));
	const blocks: Block[] = [
		fields("coupons:uses", [
			["Redemptions", String(detail.usesCount)],
			["Max uses", detail.maxUses === null ? "unlimited" : String(detail.maxUses)],
			[
				"Max per customer",
				detail.maxUsesPerCustomer === null ? "unlimited" : String(detail.maxUsesPerCustomer),
			],
			// M-11a: "Remaining" alone is not a label — name the axis. The §12.2
			// listing's bare "Remaining" conflicts with M-11a/X-43; the rule wins
			// (N-1) and is reported as a listing defect in the PR.
			["Remaining redemptions", remaining],
		]),
	];
	if (detail.maxUses !== null) {
		blocks.push(redemptionsMeter(detail));
	}
	blocks.push({
		type: "context",
		// 163 chars ≤ 200.
		text: "Orders already placed keep their snapshotted discount regardless of edits here. Lowering max uses to at or below the current count exhausts the coupon immediately.",
	});
	// Delete lives HERE, beside the count that gates it (DA-2, forbid-if-redeemed).
	if (detail.usesCount === 0) {
		blocks.push(deleteCouponActions(detail));
	} else {
		blocks.push({
			type: "context",
			text: withheldDeleteContext(detail.usesCount),
		});
	}
	return blocks;
}

/** A COUNT meter (redemptions-of-max-uses), so `custom_value` is optional per
 *  M-8 (only mandatory when `value`/`max` are money) — included anyway for a
 *  readable readout. Only rendered when `maxUses` is set: a `meter` over a
 *  synthetic or absent max is forbidden (§2, M-8's zero-denominator note). */
function redemptionsMeter(detail: CouponSummaryWire): MeterBlock {
	const max = detail.maxUses ?? 0;
	return {
		type: "meter",
		label: "Redemptions",
		value: detail.usesCount,
		max,
		custom_value: `${detail.usesCount} of ${max}`,
	};
}

function deleteCouponActions(detail: CouponSummaryWire): ActionsBlock {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE,
		// The BUTTON stays a generic verb phrase; the code lives in the confirm
		// title instead (M-7 — an id/handle never sits in a button/submit label).
		label: "Delete coupon",
		style: "danger",
		value: { couponId: detail.id, code: detail.code },
		confirm: {
			// fitLabel: a merchant-chosen code has no length cap on the wire, so
			// the title is truncated the same way a data-derived accordion label
			// is (§1's 60-char confirm.title budget, X-11).
			title: fitLabel(`Delete ${detail.code}?`),
			// 112 chars ≤ 200, trimmed from the former 301-char text.
			text: "Only a never-redeemed coupon can be deleted. In-flight carts recompute without it; placed orders are unaffected.",
			confirm: "Yes, delete",
			deny: "Keep it",
			style: "danger",
		},
	};
	return { type: "actions", elements: [button] };
}

/** DA-7's normative blockquote, parametrized. No "deliberately"/"there is
 *  no"/"we do not" (X-41); names the alternative (DA-7a). */
function withheldDeleteContext(usesCount: number): string {
	return `This coupon has been redeemed ${usesCount} time${usesCount === 1 ? "" : "s"} — deletion is blocked to keep the redemption audit trail. To retire it, set its expiry to a past date.`;
}

// -- form parsing (exact integer math; NO floats — CLAUDE.md) -------------------

type ParsedEconomics =
	| {
			ok: true;
			amountCents: number | null;
			rateBps: number | null;
			capCents: number | null;
			currency: string | null;
	  }
	| { ok: false; message: string };

/**
 * The coupon's current optional values, recovered from the form's own carrier
 * — see property (3) of {@link editCouponForm}. Money and counts come back as
 * the INPUT strings the fields would have submitted, so there is exactly one
 * parsing path downstream; the window bounds come back as stored INSTANTS,
 * because {@link resolveBound} preserves them byte for byte.
 */
interface CurrentValues {
	cap: string;
	minSubtotal: string;
	maxUses: string;
	maxUsesPerCustomer: string;
	startsAt: string | null;
	expiresAt: string | null;
}

/** No carried current at all — the CREATE form, which has none of these fields
 *  and whose absent keys therefore mean "unset", exactly as before. */
const NO_CURRENT: CurrentValues = {
	cap: "",
	minSubtotal: "",
	maxUses: "",
	maxUsesPerCustomer: "",
	startsAt: null,
	expiresAt: null,
};

function currentValues(carried: Readonly<Record<string, string>> | undefined): CurrentValues {
	return {
		cap: carriedMoneyInput(carried?.curCap),
		minSubtotal: carriedMoneyInput(carried?.curMinSubtotal),
		maxUses: carriedCount(carried?.curMaxUses),
		maxUsesPerCustomer: carriedCount(carried?.curMaxUsesPerCustomer),
		startsAt: carriedInstant(carried?.curStartsAt),
		expiresAt: carriedInstant(carried?.curExpiresAt),
	};
}

/** Carried MINOR UNITS → the decimal string the field renders. A carrier
 *  round-trips through the operator's browser, so anything that is not a plain
 *  non-negative integer reads as "no current value" rather than being trusted
 *  into a money field. */
function carriedMoneyInput(raw: string | undefined): string {
	const count = carriedCount(raw);
	return count === "" ? "" : formatMinorUnitsInput(Number.parseInt(count, 10));
}

/** Carried whole count, or `""` for absent/untrusted. */
function carriedCount(raw: string | undefined): string {
	if (raw === undefined || !/^\d+$/.test(raw)) return "";
	const n = Number.parseInt(raw, 10);
	return Number.isSafeInteger(n) ? String(n) : "";
}

/**
 * The value a field contributes to this save. A field the operator SUBMITTED
 * wins — blank included, because that blank is the explicit unset the edit
 * group's banner promises. A field that never reached the submit at all falls
 * back to the value the form carried, so a collapsed disclosure cannot quietly
 * clear what it was hiding (property (3) of {@link editCouponForm}).
 *
 * `disclosed` narrows what counts as a deliberate blank. A blank arriving from
 * a bound the operator never REVEALED cannot be an instruction — they could not
 * see the field, let alone empty it — so it reads as "unchanged" too. Today
 * this changes nothing: the pinned renderer posts each hidden field's own
 * `initial_value`, which is blank only when the bound was already unset. It
 * closes the remaining mutation of property (3): a renderer that dropped
 * hidden fields would be caught by the absent-key branch, but one that cleared
 * them to `""` would slip past it and null every collapsed bound.
 */
function submittedOr(
	values: Record<string, unknown>,
	key: string,
	current: string,
	disclosed = true,
): string {
	const raw = readString(values[key]);
	if (raw === undefined) return current;
	const trimmed = raw.trim();
	return trimmed.length === 0 && !disclosed ? current : trimmed;
}

/** Whether the operator opened the disclosure holding the four bounds. A
 *  `toggle` submits a real boolean, so this is an identity check, never a
 *  truthiness one — `readString` would read it as absent. */
function limitsDisclosed(values: Record<string, unknown>): boolean {
	return values[LIMITS_TOGGLE] === true;
}

/**
 * Parse the type-dependent economics fields. On CREATE both types' fields are
 * on the form (a stateless Block form cannot toggle fields on the type
 * select; `condition` is a CLIENT-side visibility hint only), so a value in
 * the OTHER type's field is an explicit boundary error — never silently
 * dropped. On EDIT only the active type's fields are rendered and `currency`
 * is immutable (`mode: "edit"` skips it).
 */
function parseEconomics(
	type: "fixed_amount" | "percentage",
	values: Record<string, unknown>,
	mode: "create" | "edit",
	current: CurrentValues,
): ParsedEconomics {
	const amountRaw = (readString(values.amount) ?? "").trim();
	const currencyRaw = (readString(values.currency) ?? "").trim().toUpperCase();
	const rateRaw = (readString(values.ratePercent) ?? "").trim();
	// `cap` is one of the four bounds behind the EDIT form's disclosure. On
	// CREATE it is an ordinary visible field and `current.cap` is `""`, so both
	// branches collapse to the plain field read this used to be.
	const capRaw = submittedOr(
		values,
		"cap",
		current.cap,
		mode === "create" || limitsDisclosed(values),
	);

	if (type === "fixed_amount") {
		if (rateRaw.length > 0 || capRaw.length > 0) {
			return {
				ok: false,
				message: "Leave the percentage-only fields (rate, cap) blank for a fixed_amount coupon.",
			};
		}
		const amountCents = parseMinorUnitsInput(amountRaw, { allowZero: false });
		if (amountCents === null) {
			return {
				ok: false,
				message:
					"Amount off must be a positive number like 5.00 (up to two decimal places) — a fixed_amount coupon cannot leave it unset.",
			};
		}
		let currency: string | null = null;
		if (mode === "create") {
			if (!/^[A-Z]{3}$/.test(currencyRaw)) {
				return { ok: false, message: "Currency must be a 3-letter ISO-4217 code like USD." };
			}
			currency = currencyRaw;
		}
		return { ok: true, amountCents, rateBps: null, capCents: null, currency };
	}

	// percentage
	if (amountRaw.length > 0 || (mode === "create" && currencyRaw.length > 0)) {
		return {
			ok: false,
			message:
				"Leave the fixed-amount-only fields (amount, currency) blank for a percentage coupon.",
		};
	}
	const rateBps = parsePercentToBps(rateRaw);
	if (rateBps === null || rateBps === 0) {
		return {
			ok: false,
			message:
				"Rate must be a positive percent like 10 or 7.25 (up to two decimal places) — a percentage coupon cannot leave it unset.",
		};
	}
	let capCents: number | null = null;
	if (capRaw.length > 0) {
		capCents = parseMinorUnitsInput(capRaw, { allowZero: false });
		if (capCents === null) {
			return {
				ok: false,
				message: "Discount cap must be a positive number like 20.00, or blank for no cap.",
			};
		}
	}
	return { ok: true, amountCents: null, rateBps, capCents, currency: null };
}

interface SharedFields {
	minSubtotalCents: number | null;
	startsAt: string | null;
	expiresAt: string | null;
	maxUses: number | null;
	maxUsesPerCustomer: number | null;
}

type ParsedShared = { ok: true; fields: SharedFields } | { ok: false; message: string };

/** Parse the type-independent fields. Blank = unset/null on every one; ABSENT
 *  = unchanged, from the carried current (see {@link submittedOr}). Only the
 *  EDIT form authors these — the create form omits them entirely, so a freshly
 *  created coupon is valid immediately, forever, unlimited and unrestricted
 *  (§12.2). */
function parseSharedFields(values: Record<string, unknown>, current: CurrentValues): ParsedShared {
	// Three of the four gated bounds live here; the window fields above them are
	// always visible, so only these read the disclosure.
	const disclosed = limitsDisclosed(values);
	const minSubtotalRaw = submittedOr(values, "minSubtotal", current.minSubtotal, disclosed);
	let minSubtotalCents: number | null = null;
	if (minSubtotalRaw.length > 0) {
		minSubtotalCents = parseMinorUnitsInput(minSubtotalRaw, { allowZero: true });
		if (minSubtotalCents === null) {
			return {
				ok: false,
				message: "Minimum spend must be a number like 35.00, or blank for none.",
			};
		}
	}
	const startsAt = resolveBound(values, "startsAt", current.startsAt, "start");
	if (startsAt.ok === false) {
		return { ok: false, message: `Starts at ${DATE_HINT}` };
	}
	const expiresAt = resolveBound(values, "expiresAt", current.expiresAt, "end");
	if (expiresAt.ok === false) {
		return { ok: false, message: `Expires at ${DATE_HINT}` };
	}
	if (startsAt.value !== null && expiresAt.value !== null && startsAt.value >= expiresAt.value) {
		return { ok: false, message: "Expires at must be on or after starts at." };
	}
	const maxUses = parseCountInput(submittedOr(values, "maxUses", current.maxUses, disclosed));
	if (maxUses.ok === false) {
		return {
			ok: false,
			message: "Max uses must be a whole number of 1 or more, or blank for unlimited.",
		};
	}
	const maxUsesPerCustomer = parseCountInput(
		submittedOr(values, "maxUsesPerCustomer", current.maxUsesPerCustomer, disclosed),
	);
	if (maxUsesPerCustomer.ok === false) {
		return {
			ok: false,
			message: "Max uses per customer must be a whole number of 1 or more, or blank for unlimited.",
		};
	}
	return {
		ok: true,
		fields: {
			minSubtotalCents,
			startsAt: startsAt.value,
			expiresAt: expiresAt.value,
			maxUses: maxUses.value,
			maxUsesPerCustomer: maxUsesPerCustomer.value,
		},
	};
}

const DATE_HINT = "must be a date like 2026-08-01.";

/** What a `date_input` submits: a DAY, not an instant. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A window bound, from whatever the form submitted plus the instant it carried.
 * Four cases, in order:
 *
 *  - NEVER SUBMITTED ⇒ the carried instant, unchanged. A key that IS present
 *    but is not a string is a different thing entirely and is REFUSED: the
 *    operator gets a banner naming the field, never a save that silently
 *    reports success while quietly meaning "unchanged".
 *  - BLANK ⇒ `null`, no bound — the explicit unset.
 *  - THE DAY THE CARRIED INSTANT ALREADY FALLS ON ⇒ that instant, BYTE FOR
 *    BYTE. A `date_input` shows days, so re-submitting the day it was already
 *    showing is not an edit, and an untouched save must never move a bound the
 *    screen only ever displayed to day precision.
 *  - ANY OTHER DAY ⇒ that day's own EDGE: a start OPENS at `00:00:00.000Z`, an
 *    expiry CLOSES at `23:59:59.999Z`. Not cosmetic. The domain's window is
 *    `[startsAt, expiresAt)` — the end bound is EXCLUSIVE (`validateCoupon`) —
 *    so an expiry pinned to midnight would retire the code at the START of the
 *    day the operator picked: a full day early, and a day earlier than this
 *    screen's own `Valid` reading claims.
 *
 * PRESERVATION BEATS REPAIR, AND THAT HAS A COST WORTH NAMING. A record
 * written before this change holds a midnight expiry, which under the exclusive
 * end bound still retires the code at the start of its stated day. Re-saving
 * the coupon untouched will NOT quietly repair it — the third case above sees
 * the same day and keeps the same instant — so correcting a legacy bound takes
 * a deliberate two-save dance: move the date off the day, save, move it back,
 * save. That is the right trade: an untouched save silently rewriting a stored
 * instant is exactly the class of surprise this leaf exists to remove, and a
 * repair that only fires when the operator did nothing is indistinguishable
 * from the data loss it would be if the heuristic were ever wrong.
 *
 * A full ISO datetime still parses and is still NORMALIZED to ISO-8601 UTC:
 * the wire is untrusted, older records hold one, and `validateCoupon` compares
 * these strings LEXICOGRAPHICALLY, so a non-ISO shape would mis-order silently.
 */
function resolveBound(
	values: Record<string, unknown>,
	key: string,
	current: string | null,
	edge: "start" | "end",
): { ok: true; value: string | null } | { ok: false } {
	const raw = readString(values[key]);
	if (raw === undefined) {
		// Absent ⇒ unchanged. PRESENT-but-not-a-string ⇒ refuse: silently reading
		// a `null`/number/array as "the operator changed nothing" would answer a
		// question nobody asked, and on a full-replace form the operator has no
		// way to tell that from a save that did what they meant.
		return values[key] === undefined ? { ok: true, value: current } : { ok: false };
	}
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { ok: true, value: null };
	if (current !== null && trimmed === current.slice(0, 10)) return { ok: true, value: current };
	if (DAY_PATTERN.test(trimmed)) {
		const at = `${trimmed}T${edge === "start" ? "00:00:00.000" : "23:59:59.999"}Z`;
		// The shape is not the check. `2026-13-45` fails to parse at all, but
		// `2026-02-30` PARSES — into 2 March — so a bare `Number.isNaN` guard
		// would store a day that does not exist verbatim, and it would then sort
		// after every real day in February. Only a string that survives
		// `parse → toISOString` unchanged is a real, canonical instant.
		return isCanonicalInstant(at) ? { ok: true, value: at } : { ok: false };
	}
	const t = Date.parse(trimmed);
	if (Number.isNaN(t)) return { ok: false };
	return { ok: true, value: new Date(t).toISOString() };
}

/** Whether `iso` survives `Date.parse` → `toISOString` unchanged — the only
 *  test that distinguishes a real instant from a merely parseable one (see
 *  {@link carriedInstant} and {@link resolveBound}). */
function isCanonicalInstant(iso: string): boolean {
	const t = Date.parse(iso);
	return !Number.isNaN(t) && new Date(t).toISOString() === iso;
}

/** Parse a use-count bound. Blank ⇒ null (unlimited); else a whole number
 *  ≥ 1 (a 0-use coupon is dead on arrival — reject rather than mint one). */
function parseCountInput(raw: string): { ok: true; value: number | null } | { ok: false } {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { ok: true, value: null };
	if (!/^\d+$/.test(trimmed)) return { ok: false };
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isSafeInteger(n) || n < 1) return { ok: false };
	return { ok: true, value: n };
}

// -- custom action: create a coupon --------------------------------------------

function createCouponAction() {
	return customAction<AdminRulesClient, CouponsRenderState>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		// EVERY refusal below re-renders the create screen with this draft
		// (DA-3a-i): the operator fixes the one field that was wrong instead of
		// retyping seven. Raw text, exactly as submitted — see CouponsRenderState.
		const draft = couponDraft(values);
		const err = (description: string) =>
			showList(
				undefined,
				{ variant: "error", title: "Coupon not created", description },
				{ kind: "new-coupon", draft },
			);
		const id = (readString(values.id) ?? "").trim();
		const code = (readString(values.code) ?? "").trim();
		const type = readString(values.type) ?? "";
		if (id.length === 0 || code.length === 0) {
			return err("Enter both a coupon ID and a code.");
		}
		if (type !== "fixed_amount" && type !== "percentage") {
			return err("Choose a valid coupon type.");
		}
		const econ = parseEconomics(type, values, "create", NO_CURRENT);
		if (!econ.ok) return err(econ.message);
		// The five shared axes have no field on this form (§12.2) — a freshly
		// created coupon is valid immediately, forever, unlimited, unrestricted.
		const result = await client.createCoupon({
			id,
			code,
			type,
			amountCents: econ.amountCents,
			rateBps: econ.rateBps,
			capCents: econ.capCents,
			currency: econ.currency,
			minSubtotalCents: null,
			startsAt: null,
			expiresAt: null,
			maxUses: null,
			maxUsesPerCustomer: null,
		});
		// A SERVICE refusal keeps the draft too (a duplicate id is fixed by
		// editing one field); success drops it, which is what returns the
		// operator to the list.
		return result.ok
			? showList(undefined, createCouponNotice(result, code))
			: showList(undefined, createCouponNotice(result, code), { kind: "new-coupon", draft });
	});
}

/** The submitted create values, verbatim and untrimmed — the operator's own
 *  text is what goes back into the form (DA-3a-iii property 5). */
function couponDraft(values: Record<string, unknown>): CouponDraft {
	return {
		id: readString(values.id) ?? "",
		code: readString(values.code) ?? "",
		type: readString(values.type) ?? "",
		amount: readString(values.amount) ?? "",
		currency: readString(values.currency) ?? "",
		ratePercent: readString(values.ratePercent) ?? "",
		cap: readString(values.cap) ?? "",
	};
}

function createCouponNotice(result: RulesCreateResult<unknown>, code: string): Notice {
	if (result.ok) {
		return {
			variant: "default",
			title: "Coupon created",
			description: `"${code}" was added and is live per its validity window.`,
		};
	}
	return {
		variant: "error",
		title: "Coupon not created",
		description: `Could not create "${code}" — check the coupon ID and code aren't already in use, then try again.`,
	};
}

// -- custom action: save a coupon (LWW full replace) ----------------------------

function saveCouponAction() {
	return customAction<AdminRulesClient>(async ({ input, carried, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const couponId = carried?.couponId;
		const code = carried?.code;
		const type = carried?.type;
		if (
			couponId === undefined ||
			code === undefined ||
			(type !== "fixed_amount" && type !== "percentage")
		) {
			return showList(undefined, {
				variant: "error",
				title: "Coupon not saved",
				description: "That action could not be read — nothing was changed. Reload and try again.",
			});
		}
		const err = (description: string) =>
			showLeaf([code], { variant: "error", title: "Coupon not saved", description });
		// The coupon's current optional values, as the form itself carried them —
		// the fallback that keeps a field which never reached this submit
		// (a `condition`-hidden bound) at the value it was hiding.
		const current = currentValues(carried);
		const econ = parseEconomics(type, values, "edit", current);
		if (!econ.ok) return err(econ.message);
		const shared = parseSharedFields(values, current);
		if (!shared.ok) return err(shared.message);
		// EVERY editable key, explicitly — the inactive type's economics as
		// explicit nulls (they are inapplicable-null by construction; type is
		// immutable). Never rely on the wire's omit⇒null coercion.
		const edit: CouponEdit = {
			amountCents: econ.amountCents,
			rateBps: econ.rateBps,
			capCents: econ.capCents,
			...shared.fields,
		};
		const result = await client.updateCoupon(couponId, edit);
		return saveCouponOutcome(result, code, showLeaf, showList);
	});
}

function saveCouponOutcome(
	result: RulesUpdateResult<unknown>,
	code: string,
	showLeaf: CustomActionApi<AdminRulesClient>["showLeaf"],
	showList: CustomActionApi<AdminRulesClient>["showList"],
) {
	if (result.ok) {
		return showLeaf([code], {
			variant: "default",
			title: "Coupon saved",
			description:
				"Every field was replaced with the submitted values (last write wins). Orders already placed keep their snapshotted discount.",
		});
	}
	if (result.reason === "not_found") {
		return showList(undefined, {
			variant: "error",
			title: "Coupon not found",
			description: "This coupon no longer exists — it may have been deleted.",
		});
	}
	return showLeaf([code], {
		variant: "error",
		title: "Coupon not saved",
		description:
			"The change could not be saved — check the service connection and the admin token in Settings.",
	});
}

// -- custom action: delete a coupon (forbid-if-redeemed) ------------------------

function deleteCouponAction() {
	return customAction<AdminRulesClient>(async ({ input, client, showLeaf, showList }) => {
		const payload = asRecord(input.value);
		const couponId = readString(payload?.couponId);
		const code = readString(payload?.code);
		if (couponId === undefined || code === undefined) return showList();
		const result = await client.deleteCoupon(couponId);
		return deleteCouponOutcome(result, code, showLeaf, showList);
	});
}

function deleteCouponOutcome(
	result: RulesDeleteResult,
	code: string,
	showLeaf: CustomActionApi<AdminRulesClient>["showLeaf"],
	showList: CustomActionApi<AdminRulesClient>["showList"],
) {
	if (result.ok) {
		return showList(undefined, {
			variant: "default",
			title: "Coupon deleted",
			description: `"${code}" was removed. In-flight carts recompute without it; orders already placed keep their snapshotted discount.`,
		});
	}
	if (result.reason === "not_found") {
		return showList(undefined, {
			variant: "default",
			title: "Already deleted",
			description: "This coupon was already removed.",
		});
	}
	if (result.reason === "in_use") {
		return showLeaf([code], {
			variant: "error",
			title: "Coupon not deleted",
			description:
				"This coupon has been redeemed — deletion is blocked to preserve the redemption audit trail. To retire it, set its expiry to a past date instead.",
		});
	}
	return showLeaf([code], {
		variant: "error",
		title: "Coupon not deleted",
		description:
			"The coupon could not be deleted — check the service connection and the admin token in Settings.",
	});
}

// -- custom actions: open and leave the create screen ---------------------------

/** INC-14's promoted button, and E-2's empty-state button — one verb, because
 *  they are one act. No draft: nothing has been typed yet. */
function newCouponAction() {
	return customAction<AdminRulesClient, CouponsRenderState>(async ({ showList }) => {
		return showList(undefined, undefined, { kind: "new-coupon" });
	});
}

/** "← Back to coupons": the root list with NO render state. Whatever was typed
 *  is dropped — deliberately, and only ever by this explicit click. */
function cancelNewCouponAction() {
	return customAction<AdminRulesClient, CouponsRenderState>(async ({ showList }) => showList());
}

// -- small shared helpers --------------------------------------------------------

/** A `fields` block from label/value PAIRS, so an odd entry count is visible
 *  at the call site — `fields` is a row-major `grid-cols-2` (R-3). */
function fields(blockId: string, entries: ReadonlyArray<readonly [string, string]>): FieldsBlock {
	return {
		type: "fields",
		block_id: blockId,
		fields: entries.map(([label, value]) => ({ label, value })),
	};
}

/** Trim a string to `max`, ellipsis included — for the one place a rendered
 *  string's length depends on SERVICE DATA (the Edit accordion's label, which
 *  carries the coupon's own discount/window summary and could otherwise blow
 *  §1's 60-char accordion-label budget). */
function fit(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function fitLabel(text: string): string {
	return fit(text, LABEL_BUDGET);
}

/** An absolute UTC timestamp TRIMMED TO SECONDS (M-6): milliseconds are noise.
 *  No timezone conversion, ever. */
function utc(iso: string): string {
	return iso.replace(/\.\d+(?=Z$)/, "");
}
