import type {
	Block,
	BlockResponse,
	ButtonElement,
	ContextBlock,
	Element,
	EmptyBlock,
	PlainBlockId,
	PluginContext,
	RouteHandler,
} from "../../types.js";
import type { ScreenActions } from "./actions.js";
import { failClosedResponse, noticeBanner, type Notice } from "./banner.js";
import { carriedFields, type CarriedContext, decodeCarrier } from "./carrier.js";
import { DATE_LOCALE } from "./datetime.js";
import { emptyState } from "./layout.js";
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
 *  (`unknown` — the level ignores the channel — unless it renders one; see
 *  {@link LevelDef} for why a LEVEL's default is `unknown` while the
 *  custom-action side's is `never`). */
export interface ListLevelDef<Client, Filter, Summary, RenderState = unknown> {
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
	): Promise<{
		items: Summary[];
		nextCursor: string | null;
		/**
		 * The EXACT size of the filtered set this page came from, when the service
		 * reports one (INC-23). Passed straight through to `render` and on to
		 * {@link listResult}, which is the only thing that reads it.
		 *
		 * OMIT IT rather than guessing. A level that narrows the FETCHED PAGE
		 * client-side (products' "Low stock only") MUST omit it while that
		 * narrowing is on: the service counted the unnarrowed set, so passing it
		 * would caption the rows on screen with a number that does not describe
		 * them — the same class of lie the page-scoped wording exists to avoid.
		 */
		total?: number;
	}>;
	/** Render the list blocks. `nextToken` is the scaffold-wrapped keyset cursor
	 *  (undefined on the last page) to hand the table's `next_cursor`. `notice`
	 *  is set when a list-level {@link CustomActionFn} re-renders this level via
	 *  {@link CustomActionApi.showList}'s notice param (a create/edit/delete
	 *  outcome on a screen whose mutable target is a LIST, not a leaf) —
	 *  undefined on a plain open/back/page/apply-filter render. A level that
	 *  never fires a list-scoped custom action can ignore it.
	 *
	 *  Declared as an arrow-typed PROPERTY, not a method — the one such member here
	 *  — so `strictFunctionTypes` checks its parameter CONTRAVARIANTLY. See
	 *  {@link LevelDef}: method syntax makes `RenderState` bivariant, which is
	 *  exactly the hole that lets a level declare a WIDER state than the screen can
	 *  ever send it. */
	render: (args: {
		actions: ScreenActions;
		path: NavPath;
		filter: Filter;
		items: Summary[];
		nextToken: string | undefined;
		/** TRUE when this render is the FIRST page of its filter (the interaction
		 *  carried no keyset cursor: a page load, an open/back, or an apply-filter).
		 *  FALSE on every "Load more" page.
		 *
		 *  It exists for ONE reason and it is an honesty rule, not a convenience:
		 *  the service's list responses carry a page and a cursor and NO total, so
		 *  `items.length` is a whole-set count only when this is the first page AND
		 *  `nextToken` is undefined. Everywhere else it counts THIS PAGE and must
		 *  say so. {@link listResult} is where the two are combined; a level should
		 *  hand this to that rather than reason about it again. */
		firstPage: boolean;
		/** Whatever this level's own `fetchPage` returned as `total` — the exact
		 *  size of the filtered set, or `undefined` when the service does not
		 *  report one (or the level declined to pass it on). Hand it to
		 *  {@link listResult}; it is the one input that lets the count line state
		 *  the SET rather than the page. */
		total: number | undefined;
		notice: Notice | undefined;
		/** This screen's render state, when a list-level {@link CustomActionFn}
		 *  passed one to {@link CustomActionApi.showList} — `undefined` on every
		 *  other render (open/back/page/apply-filter, and any custom action that
		 *  passed none). See {@link CustomActionApi}'s `RenderState` note. */
		renderState: RenderState | undefined;
	}) => Block[];
	/** Fail-closed response when the page read cannot reach the service. */
	onError(): BlockResponse;
}

/** A leaf detail level. Generic in the screen's `Client`, primary `Detail`, and
 *  the screen's `RenderState` (`unknown` — the level ignores the channel — unless
 *  it renders one; see {@link LevelDef} for why a LEVEL's default is `unknown`
 *  while the custom-action side's is `never`). */
export interface LeafLevelDef<Client, Detail, RenderState = unknown> {
	/** Load the primary record. A throw fails closed; `null` renders `notFound`.
	 *  (Named `load`, not the f-word, so the sandbox-clean grep guard never
	 *  mistakes a method declaration for a bare network-egress call.) */
	load(client: Client, path: NavPath, id: string): Promise<Detail | null>;
	/** Render the detail blocks. Receives the `client` so a SECONDARY, best-effort
	 *  read (e.g. order notes) can be done with its own try/catch — a secondary
	 *  failure must degrade, never fail the whole detail.
	 *
	 *  Arrow-typed PROPERTY rather than a method, for the contravariance
	 *  {@link LevelDef} explains — the one such member here. */
	render: (args: {
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
	}) => Promise<Block[]> | Block[];
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
 * against each other.
 *
 * TWO DELIBERATE ASYMMETRIES MAKE THAT CHECK REAL. Both were found by probing the
 * first version of this channel, which had neither and did not actually hold:
 *
 *  1. `render` is an arrow-typed PROPERTY on both level interfaces, not a method.
 *     TypeScript checks method parameters BIVARIANTLY, so with method syntax a
 *     level could declare a state WIDER than the screen's — say
 *     `{…, amountCents: number}` where the action only ever sends
 *     `{…, amountInput: string}` — and `LevelDef<Wider>` would still be accepted
 *     into a `LevelDef<Draft>[]`. The level then reads `renderState.amountCents`,
 *     typed `number`, `undefined` at runtime, and `.toFixed()` throws — on the
 *     money path, immediately after the refusal this channel exists to render.
 *     A property is checked contravariantly under `strictFunctionTypes`, which
 *     rejects exactly that and still accepts a level that ignores the channel.
 *  2. A LEVEL's default is `unknown`; the CUSTOM-ACTION side's
 *     ({@link CustomActionApi}, {@link CustomActionFn}, {@link customAction},
 *     {@link ListDetailScreenConfig}) stays `never`. They point in opposite
 *     directions on purpose: `unknown` is the widest thing a level can be handed,
 *     so a level written before the channel existed (or one that simply ignores
 *     it) drops into ANY screen's `levels`; `never` is the narrowest thing an
 *     action can send, so a screen that declared no render state cannot pass one
 *     at all — a stray third argument stays a compile error rather than becoming
 *     `unknown`-shaped garbage arriving at a `render`.
 */
export type LevelDef<RenderState = unknown> =
	| ({ kind: "list" } & ListLevelDef<unknown, unknown, unknown, RenderState>)
	| ({ kind: "leaf" } & LeafLevelDef<unknown, unknown, RenderState>);

export function listLevel<Client, Filter, Summary, RenderState = unknown>(
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

export function leafLevel<Client, Detail, RenderState = unknown>(
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
 * `createListDetailHandler<OrdersRenderState>({…})`. This is the one place the
 * levels and the custom actions meet, so naming it is what puts a mismatch between
 * them HERE, where the screen author can see both ends. (The naming is a
 * readability rule, not the safety mechanism: `LevelDef`'s two asymmetries are what
 * make the mismatch an error at all.)
 */
export interface ListDetailScreenConfig<RenderState = never> {
	actions: ScreenActions;
	/** Build the token-threaded `ctx.http` client for this screen. */
	createClient(ctx: PluginContext): Promise<unknown> | unknown;
	/** Levels indexed by drill depth (index 0 = root list). A level that ignores
	 *  the render-state channel is written exactly as before.
	 *
	 *  `NoInfer` because this array must be CHECKED against the screen's render
	 *  state, never a source of it. Levels default to `unknown` (see
	 *  {@link LevelDef}), so without it a screen that leaves `RenderState` to
	 *  inference would widen to `unknown` from its own levels — and `unknown` on the
	 *  action side would then accept any third argument, silently undoing the
	 *  "a screen with no channel cannot pass state" guarantee. Inference comes from
	 *  `customActions` (the SENDING side) or from the explicit type argument. */
	levels: LevelDef<NoInfer<RenderState>>[];
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
			console.error("[otta] admin list/detail dispatch failed:", err);
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
				// THE FILTER ENCODED HERE IS THE POST-FETCH ONE, and that is a real leg
				// of the screen's page state, not just a round-trip of what the operator
				// submitted: `fetchPage` receives the SAME object `render` and this line
				// see, so anything it writes onto the filter (products' `filter.stock` —
				// the threshold and degraded-read flags its synchronous `render` cannot
				// go and read for itself) rides the next-page cursor too. Harmless while
				// such a field is re-derived by the next `fetchPage`, and a stale value
				// on screen the moment one is not — so page context written in
				// `fetchPage` must be OVERWRITTEN there unconditionally, never merged
				// into what the cursor brought back.
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
					firstPage: cursor === undefined,
					total: page.total,
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
				console.error("[otta] admin list level failed:", err);
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
				console.error("[otta] admin leaf level failed:", err);
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
				console.error(`[otta] admin custom action ${String(action)} failed:`, err);
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
					console.error("[otta] admin custom action fallback render failed:", fallbackErr);
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

// -- how a list states its size and its zero states (INC-12) ------------------

/**
 * THE SHARED ANSWER TO "how many, and what if none" — built once here because a
 * filtered-to-zero list is the most common empty state in a live store and every
 * screen was answering it with a different half-measure: one line of `empty_text`,
 * no count anywhere, and no way to undo the filter except reopening the panel and
 * emptying each field by hand.
 *
 * WHAT THE WIRE SUPPORTS, because the copy below is bounded by it. The three
 * admin list endpoints answer `{items, nextCursor, total}` — a page, a way to
 * ask for the next one, and (since INC-23) the exact size of the filtered set.
 * `total` is what the earlier version of this note called "a queued service
 * increment"; the queue moved. So the count this module renders is:
 *
 *  - the WHOLE (filtered) set — `17 orders` — whenever a `total` is present,
 *    on ANY page. It is a COUNT(*) under the same predicate as the page, so it
 *    is exact on page 3 of 3 as much as on page 1;
 *  - the WHOLE (filtered) set from the PAGE ITSELF — same wording — when there
 *    is no `total` but the render is the first page of its filter AND there is
 *    no next cursor. Both halves are needed for that inference: page 1 of many
 *    counts a page, and page 3 of 3 knows nothing about pages 1 and 2 (keyset
 *    paging carries no running offset, and the scaffold deliberately does not
 *    accumulate one across stateless interactions);
 *  - THIS PAGE otherwise — `25 orders on this page`, which is a smaller claim
 *    and a true one. That is now the fallback for a service older than `total`,
 *    and for a level that deliberately withholds one because it narrowed the
 *    fetched page itself (see `ListLevelDef.fetchPage`'s `total`).
 *
 * NOTHING HERE INVENTS A TOTAL. A count that says the set is bigger than the
 * page must have been told so by the service; a renderer that guessed one would
 * produce exactly the number an operator reconciles against and loses.
 *
 * ZERO RENDERS NO COUNT AT ALL — zero ROWS, whatever the `total` says, and a
 * `total` of zero. `0 orders` is never emitted: at zero the state below already
 * says it in words, and a count line repeating it is the "unknown rendered as 0"
 * failure in a costume. A `total` above an empty page is the same self-
 * contradiction from the other direction, and is suppressed with it.
 */

/** A row noun in the two forms `Intl.PluralRules` picks between for the pinned
 *  locale — `{one: "order", other: "orders"}`. A screen states its own noun
 *  because only it knows what its rows are. */
export interface RowNoun {
	readonly one: string;
	readonly other: string;
}

/** The pinned locale the count is pluralized in — deliberately the console's ONE
 *  locale knob ({@link DATE_LOCALE}), so the day a real viewer locale is threaded
 *  through, the count follows the dates instead of needing its own hunt. Same
 *  narrow claim as the date dialect makes (G6): this is single-point
 *  LOCALIZABILITY, not a localized console. */
const COUNT_PLURALS = new Intl.PluralRules(DATE_LOCALE);

/** The numeral's own formatter, so a locale that does not use ASCII digits gets
 *  its own the day one is threaded — the same single-point argument the noun and
 *  the dates make. Hoisted to module scope like the date dialect's three
 *  formatters (`datetime.ts`): an `Intl` constructor is the expensive half, and
 *  building one per rendered list would pay it on every interaction. */
const COUNT_NUMERALS = new Intl.NumberFormat(DATE_LOCALE);

/** The suffix that keeps a page-scoped count from reading as a whole-set one. */
const PAGE_SCOPED_SUFFIX = "on this page";

/** The label of the affordance INC-12 adds. MODULE-PRIVATE, and it stays that
 *  way: the sharing that matters is {@link clearFiltersButton}, which carries the
 *  label AND the bare-`apply-filter` payload AND the path carry together — a
 *  screen that reached for the label alone would be re-deriving the other two.
 *  `tax-page.ts` and `shipping-page.ts` still hand-roll the whole button; they
 *  adopt the BUILDER when they are next touched, not this string. */
const CLEAR_FILTERS_LABEL = "Clear filters";

/** The trailing half of a "there is another page behind this one" note. */
const SCAN_FURTHER = "Load more scans further.";

/** The lead half of that note when NO filter is on — a page that came back empty
 *  with a cursor still behind it is not an empty collection, so it must not
 *  borrow the filtered wording (nor the `empty` block). */
const NOTHING_ON_PAGE = "Nothing on this page.";

/**
 * The zero state for a page that is NOT the first one and has nothing behind it:
 * the operator paged forward and the next page came back empty.
 *
 * IT GETS ITS OWN WORDING BECAUSE THE SCREEN'S DOES NOT APPLY. A screen's
 * `empty` copy ("No orders yet", "No products yet") is a claim about the WHOLE
 * COLLECTION, and on page 2+ the renderer has no standing to make one — page 1
 * had rows. That is the same species of unearned claim the count line already
 * refuses, and it is reachable in a live store: two look-ahead reads either side
 * of a concurrent delete leave a cursor pointing past the last row.
 *
 * Deliberately offers NOTHING to click: no filter is on, so there is nothing to
 * clear, and Block Kit has no "back to the first page" control to fabricate.
 */
const PAGE_ZERO: Omit<ZeroStateCopy, "blockId"> = {
	title: "Nothing on this page",
	description:
		"This page came back empty. The list may have changed since the page before it was loaded — reload the screen to see it as it stands now.",
};

/**
 * `17 orders` · `1 order` · `25 orders on this page`, or `undefined` at zero.
 *
 * `complete` is the caller's claim that the PAGE count covers the whole filtered
 * set (see the module note above: `firstPage && nextToken === undefined`).
 * Getting it wrong is one of the two ways this function can lie, which is why
 * {@link listResult} derives it rather than letting a screen assert it.
 *
 * `total` is the service's own count of that set (INC-23). When present it
 * OVERRIDES both the page count and the page-scoped suffix — an exact whole-set
 * figure needs neither, on any page. It is validated here rather than trusted:
 * a non-integer, negative, or below-the-page count is a service that disagrees
 * with itself, and the page-scoped fallback (a claim this render can back up on
 * its own) is the safe direction. `total < count` is impossible for a count and
 * a page taken under one predicate — but they are two statements, so a
 * concurrent insert/delete between them is the ordinary case, and only the
 * direction that would UNDERSTATE the rows an operator can see is refused.
 */
export function rowCountLine(
	count: number,
	noun: RowNoun,
	opts: { complete: boolean; total?: number },
): string | undefined {
	// ZERO ROWS RENDER NO COUNT — `total` present or not. The alternative,
	// "17 orders" sitting immediately above "No orders yet" or "Nothing on this
	// page", is the screen contradicting itself in two adjacent blocks, which is
	// the same class of defect this module exists to police. The zero state owns
	// that render and says what happened in words.
	if (count <= 0) return undefined;
	const usable =
		opts.total !== undefined &&
		Number.isSafeInteger(opts.total) &&
		opts.total >= 0 &&
		opts.total >= count;
	const n = usable ? (opts.total ?? 0) : count;
	if (n <= 0) return undefined;
	const word = COUNT_PLURALS.select(n) === "one" ? noun.one : noun.other;
	const formatted = COUNT_NUMERALS.format(n);
	return usable || opts.complete
		? `${formatted} ${word}`
		: `${formatted} ${word} ${PAGE_SCOPED_SUFFIX}`;
}

/**
 * The `Clear filters` control, wherever it appears.
 *
 * A BARE `apply-filter` IS THE CLEAR: it carries no `values`, so the scaffold
 * rebuilds the level's DEFAULT filter (`filterFromValues({})`) and re-lists. The
 * drill path rides in `value`, never in a `block_id` — a button echoes no
 * `block_id` (L-6, B-1) — which is also what keeps the operator's place in the
 * nav path: the dispatcher reads `value.__path` and re-lists THAT level, not the
 * root.
 *
 * This is the sanctioned, EXPLICIT way to drop a filter. The `back` button drops
 * one too (it re-renders the parent level with its default filter), but that is
 * an implicit side effect of navigating and is not touched here.
 */
export function clearFiltersButton(actions: ScreenActions, path: NavPath): ButtonElement {
	return {
		type: "button",
		action_id: actions.applyFilter,
		label: CLEAR_FILTERS_LABEL,
		value: { [PATH_FIELD]: encodePath(path) },
	};
}

/** The wording of ONE zero state. Screens author every string: six screens
 *  describe their rows differently, and a generic "No results" would be the
 *  half-measure this replaces. */
export interface ZeroStateCopy {
	/** The heading — short, and never accusatory. */
	title: string;
	/** One or two sentences saying what is going on and what to do next
	 *  (≤200 chars, X-11's `empty.description` budget). */
	description: string;
	/** The `empty` block's React key. */
	blockId: PlainBlockId;
}

export interface ListResultOptions {
	/** For the `Clear filters` button's target. */
	actions: ScreenActions;
	/** This level's drill path, so the clear re-lists HERE. */
	path: NavPath;
	/** Rows on the page about to be rendered. */
	count: number;
	/** Whether any filter is on — the same boolean the active-filter summary is
	 *  derived from, so the count line, the summary and the zero state cannot
	 *  disagree about it. */
	filtered: boolean;
	/** `render`'s own `firstPage`. */
	firstPage: boolean;
	/** `render`'s own `nextToken`. */
	nextToken: string | undefined;
	/** `render`'s own `total` — the exact size of the filtered set when the
	 *  service reports one. Absent ⇒ the count falls back to describing the page
	 *  (see the module note above). */
	total?: number;
	noun: RowNoun;
	/** Zero rows and NO filter on: the collection itself is empty. Non-accusatory
	 *  by construction — nothing has gone wrong — and it may offer the way IN
	 *  (`actions`, e.g. Coupons' "New coupon") where such a way exists. */
	empty: ZeroStateCopy & { actions?: readonly Element[] };
	/** Zero rows WITH a filter on: the operator narrowed to nothing, so the way out
	 *  is the filter. The `Clear filters` button is appended by this function — a
	 *  screen never supplies it, so it can never be forgotten on one screen. */
	noMatch: ZeroStateCopy & {
		/** The table's `empty_text` for this filter — still needed, because a table
		 *  WITH rows carries it against a later render. */
		emptyText: string;
		/** The "another page remains" note, when the screen has better words for it
		 *  than the default `${emptyText} ${SCAN_FURTHER}`. */
		scanNote?: string;
	};
}

/**
 * What a list level renders in place of (or alongside) its table. FIVE outcomes,
 * and the third one is the one that is easy to get wrong:
 *
 *  1. **Rows.** `emptyBlock` undefined — the screen renders its table as usual,
 *     with `emptyText` on it.
 *  2. **Zero, unfiltered, FIRST page, no next page.** The collection is empty:
 *     `emptyBlock` carries the screen's `empty` copy and REPLACES the table (E-2).
 *  2b. **Zero, unfiltered, NOT the first page.** The same shape with
 *     {@link PAGE_ZERO}'s page-scoped wording instead — the screen's copy is a
 *     whole-collection claim this render has not earned.
 *  3. **Zero with ANOTHER PAGE BEHIND IT.** No `empty` block and NO `emptyText`,
 *     plus a `scanNote` — the pinned renderer short-circuits a zero-row table
 *     that carries `empty_text` to a bare `<p>` (`blocks/table.tsx`) AND takes
 *     the "Load more" button with it, so both would strand an operator mid-scan
 *     on a page that is not the end of anything. A headers-only table keeps
 *     `Load more` alive and the note says what to do with it. (Established by the
 *     stock increment for the low-stock filter, which narrows the FETCHED PAGE;
 *     generalized here so no screen has to rediscover it.)
 *  4. **Zero, filtered, last page.** `emptyBlock` carries the screen's `noMatch`
 *     copy plus the `Clear filters` button, and replaces the table.
 */
export interface ListResult {
	/** `17 orders` for the intro line, or `undefined` at zero. */
	countLine: string | undefined;
	/** Render INSTEAD of the table when set. */
	emptyBlock: EmptyBlock | undefined;
	/** The table's `empty_text` — `undefined` means OMIT IT (outcome 3). */
	emptyText: string | undefined;
	/** A trailing `context` line, set only in outcome 3. */
	scanNote: ContextBlock | undefined;
}

export function listResult(opts: ListResultOptions): ListResult {
	const countLine = rowCountLine(opts.count, opts.noun, {
		complete: opts.firstPage && opts.nextToken === undefined,
		...(opts.total !== undefined ? { total: opts.total } : {}),
	});
	if (opts.count > 0) {
		return {
			countLine,
			emptyBlock: undefined,
			emptyText: opts.noMatch.emptyText,
			scanNote: undefined,
		};
	}
	if (opts.nextToken !== undefined) {
		const lead = opts.filtered ? opts.noMatch.emptyText : NOTHING_ON_PAGE;
		return {
			countLine,
			emptyBlock: undefined,
			emptyText: undefined,
			scanNote: {
				type: "context",
				text: opts.noMatch.scanNote ?? `${lead} ${SCAN_FURTHER}`,
			},
		};
	}
	// THE SCREEN'S `empty` COPY IS A WHOLE-COLLECTION CLAIM, so it is gated on
	// `firstPage` exactly as the count line is. "No orders yet" on page 2 is the
	// same unearned claim as "17 orders" would be there — and it is reachable in a
	// live store, not only in theory: the look-ahead read that minted the cursor
	// and the read that follows it straddle a concurrent delete, and the second
	// comes back empty. Page 2+ therefore falls through to page-scoped wording.
	//
	// `noMatch` is NOT gated the same way, and the asymmetry is deliberate: it
	// names the operator's OWN filter rather than the collection, and the undo it
	// carries is the right next act on any page. A screen whose filter narrows the
	// FETCHED PAGE says so in its own words (`products-page.ts`), which is where a
	// page-scoped reading of a filtered miss belongs.
	const copy = opts.filtered
		? opts.noMatch
		: opts.firstPage
			? opts.empty
			: { ...PAGE_ZERO, blockId: opts.empty.blockId };
	// The three states differ in their ACTIONS as much as in their words: a
	// narrowed-to-nothing list offers the undo, an empty collection offers the way
	// in, and a page that ran off the end offers neither (an `empty` block with no
	// actions is a valid state — `emptyState` omits the key rather than emitting
	// `[]`).
	const actions = opts.filtered
		? [clearFiltersButton(opts.actions, opts.path)]
		: opts.firstPage
			? (opts.empty.actions ?? [])
			: [];
	return {
		countLine,
		emptyBlock: emptyState({
			title: copy.title,
			description: copy.description,
			size: "base",
			actions,
			blockId: copy.blockId,
		}),
		emptyText: opts.noMatch.emptyText,
		scanNote: undefined,
	};
}

/** The list's intro `context` line with its row count in front —
 *  `17 orders · Filter, open an order, …`. The count leads because it is the one
 *  part of the line that changes, and the standing sentence is what an operator
 *  stops reading after the first visit. */
export function listIntroLine(countLine: string | undefined, intro: string): ContextBlock {
	return { type: "context", text: countLine === undefined ? intro : `${countLine} · ${intro}` };
}

// -- shared payload parsing (exported: screens reuse the same coercions) -------

export function readString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * Read a `toggle` field's submitted value. `toggle` emits a REAL boolean
 * (`elements/toggle.tsx`), not a string — {@link readString} is `typeof
 * value === "string" ? value : undefined`, so every parser that read a toggle
 * with `readString(values.x) === "true"` silently got `undefined !== "true"`,
 * i.e. always `false`, on a field that appeared to save and never persisted
 * (design spec F-6). A toggle is mount-only (R-12) and MUST declare an
 * `initial_value` (F-6b/X-24) or it is simply absent from `values` — this
 * function does not paper over that; it only fixes the type coercion once the
 * field is present.
 */
export function readBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
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
