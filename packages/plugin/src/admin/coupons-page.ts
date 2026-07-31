import { COMMERCE_SERVICE_BASE_URL } from "../manifest.js";
import { formatMoney } from "../presentation/format-money.js";
import { cents as toCents, currency as toCurrency } from "../presentation/money.js";
import type {
	ActionsBlock,
	AdminPageConfig,
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
	createListDetailHandler,
	customAction,
	decodePath,
	emptyState,
	encodePath,
	failClosedResponse,
	filterPanel,
	filterSummary,
	leafLevel,
	listLevel,
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
 * The detail is `header` + back + notice + the 6-entry identity strip, then
 * TWO task-named panels — `Coupon` · `Redemptions` (D-2, D-2a: a would-be
 * `History` panel would hold only Created, which lives in the identity strip
 * instead) — whose one named group (`Edit`) is an `accordion`.
 *
 * WHY THIS SCREEN HAS NO RENDER-STATE CHANNEL FOR DA-3. Every destructive/
 * risky write here is DA-2 (delete: no input, forbid-if-redeemed) or DA-4
 * (create/save: plain forms, no confirm) — there is no free-text-or-typed-
 * amount flow that would need DA-3's stage/confirm shape, so this screen
 * carries none of Orders' refusal machinery. It DOES use the render-state
 * channel once, for a NON-DA-3 purpose the spec also assigns it (B-6, E-2):
 * forcing the "New coupon" group open from the empty state's own button
 * without discarding the operator's typed input in any other group. See
 * {@link CouponsRenderState}.
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
/** Fired by the empty state's "New coupon" button (E-2) — forces the create
 *  group open on the re-rendered list. Not a DA-3 verb; see the module doc. */
const ACTION_NEW = COUPON_ACTIONS.custom("new");

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
 * One member: the empty state's "New coupon" button re-renders the list with
 * `renderState: {kind:"new-coupon"}`, and {@link createCouponAccordion} is the
 * one place that reads it, changing the accordion's `block_id` AND setting
 * `default_open: true` together (B-6 — either alone is wrong: the flag alone
 * does nothing to an already-mounted accordion, and the id alone renders
 * collapsed because the remount re-reads `default_open`, which defaults to
 * `false`).
 */
type CouponsRenderState = { kind: "new-coupon" };

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
		render({ actions, path, filter, items, nextToken, notice, renderState }) {
			return couponsBlocks(actions, path, filter, items, nextToken, notice, renderState);
		},
		onError: () => couponsFailClosed(),
	});
}

function toClientFilter(form: CouponsFilterForm): CouponsListFilter {
	return form.search !== undefined ? { search: form.search } : {};
}

/**
 * §12.2's list skeleton, exactly: `header` · one `context` (≤140) · notice
 * `banner` · the INLINE one-field search (L-2: at 1 field it renders directly,
 * no accordion) · the active-filter `section` · THE DATA (table, or `empty` in
 * its place) · the "Open coupon" drill-in · the "New coupon" create accordion.
 * Nothing else may precede the table (P-1/L-1).
 */
function couponsBlocks(
	actions: ScreenActions,
	path: NavPath,
	filter: CouponsFilterForm,
	coupons: CouponSummaryWire[],
	nextToken: string | undefined,
	notice: Notice | undefined,
	renderState: CouponsRenderState | undefined,
): Block[] {
	const blocks: Block[] = [
		{ type: "header", text: "Coupons", block_id: "coupons:hdr" },
		{
			type: "context",
			// 78 chars ≤ 140 (§1).
			text: "Search a coupon and open it. Discounts apply to the cart subtotal at checkout.",
		},
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));

	// ONE part for the screen's one authored filter field (L-3).
	const activeFilters = [filter.search !== undefined && `code: ${filter.search}`];
	blocks.push(
		filterPanel({
			form: searchForm(actions, path, filter),
			blockId: "coupons:filters",
			activeFilters,
			// 1 field ≤ the default inline threshold (2) — renders directly, no
			// accordion (L-2).
		}),
	);
	const summary = filterSummary(activeFilters);
	if (summary !== undefined) {
		blocks.push({
			type: "section",
			text: summary,
			// The path rides in `value`, NOT `block_id` — a button echoes no
			// `block_id` (L-6, B-1).
			accessory: {
				type: "button",
				action_id: actions.applyFilter,
				label: "Clear filters",
				value: { [PATH_FIELD]: encodePath(path) },
			},
			block_id: "coupons:filter-summary",
		});
	}

	const filtered = summary !== undefined;
	if (coupons.length === 0 && !filtered) {
		// E-2: the primary collection at its TRUE zero state. The table is
		// OMITTED and `empty` renders in its place, with the create affordance in
		// `empty.actions` — its handler re-renders THIS list with the create
		// group forced open (B-6), which is why that group still has to exist
		// below regardless of row count (L-8).
		blocks.push(
			emptyState({
				title: "No coupons yet",
				description: "Create one to start discounting carts.",
				size: "base",
				actions: [{ type: "button", action_id: ACTION_NEW, label: "New coupon", value: {} }],
				blockId: "coupons:empty",
			}),
		);
	} else {
		blocks.push(couponsTable(coupons, nextToken));
	}
	if (coupons.length > 0) blocks.push(openCouponForm(actions, path, coupons));
	blocks.push(createCouponAccordion(renderState));
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
function couponsTable(coupons: CouponSummaryWire[], nextToken: string | undefined): TableBlock {
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
		empty_text: "No coupon matches that code.",
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
 * The create group (L-8): closed by default, forced open (B-6: changed
 * `block_id` AND `default_open: true`) when `renderState` says the empty
 * state's own button fired (E-2). Always rendered, regardless of row count,
 * so there is a group for that button to force open.
 */
function createCouponAccordion(renderState: CouponsRenderState | undefined): Block {
	const forceOpen = renderState?.kind === "new-coupon";
	return {
		type: "accordion",
		block_id: forceOpen ? "coupons:new:opened" : "coupons:new",
		label: "New coupon",
		default_open: forceOpen,
		blocks: [
			{
				type: "context",
				// 108 chars ≤ 200.
				text: "ID, code, type and currency are fixed at creation — to change them, retire this coupon and issue a new code.",
			},
			createCouponForm(),
		],
	};
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
 */
function createCouponForm(): FormBlock {
	const typeOptions: SelectOption[] = [
		{ value: "fixed_amount", label: "Fixed amount off" },
		{ value: "percentage", label: "Percentage off" },
	];
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
				{ type: "text_input", action_id: "id", label: "Coupon ID", placeholder: "e.g. summer25" },
				{ type: "text_input", action_id: "code", label: "Code", placeholder: "e.g. SUMMER25" },
				{
					type: "select",
					action_id: "type",
					label: "Type",
					options: typeOptions,
					initial_value: "fixed_amount", // required for `condition` to evaluate (R-12b)
				},
				{
					type: "text_input",
					action_id: "amount",
					label: "Amount off",
					placeholder: "5.00",
					condition: { field: "type", eq: "fixed_amount" },
				},
				{
					type: "text_input",
					action_id: "currency",
					label: "Currency (ISO-4217)",
					placeholder: "USD",
					condition: { field: "type", eq: "fixed_amount" },
				},
				{
					type: "text_input",
					action_id: "ratePercent",
					label: "Rate (%)",
					placeholder: "7.25",
					condition: { field: "type", eq: "percentage" },
				},
				{
					type: "text_input",
					action_id: "cap",
					label: "Discount cap (optional)",
					placeholder: "20.00",
					condition: { field: "type", eq: "percentage" },
				},
			],
			submit: { label: "Create coupon", action_id: ACTION_CREATE },
		},
	});
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
 * §12.2's detail skeleton: `header` · back · notice · the 6-entry identity
 * strip · TWO constant task-named panels — `Coupon` · `Redemptions` (D-2).
 * Coupons have no reconcile/fulfilment concept, so D-5's rank-3 "named
 * primary edit group" is the only rank that can ever fire — and it always
 * does, because a loaded coupon (no soft-delete/tombstone concept) is always
 * editable: the `Edit` group is `default_open: true` on every render.
 */
function detailBlocks(
	actions: ScreenActions,
	path: NavPath,
	code: string,
	detail: CouponSummaryWire,
	notice: Notice | undefined,
): Block[] {
	const blocks: Block[] = [
		// M-10: the coupon's CODE is its human handle, so it is the header — the
		// internal `id` never needs its own display row.
		{ type: "header", text: `Coupon — ${code}` },
		backButton(actions.back, "← Back to coupons", path),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push(
		fields("coupons:identity", [
			["Code", detail.code],
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
		// D-6: the label carries the answer that makes opening it unnecessary.
		label: fitLabel(
			`Edit — ${couponDiscountSummary(detail)} · ${couponWindowSummary(detail.startsAt, detail.expiresAt)}`,
		),
		// D-5 rank 3: always true — a loaded coupon has no tombstone/terminal
		// state, so it is always editable, and Coupons has no rank 1/2 group to
		// lose the slot to.
		default_open: true,
		blocks: [
			{
				type: "context",
				// 116 chars ≤ 200, trimmed from the former 613-char paragraph.
				text: "Saving replaces every field below — this is a full replace, so a blank optional field saves as unset, not unchanged.",
			},
			editCouponForm(detail),
		],
	};
}

/**
 * The full-replace edit form. EVERY editable field is pre-filled (unset ⇒
 * blank); only the coupon's OWN type's economics fields are authored (the
 * other type's are inapplicable-null by construction — `type` is immutable —
 * and are hard-nulled on save, never relying on the wire's omit⇒null
 * coercion). `couponId`/`code`/`type` ride invisibly in the carrier (F-2); B-3's
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
		editFields.push({
			type: "text_input",
			action_id: "cap",
			label: "Discount cap (optional)",
			...(detail.capCents !== null
				? { initial_value: formatMinorUnitsInput(detail.capCents) }
				: {}),
		});
	}
	editFields.push({
		type: "text_input",
		action_id: "minSubtotal",
		label: "Minimum spend (optional)",
		...(detail.minSubtotalCents !== null
			? { initial_value: formatMinorUnitsInput(detail.minSubtotalCents) }
			: {}),
	});
	editFields.push({
		type: "text_input",
		action_id: "startsAt",
		label: "Starts at (optional)",
		placeholder: "2026-08-01T00:00:00Z",
		...(detail.startsAt !== null ? { initial_value: detail.startsAt } : {}),
	});
	editFields.push({
		type: "text_input",
		action_id: "expiresAt",
		label: "Expires at (optional)",
		placeholder: "2026-09-01T00:00:00Z",
		...(detail.expiresAt !== null ? { initial_value: detail.expiresAt } : {}),
	});
	editFields.push({
		type: "text_input",
		action_id: "maxUses",
		label: "Max uses (optional)",
		...(detail.maxUses !== null ? { initial_value: String(detail.maxUses) } : {}),
	});
	editFields.push({
		type: "text_input",
		action_id: "maxUsesPerCustomer",
		label: "Max uses per customer (optional)",
		...(detail.maxUsesPerCustomer !== null
			? { initial_value: String(detail.maxUsesPerCustomer) }
			: {}),
	});
	return carriedForm({
		namespace: "coupons:edit",
		context: { couponId: detail.id, code: detail.code, type: detail.type },
		form: {
			type: "form",
			fields: editFields,
			submit: { label: "Save coupon", action_id: ACTION_SAVE },
		},
	});
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
): ParsedEconomics {
	const amountRaw = (readString(values.amount) ?? "").trim();
	const currencyRaw = (readString(values.currency) ?? "").trim().toUpperCase();
	const rateRaw = (readString(values.ratePercent) ?? "").trim();
	const capRaw = (readString(values.cap) ?? "").trim();

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

/** Parse the type-independent fields (blank = unset/null on every one). Only
 *  the EDIT form authors these — the create form omits them entirely, so a
 *  freshly created coupon is valid immediately, forever, unlimited and
 *  unrestricted (§12.2). */
function parseSharedFields(values: Record<string, unknown>): ParsedShared {
	const minSubtotalRaw = (readString(values.minSubtotal) ?? "").trim();
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
	const startsAt = parseIsoInput(readString(values.startsAt) ?? "");
	if (startsAt.ok === false) {
		return { ok: false, message: `Starts at ${ISO_HINT}` };
	}
	const expiresAt = parseIsoInput(readString(values.expiresAt) ?? "");
	if (expiresAt.ok === false) {
		return { ok: false, message: `Expires at ${ISO_HINT}` };
	}
	if (startsAt.value !== null && expiresAt.value !== null && startsAt.value >= expiresAt.value) {
		return { ok: false, message: "Expires at must be after starts at." };
	}
	const maxUses = parseCountInput(readString(values.maxUses) ?? "");
	if (maxUses.ok === false) {
		return {
			ok: false,
			message: "Max uses must be a whole number of 1 or more, or blank for unlimited.",
		};
	}
	const maxUsesPerCustomer = parseCountInput(readString(values.maxUsesPerCustomer) ?? "");
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

const ISO_HINT = "must be an ISO 8601 date or date-time like 2026-08-01 or 2026-08-01T00:00:00Z.";

/**
 * Parse a merchant-entered date bound. Blank ⇒ null (open bound). A parseable
 * value is NORMALIZED to full ISO-8601 UTC (`toISOString`) — load-bearing,
 * not cosmetic: the domain's `validateCoupon` compares the stored string
 * LEXICOGRAPHICALLY against an ISO-UTC `now`, so a non-ISO shape would
 * mis-order silently.
 */
function parseIsoInput(raw: string): { ok: true; value: string | null } | { ok: false } {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { ok: true, value: null };
	const t = Date.parse(trimmed);
	if (Number.isNaN(t)) return { ok: false };
	return { ok: true, value: new Date(t).toISOString() };
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
	return customAction<AdminRulesClient>(async ({ input, client, showList }) => {
		const values = input.values ?? {};
		const err = (description: string) =>
			showList(undefined, { variant: "error", title: "Coupon not created", description });
		const id = (readString(values.id) ?? "").trim();
		const code = (readString(values.code) ?? "").trim();
		const type = readString(values.type) ?? "";
		if (id.length === 0 || code.length === 0) {
			return err("Enter both a coupon ID and a code.");
		}
		if (type !== "fixed_amount" && type !== "percentage") {
			return err("Choose a valid coupon type.");
		}
		const econ = parseEconomics(type, values, "create");
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
		return showList(undefined, createCouponNotice(result, code));
	});
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
		const econ = parseEconomics(type, values, "edit");
		if (!econ.ok) return err(econ.message);
		const shared = parseSharedFields(values);
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

// -- custom action: force the "New coupon" group open from the empty state -----

/** E-2's empty-state button (B-6). Not a DA-3 verb — see the module doc for
 *  why this screen's only render-state use is this one, non-destructive case. */
function newCouponAction() {
	return customAction<AdminRulesClient, CouponsRenderState>(async ({ showList }) => {
		return showList(undefined, undefined, { kind: "new-coupon" });
	});
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
