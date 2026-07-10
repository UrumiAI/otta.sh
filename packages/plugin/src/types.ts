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

// -- context / capabilities ---------------------------------------------------

/** The `network:request` capability's surface (em-dash `createHttpAccess`,
 *  `context.ts:619-671`) — the ONLY egress a sandboxed plugin gets. */
export interface HttpAccess {
	fetch(url: string, init?: RequestInit): Promise<Response>;
}

/**
 * The context passed to every hook/route handler. Urumi's plugin declares
 * only `content:read` + `network:request` (manifest.ts) — so `http` is the
 * only capability-gated surface it ever receives. No `content`/`media`/
 * `users`/`email`/`storage` — declaring any of those would fail the
 * sandbox-clean guard (DEVELOPMENT.md §5).
 */
export interface PluginContext {
	http: HttpAccess;
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
