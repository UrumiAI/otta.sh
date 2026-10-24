/**
 * Price and stock the playground's sample products.
 *
 * EmDash's playground middleware applies the site seed through the content
 * repository and fires no plugin hooks, so the three products exist as CMS
 * rows and nothing else. The storefront then says they are not for sale.
 * The quick-start script (`scripts/seed-demo-commerce.ts`) fixes that for a
 * long-lived site by publishing each product — which runs Otta's
 * `content:afterPublish` hook — and then writing the demo SKU, price and
 * stock through the console. This module is that same sequence, in the
 * request that serves the playground, with one extra wait:
 *
 * The publish hook is deferred (`after()`), so it is not visible until a
 * later request. The first pass publishes and answers `pending`. The next
 * document request finds the commerce rows and prices them. Re-running is
 * safe: a product that already has a SKU is left alone, the same rule as
 * the script, so a visitor who reprices the sample is not overwritten.
 *
 * Card payments are not part of this. The playground has no Stripe keys, and
 * checkout says so. Nothing here pretends a charge happened.
 */
import {
	DEMO_PRICING,
	demoRows,
	parseExistingCommerce,
	priceBody,
	readCmsPage,
	restockBody,
	shouldPrice,
	type DemoRow,
} from "../../scripts/seed-demo-commerce.js";

/** Query flag on the boot interstitial. The loading page always lands on
 *  the admin; while this is present we are still pricing, and once pricing
 *  finishes that admin hit is sent to the shop. */
export const PLAYGROUND_BOOT_PARAM = "otta_pg";

/** How many document reloads we will spend waiting for the publish hook
 *  before we stop refreshing and show the shop anyway. */
export const PLAYGROUND_MAX_ATTEMPTS = 8;

const SAVE_IDENTITY = "products:save-identity";
const RESTOCK = "products:restock";

export type PrepareResult =
	| { kind: "ready" }
	| { kind: "pending" }
	| { kind: "failed"; message: string };

export interface PlaygroundPorts {
	/** CMS product rows, already the list items (not the HTTP envelope). */
	listItems(): Promise<unknown[]>;
	/** Publish one product so Otta's hook can create its commerce row. */
	publish(id: string): Promise<void>;
	/** The console detail payload (`{ ok, product }`), or a refusal. */
	read(id: string): Promise<unknown>;
	/** One console action. Throws when the console refuses it. */
	act(actionId: string, value: Record<string, string>): Promise<void>;
	/** Put the CMS title back. EmDash's playground init overwrites it. */
	renameSite?(): Promise<void>;
}

/**
 * What to do with the document request after {@link prepareDemoCommerce}.
 * Pure so the boot redirect (admin → shop) is pinned without a browser.
 */
export type PlaygroundPlan =
	| { type: "render" }
	| { type: "redirect"; location: string }
	| { type: "wait"; attempt: number }
	| { type: "stuck"; message: string };

export function planPlaygroundNavigation(args: {
	pathname: string;
	attempt: number;
	/** The request came from `/playground`, or is a reload of the interstitial. */
	boot: boolean;
	prepare: PrepareResult;
}): PlaygroundPlan {
	if (args.prepare.kind === "failed") return { type: "stuck", message: args.prepare.message };
	if (args.prepare.kind === "pending") {
		if (args.attempt >= PLAYGROUND_MAX_ATTEMPTS) {
			return {
				type: "stuck",
				message:
					"The sample products were published, but their prices did not land in time. The shop is up; a product without a price cannot be added to the cart.",
			};
		}
		return { type: "wait", attempt: args.attempt + 1 };
	}
	if (args.boot && isPlaygroundAdminHome(args.pathname))
		return { type: "redirect", location: "/products" };
	if (args.attempt > 0) return { type: "redirect", location: args.pathname };
	return { type: "render" };
}

/** The loading page's destination, and nothing under it. A later click into
 *  the admin must not be bounced back to the shop. */
export function isPlaygroundAdminHome(pathname: string): boolean {
	return pathname === "/_emdash/admin" || pathname === "/_emdash/admin/";
}

export function playgroundWaitPath(pathname: string, attempt: number): string {
	const url = new URL(pathname, "https://playground.invalid");
	url.searchParams.set(PLAYGROUND_BOOT_PARAM, String(attempt));
	return `${url.pathname}${url.search}`;
}

export function playgroundAttempt(raw: string | null): number {
	if (raw === null || !/^\d+$/.test(raw)) return 0;
	const parsed = Number(raw);
	return parsed > PLAYGROUND_MAX_ATTEMPTS ? PLAYGROUND_MAX_ATTEMPTS : parsed;
}

/** A browser document navigation. Asset and API requests are not asked to
 *  wait while the catalog is priced. */
export function isPlaygroundDocument(
	method: string,
	pathname: string,
	accept: string | null,
	dest: string | null,
): boolean {
	if (method !== "GET") return false;
	if (pathname.startsWith("/_astro") || pathname.startsWith("/_image")) return false;
	if (pathname.startsWith("/_emdash/api") || pathname.startsWith("/_playground")) return false;
	if (pathname === "/playground" || pathname === "/playground/") return false;
	if (dest !== null && dest !== "document") return false;
	if (dest === "document") return true;
	return (accept ?? "").includes("text/html");
}

export function isPlaygroundBoot(
	origin: string,
	referer: string | null,
	bootParam: boolean,
): boolean {
	if (bootParam) return true;
	if (referer === null) return false;
	try {
		const ref = new URL(referer);
		return (
			ref.origin === origin && (ref.pathname === "/playground" || ref.pathname === "/playground/")
		);
	} catch {
		return false;
	}
}

/** Items out of a content-list result. Throws on a refusal so a failed list
 *  cannot look like an empty catalog and skip every product. */
export function itemsFromListResult(result: unknown): { items: unknown[]; nextCursor?: string } {
	if (typeof result !== "object" || result === null) {
		throw new Error("the product list was not an object");
	}
	const envelope = result as { success?: unknown; error?: { message?: unknown }; data?: unknown };
	if (envelope.success === false) {
		const message = envelope.error?.message;
		throw new Error(
			typeof message === "string" && message.length > 0 ? message : "the product list was refused",
		);
	}
	const data = envelope.data;
	if (typeof data !== "object" || data === null) return { items: [] };
	const record = data as { items?: unknown; nextCursor?: unknown };
	const items = Array.isArray(record.items) ? record.items : [];
	const nextCursor =
		typeof record.nextCursor === "string" && record.nextCursor.length > 0
			? record.nextCursor
			: undefined;
	return { items, ...(nextCursor !== undefined ? { nextCursor } : {}) };
}

/**
 * Publish anything that has no commerce row yet, and price anything whose
 * row exists and has no SKU. A publish in this same call answers `pending`:
 * the hook that creates the row has not run yet.
 */
export async function prepareDemoCommerce(ports: PlaygroundPorts): Promise<PrepareResult> {
	let rows: DemoRow[];
	try {
		const page = readCmsPage(await ports.listItems());
		rows = demoRows(Object.keys(DEMO_PRICING), page);
	} catch (error) {
		return { kind: "failed", message: errorText(error) };
	}

	let published = false;
	try {
		for (const row of rows) {
			const existing = parseExistingCommerce(await ports.read(row.id), row.id);
			if (!shouldPrice(existing)) {
				// A run that died between the price and the restock leaves a SKU
				// at zero. The restock nonce is stable, so saying it again does
				// not add a second pile once the first one was recorded, and it
				// does fill the hole when the first one never was.
				if (
					existing !== null &&
					existing.active &&
					existing.sku === row.sku &&
					existing.onHand === 0
				) {
					await ports.act(RESTOCK, restockBody(row, existing.onHand, restockNonce(row)));
				}
				continue;
			}
			if (existing === null) {
				await ports.publish(row.id);
				published = true;
				continue;
			}
			await ports.act(SAVE_IDENTITY, priceBody(row, existing.updatedAt));
			const priced = parseExistingCommerce(await ports.read(row.id), row.id);
			if (priced === null || priced.onHand === null) {
				throw new Error(`${row.slug} was priced but has no inventory record to stock`);
			}
			if (row.initialOnHand > 0 && priced.onHand === 0) {
				await ports.act(RESTOCK, restockBody(row, priced.onHand, restockNonce(row)));
			}
		}
	} catch (error) {
		return { kind: "failed", message: errorText(error) };
	}

	if (published) return { kind: "pending" };
	try {
		await ports.renameSite?.();
	} catch (error) {
		console.error("[otta-playground] could not set the site title", error);
	}
	return { kind: "ready" };
}

/**
 * The caller EmDash's plugin dispatch will accept.
 *
 * `toRouteCallerInfo` does `user.createdAt.toISOString()`. The playground
 * session user is only `{ id, email, name, role }` — the anonymous admin
 * EmDash puts on `locals` — so dispatch throws before the console runs.
 * A missing timestamp is filled here. A caller that is not that admin
 * shape is null, and the gate stops instead of calling dispatch.
 */
export function playgroundRouteCaller(user: unknown): {
	id: string;
	email: string;
	name: string | null;
	role: number;
	createdAt: string;
} | null {
	if (typeof user !== "object" || user === null) return null;
	const record = user as {
		id?: unknown;
		email?: unknown;
		name?: unknown;
		role?: unknown;
		createdAt?: unknown;
	};
	if (typeof record.id !== "string" || record.id.length === 0) return null;
	if (typeof record.email !== "string" || record.email.length === 0) return null;
	if (typeof record.role !== "number") return null;
	const name = typeof record.name === "string" ? record.name : null;
	return {
		id: record.id,
		email: record.email,
		name,
		role: record.role,
		createdAt: callerCreatedAt(record.createdAt),
	};
}

/** One nonce per sample product, stable across reloads, so the restock is
 *  once-only inside the visitor's database. */
function restockNonce(row: DemoRow): string {
	// Hyphens only. The console accepts `[A-Za-z0-9-]{16,64}` and refuses a
	// colon, which is what "that action could not be read" means.
	return `playground-restock-${row.slug}`;
}

function callerCreatedAt(value: unknown): string {
	if (typeof value === "string" && value.length > 0) return value;
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
	return new Date().toISOString();
}

function errorText(error: unknown): string {
	return error instanceof Error && error.message.length > 0
		? error.message
		: "the sample catalog could not be priced";
}
