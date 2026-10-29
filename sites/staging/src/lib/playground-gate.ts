/**
 * Runs on the playground build only. The storefront build leaves
 * `__OTTA_PLAYGROUND__` false and this returns null on every request.
 *
 * EmDash's own playground middleware has already created the visitor's
 * database, applied the CMS seed and set `locals.user` by the time we run.
 * What it cannot do is price the products: the seed fires no Otta hooks.
 * {@link prepareDemoCommerce} does, then the boot request is sent to the
 * shop instead of being left in the CMS admin.
 */
import {
	CONSOLE_ACT_INTERACTION,
	CONSOLE_READ_INTERACTION,
	OTTA_PLUGIN_ID,
	PRODUCTS_CONSOLE_RESOURCE_PREFIX,
} from "@urumi.ai/otta-plugin";
import type { APIContext } from "astro";
import { ContentRepository, OptionsRepository } from "emdash";
import { PLAYGROUND_PRODUCT_PHOTOS, shouldAttachPlaygroundPhoto } from "./playground-photos.js";
import {
	injectPlaygroundBanner,
	playgroundInterstitial,
	playgroundStuck,
} from "./playground-banner.js";
import {
	PLAYGROUND_BOOT_PARAM,
	isPlaygroundBoot,
	isPlaygroundDocument,
	itemsFromListResult,
	planPlaygroundNavigation,
	playgroundAttempt,
	playgroundRouteCaller,
	playgroundWaitPath,
	prepareDemoCommerce,
	withPlaygroundCreatedAt,
	type PrepareResult,
} from "./playground-commerce.js";
import { STARS_PATH, starsResponse } from "./playground-star.js";

declare const __OTTA_PLAYGROUND__: boolean;

const PRODUCTS = "products";
const SITE_TITLE = "Otta";
/** EmDash's playground cookie. The ready-set is keyed by it so a second
 *  isolate re-checks that visitor's database instead of another one's. */
const SESSION_COOKIE = "emdash_playground";

const readySessions = new Set<string>();
const lanes = new Map<string, Promise<unknown>>();

export function isPlaygroundBuild(): boolean {
	return typeof __OTTA_PLAYGROUND__ === "boolean" && __OTTA_PLAYGROUND__;
}

/** Null means the request carries on into the storefront middleware. */
export async function playgroundGate(context: APIContext): Promise<Response | null> {
	if (!isPlaygroundBuild()) return null;
	// Every request, not just documents: the admin's console calls are
	// fetches, and they dispatch with this same user.
	context.locals.user = withPlaygroundCreatedAt(context.locals.user) as typeof context.locals.user;
	const { request, url } = context;
	if (url.pathname === STARS_PATH && request.method === "GET") return starsResponse();
	if (
		!isPlaygroundDocument(
			request.method,
			url.pathname,
			request.headers.get("accept"),
			request.headers.get("sec-fetch-dest"),
		)
	) {
		return null;
	}

	const token = context.cookies.get(SESSION_COOKIE)?.value ?? "anonymous";
	let prepare: PrepareResult;
	try {
		prepare = await inSession(token, () => prepareSession(context, token));
	} catch (error) {
		console.error("[otta-playground] sample catalog", error);
		return playgroundStuck(
			error instanceof Error ? error.message : "the sample catalog could not be priced",
		);
	}

	const plan = planPlaygroundNavigation({
		pathname: url.pathname,
		attempt: playgroundAttempt(url.searchParams.get(PLAYGROUND_BOOT_PARAM)),
		boot: isPlaygroundBoot(
			url.origin,
			request.headers.get("referer"),
			url.searchParams.has(PLAYGROUND_BOOT_PARAM),
		),
		prepare,
	});
	if (plan.type === "wait")
		return playgroundInterstitial(playgroundWaitPath(url.pathname, plan.attempt));
	if (plan.type === "stuck") return playgroundStuck(plan.message);
	if (plan.type === "redirect") return redirect(plan.location);
	return null;
}

export async function withPlaygroundBanner(response: Response): Promise<Response> {
	if (!isPlaygroundBuild()) return response;
	return injectPlaygroundBanner(response);
}

async function prepareSession(context: APIContext, token: string): Promise<PrepareResult> {
	if (readySessions.has(token)) return { kind: "ready" };
	const emdash = context.locals.emdash as {
		handleContentList?: (
			collection: string,
			params: { limit?: number; cursor?: string },
		) => Promise<unknown>;
		handleContentPublish?: (
			collection: string,
			id: string,
			options: { actor?: { id: string; role: number } },
		) => Promise<unknown>;
		handlePluginApiRoute?: (
			pluginId: string,
			method: string,
			path: string,
			request: Request,
			user?: unknown,
		) => Promise<unknown>;
	};
	if (
		emdash.handleContentList === undefined ||
		emdash.handleContentPublish === undefined ||
		emdash.handlePluginApiRoute === undefined
	) {
		return { kind: "failed", message: "Otta's admin routes are not available on this request." };
	}
	const list = emdash.handleContentList;
	const publish = emdash.handleContentPublish;
	const dispatch = emdash.handlePluginApiRoute;
	const user = context.locals.user;
	const actor = actorFrom(user);
	const caller = playgroundRouteCaller(user);
	if (caller === null) {
		return {
			kind: "failed",
			message: "The playground admin is not signed in, so the sample products cannot be priced.",
		};
	}
	const origin = context.url.origin;
	const items = await listProducts(list);
	await attachPlaygroundPhotos(context, items);

	const result = await prepareDemoCommerce({
		listItems: async () => items,
		publish: async (id) => {
			const published = await publish(PRODUCTS, id, actor !== null ? { actor } : {});
			if (!isSuccess(published)) {
				throw new Error(refusalMessage(published, `publishing ${id}`));
			}
		},
		read: (id) =>
			consoleData(dispatch, caller, origin, {
				type: CONSOLE_READ_INTERACTION,
				resource: `${PRODUCTS_CONSOLE_RESOURCE_PREFIX}detail`,
				productId: id,
			}),
		act: async (actionId, value) => {
			const data = (await consoleData(dispatch, caller, origin, {
				type: CONSOLE_ACT_INTERACTION,
				action_id: actionId,
				value,
			})) as {
				ok?: unknown;
				notice?: { variant?: string; title?: string; description?: string } | null;
			};
			if (data.ok !== true || data.notice?.variant === "error") {
				const notice = data.notice;
				throw new Error(
					`${actionId} was refused: ${notice?.title ?? "(no title)"} — ${notice?.description ?? "(no description)"}`,
				);
			}
		},
		renameSite: async () => {
			const db = (context.locals as unknown as Record<string, unknown>)["__playgroundDb"];
			if (typeof db !== "object" || db === null) return;
			await new OptionsRepository(db as ConstructorParameters<typeof OptionsRepository>[0]).set(
				"emdash:site_title",
				SITE_TITLE,
			);
		},
	});
	if (result.kind === "ready") {
		if (readySessions.size > 500) readySessions.clear();
		readySessions.add(token);
	}
	return result;
}

/** Write the shipped Otta photograph onto a sample product that has none,
 *  and refresh a row that still points at the shipped file with an older
 *  alt. A picture the visitor set to some other URL is left alone. */
async function attachPlaygroundPhotos(context: APIContext, items: unknown[]): Promise<void> {
	const db = (context.locals as unknown as Record<string, unknown>)["__playgroundDb"];
	if (typeof db !== "object" || db === null) return;
	const repo = new ContentRepository(db as ConstructorParameters<typeof ContentRepository>[0]);
	for (const raw of items) {
		if (typeof raw !== "object" || raw === null) continue;
		const item = raw as { id?: unknown; slug?: unknown; data?: unknown };
		if (typeof item.id !== "string" || typeof item.slug !== "string") continue;
		const photo = PLAYGROUND_PRODUCT_PHOTOS[item.slug];
		if (photo === undefined) continue;
		if (!shouldAttachPlaygroundPhoto(item.data, photo)) continue;
		await repo.update(PRODUCTS, item.id, { data: { images: photo } });
	}
}

async function listProducts(
	list: (collection: string, params: { limit?: number; cursor?: string }) => Promise<unknown>,
): Promise<unknown[]> {
	const items: unknown[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 5; page++) {
		const result = itemsFromListResult(
			await list(PRODUCTS, { limit: 50, ...(cursor !== undefined ? { cursor } : {}) }),
		);
		items.push(...result.items);
		if (result.nextCursor === undefined || result.nextCursor === cursor) break;
		cursor = result.nextCursor;
	}
	return items;
}

async function consoleData(
	dispatch: (
		pluginId: string,
		method: string,
		path: string,
		request: Request,
		user?: unknown,
	) => Promise<unknown>,
	user: unknown,
	origin: string,
	body: Record<string, unknown>,
): Promise<unknown> {
	const envelope = await dispatch(
		OTTA_PLUGIN_ID,
		"POST",
		"/admin",
		new Request(new URL(`/_emdash/api/plugins/${OTTA_PLUGIN_ID}/admin`, origin), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		user,
	);
	if (!isSuccess(envelope)) throw new Error(refusalMessage(envelope, "the commerce console"));
	const data = (envelope as { data?: unknown }).data;
	if (typeof data !== "object" || data === null)
		throw new Error("the commerce console returned no data");
	return data;
}

function actorFrom(user: unknown): { id: string; role: number } | null {
	if (typeof user !== "object" || user === null) return null;
	const record = user as { id?: unknown; role?: unknown };
	return typeof record.id === "string" && typeof record.role === "number"
		? { id: record.id, role: record.role }
		: null;
}

function isSuccess(value: unknown): boolean {
	return (
		typeof value === "object" && value !== null && (value as { success?: unknown }).success === true
	);
}

function refusalMessage(value: unknown, what: string): string {
	const error = (value as { error?: { message?: unknown } } | null)?.error?.message;
	return typeof error === "string" && error.length > 0
		? `${what}: ${error}`
		: `${what} was refused`;
}

function redirect(location: string): Response {
	return new Response(null, {
		status: 302,
		headers: { location, "cache-control": "no-store" },
	});
}

/** Serialize prepare for one visitor. Two document requests at once (the
 *  browser's speculative load, a double reload) would otherwise both see
 *  "no SKU" and restock twice. */
async function inSession<T>(token: string, task: () => Promise<T>): Promise<T> {
	const previous = lanes.get(token) ?? Promise.resolve();
	const run = previous.then(task, task);
	lanes.set(token, run);
	try {
		return await run;
	} finally {
		if (lanes.get(token) === run) lanes.delete(token);
	}
}
