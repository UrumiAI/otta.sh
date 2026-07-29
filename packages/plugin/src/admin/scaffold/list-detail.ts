import type { Block, BlockResponse, PluginContext, RouteHandler } from "../../types.js";
import type { ScreenActions } from "./actions.js";
import type { Notice } from "./banner.js";
import { type CarriedContext, decodeCarrier } from "./carrier.js";
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
	/** The originating block's `block_id`, echoed back by em-dash on a form
	 *  submit (`form.tsx:57`) and on a table's sort/load-more `block_action`
	 *  (`table.tsx:55,64`). Block Kit has no hidden field, so this is where a form
	 *  carries context it must not show an operator — decoded via
	 *  {@link readCarrier}. */
	block_id?: unknown;
}

// -- level definitions (public factories, strongly typed per screen) ----------

/** A keyset-paged list level. Generic in the screen's `Client`, filter-form
 *  shape `Filter`, and row-summary type `Summary`. */
export interface ListLevelDef<Client, Filter, Summary> {
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
	}): Block[];
	/** Fail-closed response when the page read cannot reach the service. */
	onError(): BlockResponse;
}

/** A leaf detail level. Generic in the screen's `Client` and primary `Detail`. */
export interface LeafLevelDef<Client, Detail> {
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
	}): Promise<Block[]> | Block[];
	/** Blocks for a missing record (id resolved to `null`). */
	notFound(args: { actions: ScreenActions; path: NavPath; id: string }): Block[];
	/** Fail-closed response when the primary read cannot reach the service. */
	onError(): BlockResponse;
}

/** The engine-facing (type-erased) level shape. Screens never build this
 *  directly — {@link listLevel}/{@link leafLevel} produce it from typed defs. */
export type LevelDef =
	| ({ kind: "list" } & ListLevelDef<unknown, unknown, unknown>)
	| ({ kind: "leaf" } & LeafLevelDef<unknown, unknown>);

export function listLevel<Client, Filter, Summary>(
	def: ListLevelDef<Client, Filter, Summary>,
): LevelDef {
	// SAFETY (existential-type erasure): the engine stores levels type-erased
	// (`unknown`) because one `levels` array mixes levels of different Client/
	// Filter/Summary types. The casts below are sound because this closure is the
	// ONLY producer AND consumer of those `unknown`s for this level: `client` is
	// always the value `config.createClient` returned, `filter` is always a value
	// THIS level's `filterFromValues` produced (the engine never fabricates or
	// cross-wires one level's filter into another), and `items` are always what
	// THIS level's `fetchPage` returned. The typed `def` never sees a foreign value.
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

export function leafLevel<Client, Detail>(def: LeafLevelDef<Client, Detail>): LevelDef {
	// SAFETY: same existential-erasure argument as `listLevel` — `client` is
	// always `config.createClient`'s value, and `detail` is always what THIS
	// level's `load` returned, round-tripped through the engine unchanged.
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

/** The re-render surface a custom action calls once its side effect is done. */
export interface CustomActionApi<Client> {
	input: ListDetailInput;
	client: Client;
	/** The hidden context the originating form carried in its `block_id` —
	 *  decoded once per interaction, `undefined` when the block carried none (or
	 *  carried something that is not a carrier token). This is what replaces the
	 *  single-option "carrier" `select` fields: read `carried.orderId` instead of
	 *  `input.values.orderId`. Every value is UNTRUSTED operator-round-tripped
	 *  input — re-authorize it exactly as you would a select's value. */
	carried: CarriedContext | undefined;
	/** Re-render the leaf at `path` (its id is `path`'s last element), optionally
	 *  with a notice banner. */
	showLeaf(path: NavPath, notice?: Notice): Promise<BlockResponse>;
	/** Re-render the list at `path` (default: the root list), optionally with a
	 *  notice banner — the list-level counterpart to `showLeaf`'s notice, for a
	 *  custom action whose target level is a list (e.g. a create/edit/delete on
	 *  a screen with no leaf level, such as a two-list-level registry drill-down). */
	showList(path?: NavPath, notice?: Notice): Promise<BlockResponse>;
}

export type CustomActionFn<Client> = (api: CustomActionApi<Client>) => Promise<BlockResponse>;

export function customAction<Client>(fn: CustomActionFn<Client>): CustomActionFn<unknown> {
	// SAFETY: same existential-erasure argument as `listLevel`/`leafLevel` —
	// `api.client` is always the value `config.createClient` returned.
	return (api) => fn({ ...api, client: api.client as Client });
}

// -- the screen + its handler -------------------------------------------------

export interface ListDetailScreenConfig {
	actions: ScreenActions;
	/** Build the token-threaded `ctx.http` client for this screen. */
	createClient(ctx: PluginContext): Promise<unknown> | unknown;
	/** Levels indexed by drill depth (index 0 = root list). */
	levels: LevelDef[];
	/** Resolve an `open` interaction to the FULL target path (ancestors + the
	 *  selected id). The scaffold renders `levels[targetPath.length]` at it —
	 *  a leaf or a deeper list. Undefined ⇒ fall back to the root list. */
	parseOpen(input: ListDetailInput): { targetPath: NavPath } | undefined;
	/** Screen-specific side-effecting actions, keyed by full action id. */
	customActions?: Record<string, CustomActionFn<unknown>>;
}

/**
 * Build the single `RouteHandler` for a list/detail screen. The returned
 * handler is what the admin-route dispatcher forwards `open`/`back`/`page`/
 * `apply-filter`/custom-action interactions (and the page-load default) to.
 */
export function createListDetailHandler(
	config: ListDetailScreenConfig,
): RouteHandler<ListDetailInput> {
	const { actions, levels } = config;

	return async (routeCtx, ctx) => {
		const input = routeCtx.input;
		const action = readString(input.action_id);
		const client = await config.createClient(ctx);

		const listLevelAt = (depth: number): (LevelDef & { kind: "list" }) | undefined => {
			const level = levels[depth];
			return level !== undefined && level.kind === "list" ? level : undefined;
		};

		const renderList = async (
			path: NavPath,
			filter: unknown,
			cursor?: string,
			notice?: Notice,
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
			} catch {
				return level.onError();
			}
		};

		const renderLeaf = async (path: NavPath, notice?: Notice): Promise<BlockResponse> => {
			const level = levels[path.length];
			const id = path[path.length - 1];
			if (level === undefined || level.kind !== "leaf" || id === undefined) return { blocks: [] };
			let detail: unknown;
			try {
				detail = await level.load(client, path, id);
			} catch {
				return level.onError();
			}
			if (detail === null) return { blocks: level.notFound({ actions, path, id }) };
			return { blocks: await level.render({ client, actions, path, id, detail, notice }) };
		};

		/** Render whichever level `path` lands on — a leaf, a deeper list, or the
		 *  root list (an empty path). Lists open with their default (empty) filter. */
		const renderPath = async (path: NavPath, notice?: Notice): Promise<BlockResponse> => {
			const level = levels[path.length];
			if (level === undefined) return { blocks: [] };
			if (level.kind === "leaf") return renderLeaf(path, notice);
			return renderList(path, level.filterFromValues({}), undefined, notice);
		};

		const rootList = (notice?: Notice): Promise<BlockResponse> => {
			const root = listLevelAt(0);
			return root === undefined
				? Promise.resolve({ blocks: [] })
				: renderList([], root.filterFromValues({}), undefined, notice);
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
			return (await custom({
				input,
				client,
				carried: readCarrier(input),
				showLeaf: (path, notice) => renderLeaf(path, notice),
				showList: (path, notice) =>
					path === undefined ? rootList(notice) : renderPath(path, notice),
			})) as Awaited<ReturnType<RouteHandler<ListDetailInput>>>;
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
 * Total: a missing, non-carrier or malformed `block_id` yields `undefined`.
 */
export function readCarrier(input: ListDetailInput): CarriedContext | undefined {
	return decodeCarrier(input.block_id);
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
	const fromCarrier = readCarrier(input)?.[PATH_FIELD];
	if (fromCarrier !== undefined) return decodePath(fromCarrier) ?? undefined;
	return undefined;
}
