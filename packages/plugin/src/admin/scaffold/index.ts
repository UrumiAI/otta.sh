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
 *     array of levels indexed by drill depth.
 *   - `NavPath` + `encodeListCursor`/`decodeListCursor` + `backButton(...)` +
 *     `filterPathField(...)` — drill-path & keyset-cursor plumbing that survives
 *     stateless interactions (the engine auto-injects the filter path carrier
 *     into deep-level filter forms, so the carry cannot be silently omitted).
 *   - `readAdminTokens(ctx)` — admin + service token threading (one source).
 *   - `Notice`/`noticeBanner(...)`/`failClosedResponse(...)` — consistent
 *     banner + fail-closed rendering.
 */

export { NAV_VERBS, screenActions, type ScreenActions } from "./actions.js";
export { failClosedResponse, noticeBanner, type FailClosedOptions, type Notice } from "./banner.js";
export {
	createListDetailHandler,
	customAction,
	leafLevel,
	listLevel,
	readString,
	asRecord,
	type CustomActionApi,
	type CustomActionFn,
	type LeafLevelDef,
	type LevelDef,
	type ListDetailInput,
	type ListDetailScreenConfig,
	type ListLevelDef,
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
export { readAdminTokens, type AdminTokens } from "./tokens.js";
