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
	RouteHandler,
	SelectOption,
	TableBlock,
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
	createListDetailHandler,
	customAction,
	decodePath,
	encodePath,
	failClosedResponse,
	leafLevel,
	listLevel,
	noticeBanner,
	readAdminTokens,
	readString,
	screenActions,
	type CustomActionApi,
	type ListDetailInput,
	type Notice,
	type ScreenActions,
} from "./scaffold/index.js";

/**
 * The admin Coupons console page (admin-UX Increment 3, slice 4 — "coupon
 * management"): a 2-level scaffold screen — the keyset-paged coupons list
 * (search = case-insensitive EXACT code match, the list capability PR #74
 * added) drilling into a per-coupon detail/edit LEAF (the first rules screen
 * with a true leaf level — tax/shipping are list-into-list). Rendered by the
 * single `admin` dispatch route (`admin-route.ts`), built on the shared
 * list/detail scaffold and `AdminRulesClient`. Percentage math reuses the
 * shared `percent-input` exact-integer bps parser/formatter (extracted from
 * the Tax console at this second consumer); money reuses the shared
 * `money-input` helper (never a float, never `number_input`).
 *
 * UNCHANGED-vs-CLEAR, presented honestly (the crux of this screen): coupon
 * UPDATE is the documented LWW exception (PR #71 / `CouponStore.update`) and
 * its wire is a FULL REPLACEMENT — the service coerces every omitted field to
 * null before the store call, so the wire genuinely cannot say "leave this
 * field alone". This screen therefore never pretends it can: the edit form
 * pre-fills EVERY editable field with the coupon's current value and always
 * submits ALL of them (explicit null for a blanked field, never relying on
 * omission). "Leave unchanged" = don't touch the pre-fill; "clear" = blank
 * the field — and the form's own copy says exactly that. The one axis with no
 * "unset" is the coupon's primary economic value (`amount` for fixed_amount,
 * `rate` for percentage — the domain throws on a fixed coupon without an
 * amount), so blanking it is a boundary error, not a null.
 *
 * IMMUTABLE identity/kind, presented honestly: `id`, `code`, `type` and (for
 * fixed_amount) `currency` are fixed at creation — `CouponEdit` cannot carry
 * them ("a merchant supersedes a live promotion with a NEW code, never
 * re-defines an issued one" — the port doc). They render as read-only detail
 * fields, never as editable inputs.
 *
 * DELETE is forbid-if-redeemed: one redemption blocks deletion forever (the
 * redemption audit trail must keep resolving to its coupon). The detail
 * withholds the delete button from a redeemed coupon and says why; the
 * server-side atomic guard remains the source of truth for the race where a
 * redemption lands after render — that 409 renders the same honest copy.
 */
export const COUPONS_PAGE: AdminPageConfig = { path: "/coupons", label: "Coupons", icon: "tag" };

/** This screen's namespaced action ids — the four scaffold nav verbs plus the
 *  coupon side-effecting verbs. */
const COUPON_ACTIONS: ScreenActions = screenActions("coupons");
const ACTION_CREATE = COUPON_ACTIONS.custom("create");
const ACTION_SAVE = COUPON_ACTIONS.custom("save");
const ACTION_DELETE = COUPON_ACTIONS.custom("delete");

/**
 * The action ids the admin-route dispatcher recognizes as belonging to the
 * Coupons console. Every `block_action`/`form_submit` this page can emit is
 * namespaced `coupons:*` and listed here, so none falls through the
 * dispatcher to the `{blocks:[]}` dead-end.
 */
export const COUPONS_ACTION_IDS: ReadonlySet<string> = COUPON_ACTIONS.actionIds(
	"create",
	"save",
	"delete",
);

/** The em-dash BlockInteraction envelope this page consumes (the scaffold's
 *  input shape — `type`/`action_id`/`values`/`value`). */
export type CouponsPageInput = ListDetailInput;

/** The list's filter form: `search` is the ONLY axis the service ships — a
 *  case-insensitive EXACT match on `code`, never a substring. */
interface CouponsFilterForm {
	search?: string;
}

/** Matches the service's default page size (`couponsListQuery` limit default). */
const PAGE_LIMIT = 25;

export function createCouponsPageHandler(): RouteHandler<CouponsPageInput> {
	return createListDetailHandler({
		actions: COUPON_ACTIONS,
		async createClient(ctx) {
			const tokens = await readAdminTokens(ctx);
			return new AdminRulesClient({
				fetch: ctx.http.fetch,
				baseUrl: COMMERCE_SERVICE_BASE_URL,
				...tokens,
			});
		},
		// The list's "Open coupon" form submits the encoded one-deep target path
		// (`[code]`) in `values.target` — the code, not the id, because the only
		// read that returns the FULL editable projection (incl. the window) is
		// the exact-code list search (see `couponDetailLevel().load`).
		parseOpen(input) {
			const encoded = readString(input.values?.target);
			const targetPath = encoded === undefined ? null : decodePath(encoded);
			return targetPath === null ? undefined : { targetPath };
		},
		levels: [couponsListLevel(), couponDetailLevel()],
		customActions: {
			[ACTION_CREATE]: createCouponAction(),
			[ACTION_SAVE]: saveCouponAction(),
			[ACTION_DELETE]: deleteCouponAction(),
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

/** `usesCount / maxUses` — `usesCount` doubles as the cheap "has this been
 *  redeemed" indicator (deletion is blocked once it is nonzero). */
export function couponUsesSummary(usesCount: number, maxUses: number | null): string {
	return `${usesCount} / ${maxUses === null ? "∞" : maxUses}`;
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

/** A hidden single-option carrier (the scaffold's proven pattern, e.g.
 *  `tax-page.ts`'s `hiddenCarrier`) that threads one value through a
 *  stateless `form_submit`. */
function hiddenCarrier(actionId: string, value: string): FormBlock["fields"][number] {
	return {
		type: "select",
		action_id: actionId,
		label: actionId,
		options: [{ value, label: value }],
		initial_value: value,
	};
}

// -- level 0: the coupons list -------------------------------------------------

function couponsListLevel() {
	return listLevel<AdminRulesClient, CouponsFilterForm, CouponSummaryWire>({
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
		render({ actions, filter, items, nextToken, notice }) {
			return couponsBlocks(actions, filter, items, nextToken, notice);
		},
		onError: () => couponsFailClosed(),
	});
}

function toClientFilter(form: CouponsFilterForm): CouponsListFilter {
	return form.search !== undefined ? { search: form.search } : {};
}

function couponsBlocks(
	actions: ScreenActions,
	filter: CouponsFilterForm,
	coupons: CouponSummaryWire[],
	nextToken: string | undefined,
	notice: Notice | undefined,
): Block[] {
	const table: TableBlock = {
		type: "table",
		columns: [
			{ key: "code", label: "Code", format: "code" },
			{ key: "type", label: "Type", format: "badge" },
			{ key: "discount", label: "Discount" },
			{ key: "window", label: "Valid" },
			{ key: "uses", label: "Uses" },
		],
		rows: coupons.map((c) => ({
			code: c.code,
			type: c.type,
			discount: couponDiscountSummary(c),
			window: couponWindowSummary(c.startsAt, c.expiresAt),
			uses: couponUsesSummary(c.usesCount, c.maxUses),
		})),
		page_action_id: actions.page,
		...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
		empty_text:
			filter.search !== undefined
				? "No coupon has that code. Search matches a code exactly (case-insensitive), never a substring."
				: "No coupons yet — create one below.",
	};
	const blocks: Block[] = [
		{ type: "header", text: "Coupons" },
		{
			type: "context",
			text: "A coupon discounts the cart subtotal at checkout — fixed_amount takes a set money amount off (in one currency), percentage takes an exact basis-point share (with an optional cap). Money is exact integer minor units, never floating point. A coupon's ID, code, type and currency are fixed at creation: to change those, retire the coupon and issue a new code. Uses counts redemptions — one redemption permanently blocks deletion (the audit trail is preserved).",
		},
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push(searchForm(filter));
	blocks.push(table);
	if (coupons.length > 0) blocks.push(openCouponForm(coupons));
	blocks.push({ type: "divider" });
	blocks.push(createCouponForm());
	return blocks;
}

function searchForm(filter: CouponsFilterForm): FormBlock {
	return {
		type: "form",
		fields: [
			{
				type: "text_input",
				action_id: "search",
				label: "Code (exact match, case-insensitive; blank = all coupons)",
				placeholder: "e.g. SUMMER25",
				...(filter.search !== undefined ? { initial_value: filter.search } : {}),
			},
		],
		submit: { label: "Search", action_id: COUPON_ACTIONS.applyFilter },
	};
}

function openCouponForm(coupons: CouponSummaryWire[]): FormBlock {
	const options: SelectOption[] = coupons.map((c) => ({
		value: encodePath([c.code]),
		label: `${c.code} — ${couponDiscountSummary(c)}`,
	}));
	return {
		type: "form",
		fields: [{ type: "select", action_id: "target", label: "Open coupon", options }],
		submit: { label: "View / edit", action_id: COUPON_ACTIONS.open },
	};
}

function createCouponForm(): FormBlock {
	const typeOptions: SelectOption[] = [
		{ value: "fixed_amount", label: "Fixed amount off" },
		{ value: "percentage", label: "Percentage off" },
	];
	return {
		type: "form",
		fields: [
			{ type: "text_input", action_id: "id", label: "Coupon ID", placeholder: "e.g. summer25" },
			{
				type: "text_input",
				action_id: "code",
				label: "Code (what the buyer enters; immutable once created)",
				placeholder: "e.g. SUMMER25",
			},
			{
				type: "select",
				action_id: "type",
				label: "Type (immutable once created)",
				options: typeOptions,
				initial_value: "fixed_amount",
			},
			{
				type: "text_input",
				action_id: "amount",
				label: "Amount off (fixed_amount only — e.g. 5.00)",
				placeholder: "5.00",
			},
			{
				type: "text_input",
				action_id: "currency",
				label: "Currency (fixed_amount only — ISO-4217, e.g. USD; immutable)",
				placeholder: "USD",
			},
			{
				type: "text_input",
				action_id: "ratePercent",
				label: "Rate (percentage only — %, up to 2 decimals, e.g. 7.25)",
				placeholder: "7.25",
			},
			{
				type: "text_input",
				action_id: "cap",
				label: "Discount cap (percentage only — blank = no cap)",
				placeholder: "20.00",
			},
			{
				type: "text_input",
				action_id: "minSubtotal",
				label: "Minimum spend (blank = none)",
				placeholder: "35.00",
			},
			{
				type: "text_input",
				action_id: "startsAt",
				label: "Starts at (ISO 8601 UTC; blank = immediately)",
				placeholder: "2026-08-01T00:00:00Z",
			},
			{
				type: "text_input",
				action_id: "expiresAt",
				label: "Expires at (ISO 8601 UTC; blank = never)",
				placeholder: "2026-09-01T00:00:00Z",
			},
			{
				type: "text_input",
				action_id: "maxUses",
				label: "Max total uses (blank = unlimited)",
				placeholder: "100",
			},
			{
				type: "text_input",
				action_id: "maxUsesPerCustomer",
				label: "Max uses per customer (blank = unlimited)",
				placeholder: "1",
			},
		],
		submit: { label: "Create coupon", action_id: ACTION_CREATE },
	};
}

function couponsFailClosed() {
	return failClosedResponse({
		header: "Coupons",
		title: "Coupons are unavailable",
		description:
			"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
		toast: "Could not load coupons",
	});
}

// -- level 1: a coupon's detail/edit leaf --------------------------------------

function couponDetailLevel() {
	return leafLevel<AdminRulesClient, CouponSummaryWire>({
		// The detail load is the exact-code LIST search, not `GET /coupons/:code`
		// — deliberately: the point-lookup serialization omits `startsAt`/
		// `expiresAt`, and a full-replace edit form that cannot pre-fill the
		// window would silently CLEAR it on every save. The list projection is
		// the one read that carries every editable field. `search` is an exact
		// case-insensitive match, so 0-or-1 rows is the norm; the exact-code
		// find guards the theoretical case-variant collision.
		async load(client, _path, code) {
			const page = await client.listCoupons({ search: code }, { limit: 2 });
			return page.coupons.find((c) => c.code === code) ?? page.coupons[0] ?? null;
		},
		render({ actions, id, detail, notice }) {
			return detailBlocks(actions, id, detail, notice);
		},
		notFound({ actions, id }) {
			return [
				{ type: "header", text: "Coupon not found" },
				backButton(actions.back, "← Back to coupons"),
				{
					type: "banner",
					variant: "error",
					title: "Coupon not found",
					description: `No coupon matches "${id}" — it may have been deleted.`,
				},
			];
		},
		onError: () =>
			failClosedResponse({
				header: "Coupon",
				title: "This coupon is unavailable",
				description:
					"Could not reach the commerce service. Check the service connection and the admin token in Settings.",
				toast: "Could not load the coupon",
			}),
	});
}

function detailBlocks(
	actions: ScreenActions,
	code: string,
	detail: CouponSummaryWire,
	notice: Notice | undefined,
): Block[] {
	const fields: FieldsBlock = {
		type: "fields",
		fields: [
			{ label: "ID", value: detail.id },
			{ label: "Code", value: detail.code },
			{ label: "Type", value: detail.type },
			{ label: "Discount", value: couponDiscountSummary(detail) },
			{ label: "Currency", value: detail.currency ?? "— (currency-agnostic)" },
			{
				label: "Minimum spend",
				value:
					detail.minSubtotalCents === null
						? "— (none)"
						: formatCentsForDisplay(detail.minSubtotalCents, detail.currency),
			},
			{ label: "Valid", value: couponWindowSummary(detail.startsAt, detail.expiresAt) },
			{ label: "Uses", value: couponUsesSummary(detail.usesCount, detail.maxUses) },
			{ label: "Created", value: detail.createdAt },
		],
	};
	const blocks: Block[] = [
		{ type: "header", text: `Coupon — ${code}` },
		backButton(actions.back, "← Back to coupons", [code]),
	];
	if (notice !== undefined) blocks.push(noticeBanner(notice));
	blocks.push(fields);
	blocks.push({ type: "divider" });
	blocks.push({
		type: "context",
		text: "Saving REPLACES every field below — there is no partial update on the wire, so a blank optional field saves as UNSET (it does not mean \"leave unchanged\"). Fields are pre-filled with the coupon's current values: a field you don't touch is re-saved with its current value; a field you blank is cleared. Edits are last-write-wins (no concurrent-edit protection — the later save replaces the earlier). The redemption count is never editable, and orders already placed keep their snapshotted discount regardless of edits here. Lowering max uses to or below the current redemption count immediately exhausts the coupon.",
	});
	blocks.push(editCouponForm(detail));
	blocks.push({ type: "divider" });
	if (detail.usesCount === 0) {
		blocks.push(deleteCouponActions(detail));
	} else {
		blocks.push({
			type: "context",
			text: `This coupon has been redeemed ${detail.usesCount} time(s) — deletion is blocked to preserve the redemption audit trail. To retire it, set its expiry to a past date (or lower max uses to its current redemption count).`,
		});
	}
	return blocks;
}

/** The full-replace edit form. EVERY editable field is rendered pre-filled
 *  (see the module doc's unchanged-vs-clear note); only the ACTIVE type's
 *  economics fields appear — the other type's fields are inapplicable-null
 *  by construction (type is immutable) and are hard-nulled on save. */
function editCouponForm(detail: CouponSummaryWire): FormBlock {
	const fields: FormBlock["fields"] = [
		hiddenCarrier("couponId", detail.id),
		hiddenCarrier("code", detail.code),
		hiddenCarrier("type", detail.type),
	];
	if (detail.type === "fixed_amount") {
		fields.push({
			type: "text_input",
			action_id: "amount",
			label: `Amount off (${detail.currency ?? "?"} — required, cannot be cleared)`,
			...(detail.amountCents !== null
				? { initial_value: formatMinorUnitsInput(detail.amountCents) }
				: {}),
		});
	} else {
		fields.push({
			type: "text_input",
			action_id: "ratePercent",
			label: "Rate (%, up to 2 decimals — required, cannot be cleared)",
			...(detail.rateBps !== null ? { initial_value: formatBpsAsPercent(detail.rateBps) } : {}),
		});
		fields.push({
			type: "text_input",
			action_id: "cap",
			label: "Discount cap (blank = no cap)",
			...(detail.capCents !== null
				? { initial_value: formatMinorUnitsInput(detail.capCents) }
				: {}),
		});
	}
	fields.push({
		type: "text_input",
		action_id: "minSubtotal",
		label: "Minimum spend (blank = none)",
		...(detail.minSubtotalCents !== null
			? { initial_value: formatMinorUnitsInput(detail.minSubtotalCents) }
			: {}),
	});
	fields.push({
		type: "text_input",
		action_id: "startsAt",
		label: "Starts at (ISO 8601 UTC; blank = immediately)",
		...(detail.startsAt !== null ? { initial_value: detail.startsAt } : {}),
	});
	fields.push({
		type: "text_input",
		action_id: "expiresAt",
		label: "Expires at (ISO 8601 UTC; blank = never)",
		...(detail.expiresAt !== null ? { initial_value: detail.expiresAt } : {}),
	});
	fields.push({
		type: "text_input",
		action_id: "maxUses",
		label: "Max total uses (blank = unlimited)",
		...(detail.maxUses !== null ? { initial_value: String(detail.maxUses) } : {}),
	});
	fields.push({
		type: "text_input",
		action_id: "maxUsesPerCustomer",
		label: "Max uses per customer (blank = unlimited)",
		...(detail.maxUsesPerCustomer !== null
			? { initial_value: String(detail.maxUsesPerCustomer) }
			: {}),
	});
	return {
		type: "form",
		fields,
		submit: { label: `Save ${detail.code}`, action_id: ACTION_SAVE },
	};
}

function deleteCouponActions(detail: CouponSummaryWire): ActionsBlock {
	const button: ButtonElement = {
		type: "button",
		action_id: ACTION_DELETE,
		label: `Delete ${detail.code}`,
		style: "danger",
		value: { couponId: detail.id, code: detail.code },
		confirm: {
			title: `Delete coupon ${detail.code}?`,
			text: "Only a coupon that has never been redeemed can be deleted — one redemption blocks deletion permanently to preserve the redemption audit trail. In-flight carts that quoted this code recompute without it on their next update; orders already placed keep their snapshotted discount. This cannot be undone.",
			confirm: "Yes, delete",
			deny: "Keep it",
			style: "danger",
		},
	};
	return { type: "actions", elements: [button] };
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
 * select), so a value in the OTHER type's field is an explicit boundary error
 * — never silently dropped. On EDIT only the active type's fields are
 * rendered and `currency` is immutable (`mode: "edit"` skips it).
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

/** Parse the type-independent fields (blank = unset/null on every one). */
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
			message: "Max total uses must be a whole number of 1 or more, or blank for unlimited.",
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
		const shared = parseSharedFields(values);
		if (!shared.ok) return err(shared.message);
		const result = await client.createCoupon({
			id,
			code,
			type,
			amountCents: econ.amountCents,
			rateBps: econ.rateBps,
			capCents: econ.capCents,
			currency: econ.currency,
			...shared.fields,
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
	return customAction<AdminRulesClient>(async ({ input, client, showLeaf, showList }) => {
		const values = input.values ?? {};
		const couponId = readString(values.couponId);
		const code = readString(values.code);
		const type = readString(values.type);
		if (
			couponId === undefined ||
			code === undefined ||
			(type !== "fixed_amount" && type !== "percentage")
		) {
			return showList();
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
