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

export interface ButtonElement {
	type: "button";
	action_id: string;
	label: string;
	/** Arbitrary JSON echoed back as `BlockAction.value` on click (em-dash
	 *  `packages/blocks/src/types.ts:13-20`) — Block Kit elements CAN carry
	 *  a payload straight to the plugin route (plan §8 Risk 5). */
	value?: unknown;
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
	format?: "text" | "number" | "badge" | "code";
}
export interface TableBlock {
	type: "table";
	columns: TableColumn[];
	rows: Array<Record<string, unknown>>;
	empty_text?: string;
}
/** `banner` (em-dash `types.ts`) — used to fail closed: a plugin route that
 *  can't reach the service renders this instead of throwing into the host. */
export interface BannerBlock {
	type: "banner";
	variant: "error" | "info" | "success";
	text: string;
}
export interface FormFieldSpec {
	type: "text_input" | "number_input";
	action_id: string;
	label: string;
	initial_value?: string | number;
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
	fields: Array<FormFieldSpec | SecretInputFieldSpec>;
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
