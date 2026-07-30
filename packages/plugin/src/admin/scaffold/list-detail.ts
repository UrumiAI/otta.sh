import type { Block, BlockResponse, PluginContext, RouteHandler } from "../../types.js";
import type { ScreenActions } from "./actions.js";
import { failClosedResponse, noticeBanner, type Notice } from "./banner.js";
import { carriedFields, type CarriedContext, decodeCarrier } from "./carrier.js";
import {
	decodeListCursor,
	decodePath,
	encodeListCursor,
	encodePath,
	filterPathField,
	PATH_FIELD,
	type NavPath,
} from "./nav.js";

/**
 * The reusable admin list → detail (→ …) dispatch scaffold.
 *
 * A screen is an ordered array of {@link LevelDef}s indexed by drill depth:
 * `levels[0]` renders at path `[]` (the root list), `levels[1]` at a
 * one-deep path (`["ord-1"]`), and so on. Each level is either a keyset-paged
 * `list` or a `leaf` detail. The scaffold owns the STATELESS control flow —
 * open/back/page/apply-filter, cursor + drill-path (de)serialization, and the
 * dispatch every screen shares — while each level's `render` owns its own Block
 * Kit body. Screen-specific side effects (a status transition, appending a
 * note) are registered as {@link customAction}s.
 *
 * TWO CHANNELS RUN FROM A CUSTOM ACTION BACK INTO A LEVEL'S `render`: a
 * {@link Notice} banner ("what happened"), and this screen's own
 * `RenderState` ("what to render now" — which group to open, which values to
 * prefill). Both are arguments to {@link CustomActionApi.showLeaf} /
 * {@link CustomActionApi.showList}; see the `RenderState` note on
 * {@link CustomActionApi} for why the second one exists and what it is not.
 *
 * IO discipline: the ONLY egress is whatever the screen's `client` performs;
 * this module touches neither `fetch` nor `ctx.http` directly, so it never
 * appears among the sandbox-clean guard's offenders.
 */

/** The em-dash `BlockInteraction` envelope, narrowed to what the scaffold reads. */
export interface ListDetailInput {
	type?: unknown;
	action_id?: unknown;
	/** `form_submit` payload. */
	values?: Record<string, unknown>;
	/** `block_action` payload (e.g. the table "Load more" `{cursor}`, or a
	 *  transition button's `{orderId, toState}`). */
	value?: unknown;
	/** The originating block's `block_id`, echoed back by em-dash on a `form`
	 *  submit and on a `table`'s sort/load-more `block_action` — those two blocks
	 *  ONLY (`blocks/form.tsx`, `blocks/table.tsx` in the pinned 0.31.1; a button
	 *  echoes nothing and carries context in `value` instead). Block Kit declares no
	 *  hidden field, so this is where a form carries context it must not show an
	 *  operator — decoded via {@link readCarrier}. */
	block_id?: unknown;
}

// -- level definitions (public factories, strongly typed per screen) ----------

/** A keyset-paged list level. Generic in the screen's `Client`, filter-form
 *  shape `Filter`, row-summary type `Summary`, and the screen's `RenderState`
 *  (`never` — no channel — unless the level renders one; see
 *  {@link CustomActionApi}). */
export interface ListLevelDef<Client, Filter, Summary, RenderState = never> {
	/** Page size for the keyset read. */
	limit: number;
	/** Parse a filter-form `form_submit`'s `values` into this level's filter. */
	filterFromValues(values: Record<string, unknown>): Filter;
	/** Fetch one page. `parentPath` is the ancestor ids of THIS list (`[]` at the
	 *  root); `opts.cursor` is the opaque SERVICE cursor when paging. */
	fetchPage(
		client: Client,
		parentPath: NavPath,
		filter: Filter,
		opts: { cursor?: string; limit: number },
	): Promise<{ items: Summary[]; nextCursor: string | null }>;
	/** Render the list blocks. `nextToken` is the scaffold-wrapped keyset cursor
	 *  (undefined on the last page) to hand the table's `next_cursor`. `notice`
	 *  is set when a list-level {@link CustomActionFn} re-renders this level via
	 *  {@link CustomActionApi.showList}'s notice param (a create/edit/delete
	 *  outcome on a screen whose mutable target is a LIST, not a leaf) —
	 *  undefined on a plain open/back/page/apply-filter render. A level that
	 *  never fires a list-scoped custom action can ignore it. */
	render(args: {
		actions: ScreenActions;
		path: NavPath;
		filter: Filter;
		items: Summary[];
		nextToken: string | undefined;
		notice: Notice | undefined;
		/** This screen's render state, when a list-level {@link CustomActionFn}
		 *  passed one to {@link CustomActionApi.showList} — `undefined` on every
		 *  other render (open/back/page/apply-filter, and any custom action that
		 *  passed none). See {@link CustomActionApi}'s `RenderState` note. */
		renderState: RenderState | undefined;
	}): Block[];
	/** Fail-closed response when the page read cannot reach the service. */
	onError(): BlockResponse;
}

/** A leaf detail level. Generic in the screen's `Client`, primary `Detail`, and
 *  the screen's `RenderState` (`never` — no channel — unless the level renders
 *  one; see {@link CustomActionApi}). */
export interface LeafLevelDef<Client, Detail, RenderState = never> {
	/** Load the primary record. A throw fails closed; `null` renders `notFound`.
	 *  (Named `load`, not the f-word, so the sandbox-clean grep guard never
	 *  mistakes a method declaration for a bare network-egress call.) */
	load(client: Client, path: NavPath, id: string): Promise<Detail | null>;
	/** Render the detail blocks. Receives the `client` so a SECONDARY, best-effort
	 *  read (e.g. order notes) can be done with its own try/catch — a secondary
	 *  failure must degrade, never fail the whole detail. */
	render(args: {
		client: Client;
		actions: ScreenActions;
		path: NavPath;
		id: string;
		detail: Detail;
		notice: Notice | undefined;
		/** This screen's render state, when the firing {@link CustomActionFn} passed
		 *  one to {@link CustomActionApi.showLeaf} — `undefined` on every other
		 *  render (open/back, and any custom action that passed none). This is where
		 *  a DA-3 stage/refuse render learns WHICH group to open and WHAT to prefill;
		 *  see {@link CustomActionApi}'s `RenderState` note. */
		renderState: RenderState | undefined;
	}): Promise<Block[]> | Block[];
	/** Blocks for a missing record (id resolved to `null`).
	 *
	 *  Deliberately NOT given the render state (nor the notice, as before): the
	 *  record it was staged against no longer resolves, so a group forced open
	 *  around a form prefilled with an amount for a vanished order is a lie. The
	 *  missing record IS the outcome the operator needs. */
	notFound(args: { actions: ScreenActions; path: NavPath; id: string }): Block[];
	/** Fail-closed response when the primary read cannot reach the service. */
	onError(): BlockResponse;
}

/**
 * The engine-facing (type-erased) level shape. Screens never build this
 * directly — {@link listLevel}/{@link leafLevel} produce it from typed defs.
 *
 * `RenderState` is the ONE type parameter that is NOT erased here, and that is
 * the whole of the channel's type safety. Everything else (`Client`, `Filter`,
 * `Summary`, `Detail`) is produced and consumed inside a single level, so the
 * factories below can erase it and cast it back with a local soundness argument.
 * Render state instead crosses from ONE closure (a custom action) to ANOTHER (a
 * level's `render`), which no local argument can cover — so it stays visible in
 * the type, and {@link createListDetailHandler} is where the two ends are checked
 * against each other. `never` (the default) means "this screen has no channel".
 */
export type LevelDef<RenderState = never> =
	| ({ kind: "list" } & ListLevelDef<unknown, unknown, unknown, RenderState>)
	| ({ kind: "leaf" } & LeafLevelDef<unknown, unknown, RenderState>);

export function listLevel<Client, Filter, Summary, RenderState = never>(
	def: ListLevelDef<Client, Filter, Summary, RenderState>,
): LevelDef<RenderState> {
	// SAFETY (existential-type erasure): the engine stores levels type-erased
	// (`unknown`) because one `levels` array mixes levels of different Client/
	// Filter/Summary types. The casts below are sound because this closure is the
	// ONLY producer AND consumer of those `unknown`s for this level: `client` is
	// always the value `config.createClient` returned, `filter` is always a value
	// THIS level's `filterFromValues` produced (the engine never fabricates or
	// cross-wires one level's filter into another), and `items` are always what
	// THIS level's `fetchPage` returned. The typed `def` never sees a foreign value.
	//
	// `renderState` needs NO cast and gets none: that argument is exactly why it is
	// left in `LevelDef`'s type instead of being erased alongside the rest.
	return {
		kind: "list",
		limit: def.limit,
		filterFromValues: (values) => def.filterFromValues(values),
		fetchPage: (client, parentPath, filter, opts) =>
			def.fetchPage(client as Client, parentPath, filter as Filter, opts),
		render: (args) =>
			def.render({ ...args, filter: args.filter as Filter, items: args.items as Summary[] }),
		onError: () => def.onError(),
	};
}

export function leafLevel<Client, Detail, RenderState = never>(
	def: LeafLevelDef<Client, Detail, RenderState>,
): LevelDef<RenderState> {
	// SAFETY: same existential-erasure argument as `listLevel` — `client` is
	// always `config.createClient`'s value, and `detail` is always what THIS
	// level's `load` returned, round-tripped through the engine unchanged.
	// `renderState` is un-erased and therefore un-cast, as in `listLevel`.
	return {
		kind: "leaf",
		load: (client, path, id) => def.load(client as Client, path, id),
		render: (args) =>
			def.render({ ...args, client: args.client as Client, detail: args.detail as Detail }),
		notFound: (args) => def.notFound(args),
		onError: () => def.onError(),
	};
}

// -- custom (side-effecting) actions ------------------------------------------

/**
 * The re-render surface a custom action calls once its side effect is done.
 *
 * `RenderState` IS THE SCREEN'S OWN TYPE, and the scaffold never looks inside it.
 * It answers the question a `notice` cannot: a banner says WHAT HAPPENED, render
 * state says WHAT TO RENDER NOW — which group to open, which values to put back in
 * a form. The spec's DA-3/DA-3a shape needs both at once: a refusal (the record
 * moved under the operator, or they typed `19,99` in an amount field) must
 * re-render **state 1** with the group open and the operator's input preserved,
 * and a banner alone leaves the re-rendered level guessing at both.
 *
 * WHAT IT IS NOT — three properties it is worth being explicit about, because each
 * is a plausible misreading that would break something the scaffold guarantees:
 *
 *  - **NOT STORAGE, and not a wire format.** The value is passed by reference to
 *    the level's `render` inside the SAME response. Nothing is serialized, stored
 *    or echoed to the client, and the next interaction's `renderState` is
 *    `undefined` again. Every screen stays stateless: whatever must survive the
 *    NEXT click still rides in `button.value` or in a form's `block_id` carrier
 *    (see `./carrier.js`) exactly as before. A stage/confirm flow therefore uses
 *    both — render state to show state 2, and the confirm button's `value` to carry
 *    the staged payload and its watermark into the write.
 *  - **NOT DATA.** Pass what to render, not what was read. The custom action's copy
 *    of a record is pre-mutation or (on a DA-3a refusal) known-stale by
 *    construction, so re-rendering from it would show the operator figures that are
 *    already wrong — which is the failure the re-read exists to catch. The engine
 *    still calls the level's own `load`, and the level still renders from what it
 *    returns. (Nothing prevents a screen stuffing a loaded record in here, since
 *    the value is opaque; it is a mistake, and the paragraph above is why.)
 *  - **NOT TRUSTED, and never inspected.** The engine reads no property of it, so a
 *    value whose own getters throw can only blow up in the screen's `render` —
 *    already inside the leaf/list containment, which fails closed to that level's
 *    `onError`. Do not defeat that by validating it here; there is nothing to
 *    validate, and a check would be a new throw site outside a level's try.
 *
 * Type-safety: `RenderState` is the one parameter {@link LevelDef} does not erase,
 * so a screen's levels and its custom actions are checked against each other at
 * the {@link createListDetailHandler} call site. It defaults to `never`, so a
 * screen that declares none cannot pass one by accident.
 */
export interface CustomActionApi<Client, RenderState = never> {
	input: ListDetailInput;
	client: Client;
	/** The hidden context the originating form carried in its `block_id` —
	 *  decoded once per interaction, `undefined` when the block carried none (or
	 *  carried something that is not a carrier token). This is what replaces the
	 *  single-option "carrier" `select` fields: read `carried.orderId` instead of
	 *  `input.values.orderId`. Every value is UNTRUSTED operator-round-tripped
	 *  input — re-authorize it exactly as you would a select's value.
	 *
	 *  RESERVED KEYS ARE STRIPPED (`__path`, `__v`): this record holds only the
	 *  screen's own fields, so `Object.entries(carried)` is safe to iterate. The
	 *  drill path is on {@link CustomActionApi.carriedPath} instead. */
	carried: CarriedContext | undefined;
	/** The drill {@link NavPath} this interaction carried, from a button's
	 *  `value.__path`, a form's `values.__path`, or the block's `block_id` carrier —
	 *  same precedence the engine's own nav uses. `undefined` when nothing carried
	 *  one (the depth-≤1 case); hand it to {@link CustomActionApi.showLeaf} or
	 *  {@link CustomActionApi.showList} to re-render where the operator was. */
	carriedPath: NavPath | undefined;
	/** Re-render the leaf at `path` (its id is `path`'s last element), optionally
	 *  with a notice banner, and optionally with this screen's `renderState` — which
	 *  the level's `render` receives verbatim. The two compose, and the refusal case
	 *  needs both: `showLeaf(path, REFUSED_NOTICE, {…what the operator typed…})`. */
	showLeaf(path: NavPath, notice?: Notice, renderState?: RenderState): Promise<BlockResponse>;
	/** Re-render the list at `path` (default: the root list), optionally with a
	 *  notice banner and this screen's `renderState` — the list-level counterpart to
	 *  `showLeaf`, for a custom action whose target level is a list (e.g. a
	 *  create/edit/delete on a screen with no leaf level, such as a two-list-level
	 *  registry drill-down). A `path` landing on a LEAF renders that leaf, state and
	 *  all, exactly as `showLeaf` would. */
	showList(path?: NavPath, notice?: Notice, renderState?: RenderState): Promise<BlockResponse>;
}

export type CustomActionFn<Client, RenderState = never> = (
	api: CustomActionApi<Client, RenderState>,
) => Promise<BlockResponse>;

export function customAction<Client, RenderState = never>(
	fn: CustomActionFn<Client, RenderState>,
): CustomActionFn<unknown, RenderState> {
	// SAFETY: same existential-erasure argument as `listLevel`/`leafLevel` —
	// `api.client` is always the value `config.createClient` returned. `RenderState`
	// is NOT erased (see `LevelDef`), so nothing about the channel is cast here.
	return (api) => fn({ ...api, client: api.client as Client });
}

// -- the screen + its handler -------------------------------------------------

/**
 * A screen's configuration. `RenderState` is the screen's own render-state type
 * (see {@link CustomActionApi}) and defaults to `never` — the no-channel case, and
 * every screen written before the channel existed.
 *
 * A SCREEN WITH RENDER STATE SHOULD NAME IT EXPLICITLY —
 * `createListDetailHandler<OrdersRenderState>({…})` — rather than leaving it to
 * inference. This is the one place the levels and the custom actions meet, so an
 * explicit argument is what makes a mismatch between them an error HERE (where the
 * screen author can see both) instead of somewhere further in.
 */
export interface ListDetailScreenConfig<RenderState = never> {
	actions: ScreenActions;
	/** Build the token-threaded `ctx.http` client for this screen. */
	createClient(ctx: PluginContext): Promise<unknown> | unknown;
	/** Levels indexed by drill depth (index 0 = root list). A level that ignores
	 *  the render-state channel is written exactly as before. */
	levels: LevelDef<RenderState>[];
	/** Resolve an `open` interaction to the FULL target path (ancestors + the
	 *  selected id). The scaffold renders `levels[targetPath.length]` at it —
	 *  a leaf or a deeper list. Undefined ⇒ fall back to the root list. */
	parseOpen(input: ListDetailInput): { targetPath: NavPath } | undefined;
	/** Screen-specific side-effecting actions, keyed by full action id. */
	customActions?: Record<string, CustomActionFn<unknown, RenderState>>;
}

/** The notice a custom action's failed re-render carries. A side effect may
 *  ALREADY have applied when the failure happened, so this must never read as a
 *  plain "it failed". */
const ACTION_OUTCOME_UNKNOWN: Notice = {
	variant: "error",
	title: "Action outcome unknown",
	description:
		"The action may already have been applied, but this screen could not be rebuilt afterwards. Re-check the record before retrying.",
};

/**
 * Build the single `RouteHandler` for a list/detail screen. The returned
 * handler is what the admin-route dispatcher forwards `open`/`back`/`page`/
 * `apply-filter`/custom-action interactions (and the page-load default) to.
 *
 * NO EXCEPTION MAY ESCAPE THIS HANDLER. A throw becomes a non-2xx from the
 * plugin route, and a non-2xx replaces the whole `BlockRenderer` tree with a raw
 * status panel — unmounting every accordion and tab, and telling an operator
 * nothing about whether their action applied. Each rendering path therefore fails
 * closed to a banner of its own (a level's `onError()`, or the root list plus
 * {@link ACTION_OUTCOME_UNKNOWN}), and this wrapper is the LAST-RESORT net behind
 * all of them: it also covers the paths no inner try can reach — `createClient`,
 * `parseOpen`, `filterFromValues`, and a screen's own `onError()` throwing.
 */
export function createListDetailHandler<RenderState = never>(
	config: ListDetailScreenConfig<RenderState>,
): RouteHandler<ListDetailInput> {
	const dispatch = createDispatcher(config);
	return async (routeCtx, ctx) => {
		try {
			return await dispatch(routeCtx, ctx);
		} catch (err) {
			// LOG IT. Contained failures are indistinguishable from an unreachable
			// service in the UI (both are an error banner), so without this a screen bug
			// — say a carrier namespace interpolating a zone named "EU West" — reads to
			// an operator AND to a developer tailing worker logs as an infrastructure
			// outage, with the message, the stack and the offending value gone.
			console.error("[urumi] admin list/detail dispatch failed:", err);
			// The RESPONSE stays deliberately generic and screen-agnostic: at this point
			// the screen's own fail-closed rendering is what failed, so nothing
			// screen-specific can be trusted to build blocks, and the error must never
			// reach the UI (it can carry a URL or a status — see `failClosedResponse`).
			return failClosedResponse({
				header: "Unavailable",
				title: "This screen could not be rendered",
				description:
					"Something went wrong building this view. Reload the page; if it persists, the record may need checking directly.",
				toast: "Could not render this screen",
			});
		}
	};
}

function createDispatcher<RenderState>(
	config: ListDetailScreenConfig<RenderState>,
): RouteHandler<ListDetailInput> {
	const { actions, levels } = config;

	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		const action = readString(input.action_id);
		const client = await config.createClient(ctx);

		const listLevelAt = (depth: number): (LevelDef<RenderState> & { kind: "list" }) | undefined => {
			const level = levels[depth];
			return level !== undefined && level.kind === "list" ? level : undefined;
		};

		const renderList = async (
			path: NavPath,
			filter: unknown,
			cursor?: string,
			notice?: Notice,
			renderState?: RenderState,
		): Promise<BlockResponse> => {
			const level = listLevelAt(path.length);
			if (level === undefined) return { blocks: [] };
			try {
				const page = await level.fetchPage(client, path, filter, {
					limit: level.limit,
					...(cursor !== undefined ? { cursor } : {}),
				});
				const nextToken =
					page.nextCursor === null
						? undefined
						: encodeListCursor(
								path.length > 0
									? { c: page.nextCursor, f: filter, p: path }
									: { c: page.nextCursor, f: filter },
							);
				const blocks = level.render({
					actions,
					path,
					filter,
					items: page.items,
					nextToken,
					notice,
					renderState,
				});
				// GUARANTEE the deep-level filter carry (review round 2, item 1): at
				// depth ≥ 1 an `apply-filter` submit MUST carry the drill path, or it
				// would silently re-filter the ROOT list. Screens don't have to
				// remember this — every rendered form whose submit fires `applyFilter`
				// gets the path-carrier field injected here (no-op if the screen
				// already placed one via `filterPathField`).
				return {
					blocks: path.length === 0 ? blocks : withFilterPathCarry(blocks, actions, path),
				};
			} catch (err) {
				// This is where a SCREEN BUG lands (its `fetchPage` or its `render`), and
				// the banner below cannot tell an operator apart from an unreachable
				// service — so the detail has to reach the logs.
				console.error("[urumi] admin list level failed:", err);
				return level.onError();
			}
		};

		const renderLeaf = async (
			path: NavPath,
			notice?: Notice,
			renderState?: RenderState,
		): Promise<BlockResponse> => {
			const level = levels[path.length];
			const id = path[path.length - 1];
			if (level === undefined || level.kind !== "leaf" || id === undefined) return { blocks: [] };
			// `render` and `notFound` are INSIDE the try, not just `load`: they are
			// screen code that builds blocks, and block builders throw (a rejected
			// carrier namespace, a filter form over its field budget, a hostile
			// `renderState` whose own getters throw — the engine never reads it, so a
			// screen's `render` is the only place it can be touched). An escaping throw
			// becomes a non-2xx, which replaces the whole rendered tree with a raw status
			// panel — the worst possible outcome right after a side effect applied,
			// because the operator cannot tell whether it did.
			try {
				const detail = await level.load(client, path, id);
				if (detail === null) return { blocks: level.notFound({ actions, path, id }) };
				return {
					blocks: await level.render({ client, actions, path, id, detail, notice, renderState }),
				};
			} catch (err) {
				console.error("[urumi] admin leaf level failed:", err);
				return level.onError();
			}
		};

		/** Render whichever level `path` lands on — a leaf, a deeper list, or the
		 *  root list (an empty path). Lists open with their default (empty) filter. */
		const renderPath = async (
			path: NavPath,
			notice?: Notice,
			renderState?: RenderState,
		): Promise<BlockResponse> => {
			const level = levels[path.length];
			if (level === undefined) return { blocks: [] };
			if (level.kind === "leaf") return renderLeaf(path, notice, renderState);
			return renderList(path, level.filterFromValues({}), undefined, notice, renderState);
		};

		const rootList = (notice?: Notice, renderState?: RenderState): Promise<BlockResponse> => {
			const root = listLevelAt(0);
			return root === undefined
				? Promise.resolve({ blocks: [] })
				: renderList([], root.filterFromValues({}), undefined, notice, renderState);
		};

		// -- open: drill into the resolved target path ----------------------------
		if (action === actions.open) {
			const target = config.parseOpen(input);
			return target === undefined ? rootList() : renderPath(target.targetPath);
		}

		// -- back: pop exactly one level toward the root --------------------------
		if (action === actions.back) {
			const current = readNavPath(input) ?? [];
			return renderPath(current.slice(0, -1));
		}

		// -- page: keyset next page (defensive: bad/missing cursor ⇒ root list) ----
		if (action === actions.page) {
			const token = readString(asRecord(input.value)?.cursor);
			const decoded = token === undefined ? null : decodeListCursor(token);
			// No usable cursor ⇒ re-render whatever level the firing block said it
			// belonged to (its `block_id` carrier), else the root list as before.
			//
			// DO NOT SET `sortable: true` ON A TABLE COLUMN UNTIL SORT IS SUPPORTED
			// END TO END. em-dash fires this SAME action id for a sortable
			// column-header click, with `value: {sort: {key, dir}}` and NO cursor
			// (`blocks/table.tsx:44-58`). Nothing here (or in any list level, or in
			// the service's list ports) reads `sort`, so such a click re-renders the
			// level with its DEFAULT filter — silently dropping the operator's
			// filter, and never sorting anything. The carrier below at least keeps
			// the drill path when the table carries one; the dropped filter and the
			// ignored sort remain, which is why the header must not be made
			// clickable yet. Latent today: no page sets `sortable`. Fixing it needs a
			// sort parameter threaded through `ListLevelDef.fetchPage` into the
			// service list ports — out of scope for the layout vocabulary.
			if (decoded === null) return renderPath(readNavPath(input) ?? []);
			return renderList(decoded.p ?? [], decoded.f, decoded.c);
		}

		// -- apply-filter: re-list the current level with a fresh filter ----------
		if (action === actions.applyFilter) {
			const path = readNavPath(input) ?? [];
			const level = listLevelAt(path.length);
			if (level === undefined) return rootList();
			return renderList(path, level.filterFromValues(input.values ?? {}));
		}

		// -- custom (side-effecting) actions --------------------------------------
		const custom = action === undefined ? undefined : config.customActions?.[action];
		if (custom !== undefined) {
			try {
				return (await custom({
					input,
					client,
					carried: readCarrier(input),
					carriedPath: readNavPath(input),
					// The render-state argument is forwarded UNTOUCHED and un-inspected: the
					// engine has no business reading a screen's own value, and reading one
					// here would put a new throw site outside every level's containment.
					showLeaf: (path, notice, renderState) => renderLeaf(path, notice, renderState),
					showList: (path, notice, renderState) =>
						path === undefined
							? rootList(notice, renderState)
							: renderPath(path, notice, renderState),
				})) as Awaited<ReturnType<RouteHandler<ListDetailInput>>>;
			} catch (err) {
				// A custom action is the one place a SIDE EFFECT may already have
				// applied, so this cannot be a silent fallback: the mutation might have
				// committed and only the re-render failed. Log it (the operator's banner
				// says "unknown", and the logs are where the actual cause lives), then
				// show the root list — so the operator keeps a working screen — with a
				// banner saying the outcome is unknown, rather than a raw status panel
				// that says nothing and unmounts everything. The banner is PREPENDED
				// rather than passed as a notice because a list level may ignore `notice`.
				// No render state is forwarded here either: the value in flight is a
				// plausible cause of the throw, and this fallback's whole job is to be the
				// simplest render that can still work.
				console.error(`[urumi] admin custom action ${String(action)} failed:`, err);
				const toast = {
					message: "Action outcome unknown — re-check the record",
					type: "error" as const,
				};
				// DOUBLE FAULT: if rebuilding the root list ALSO throws, the outer
				// wrapper would answer with its generic copy, dropping the one thing the
				// operator must know — that a mutation may have committed. So the warning
				// is preserved on its own rather than delegated.
				let fallbackBlocks: Block[];
				try {
					fallbackBlocks = (await rootList()).blocks;
				} catch (fallbackErr) {
					console.error("[urumi] admin custom action fallback render failed:", fallbackErr);
					fallbackBlocks = [];
				}
				return { blocks: [noticeBanner(ACTION_OUTCOME_UNKNOWN), ...fallbackBlocks], toast };
			}
		}

		// -- page load (or any other interaction routed here) ⇒ the root list ------
		return rootList();
	};
}

/**
 * Inject the drill-path carrier ({@link filterPathField}) into every rendered
 * form whose submit fires this screen's `applyFilter`, skipping forms that
 * already carry the path — either as an explicit field or, preferably, INVISIBLY
 * in the form's `block_id` carrier — which is how a screen drops the visible
 * "Scope" dropdown: build it with
 * `carriedForm({namespace, context: {[PATH_FIELD]: encodePath(path)}, form})` and
 * the injection stands down, but ONLY when the carried path is EXACTLY this level's.
 *
 * RECURSES INTO LAYOUT CONTAINERS (`columns` / `tab` / `accordion`): the whole
 * point of the guarantee is that a screen cannot silently break deep
 * apply-filter, and wrapping a filter form in a collapsed `accordion` (the
 * density fix) would otherwise hide it from this pass. Non-mutating: returns new
 * block/field/container arrays.
 */
function withFilterPathCarry(blocks: Block[], actions: ScreenActions, path: NavPath): Block[] {
	const recurse = (inner: Block[]): Block[] => withFilterPathCarry(inner, actions, path);
	const encoded = encodePath(path);
	return blocks.map((block): Block => {
		if (block.type === "form") {
			if (block.submit.action_id !== actions.applyFilter) return block;
			if (block.fields.some((f) => f.action_id === PATH_FIELD)) return block;
			// Stand down ONLY for a carrier naming THIS EXACT path. A hand-written
			// carrier that captured a stale or outer-scope path would otherwise
			// suppress the injection AND filter the wrong level — the failure this
			// guarantee exists to make impossible. Any other carried path is treated
			// as absent, so the correct path is injected and wins by precedence.
			if (decodeCarrier(block.block_id)?.[PATH_FIELD] === encoded) return block;
			return { ...block, fields: [...block.fields, filterPathField(path)] };
		}
		const children = childBlockLists(block);
		return children === undefined ? block : withChildBlockLists(block, children.map(recurse));
	});
}

/**
 * Every nested block list a container block holds, or `undefined` for a leaf
 * block. EXHAUSTIVE over `Block` on purpose: the `never` assignment below is a
 * compile error the moment a new block-bearing member joins the union, so a future
 * container cannot silently reintroduce the bug this traversal fixes (an
 * un-injected deep filter form re-filtering the root list).
 *
 * Paired with {@link withChildBlockLists}, which puts the mapped lists back in the
 * same order.
 */
function childBlockLists(block: Block): Block[][] | undefined {
	switch (block.type) {
		case "columns":
			return block.columns;
		case "accordion":
			return [block.blocks];
		case "tab":
			return block.panels.map((panel) => panel.blocks);
		case "header":
		case "section":
		case "context":
		case "divider":
		case "stats":
		case "table":
		case "banner":
		case "fields":
		case "actions":
		case "form":
		case "empty":
		case "image":
		case "meter":
			return undefined;
		default: {
			const exhaustive: never = block;
			return exhaustive;
		}
	}
}

/** Rebuild `block` with `lists` in place of its nested block lists — the inverse of
 *  {@link childBlockLists}, non-mutating, same order. */
function withChildBlockLists(block: Block, lists: Block[][]): Block {
	switch (block.type) {
		case "columns":
			return { ...block, columns: lists };
		case "accordion":
			return { ...block, blocks: lists[0] ?? [] };
		case "tab":
			return {
				...block,
				panels: block.panels.map((panel, i) => ({ ...panel, blocks: lists[i] ?? panel.blocks })),
			};
		default:
			return block;
	}
}

// -- shared payload parsing (exported: screens reuse the same coercions) -------

export function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object"
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Recover the hidden context the originating block carried in its `block_id`
 * (see {@link ./carrier.js}). Exported because a screen's `parseOpen` — which
 * runs OUTSIDE a custom action, so it has no {@link CustomActionApi.carried} —
 * needs the same recovery, e.g. to read the id an open form carried.
 *
 * RESERVED KEYS ARE STRIPPED: `__path` (the drill level, engine business — use
 * {@link CustomActionApi.carriedPath}) and `__v` (`carriedForm`'s prefill digest,
 * which exists only to change the React key). A screen therefore sees ONLY the
 * fields it carried, and can iterate the record without special-casing ours.
 *
 * Total: a missing, non-carrier or malformed `block_id` yields `undefined`.
 */
export function readCarrier(input: ListDetailInput): CarriedContext | undefined {
	const decoded = decodeCarrier(input.block_id);
	return decoded === undefined ? undefined : carriedFields(decoded);
}

/** Recover the drill {@link NavPath} a control carried, in precedence order:
 *  a `block_action`'s `value.__path`, a `form_submit`'s `values.__path`, then the
 *  originating block's `block_id` carrier (`__path`). The first two are the
 *  VISIBLE carriers (a back button's payload, the injected "Scope" field); the
 *  third is the invisible one, which is how a form or a table states its drill
 *  level without showing an operator a field. Absent ⇒ undefined (the caller
 *  defaults to the root), which is exactly the depth-≤2 case. */
function readNavPath(input: ListDetailInput): NavPath | undefined {
	const fromValue = asRecord(input.value)?.[PATH_FIELD];
	if (typeof fromValue === "string") return decodePath(fromValue) ?? undefined;
	const fromValues = input.values?.[PATH_FIELD];
	if (typeof fromValues === "string") return decodePath(fromValues) ?? undefined;
	// The RAW record, not `readCarrier` — that strips the reserved keys for screens,
	// and `__path` is precisely the reserved key the engine itself needs here.
	const fromCarrier = decodeCarrier(input.block_id)?.[PATH_FIELD];
	if (fromCarrier !== undefined) return decodePath(fromCarrier) ?? undefined;
	return undefined;
}
