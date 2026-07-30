/**
 * Minimal local mirror of the EmDash sandboxed-plugin surface Urumi depends
 * on (verified against `~/em-dash`: `packages/core/src/plugins/types.ts`,
 * `packages/core/src/plugin-types.ts`, `packages/blocks/src/types.ts`).
 *
 * Urumi is a standalone repo (DEVELOPMENT.md preamble — "mirrors EmDash's
 * conventions without inheriting its config") and does not depend on the
 * `emdash` package at runtime; a real sandboxed EmDash plugin would instead
 * write `import type { PluginContext, SandboxedPlugin } from "emdash/plugin"`
 * (a types-only import erased at build time). These types are a deliberately
 * narrow subset — only what Urumi's hooks/routes/widget actually touch.
 */

// -- content lifecycle hooks -------------------------------------------------

/** `ContentHookEvent` (em-dash `types.ts:711-715`). */
export interface ContentHookEvent {
	content: Record<string, unknown>;
	collection: string;
	isNew: boolean;
}

/** `ContentDeleteEvent` (em-dash `types.ts:720-725`). No `content`/`updatedAt`
 *  is available on this event — only `id`/`collection`/`permanent`. */
export interface ContentDeleteEvent {
	id: string;
	collection: string;
	permanent: boolean;
}

/**
 * `ContentStateChangeEvent` (em-dash `packages/core/src/plugins/types.ts:731-734`)
 * — fired after publish/unpublish/restore/schedule/unschedule. Confirmed
 * reaching SANDBOXED plugins verbatim as `{ content, collection }` via
 * `EmDashRuntime.runDeferredContentHook` → `plugin.invokeHook(name, {
 * content, collection })` (`emdash-runtime.ts:3496-3510`); `content` is the
 * full published `ContentItem` record (spread by `contentItemToRecord`,
 * `emdash-runtime.ts:363-365`), so `content.id`/`content.updatedAt` are
 * present exactly like `ContentHookEvent`. `content:afterPublish` requires
 * only `content:read` to register (`hooks.ts` `HOOK_REQUIRED_CAPABILITY`),
 * same as `afterSave`/`afterDelete` — no new capability needed. */
export interface ContentStateChangeEvent {
	content: Record<string, unknown>;
	collection: string;
}

// -- context / capabilities ---------------------------------------------------

/** The `network:request` capability's surface (em-dash `createHttpAccess`,
 *  `context.ts:619-671`) — the ONLY egress a sandboxed plugin gets.
 *  Property-style signature (not a method) so the direct-fetch grep guard
 *  (`test/sandbox-clean-guard.test.ts`) sees no bare fetch-invocation token
 *  in this declaration. */
export interface HttpAccess {
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Non-secret key/value store (em-dash `KVAccess`, `packages/core/src/plugins/
 * types.ts:163-168`). VERIFIED: `kv` is NOT capability-gated in EmDash
 * (`context.ts:1002-1003` builds it unconditionally; the sandbox bridge's
 * `kv/*` cases call no `requireCapability`, unlike `http/fetch`) — so using it
 * needs no manifest capability and keeps the sandbox-clean guard green. It is
 * last-writer-wins with NO CAS/uniqueness guarantee, which is exactly why the
 * settings design (§5.1) reserves it for cosmetic, display-only prefs the
 * SERVICE never reads (`storeDisplayName`) and never for anything the domain
 * depends on. Keys are transparently namespaced `plugin:<id>:` by the host;
 * the convention is `settings:*` for user-configurable prefs (em-dash
 * `types.ts:159-162`). SECRETS MUST NEVER be written here (§5). Method is
 * `set` (not `put`) — verified against em-dash. */
export interface KvAccess {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}

/**
 * The context passed to every hook/route handler. Urumi's plugin declares
 * only `content:read` + `network:request` (manifest.ts) — so `http` is the
 * only capability-gated surface it ever receives. `kv` is available WITHOUT a
 * capability (verified above) and holds only non-secret display prefs. No
 * `content`/`media`/`users`/`email`/`storage`/`db` — declaring any of those
 * would fail the sandbox-clean guard (DEVELOPMENT.md §5).
 */
export interface PluginContext {
	http: HttpAccess;
	kv: KvAccess;
}

// -- routes -------------------------------------------------------------------

export interface SandboxedRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
}

export interface SandboxedRouteContext<TInput = unknown> {
	input: TInput;
	request: SandboxedRequest;
}

export type RouteHandler<TInput = unknown> = (
	routeCtx: SandboxedRouteContext<TInput>,
	ctx: PluginContext,
) => Promise<unknown>;

export type RouteEntry<TInput = unknown> =
	| RouteHandler<TInput>
	| { handler: RouteHandler<TInput>; public?: boolean };

// -- hooks ----------------------------------------------------------------

export type HookHandler<TEvent> = (event: TEvent, ctx: PluginContext) => Promise<unknown> | unknown;

export interface SandboxedPluginHooks {
	"content:afterSave"?: { handler: HookHandler<ContentHookEvent> };
	"content:afterDelete"?: { handler: HookHandler<ContentDeleteEvent> };
	"content:afterPublish"?: { handler: HookHandler<ContentStateChangeEvent> };
	"content:afterUnpublish"?: { handler: HookHandler<ContentStateChangeEvent> };
}

/** The shape a sandboxed plugin's entry module default-exports (em-dash:
 *  `export default { hooks?, routes? } satisfies SandboxedPlugin`). */
export interface SandboxedPlugin {
	hooks?: SandboxedPluginHooks;
	routes?: Record<string, RouteEntry>;
}

// -- admin / Block Kit (em-dash `packages/blocks/src/types.ts`) -------------

export type FieldType =
	| "string"
	| "text"
	| "url"
	| "number"
	| "integer"
	| "boolean"
	| "datetime"
	| "select"
	| "multiSelect"
	| "portableText"
	| "image"
	| "file"
	| "reference"
	| "json"
	| "slug"
	| "repeater";

/**
 * NO `disabled` ON ANY ELEMENT — deliberately, and do not re-add it. em-dash
 * 0.31.1's element types have no such field and none of its renderers read one
 * (`packages/blocks/src/elements/*.tsx`, `render-element.tsx`), so a `disabled`
 * element would render as a FULLY LIVE control that merely looks handled. It was
 * declared on all four of these interfaces until this file's layout-vocabulary
 * widening and was never set by any screen. To withhold an action, omit the
 * element (or gate it behind a `confirm`); to show a read-only value, render it
 * as `fields`/`context` text, not as an input.
 *
 * Inputs are also UNCONTROLLED (`defaultValue`), so `initial_value` is read once
 * at mount — see `admin/scaffold/carrier.ts` on why a form's `block_id` has to
 * change when its prefilled values do.
 */
export interface TextInputElement {
	type: "text_input";
	action_id: string;
	label?: string;
	placeholder?: string;
	initial_value?: string;
	/** Renders a textarea (em-dash `TextInputElement.multiline`). */
	multiline?: boolean;
}

export interface NumberInputElement {
	type: "number_input";
	action_id: string;
	label?: string;
	initial_value?: number;
}

/** `toggle` (em-dash `packages/blocks/src/types.ts` `ToggleElement`) — a boolean
 *  switch. Submits a real boolean, so a screen reading it must coerce with
 *  `typeof v === "boolean"`, not `readString`. */
export interface ToggleElement {
	type: "toggle";
	action_id: string;
	label: string;
	description?: string;
	initial_value?: boolean;
}

/** `combobox` (em-dash `ComboboxElement`) — a `select` with type-ahead over its
 *  own `options`. Use it where a `select`'s option list is long enough to be
 *  unusable (a zone or product picker); the wire value is the chosen
 *  `option.value`, exactly like `select`. NOTE: em-dash's `SelectElement` also
 *  has an `optionsRoute` for server-populated options, deliberately NOT mirrored
 *  — it would be a second, undeclared egress path out of the admin page. */
export interface ComboboxElement {
	type: "combobox";
	action_id: string;
	label: string;
	options: SelectOption[];
	initial_value?: string;
	placeholder?: string;
}

export interface SelectOption {
	value: string;
	label: string;
}

/**
 * `FieldCondition` (em-dash `packages/blocks/src/types.ts` `FieldCondition`) —
 * gates a `FormBlock` field's visibility against another field's LIVE value
 * (`blocks/form.tsx`'s `evaluateCondition`, re-run on every render against the
 * form's own `values` state). Verified present in the installed 0.31.1
 * renderer and unchanged from 0.29.0 (R-23).
 *
 * ADDED HERE (not by the #151 foundation revision, whose §0.1 B table did not
 * list it): the admin console spec's F-5b/R-23 already assume `condition`
 * exists on `FormField`, and the Coupons create form (condition-gated on
 * `type`) is its first consumer in this repo. `EmDash's own `FormField` is
 * `(element union) & { condition?: FieldCondition }`; mirrored the same way on
 * `FormBlock["fields"]` below rather than adding a per-field-spec property, so
 * every field kind gets it in one place. */
export type FieldCondition =
	| { field: string; eq?: unknown; neq?: never }
	| { field: string; neq?: unknown; eq?: never };

export interface SelectElement {
	type: "select";
	action_id: string;
	label?: string;
	options: SelectOption[];
	initial_value?: string;
}

/** `ConfirmDialog` (em-dash `packages/blocks/src/types.ts:3-9`) — the modal a
 *  button raises before firing. ALL of `{title, text, confirm, deny}` are
 *  REQUIRED by the authoritative type (MOD-8); `style:"danger"` tints it. */
export interface ConfirmDialog {
	title: string;
	text: string;
	confirm: string;
	deny: string;
	style?: "danger";
}

export interface ButtonElement {
	type: "button";
	action_id: string;
	label: string;
	/**
	 * Arbitrary JSON echoed back as `BlockAction.value` on click (em-dash
	 * `packages/blocks/src/types.ts:13-20`) — Block Kit elements CAN carry a
	 * payload straight to the plugin route (plan §8 Risk 5).
	 *
	 * THIS IS A BUTTON'S ONLY CONTEXT CHANNEL. A button fires
	 * `{type:"block_action", action_id, value}` and NOTHING ELSE — verified in the
	 * installed 0.31.1 renderer: `ButtonElementComponent` emits no `block_id`, and
	 * `ActionsBlockComponent`/`EmptyBlockComponent`/`SectionBlockComponent` all
	 * call `renderElement(el, onAction)` without passing their own block id. So a
	 * carrier token on the enclosing `actions`/`empty`/`section` block would never
	 * come back; put the context here instead (see `admin/scaffold/carrier.ts`).
	 */
	value?: unknown;
	/** Visual emphasis (em-dash `ButtonElement.style`) — `danger` for a
	 *  destructive transition (cancel/refund). */
	style?: "primary" | "danger" | "secondary";
	/** A confirm dialog raised before the action fires (em-dash
	 *  `ButtonElement.confirm`) — required on destructive transitions. */
	confirm?: ConfirmDialog;
}

/** Discriminated union — a subset of em-dash's 12-member `Element`
 *  (`packages/blocks/src/types.ts`); `checkbox`, `radio`, `repeater`,
 *  `media_picker` and `secret_input` (which has its own field spec below) are
 *  supported by the renderer but nothing in Urumi emits them as elements. */
export type Element =
	| TextInputElement
	| NumberInputElement
	| SelectElement
	| ToggleElement
	| ComboboxElement
	| ButtonElement;

/** `FieldWidgetConfig` (em-dash `types.ts:1249-1258`). `elements` (not
 *  `entry`) is the sandboxed/Block-Kit form — no React (DEVELOPMENT.md §5). */
export interface FieldWidgetConfig {
	name: string;
	label: string;
	fieldTypes: FieldType[];
	elements: Element[];
}

// -- page-level Block Kit blocks (em-dash `packages/blocks/src/types.ts`) -----
// A narrow subset — the blocks the admin console actually renders. Snake_case
// field names follow the authoritative wire types (em-dash `types.ts`), matching
// Urumi's existing element types.

/** The phantom brand distinguishing a carrier `block_id` from a plain React key.
 *  NAMED FOR THE ERROR MESSAGE: tsc prints both the property name and the string
 *  below when the rule is broken, so an author sees the rule rather than a bare
 *  `Type '"carrier"' is not assignable to type 'undefined'`. */
declare const CARRIER_ONLY_ON_FORM_OR_TABLE: unique symbol;

/** What the compiler prints on a misplaced carrier. */
type CarrierRule = "only form and table echo block_id back; a button carries context in value";

/**
 * A `block_id` that is ONLY a React key — the safe default, and what every block
 * except `form`/`table` accepts.
 *
 * Any plain `string` satisfies it, but a {@link CarrierBlockId} deliberately does
 * NOT: putting a carrier token on a block that never echoes it back is a compile
 * error rather than an `api.carried` that is silently `undefined` at runtime.
 */
export type PlainBlockId = string & {
	readonly [CARRIER_ONLY_ON_FORM_OR_TABLE]?: undefined;
};

/**
 * A `block_id` carrying encoded hidden context (`admin/scaffold/carrier.ts`'s
 * `encodeCarrier`). Assignable ONLY to `FormBlock.block_id` and
 * `TableBlock.block_id`, because those are the only two blocks whose interactions
 * echo `block_id` back to the plugin.
 *
 * The brand is launderable (`as PlainBlockId` compiles) — it is a signpost, not a
 * wall. If you find yourself writing that cast, the block you are labelling does
 * not echo `block_id`, and the context has to go in `ButtonElement.value` instead.
 */
export type CarrierBlockId = string & {
	readonly [CARRIER_ONLY_ON_FORM_OR_TABLE]: CarrierRule;
};

/**
 * `BlockBase` (em-dash `packages/blocks/src/types.ts` `BlockBase`) — EVERY block
 * may carry an opaque `block_id`, which in the pinned 0.31.1 renderer is the
 * React key of a block within its list (`renderer.tsx`, `block.block_id ?? i`).
 * Two blocks in the SAME list must never share one; nested lists (a `columns`
 * column, a `tab` panel, an `accordion` body) get their own `BlockRenderer`, so
 * keys only have to be unique WITHIN one list — and a nested block's key is
 * therefore its index unless it sets one (which is why an accordion-wrapped form
 * is index-0-forever; see `carriedForm` in `admin/scaffold/carrier.ts`).
 *
 * IT IS NOT AN INTERACTION CHANNEL FOR MOST BLOCKS. Only `form` and `table` echo
 * `block_id` back — see {@link CarrierBlockBase}. On every other block it is a
 * key and nothing more, so this base accepts {@link PlainBlockId} only.
 */
export interface BlockBase {
	/** React key within this block's list. NEVER a carrier: this block's
	 *  interactions (if it has any) do not echo it back. */
	block_id?: PlainBlockId;
}

/**
 * The base for the ONLY two blocks whose interactions echo `block_id` back to the
 * plugin, so the only two that can carry hidden context. Verified against the
 * installed 0.31.1 renderer — exactly three echo sites exist:
 * `blocks/form.tsx` on `form_submit`, and `blocks/table.tsx` twice (a sortable
 * header click and "Load more"), both `block_action`. Buttons — including a
 * `section` accessory and an `empty` block's actions — carry NO `block_id`; their
 * only context channel is `ButtonElement.value`.
 */
export interface CarrierBlockBase {
	/** React key within this block's list, and the value echoed back on this
	 *  block's own interactions — so it may be a `CarrierBlockId`. */
	block_id?: PlainBlockId | CarrierBlockId;
}

export interface HeaderBlock extends BlockBase {
	type: "header";
	text: string;
}
export interface SectionBlock extends BlockBase {
	type: "section";
	text: string;
	/** A single trailing control on the same line as `text` (em-dash
	 *  `SectionBlock.accessory`, rendered by `blocks/section.tsx` via
	 *  `renderElement(block.accessory, onAction)`). This is where a
	 *  "Clear filters"-style affordance belongs — one line of prose plus its one
	 *  control — instead of a whole `actions` block below it. Because it is
	 *  rendered as a bare element, its interactions carry NO `block_id`: a button
	 *  accessory's only context channel is `ButtonElement.value`. */
	accessory?: Element;
}
export interface ContextBlock extends BlockBase {
	type: "context";
	text: string;
}
export interface DividerBlock extends BlockBase {
	type: "divider";
}
export interface StatItem {
	label: string;
	value: string;
	description?: string;
}
export interface StatsBlock extends BlockBase {
	type: "stats";
	items: StatItem[];
}
export interface TableColumn {
	key: string;
	label: string;
	/** Widened to include em-dash's `relative_time` (MOD-8) for the created-at
	 *  column; the authoritative union is
	 *  `"text"|"badge"|"relative_time"|"number"|"code"`. */
	format?: "text" | "number" | "badge" | "code" | "relative_time";
	/** Makes the column header clickable (em-dash `TableColumn.sortable`).
	 *
	 *  DO NOT SET THIS UNTIL SORT IS SUPPORTED END TO END. The renderer sorts
	 *  NOTHING: a click fires the table's `page_action_id` with
	 *  `value: {sort: {key, dir}}` and NO `cursor` (`blocks/table.tsx`) — the same
	 *  action id "Load more" uses — and the scaffold's `page` branch keys off
	 *  `value.cursor`. Worse than a dead header: `TableBlockComponent` sets
	 *  `cursor-pointer`, records the sort in local state and RENDERS AN ▲/▼ ARROW
	 *  on the clicked column, so it LOOKS like it sorted while the rows are
	 *  unchanged and the operator's filter is silently dropped by the re-render.
	 *  Honouring it needs a sort parameter threaded through
	 *  `ListLevelDef.fetchPage` into the service's list ports. */
	sortable?: boolean;
}
export interface TableBlock extends CarrierBlockBase {
	type: "table";
	columns: TableColumn[];
	rows: Array<Record<string, unknown>>;
	/** em-dash's authoritative `TableBlock` REQUIRES `page_action_id` (the
	 *  block_action id its "Load more" fires) and allows an optional `next_cursor`
	 *  (`packages/blocks/src/types.ts:271-278`). Kept OPTIONAL here (MOD-3
	 *  backward-compat): the Phase-7 Reports tables — shipped in PR #46 — omit
	 *  both, and widening must not break them. The Orders console ALWAYS supplies
	 *  `page_action_id` (and `next_cursor` when a next page exists), which is what
	 *  the production renderer requires. FOLLOW-UP: migrate the Reports tables to
	 *  carry `page_action_id` and tighten this to required. */
	page_action_id?: string;
	next_cursor?: string;
	empty_text?: string;
}
/**
 * `banner` — WIDENED to a backward-compatible SUPERSET of em-dash's
 * authoritative `BannerBlock` (`packages/blocks/src/types.ts:318-323`:
 * `{variant?: "default"|"alert"|"error"; title?; description?}`) plus Urumi's
 * legacy `{variant: "error"|"info"|"success"; text}` (MOD-3). The Reports/Settings
 * pages emit the legacy `{variant, text}` shape (unchanged, still typechecks);
 * the em-dash renderer shows NO body for those, so the Orders console emits the
 * em-dash-correct `{variant:"error", title, description}` shape so its banners
 * render in production. FOLLOW-UP: migrate Reports/Settings banners to
 * title/description and drop the legacy `text` field.
 */
export interface BannerBlock extends BlockBase {
	type: "banner";
	variant: "default" | "alert" | "error" | "info" | "success";
	/** Legacy Urumi body (Reports/Settings). */
	text?: string;
	/** em-dash-authoritative banner body. */
	title?: string;
	description?: string;
}
/** `fields` (em-dash `packages/blocks/src/types.ts:266-269`) — a label/value
 *  grid, used by the Orders detail view for the order's scalar fields (MOD-8). */
export interface FieldsBlock extends BlockBase {
	type: "fields";
	fields: Array<{ label: string; value: string }>;
}
/** `actions` (em-dash `packages/blocks/src/types.ts:280-283`) — a row of
 *  interactive elements (buttons), used for the detail view's Back + transition
 *  buttons (MOD-8). */
export interface ActionsBlock extends BlockBase {
	type: "actions";
	elements: Element[];
}
export interface FormFieldSpec {
	type: "text_input" | "number_input";
	action_id: string;
	label: string;
	initial_value?: string | number;
	placeholder?: string;
	/** Textarea. em-dash declares `multiline` on `text_input` ONLY; this spec
	 *  covers both input kinds (a pre-existing Urumi convenience), so it is
	 *  meaningless — and ignored by the renderer — on a `number_input`. */
	multiline?: boolean;
}
/** A `select` form field (em-dash `SelectElement`,
 *  `packages/blocks/src/types.ts:40-48`) — the Orders filter status picker + the
 *  open-order picker (MOD-8: needs `options` + `label`). */
export interface SelectFieldSpec {
	type: "select";
	action_id: string;
	label: string;
	options: SelectOption[];
	initial_value?: string;
}
/** A `date_input` form field (em-dash `DateInputElement`,
 *  `packages/blocks/src/types.ts:74-80`) — the Orders filter from/to bounds
 *  (MOD-8). */
export interface DateFieldSpec {
	type: "date_input";
	action_id: string;
	label: string;
	initial_value?: string;
	placeholder?: string;
}
/** A masked, write-only secret input (em-dash `SecretInputElement`,
 *  `packages/blocks/src/types.ts:58-64`). Deliberately carries NO
 *  `initial_value`: the stored secret is NEVER rendered back into a block.
 *  `has_value` lets the admin UI show a "current value set" affordance without
 *  exposing the value; `placeholder` carries the "leave blank to keep current"
 *  hint. */
export interface SecretInputFieldSpec {
	type: "secret_input";
	action_id: string;
	label: string;
	placeholder?: string;
	has_value?: boolean;
}
/**
 * `form` (em-dash `packages/blocks/src/types.ts` `FormBlock`). Fields ALWAYS
 * render as a full-width vertical stack — `blocks/form.tsx` wraps them in
 * `flex flex-col gap-4`, and the `FormField` union has no layout container — so a
 * form's own fields CANNOT be laid out side by side, in this or any 0.29.0 → 0.31.1
 * version. `ColumnsBlock` takes `Block[][]`, so splitting a filter across columns
 * would split its submit; the density answer for filters is to collapse the whole
 * form (`admin/scaffold/layout.ts`'s `filterPanel`), and `columns` is for putting
 * WHOLE blocks side by side.
 *
 * `block_id` (from {@link CarrierBlockBase}) IS echoed back on submit
 * (`blocks/form.tsx`), which is how a stateless form carries hidden context — see
 * `admin/scaffold/carrier.ts`, and prefer its `carriedForm` helper to setting this
 * by hand.
 */
export interface FormBlock extends CarrierBlockBase {
	type: "form";
	fields: Array<
		(
			| FormFieldSpec
			| SecretInputFieldSpec
			| SelectFieldSpec
			| DateFieldSpec
			| ToggleElement
			| ComboboxElement
		) & {
			/** Hide this field unless `condition` evaluates true against the
			 *  form's own live `values` (R-23). Used to keep a polymorphic create
			 *  form inside the visible-field budget (F-5b) — e.g. the coupon
			 *  create form's `amount`/`currency` fields are `condition`-gated on
			 *  `type === "fixed_amount"` and `ratePercent`/`cap` on
			 *  `type === "percentage"`, so both branches ship in one stateless
			 *  render and the operator's live selection decides which is drawn. */
			condition?: FieldCondition;
		}
	>;
	submit: { label: string; action_id: string };
}

/**
 * `columns` (em-dash `ColumnsBlock`) — the only horizontal layout primitive.
 * RENDERER BEHAVIOUR (`blocks/columns.tsx`): the grid is `grid-cols-2` when there
 * are EXACTLY two columns and `grid-cols-3` otherwise, so one column renders at a
 * third of the width and four or more columns wrap onto further rows of three.
 * Each column is rendered by its own nested `BlockRenderer`, so blocks nest
 * arbitrarily and `block_id` keys only have to be unique within a column.
 */
export interface ColumnsBlock extends BlockBase {
	type: "columns";
	columns: Block[][];
}

/** One `tab` panel (em-dash `TabPanel`). */
export interface TabPanel {
	label: string;
	blocks: Block[];
}
/** `tab` (em-dash `TabBlock`). Tab state is CLIENT side only: switching panels
 *  re-renders locally and fires no interaction, so every panel's blocks must be
 *  built on the same server render. `default_tab` is a zero-based index into
 *  `panels`.
 *
 *  ONE WART: em-dash's own `validateBlocks` does NOT list `"tab"` in its
 *  `BLOCK_TYPES` set (checked in the installed 0.31.1 `validation-*.js`), so a
 *  validating tool reports `Unknown block type 'tab'` even though the renderer
 *  dispatches it correctly. Harmless for us — nothing in the EmDash runtime or
 *  admin app calls `validateBlocks` — but do not "fix" our blocks in response to
 *  such a report. Fork PR #7 addresses it upstream; we would pick it up on a
 *  future release. */
export interface TabBlock extends BlockBase {
	type: "tab";
	panels: TabPanel[];
	default_tab?: number;
}

/** `empty` (em-dash `EmptyBlock`) — the "nothing here" state as ONE block (icon +
 *  title + optional description/command line/actions) instead of a section heading
 *  plus an empty table. `command_line` renders as a copyable shell command (never
 *  appropriate on these operator screens — there is no command an operator should
 *  run); `actions` are rendered ELEMENTS, not blocks, and like every bare element
 *  their interactions carry no `block_id`. */
export interface EmptyBlock extends BlockBase {
	type: "empty";
	title: string;
	description?: string;
	command_line?: string;
	size?: "sm" | "base" | "lg";
	actions?: Element[];
}

/** `accordion` (em-dash `AccordionBlock`) — a collapsible body, closed unless
 *  `default_open`. Open/close is CLIENT side only (no interaction fires), so the
 *  collapsed body is still built and sent on every render: it saves scroll, not
 *  work. `default_open` is read ONCE, in a `useState` initialiser, so it cannot
 *  reopen a panel the operator closed — treat it as an initial hint, never as
 *  state you control. A nested block's React key is its index within
 *  `blocks` unless it sets its own `block_id`. */
export interface AccordionBlock extends BlockBase {
	type: "accordion";
	label: string;
	blocks: Block[];
	default_open?: boolean;
}

/** `image` (em-dash `ImageBlock`). */
export interface ImageBlock extends BlockBase {
	type: "image";
	url: string;
	alt: string;
	title?: string;
}

/** `meter` (em-dash `MeterBlock`) — a labelled progress bar over a plain
 *  `number`. `min`/`max` default to 0/100, though transitively via the underlying
 *  `@base-ui` meter rather than in `blocks/meter.tsx` itself. NEVER feed it a
 *  money amount: money is integer minor units (`Cents`) and this block has no
 *  currency, so pass a count/ratio and use `custom_value` for the human-readable
 *  readout. */
export interface MeterBlock extends BlockBase {
	type: "meter";
	label: string;
	value: number;
	max?: number;
	min?: number;
	custom_value?: string;
}

/**
 * The blocks Urumi renders. Still a subset of em-dash's 18-member union: `code`
 * is supported by the renderer but nothing in Urumi emits it, and `chart` is
 * DELIBERATELY excluded — `blocks/chart.tsx` formats its own values and has no
 * currency, so putting money on it would mean a display float on the money path
 * (money is integer minor units, always formatted through
 * `presentation/format-money.ts`).
 *
 * `ColumnsBlock`, `TabBlock` and `AccordionBlock` refer back to `Block`, so this
 * union is RECURSIVE — a nested block is type-checked exactly like a top-level
 * one, and any future member is automatically legal inside a layout container.
 * IF YOU ADD A MEMBER THAT CONTAINS BLOCKS, add it to `childBlockLists` in
 * `admin/scaffold/list-detail.ts` — that helper is exhaustive on this union, so
 * the compiler will tell you.
 */
export type Block =
	| HeaderBlock
	| SectionBlock
	| ContextBlock
	| DividerBlock
	| StatsBlock
	| TableBlock
	| BannerBlock
	| FieldsBlock
	| ActionsBlock
	| FormBlock
	| ColumnsBlock
	| TabBlock
	| EmptyBlock
	| AccordionBlock
	| ImageBlock
	| MeterBlock;

/** `BlockResponse` envelope (em-dash `types.ts:412-415`). */
export interface BlockResponse {
	blocks: Block[];
	toast?: { message: string; type: "success" | "error" | "info" };
}

/** A single `admin.settingsSchema` field descriptor (em-dash
 *  `manifest-schema.ts:156-190`). `secret` fields are write-only and never
 *  returned — DELIBERATELY unused here: no Phase-7 setting is a secret. */
export interface SettingsFieldSpec {
	type: "string" | "number" | "boolean";
	label: string;
	description?: string;
	/** Where this field is persisted — Urumi's tiering (§5.1) made explicit in
	 *  the schema so the two save paths are visible, not hidden. */
	tier: "kv" | "service";
}

/** `admin.pages` entry (em-dash `PluginAdminConfig.pages`). */
export interface AdminPageConfig {
	path: string;
	label: string;
	icon?: string;
}
