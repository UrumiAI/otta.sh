/**
 * Reusable admin list/detail scaffold — the `orders-page.ts` `list → detail`
 * dispatch pattern generalized so upcoming screens (product list, tax classes,
 * shipping zones → methods → rates) reuse it (plan §5c). The orders console is
 * the first screen ported onto it (the proof it preserves behavior).
 *
 * Surface:
 *   - `screenActions(entity)` — namespaced `<entity>:<verb>` action ids + the
 *     dispatcher's action-id set.
 *   - `createListDetailHandler({actions, createClient, levels, parseOpen,
 *     customActions})` + `listLevel(...)` / `leafLevel(...)` / `customAction(...)`
 *     — the N-level dispatch engine (open/back/page/apply-filter) driven by an
 *     array of levels indexed by drill depth. A custom action re-renders a level
 *     through `showLeaf`/`showList`, which carry TWO channels back into that
 *     level's `render`: a `Notice` banner (what happened) and the screen's own
 *     opaque `renderState` (what to render now — which group to open, which values
 *     to prefill, as DA-3/DA-3a needs). Render state is within-request only:
 *     nothing is stored, so screens stay stateless.
 *   - `NavPath` + `encodeListCursor`/`decodeListCursor` + `backButton(...)` +
 *     `filterPathField(...)` — drill-path & keyset-cursor plumbing that survives
 *     stateless interactions (the engine auto-injects the filter path carrier
 *     into deep-level filter forms, so the carry cannot be silently omitted).
 *   - `carriedForm(...)` + `encodeCarrier`/`decodeCarrier` + `readCarrier(input)` —
 *     hidden form context in a `form`/`table` `block_id` (the ONLY two blocks that
 *     echo it back — a button carries context in `value` instead), replacing the
 *     single-option "carrier" `select` fields that showed operators raw internal
 *     field names. Prefer `carriedForm`: it also makes the form's React key track
 *     its prefilled values, which is what keeps a re-render's new `initial_value`s
 *     visible.
 *   - `filterPanel(...)` / `emptyState(...)` — the shared layout vocabulary: a
 *     filter form collapsed behind its own active-filter summary, and a real
 *     `empty` block.
 *   - `listResult(...)` / `listIntroLine(...)` / `rowCountLine(...)` /
 *     `clearFiltersButton(...)` — how a list states its SIZE and its two zero
 *     states (INC-12): an honest, page-scoped-or-whole-set row count in the intro
 *     line, a designed zero-results state that offers `Clear filters`, and the
 *     separate, non-accusatory state for a collection that is simply empty.
 *     Written once so the screens configure the wording and nothing else.
 *     `tax-page.ts` / `shipping-page.ts` still hand-roll their own `Clear
 *     filters` button and are the next-touch consolidation onto
 *     `clearFiltersButton`.
 *   - `readAdminTokens(ctx)` — admin + service token threading (one source).
 *   - `Notice`/`noticeBanner(...)`/`failClosedResponse(...)` — consistent
 *     banner + fail-closed rendering.
 *   - `shortIdsFor(...)` / `shortIdFixed(...)` — the UUID display rule (D4): an
 *     opaque id renders as a git-style shortest-unique prefix, never in full in
 *     a list row. Every screen showing a uuid uses these two, so the prefix an
 *     operator learns on one surface means the same thing on the next.
 *   - `formatTimestamp(...)` / `formatDate(...)` / `formatDay(...)`, plus the
 *     day-bounds helpers (`dayOf`, `startOfDay`, `endOfDay`) — the console's ONE
 *     date dialect. Nothing renders a raw wire timestamp, and list and detail
 *     state the same field in the same words.
 */

export { NAV_VERBS, screenActions, type ScreenActions } from "./actions.js";
export { failClosedResponse, noticeBanner, type FailClosedOptions, type Notice } from "./banner.js";
// `DATE_LOCALE` is deliberately NOT re-exported: it is the module's own knob,
// not a screen's, and a screen reaching for it would be building a second
// formatter — the exact thing this module exists to stop. Import it from
// `./datetime.js` directly if you are testing the dialect itself.
//
// `DAY_PATTERN` IS EXPORTED FOR THE SCREENS THAT ASK "is this a bare calendar
// day?" outside `startOfDay`/`endOfDay`, which closed over the other two
// callers. Coupons is that screen: its `resolveBound` reads the regex directly
// (INC-10 deleted the private third copy it used to carry), which is exactly
// the drift this module exists to prevent.
export {
	dayOf,
	endOfDay,
	formatDate,
	formatDay,
	formatTimestamp,
	startOfDay,
	DAY_MS,
	DAY_PATTERN,
} from "./datetime.js";
export {
	carriedFields,
	carriedForm,
	carrierNamespace,
	CARRIER_MARKER,
	decodeCarrier,
	encodeCarrier,
	MAX_CARRIER_LENGTH,
	PREFILL_FIELD,
	type CarriedContext,
} from "./carrier.js";
export {
	emptyState,
	filterPanel,
	filterPanelLabel,
	filterSummary,
	type FilterPanelOptions,
} from "./layout.js";
export {
	clearFiltersButton,
	createListDetailHandler,
	customAction,
	leafLevel,
	listIntroLine,
	listLevel,
	listResult,
	readBoolean,
	readCarrier,
	readString,
	rowCountLine,
	asRecord,
	type CustomActionApi,
	type CustomActionFn,
	type LeafLevelDef,
	type LevelDef,
	type ListDetailInput,
	type ListDetailScreenConfig,
	type ListLevelDef,
	type ListResult,
	type ListResultOptions,
	type RowNoun,
	type ZeroStateCopy,
} from "./list-detail.js";
export {
	backButton,
	decodeListCursor,
	decodePath,
	encodeListCursor,
	encodePath,
	filterPathField,
	PATH_FIELD,
	type ListCursor,
	type NavPath,
} from "./nav.js";
export { shortIdFixed, shortIdsFor, SHORT_ID_CONFIRM_LEN, SHORT_ID_MIN } from "./short-id.js";
export { readAdminTokens, type AdminTokens } from "./tokens.js";
