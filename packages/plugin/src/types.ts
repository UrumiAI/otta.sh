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

export interface TextInputElement {
	type: "text_input";
	action_id: string;
	label?: string;
	placeholder?: string;
	initial_value?: string;
	disabled?: boolean;
}

export interface NumberInputElement {
	type: "number_input";
	action_id: string;
	label?: string;
	initial_value?: number;
	disabled?: boolean;
}

export interface SelectOption {
	value: string;
	label: string;
}

export interface SelectElement {
	type: "select";
	action_id: string;
	label?: string;
	options: SelectOption[];
	initial_value?: string;
	disabled?: boolean;
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
	/** Arbitrary JSON echoed back as `BlockAction.value` on click (em-dash
	 *  `packages/blocks/src/types.ts:13-20`) — Block Kit elements CAN carry
	 *  a payload straight to the plugin route (plan §8 Risk 5). */
	value?: unknown;
	/** Visual emphasis (em-dash `ButtonElement.style`) — `danger` for a
	 *  destructive transition (cancel/refund). */
	style?: "primary" | "danger" | "secondary";
	/** A confirm dialog raised before the action fires (em-dash
	 *  `ButtonElement.confirm`) — required on destructive transitions. */
	confirm?: ConfirmDialog;
	disabled?: boolean;
}

/** Discriminated union — a deliberately narrow subset of em-dash's `Element`
 *  (`packages/blocks/src/types.ts:153-165`); Urumi's widget only needs
 *  these four kinds. */
export type Element = TextInputElement | NumberInputElement | SelectElement | ButtonElement;

/** `FieldWidgetConfig` (em-dash `types.ts:1249-1258`). `elements` (not
 *  `entry`) is the sandboxed/Block-Kit form — no React (DEVELOPMENT.md §5). */
export interface FieldWidgetConfig {
	name: string;
	label: string;
	fieldTypes: FieldType[];
	elements: Element[];
}

// -- page-level Block Kit blocks (em-dash `packages/blocks/src/types.ts`) -----
// A deliberately narrow subset — only the blocks the Phase-7 Reports page and
// Settings form actually render. Snake_case field names follow the authoritative
// wire types (em-dash `types.ts`), matching Urumi's existing element types.

export interface HeaderBlock {
	type: "header";
	text: string;
}
export interface SectionBlock {
	type: "section";
	text: string;
}
export interface ContextBlock {
	type: "context";
	text: string;
}
export interface DividerBlock {
	type: "divider";
}
export interface StatItem {
	label: string;
	value: string;
	description?: string;
}
export interface StatsBlock {
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
}
export interface TableBlock {
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
export interface BannerBlock {
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
export interface FieldsBlock {
	type: "fields";
	fields: Array<{ label: string; value: string }>;
}
/** `actions` (em-dash `packages/blocks/src/types.ts:280-283`) — a row of
 *  interactive elements (buttons), used for the detail view's Back + transition
 *  buttons (MOD-8). */
export interface ActionsBlock {
	type: "actions";
	elements: Element[];
}
export interface FormFieldSpec {
	type: "text_input" | "number_input";
	action_id: string;
	label: string;
	initial_value?: string | number;
	placeholder?: string;
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
export interface FormBlock {
	type: "form";
	fields: Array<FormFieldSpec | SecretInputFieldSpec | SelectFieldSpec | DateFieldSpec>;
	submit: { label: string; action_id: string };
}

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
	| FormBlock;

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
