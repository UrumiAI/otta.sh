/**
 * The Orders READ path's Block-Kit-free helpers and vocabularies.
 *
 * WHY THIS MODULE EXISTS (ADR-0015 Decision 5). Every symbol below used to live
 * in `orders-page.ts`, the Block Kit screen. The React console's list and detail
 * never depended on that screen's BEHAVIOUR — none of these helpers renders or
 * reads a block tree — but they depended on it in the BUILD, because deleting a
 * module deletes its exports. So they move here first, as a behaviour-free
 * relocation, and the page module is deleted afterwards. Nothing here changed in
 * the move; the comments are the ones the symbols arrived with.
 *
 * BLOCK-KIT-FREE IS NOT SIDE-EFFECT-FREE: {@link loadDetailSurfaces} issues four
 * parallel admin-client calls. The narrower claim is the one being made — none of
 * these functions renders a block, and none of them reads one.
 */
import {
	AdminOrdersClient,
	type CustomerContextWire,
	type OrderDetailResult,
	type OrderDetailWire,
	type OrderNoteWire,
	type OrdersListFilter,
	type OrderTimelineWire,
	type RefundsSummaryWire,
} from "./admin-orders-client.js";
import { DAY_MS, dayOf, endOfDay, startOfDay } from "./scaffold/index.js";
import { ORDER_STATE_SET } from "@otta-sh/admin-presentation";

export const PAGE_LIMIT = 25;

/**
 * THE PERIOD VOCABULARY — the console's one date control.
 *
 * The relative presets resolve to whole-day, both-ends-inclusive windows at
 * QUERY time, so a preset and a hand-typed identical period cannot resolve
 * differently, and a relative period cannot go stale in a cursor.
 */
export type PeriodKey = "last7" | "last30" | "last90" | "custom";

/** The relative presets, in render order. `days` is the WHOLE-DAY span the
 *  preset covers, TODAY INCLUDED — "last 7 days" is 7 day-boundaries, not
 *  `now - 168h`, so the label and the window it queries describe the same thing
 *  (the divergence the Reports period was fixed for). */
export const PERIOD_PRESETS: ReadonlyArray<{ key: PeriodKey; label: string; days: number }> = [
	{ key: "last7", label: "Last 7 days", days: 7 },
	{ key: "last30", label: "Last 30 days", days: 30 },
	{ key: "last90", label: "Last 90 days", days: 90 },
];

/** The all-values option. A real word, never `""`. */
export const PERIOD_ANY = "Any time";

/** The option that swaps the select for the two date fields. */
export const PERIOD_CUSTOM = "Custom…";

/** The console's own filter form values, kept alongside the opaque service cursor
 *  so paging preserves the form (MOD-9).
 *
 *  `from`/`to` are DAYS (`YYYY-MM-DD`) and belong to `period: "custom"` alone —
 *  every other period resolves its own window at query time from
 *  {@link PERIOD_PRESETS}, so a relative period cannot go stale in a carrier. */
export interface OrdersFilterForm {
	status?: string;
	period?: PeriodKey;
	from?: string;
	to?: string;
	search?: string;
}

/** Translate the console's filter form into the client's list filter (single
 *  status → an OR set of one; the period → the instants {@link periodWindow}
 *  resolves it to, which is the ONLY place this console turns a period into a
 *  query). */
export function toClientFilter(form: OrdersFilterForm): OrdersListFilter {
	const filter: OrdersListFilter = {};
	if (form.status !== undefined && form.status.length > 0) filter.states = [form.status];
	const { from, to } = periodWindow(form, new Date());
	if (from !== undefined) filter.from = from;
	if (to !== undefined) filter.to = to;
	if (form.search !== undefined && form.search.length > 0) filter.search = form.search;
	return filter;
}

/**
 * A period → the instants the service is asked for. THE ONE PLACE, so a preset
 * and a hand-typed identical period cannot resolve differently.
 *
 * INCLUSIVE WHOLE-DAY BOUNDS, the console's single date-bounds convention (the
 * Reports screen's, which this converges on): `from` is the START of its day and
 * `to` is the END of its, so a `To` of 12 Jul INCLUDES 12 Jul. The old padding
 * sent midnight for both ends, which silently dropped every order placed on the
 * last day the operator asked for.
 *
 * ONE RESIDUE WORTH KNOWING, and it is the port's, not this console's: the orders
 * window is HALF-OPEN `[from, to)` at the store (`OrderStore.listOrders`, MOD-7),
 * deliberately unlike `ReportingStore`'s inclusive `BETWEEN`. Against `<`, an
 * end-of-day `to` includes the whole `To` day except its final millisecond. The
 * end-of-day instant is what the console standardised on and what Reports sends;
 * the alternative — next-day midnight — would put a date the operator never chose
 * on the wire.
 *
 * A RELATIVE PERIOD IS RESOLVED HERE, AT QUERY TIME, against UTC now — the only
 * clock reading in the filter path. That is why nothing else derives dates from a
 * preset: the console's active-filter summary names the preset itself, so what the
 * screen says and what the service was asked can never be two different
 * computations of the same thing.
 */
function periodWindow(form: OrdersFilterForm, now: Date): { from?: string; to?: string } {
	const preset = PERIOD_PRESETS.find((p) => p.key === form.period);
	if (preset !== undefined) {
		const toDay = dayOf(now);
		// `days` counts WHOLE DAYS INCLUDING TODAY: "last 7 days" is today and the
		// six before it, so the span back is `days - 1`.
		const fromDay = dayOf(new Date(Date.parse(startOfDay(toDay)) - (preset.days - 1) * DAY_MS));
		return { from: startOfDay(fromDay), to: endOfDay(toDay) };
	}
	// The custom shape — and the only shape carrying days. An unknown `period`
	// from a hand-made payload lands here too and, carrying no days, filters by no
	// window at all rather than by a fabricated one.
	return {
		...(form.from !== undefined ? { from: startOfDay(form.from) } : {}),
		...(form.to !== undefined ? { to: endOfDay(form.to) } : {}),
	};
}

/**
 * Notes, customer context, timeline and refunds are SECONDARY surfaces: any one
 * failing must degrade to its own null and never blank the detail or fail the
 * screen closed (E-1). Fetched in parallel.
 */
export async function loadDetailSurfaces(
	client: AdminOrdersClient,
	id: string,
): Promise<{
	notes: OrderNoteWire[];
	customer: CustomerContextWire | null;
	timeline: OrderTimelineWire | null;
	refunds: RefundsSummaryWire | null;
}> {
	const [notes, customer, timeline, refunds] = await Promise.all([
		client.listNotes(id).catch((): OrderNoteWire[] => []),
		client.getCustomerContext(id).catch((): CustomerContextWire | null => null),
		client.getTimeline(id).catch((): OrderTimelineWire | null => null),
		client.getRefunds(id).catch((): RefundsSummaryWire | null => null),
	]);
	return { notes, customer, timeline, refunds };
}

/**
 * The transitions the service offers, minus the two this UI steers away from and
 * minus anything outside {@link ORDER_STATE_SET}.
 *
 * That last filter is load-bearing (DA-6): the ids are fixed at module load and
 * an id the console never registered is refused rather than dispatched, so
 * offering a button for a state this plugin never registered would give the
 * operator a control that can only ever refuse.
 */
export function offeredTransitions(o: OrderDetailWire, detail: OrderDetailResult): string[] {
	return detail.allowedTransitions.filter((t) => {
		if (!ORDER_STATE_SET.has(t)) return false;
		// A bare `shipped` would ship without tracking and email the buyer an empty
		// shipped notice — steered to the Fulfilment form, which records tracking
		// and ships atomically.
		if (o.state === "processing" && t === "shipped") return false;
		// A bare `cancelled` would cancel with no reason on file — steered to the
		// Cancel group, which records one. (The SERVICE still accepts both bare
		// transitions for other callers; this is UI steering only.)
		if (t === "cancelled") return false;
		return true;
	});
}
