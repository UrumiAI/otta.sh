/**
 * Price, stock and activate the demo products the seed creates, so the
 * quickstart ends at "buy", not at "browse".
 *
 * WHY THIS SCRIPT EXISTS. em-dash's seed applier writes content through
 * `ContentRepository` directly and fires NO content hooks, so the demo products
 * never produce a `product_commerce` row — the plugin's sync hooks are simply
 * never invoked for them. That was true before "one home per field" (PR 1b) and
 * is still true after it: a seeded product is content-only. Without this step a
 * new reader lands on `/products`, sees three products, and cannot buy any of
 * them.
 *
 * WHERE IT WRITES, AND WHY THAT CHANGED (INC-D1). It used to drive the
 * standalone commerce service's REST API (`PUT /products/:id/commerce`, then
 * `POST …/commerce/activate`). Staging now runs commerce IN-PROCESS: there is no
 * service to call, commerce truth lives in em-dash plugin storage inside the
 * site's own Worker, and every write goes through the SITE. So `SITE_URL` is now
 * the only address this script needs — `COMMERCE_SERVICE_URL` and
 * `SERVICE_API_TOKEN` are gone, and one credential (the em-dash one) now covers
 * both halves of the job.
 *
 * THE WRITE PATH IS THREE SURFACES, NOT ONE, AND THE SPLIT IS DELIBERATE. The
 * in-process admin route refuses to write `title` or `active` at all — not by
 * policy check but STRUCTURALLY: `ProductEditWire` has no member for either,
 * because both are CMS-owned (ADR-0013, "one home per field"). So the flow is:
 *
 *   1. READ the row first (`otta_console_read` / `products.detail`). This is the
 *      re-run guard, and it comes FIRST — see the next paragraph, which is the
 *      whole reason the order is written down here.
 *   2. PUBLISH the product through the CMS content API, but ONLY on the path
 *      that is about to price it. That fires the plugin's own
 *      `content:afterPublish` hook, which upserts the `product_commerce` row
 *      WITH its title and opens the publish gate. This is the only door `title`
 *      and `active` have, and using it means the row is created by exactly the
 *      code path a real merchant's first publish would take. Then re-read, for
 *      the row the hook just created and the `expectedUpdatedAt` the write needs.
 *   3. SKU + price (`otta_console_act` / `products:save-identity`), then stock
 *      (`products:restock`). Both are the same envelopes the React console
 *      posts; this script is just another client of the admin route.
 *
 * Step 2 is not optional sequencing: `updateProduct` answers
 * `{ok:false, reason:"not_found"}` when no `product_commerce` row exists, so
 * pricing genuinely cannot precede the publish that creates the row.
 *
 * WHY THE READ MUST PRECEDE THE PUBLISH, AND IT IS NOT AN OPTIMISATION. A
 * publish is not a read-only probe: it opens the publish gate. A merchant who
 * priced a product and then deliberately UNPUBLISHED it would have it silently
 * put back on sale by a publish-then-decide flow — the skip would be taken one
 * call too late, after the damage. Reading first costs one extra round trip on a
 * first run (the row does not exist yet, which the console answers as
 * `ok:false` / `product:null`, mapped to `null` by `parseExistingCommerce`) and
 * makes "this script never re-activates what it did not price" structurally
 * true rather than merely claimed.
 *
 * THE TITLE IS NO LONGER THIS SCRIPT'S TO WRITE, AND THAT IS THE FIX. The old
 * revision hand-carried `title` on the upsert body because no hook fired for a
 * seeded product and a null title makes `createOrderFromCart` reject the line
 * with `PRODUCT_NOT_PRICED` — listed, priced, active and impossible to buy, with
 * the failure invisible until the last step of checkout. Publishing through the
 * CMS fires the hook, so the title arrives from its actual owner and this script
 * never becomes a second writer of it.
 *
 * THE ACTIVATE WATERMARK IS GONE FOR THE SAME REASON. The previous flow sent a
 * hand-built UNIX-epoch `contentUpdatedAt` so that every later real lifecycle
 * event would carry a strictly newer watermark and win. The publish hook carries
 * the content's OWN `updatedAt`, which is that guarantee by construction rather
 * than by a constant chosen to be older than everything.
 *
 * RE-RUNNING IS SAFE, AND IDEMPOTENCY KEYS ARE NOT WHAT MAKES IT SO. Each
 * product is READ first and skipped — before ANY write, publish included — if
 * its row already has a SKU; see `shouldPrice`. Without that read a second run
 * would silently overwrite a merchant's prices. The admin route derives its own
 * keys from the submitted payload, so a re-run with the SAME demo values does
 * dedupe — but a re-run after a merchant repriced does not, because the payload
 * differs. `shouldPrice` is the actual guard; the keys are a courtesy.
 * Re-publishing (step 2) is separately safe on the path that reaches it: em-dash
 * re-promotes the live revision and the sync hook's upsert is ordering-guarded
 * by `contentUpdatedAt`.
 *
 * WHY THE IDS COME FROM THE CMS AND NOT FROM `seed/seed.json`. **A seed entry's
 * `id` is not the stored id.** em-dash's seed applier generates a ULID for every
 * entry and keeps the declared id only as a seed-local reference
 * (`seedIdMap: seed id -> real entry id`, `packages/core/src/seed/apply.ts`), so
 * `product:otta-tee` never exists in the content database. Addressing commerce
 * with it would mint rows no CMS product will ever join to, leaving the
 * storefront showing "Not currently available for purchase" with no error
 * anywhere. So the ids are resolved from the CMS at run time, matched by SLUG.
 * `seed/seed.json` remains the source of truth for WHICH products get priced,
 * and a slug it declares that the CMS does not have is a hard error.
 *
 * USAGE
 *
 *   # after the site's seed has been applied
 *   SITE_URL=http://localhost:4321 pnpm dlx tsx@4 \
 *     sites/staging/scripts/seed-demo-commerce.ts
 *
 * AUTH — ONE credential, for reads and writes alike, because everything now goes
 * through the site. Set `EMDASH_TOKEN` to an em-dash API token (sent as
 * `Authorization: Bearer …`); it needs `content:publish_own`/`publish_any` for
 * step 1 and `plugins:manage` with ADMIN scope for steps 2-3. With no token the
 * script falls back to `/_emdash/api/auth/dev-bypass`, which signs in as the dev
 * admin and does nothing else. That route IS registered in a production build —
 * it just returns 403 there — so a deployed site needs `EMDASH_TOKEN`.
 *
 * Session-cookie auth additionally needs em-dash's CSRF header on every non-GET
 * (`X-EmDash-Request: 1`); bearer tokens are exempt from it. The script sends it
 * unconditionally on writes, which is correct for both.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	CONSOLE_ACT_INTERACTION,
	CONSOLE_READ_INTERACTION,
	formatMinorUnitsInput,
	OTTA_PLUGIN_ID,
	PRODUCTS_CONSOLE_RESOURCE_PREFIX,
} from "@otta-sh/plugin";

export interface DemoPricing {
	sku: string;
	/** Integer MINOR units + ISO-4217, never a float (CLAUDE.md). */
	price: { amount: number; currency: string };
	initialOnHand: number;
}

/** A demo product ready to price: its REAL CMS content id and title, joined to
 *  the demo pricing for its slug. */
export interface DemoRow extends DemoPricing {
	/** The em-dash content id — the `product_commerce` primary key. Resolved
	 *  from the CMS, never from the seed file (see the module header). */
	id: string;
	slug: string;
	title: string;
}

/**
 * Demo prices, keyed by the seed entry's SLUG. Slug rather than id because the
 * slug is the one identifier that is stable across seed file and content
 * database; the id is resolved at run time. Every seeded product must appear
 * here — `demoRows` throws if one does not, so adding a fourth demo product to
 * the seed fails loudly instead of quietly shipping an unbuyable product.
 */
export const DEMO_PRICING: Record<string, DemoPricing> = {
	"otta-tee": { sku: "OTTA-TEE", price: { amount: 3200, currency: "USD" }, initialOnHand: 25 },
	"otta-mug": { sku: "OTTA-MUG", price: { amount: 1800, currency: "USD" }, initialOnHand: 40 },
	"otta-stickers": {
		sku: "OTTA-STICKERS",
		price: { amount: 600, currency: "USD" },
		initialOnHand: 100,
	},
};

interface SeedFile {
	content?: Record<string, Array<{ slug: string }>>;
}

/** One `products` entry as the CMS reports it. */
export interface CmsProductEntry {
	id: string;
	slug: string;
	title: string;
}

/** What the CMS returned, split so a failure can say WHICH kind it was. An
 *  entry whose title is not a usable string is `unusable` rather than dropped:
 *  silently filtering it would surface later as "the CMS has no published
 *  product for that slug", which sends the reader to re-run the seed instead of
 *  to the product with the broken title. */
export interface CmsProductPage {
	entries: CmsProductEntry[];
	unusable: Array<{ slug: string; reason: string }>;
}

/** The product SLUGS the seed declares — which products this script prices.
 *  Exported so a test can hold it against `DEMO_PRICING`. */
export function seededProductSlugs(seedPath: string): string[] {
	const seed = JSON.parse(readFileSync(seedPath, "utf8")) as SeedFile;
	return (seed.content?.["products"] ?? []).map((entry) => entry.slug);
}

/**
 * Join the seed's slugs to the CMS's real ids and titles, and to the demo
 * pricing. Every half of the join fails loudly rather than silently skipping —
 * a skipped product is exactly the unbuyable catalog this script prevents.
 */
export function demoRows(slugs: string[], page: CmsProductPage): DemoRow[] {
	const bySlug = new Map(page.entries.map((e) => [e.slug, e]));
	const unusableBySlug = new Map(page.unusable.map((u) => [u.slug, u.reason]));

	const unpriced = slugs.filter((s) => DEMO_PRICING[s] === undefined);
	if (unpriced.length > 0) {
		throw new Error(
			`seed/seed.json declares product(s) with no entry in DEMO_PRICING: ${unpriced.join(", ")}. Add them to sites/staging/scripts/seed-demo-commerce.ts — a seeded product with no commerce row is listed but cannot be bought.`,
		);
	}
	// Returned but unusable is a DIFFERENT failure from not returned at all, and
	// conflating them sends the reader to the wrong fix.
	const broken = slugs.filter((s) => unusableBySlug.has(s));
	if (broken.length > 0) {
		throw new Error(
			`the CMS returned product(s) this script cannot use: ${broken
				.map((s) => `${s} (${unusableBySlug.get(s)})`)
				.join(", ")}. Fix the content, then re-run.`,
		);
	}
	const missing = slugs.filter((s) => !bySlug.has(s));
	if (missing.length > 0) {
		throw new Error(
			`the CMS returned no product for slug(s): ${missing.join(", ")}. Apply the site's seed first (the dev bypass, or the setup wizard with "include sample content" enabled).`,
		);
	}

	return slugs.map((slug) => {
		const entry = bySlug.get(slug)!;
		return { ...DEMO_PRICING[slug]!, id: entry.id, slug, title: entry.title };
	});
}

/**
 * The `products:save-identity` payload for one demo product.
 *
 * EVERY VALUE IS A STRING, and that is not stylistic. `readConsolePayload`
 * (`console-transport.ts`) keeps only string-valued keys and DROPS everything
 * else — silently, without coercing. A numeric `price` here would not be a type
 * error or a validation failure; the field would simply not be in the payload,
 * `buildEditWire` would read it as "not in the form ⇒ preserve", and the product
 * would be saved with its sku and NO PRICE. So money crosses as the decimal
 * string the form would have submitted, produced by the plugin's own
 * `formatMinorUnitsInput` — the exact inverse of the `parsePriceMinorUnits` on
 * the other side, in integer arithmetic, so the round-trip cannot drift.
 *
 * `expectedUpdatedAt` is REQUIRED and must be non-blank: it is the concurrency
 * precondition, and the route refuses the write without it rather than
 * defaulting to "overwrite whatever is there".
 *
 * NO `title` AND NO `active` — neither has a member on `ProductEditWire`. They
 * arrive via the CMS publish in step 1 (see the module header).
 */
export function priceBody(row: DemoRow, expectedUpdatedAt: string): Record<string, string> {
	return {
		productId: row.id,
		expectedUpdatedAt,
		sku: row.sku,
		price: formatMinorUnitsInput(row.price.amount),
		currency: row.price.currency,
	};
}

/** The `products:restock` payload. `onHand` is the WATERMARK — the count this
 *  script just observed — not the target; the route refuses the write if the
 *  live count has moved since. `qty` is how many to ADD. */
export function restockBody(row: DemoRow, onHand: number): Record<string, string> {
	return { productId: row.id, onHand: String(onHand), qty: String(row.initialOnHand) };
}

/** The commerce row as the console detail read reports it — `null` when the
 *  product has none. Only the fields this script reasons about. */
export interface ExistingCommerce {
	sku: string | null;
	active: boolean;
	/** The concurrency precondition every write must echo back. */
	updatedAt: string;
	/** `null` ⇒ the sku has NO inventory record (or there is no sku), which is
	 *  NOT the same as a known zero — see `ProductDetailWire.onHand`. */
	onHand: number | null;
}

/**
 * Narrow the console detail payload, and FAIL LOUDLY on anything unrecognised.
 *
 * The console answers `{ ok: true, product: ProductDetailWire, … }` on success
 * and `{ ok: false, title, description }` on a refusal — BOTH under HTTP 200,
 * because a refusal is an answer, not a transport failure. So the status code
 * cannot be the check; this function is.
 *
 * An unknown shape must never resolve to "skip". An unchecked cast would leave
 * `sku` as `undefined`, which `shouldPrice` reads as "already priced", and the
 * quickstart would price NOTHING while cheerfully printing "3 left as-is". That
 * is the one outcome that looks like success.
 */
export function parseExistingCommerce(
	payload: unknown,
	productId: string,
): ExistingCommerce | null {
	const refuse = (why: string): never => {
		throw new Error(
			`the products console detail read for ${productId} ${why} (payload: ${JSON.stringify(payload)?.slice(0, 300)}). Refusing to guess — treating an unreadable answer as "already priced" would silently skip every product and report success.`,
		);
	};
	if (payload === null || typeof payload !== "object") return refuse("was not an object");
	const envelope = payload as Record<string, unknown>;
	if (envelope["ok"] === false) {
		// A refusal is a legitimate answer with one legitimate meaning here: there
		// is no commerce row yet. It is NOT "already priced".
		return null;
	}
	if (envelope["ok"] !== true) return refuse("carried no `ok` discriminator");
	const product = envelope["product"];
	if (product === null || product === undefined) return null;
	if (typeof product !== "object") return refuse("had a non-object `product`");
	const row = product as Record<string, unknown>;
	const skuOk = typeof row["sku"] === "string" || row["sku"] === null;
	const onHandOk = typeof row["onHand"] === "number" || row["onHand"] === null;
	if (!skuOk || typeof row["active"] !== "boolean" || typeof row["updatedAt"] !== "string") {
		return refuse("had no readable `sku` / `active` / `updatedAt`");
	}
	if (!onHandOk) return refuse("had a non-numeric, non-null `onHand`");
	return {
		sku: (row["sku"] as string | null) ?? null,
		active: row["active"],
		updatedAt: row["updatedAt"],
		onHand: (row["onHand"] as number | null) ?? null,
	};
}

/**
 * THE RE-RUN GUARD. Price a product only when nobody has priced it yet.
 *
 * A row with a SKU has been through Pricing & inventory (or a previous run of
 * this script), and its price, stock, kind, tax class and dimensions are the
 * merchant's. This script must never overwrite them — writing demo prices over
 * a real catalog is precisely the second-writer clobber "one home per field"
 * removed. A row that exists but has no SKU is a bare CMS-sync row with nothing
 * to lose, so it is still safe to price.
 *
 * Exported and pure so the behaviour is pinned by a test rather than by prose.
 */
export function shouldPrice(existing: ExistingCommerce | null): boolean {
	return existing === null || existing.sku === null;
}

/* `shouldActivate` is GONE (review round 3, A1). In the service era it decided
 * whether to call `activate`. It cannot decide anything now: `active` has no
 * member on the console's write wire, and the only thing that opens the gate is
 * a CMS publish — which this script performs ONLY on the path that is about to
 * price, so "should we activate?" is not a question it ever asks. It survived
 * the rewrite as an exported, tested no-op predicate; a dead guard that a test
 * still pins reads like a live one, which is worse than none. */

const DEFAULT_SITE_URL = "http://localhost:4321";

/** The plugin admin route every console write and read goes through. Built from
 *  the plugin's own id rather than spelled out, so a rename cannot leave a dead
 *  URL here that 404s at run time. */
const ADMIN_ROUTE = `/_emdash/api/plugins/${OTTA_PLUGIN_ID}/admin`;

function trimUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

/** Authenticate against the site and return the headers to read content with. */
async function cmsAuthHeaders(siteUrl: string): Promise<Record<string, string>> {
	const token = process.env["EMDASH_TOKEN"];
	if (token !== undefined && token.length > 0) {
		console.info("[otta] using EMDASH_TOKEN");
		return { Authorization: `Bearer ${token}` };
	}
	// DEV-ONLY fallback: `/_emdash/api/auth/dev-bypass`, which signs in as the dev
	// admin and nothing else. NOT `/_emdash/api/setup/dev-bypass`, which also runs
	// `applySeed(..., includeContent: true)` — authenticating by re-seeding the
	// site is a side effect no read should have. The route IS registered in a
	// production build; it just returns 403 there (it is gated on
	// `import.meta.env.DEV`), so a deployed site needs EMDASH_TOKEN.
	const res = await fetch(`${siteUrl}/_emdash/api/auth/dev-bypass`, { redirect: "manual" });
	const cookies = res.headers
		.getSetCookie()
		.map((c) => c.split(";", 1)[0])
		.filter((c): c is string => c !== undefined);
	if (cookies.length === 0) {
		throw new Error(
			`no EMDASH_TOKEN set and the dev auth bypass at ${siteUrl} returned no session cookie (HTTP ${res.status}${res.status === 403 ? " — that route is development-only" : ""}). On a deployed site, create an API token in the admin and set EMDASH_TOKEN.`,
		);
	}
	console.info("[otta] using the dev auth bypass (no EMDASH_TOKEN set)");
	return { Cookie: cookies.join("; ") };
}

/** Split one CMS list payload into usable entries and unusable ones. Pure, so a
 *  test can drive the shapes without a server. */
export function readCmsPage(items: unknown[]): CmsProductPage & { nextCursor?: string } {
	const entries: CmsProductEntry[] = [];
	const unusable: Array<{ slug: string; reason: string }> = [];
	for (const raw of items) {
		const item = raw as { id?: unknown; slug?: unknown; data?: Record<string, unknown> };
		const slug = typeof item.slug === "string" ? item.slug : "(no slug)";
		if (typeof item.id !== "string" || item.id.length === 0) {
			unusable.push({ slug, reason: "the entry has no id" });
			continue;
		}
		if (typeof item.slug !== "string" || item.slug.length === 0) {
			unusable.push({ slug, reason: "the entry has no slug" });
			continue;
		}
		const title = item.data?.["title"];
		if (typeof title !== "string" || title.trim().length === 0) {
			// NOT dropped. A row priced without a title is listed, active and
			// rejected at checkout with PRODUCT_NOT_PRICED, so this must surface as
			// its own failure rather than as "no such product".
			unusable.push({
				slug,
				reason: title === undefined ? "no `title` field" : `\`title\` is ${typeof title}`,
			});
			continue;
		}
		entries.push({ id: item.id, slug: item.slug, title });
	}
	return { entries, unusable };
}

/** Read every `products` entry out of the CMS, FOLLOWING THE CURSOR. A single
 *  page is capped by the API, and a truncated read surfaces as "the CMS
 *  returned no product for slug X" — a misleading error that sends the reader
 *  to re-seed a site that is fine. */
export async function fetchCmsProducts(
	siteUrl: string,
	headers: Record<string, string>,
	fetchImpl: typeof fetch = fetch,
): Promise<CmsProductPage> {
	const entries: CmsProductEntry[] = [];
	const unusable: Array<{ slug: string; reason: string }> = [];
	let cursor: string | undefined;
	// Bounded so a server that keeps handing back the same cursor cannot spin.
	for (let page = 0; page < 50; page++) {
		const url = `${siteUrl}/_emdash/api/content/products?limit=50${
			cursor !== undefined ? `&cursor=${encodeURIComponent(cursor)}` : ""
		}`;
		const res = await fetchImpl(url, { headers });
		if (!res.ok) {
			throw new Error(`GET ${url} → HTTP ${res.status}: ${await res.text()}`);
		}
		const payload = (await res.json()) as {
			data?: { items?: unknown[]; nextCursor?: string | null };
		};
		const read = readCmsPage(payload.data?.items ?? []);
		entries.push(...read.entries);
		unusable.push(...read.unusable);
		const next = payload.data?.nextCursor;
		if (typeof next !== "string" || next.length === 0 || next === cursor) break;
		cursor = next;
	}
	return { entries, unusable };
}

/**
 * What the script did to one product — reported honestly, so the log cannot
 * claim "active" for a call it skipped.
 *
 * `skipped-inactive` exists because the plain skip branch created a SILENT
 * FAILURE PATH. If a first run prices a product and it ends up inactive
 * anyway — or a merchant prices one and then unpublishes it — the row has a
 * SKU, so every later run takes the `!shouldPrice` early return. The product
 * sits priced-but-inactive: listed, unbuyable, and the old summary line ("N
 * left as-is; this script never overwrites a price you set") read as success.
 *
 * The script MUST NOT heal that: publishing it would put back on sale exactly
 * what a merchant may have deliberately taken off it, which is why the publish
 * now sits behind the read. So it SAYS it instead, and the summary must not be
 * able to read as success while one exists.
 */
export type SeedOutcome =
	| { kind: "priced"; activated: boolean; stocked: number }
	| { kind: "skipped"; reason: string }
	| { kind: "skipped-inactive"; reason: string }
	| { kind: "skipped-unstocked"; reason: string };

export interface SeedDeps {
	/** The SITE — the only address this script needs now that commerce is
	 *  in-process. Reads and writes both go here. */
	siteUrl: string;
	/** The em-dash credential from `cmsAuthHeaders` — a bearer token or a
	 *  session cookie. */
	authHeaders: Record<string, string>;
	fetchImpl?: typeof fetch;
}

/** Headers for a state-changing em-dash request.
 *
 *  `X-EmDash-Request: 1` is em-dash's CSRF gate, enforced in middleware for
 *  every non-GET `/_emdash/api/*` request that authenticated with a SESSION
 *  COOKIE. Bearer-token requests skip the check (a token is not an ambient
 *  credential), so sending it unconditionally is right for both and the script
 *  never has to know which credential it ended up with. */
function writeHeaders(authHeaders: Record<string, string>): Record<string, string> {
	return { ...authHeaders, "Content-Type": "application/json", "X-EmDash-Request": "1" };
}

/**
 * POST one console envelope to the plugin admin route and return its `data`.
 *
 * TWO LAYERS OF "ok" AND THEY MEAN DIFFERENT THINGS. The outer one is em-dash's
 * (`{success, data}`) and a transport/authorization failure shows up as a
 * non-2xx. The inner one is the console's: a REFUSAL rides HTTP 200 with
 * `data.ok === false`. This helper unwraps only the outer envelope and hands the
 * inner one to the caller, because "no row yet" and "stock moved under you" are
 * answers the caller reasons about, not errors to throw on.
 */
async function postConsole(
	deps: SeedDeps,
	body: Record<string, unknown>,
	what: string,
): Promise<unknown> {
	const doFetch = deps.fetchImpl ?? fetch;
	const url = `${deps.siteUrl}${ADMIN_ROUTE}`;
	const res = await doFetch(url, {
		method: "POST",
		headers: writeHeaders(deps.authHeaders),
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`${what}: POST ${url} → HTTP ${res.status}: ${await res.text()}`);
	}
	const envelope = (await res.json()) as { success?: unknown; data?: unknown };
	if (envelope.success !== true) {
		throw new Error(
			`${what}: POST ${url} returned 200 but not a success envelope: ${JSON.stringify(envelope)?.slice(0, 300)}`,
		);
	}
	return envelope.data;
}

/** Read one product's commerce row through the console. */
export async function readCommerce(row: DemoRow, deps: SeedDeps): Promise<ExistingCommerce | null> {
	const data = await postConsole(
		deps,
		{
			type: CONSOLE_READ_INTERACTION,
			// Built from the plugin's own prefix rather than spelled out: a
			// hand-transcribed resource string fails by being SILENTLY UNROUTED, and
			// exporting the prefix was the whole justification for widening the barrel.
			resource: `${PRODUCTS_CONSOLE_RESOURCE_PREFIX}detail`,
			productId: row.id,
		},
		`reading ${row.slug}`,
	);
	return parseExistingCommerce(data, row.id);
}

/** Dispatch one console action and throw on a refusal, naming the refusal's own
 *  words — the route explains itself far better than a status code would. */
async function act(
	row: DemoRow,
	deps: SeedDeps,
	actionId: string,
	value: Record<string, string>,
): Promise<void> {
	const data = (await postConsole(
		deps,
		{ type: CONSOLE_ACT_INTERACTION, action_id: actionId, value },
		`${actionId} on ${row.slug}`,
	)) as {
		ok?: unknown;
		notice?: { variant?: string; title?: string; description?: string } | null;
	};
	if (data.ok !== true) {
		const notice = data.notice ?? undefined;
		throw new Error(
			`${actionId} on ${row.slug} was refused: ${notice?.title ?? "(no title)"} — ${notice?.description ?? "(no description)"}`,
		);
	}
	// `ok: true` only means the action ran. An error NOTICE is still a refusal —
	// the console renders it instead of a blank pane — so it must not pass as a
	// success here (that is the "looks like it worked" class this script fights).
	if (data.notice?.variant === "error") {
		throw new Error(
			`${actionId} on ${row.slug} reported an error: ${data.notice.title ?? ""} — ${data.notice.description ?? ""}`,
		);
	}
}

/**
 * STEP 2 — publish the product through the CMS so the plugin's own
 * `content:afterPublish` hook creates the `product_commerce` row with its title
 * and opens the publish gate.
 *
 * ONLY CALLED ON THE PATH THAT IS ABOUT TO PRICE. This is a WRITE that opens the
 * publish gate, not a probe: calling it for a product this script is going to
 * skip would re-activate a row a merchant deliberately unpublished. The caller
 * takes the skip before reaching here.
 *
 * Re-publishing an already-published entry is SAFE and is the normal case on a
 * re-run over a bare, still-unpriced row: em-dash re-promotes the current live
 * revision, preserves the original `published_at`, and still fires the hook —
 * whose upsert is ordering-guarded by `contentUpdatedAt`, so it cannot move a
 * row backwards.
 *
 * No request body: `publishedAt` would be a backdate (and would demand
 * `content:publish_any`), and this script has no business choosing one.
 */
async function publishForCommerceRow(row: DemoRow, deps: SeedDeps): Promise<void> {
	const doFetch = deps.fetchImpl ?? fetch;
	const url = `${deps.siteUrl}/_emdash/api/content/products/${encodeURIComponent(row.id)}/publish`;
	const res = await doFetch(url, { method: "POST", headers: writeHeaders(deps.authHeaders) });
	if (!res.ok) {
		throw new Error(
			`publishing ${row.slug}: POST ${url} → HTTP ${res.status}: ${await res.text()}. This is the step that creates the commerce row (and writes its title), so nothing downstream can work without it.`,
		);
	}
}

/**
 * Price, stock and activate one demo product — or skip it, if a merchant has
 * already priced it. The whole per-product flow lives here, with an injectable
 * `fetch`, so the RE-RUN behaviour is pinned by a test rather than by prose.
 */
export async function seedOneProduct(row: DemoRow, deps: SeedDeps): Promise<SeedOutcome> {
	// 1. READ, BEFORE ANY WRITE. This is the re-run guard (`shouldPrice`), and it
	//    has to come first because the publish below is not a probe — it opens the
	//    publish gate, and doing that for a product this script will skip would put
	//    a deliberately-unpublished one back on sale.
	const existing = await readCommerce(row, deps);

	if (!shouldPrice(existing)) {
		// It has a SKU, so it has been priced — by Pricing & inventory or by an
		// earlier run. Those values are the merchant's; leave them alone, and do
		// NOT publish it.
		const sku = existing?.sku ?? "?";
		if (existing !== null && !existing.active) {
			// Priced AND off sale. Most likely a merchant unpublished it on purpose,
			// which is precisely what this script must not undo — so it is reported
			// loudly rather than counted as "left as-is" or healed behind their back.
			return { kind: "skipped-inactive", reason: `already priced (sku ${sku}) but NOT ACTIVE` };
		}
		if (existing !== null && existing.onHand === 0) {
			// Priced, active, listed — and at ZERO STOCK, so every add-to-cart fails.
			// This is what an earlier run that DIED between `products:save-identity`
			// and `products:restock` leaves behind (it has happened on a live run), and
			// the generic skip below would report it as "left as-is": the same
			// looks-fine lie the inactive branch above exists to prevent, on the stock
			// axis. Report it, and still write nothing — the stock is the merchant's.
			// A KNOWN zero only: `null` is "no inventory record read", not empty, and
			// claiming a stranding on an unreadable count would cry wolf.
			return { kind: "skipped-unstocked", reason: `already priced (sku ${sku}) but ZERO STOCK` };
		}
		return { kind: "skipped", reason: `already priced (sku ${sku})` };
	}

	// 2. The row + its title + the publish gate, through their only owner. Reached
	//    only for a product this script is about to price: one with no commerce row
	//    at all, or a bare sku-less sync row with nothing to lose. It does NOT
	//    overwrite price or stock, and it is also what heals a row whose title
	//    never landed.
	await publishForCommerceRow(row, deps);

	// 3. RE-READ. The row the hook just created (or refreshed) is the only source
	//    of the `expectedUpdatedAt` the write must echo — the publish moved it.
	const published = await readCommerce(row, deps);
	if (published === null) {
		throw new Error(
			`${row.slug} still has no commerce row after publishing it. The plugin's content sync hook did not run — check that the site is built with __OTTA_COMMERCE_MODE__ = "in-process" and that the otta plugin registered.`,
		);
	}

	// 4. SKU + price. `expectedUpdatedAt` comes from the re-read above; the route
	//    refuses the write without it.
	await act(row, deps, "products:save-identity", priceBody(row, published.updatedAt));

	// 5. Stock. RE-READ FIRST, deliberately: giving the product a sku is what
	//    creates its inventory record, so the `onHand` watermark the restock must
	//    carry only exists after step 3 — the count read before it was `null`
	//    ("no inventory record"), which the route rejects as an unreadable
	//    payload rather than treating as zero.
	const afterPricing = await readCommerce(row, deps);
	if (afterPricing === null || afterPricing.onHand === null) {
		throw new Error(
			`${row.slug} was priced (sku ${row.sku}) but has no inventory record to stock. It will be listed and unbuyable; add stock from Pricing & inventory.`,
		);
	}
	let stocked = 0;
	if (row.initialOnHand > 0 && afterPricing.onHand === 0) {
		await act(row, deps, "products:restock", restockBody(row, afterPricing.onHand));
		stocked = row.initialOnHand;
	}
	return { kind: "priced", activated: afterPricing.active, stocked };
}

async function main(): Promise<void> {
	const siteUrl = trimUrl(process.env["SITE_URL"] ?? DEFAULT_SITE_URL);
	const seedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed/seed.json");

	const slugs = seededProductSlugs(seedPath);
	const authHeaders = await cmsAuthHeaders(siteUrl);
	const page = await fetchCmsProducts(siteUrl, authHeaders);
	const rows = demoRows(slugs, page);
	console.info(`[otta] ${rows.length} demo product(s) against ${siteUrl} (commerce in-process)`);

	let priced = 0;
	let skipped = 0;
	const stranded: string[] = [];
	for (const row of rows) {
		const outcome = await seedOneProduct(row, { siteUrl, authHeaders });
		const where = `${row.title} (${row.slug} → ${row.id})`;
		if (outcome.kind === "skipped-inactive") {
			stranded.push(row.slug);
			// `warn`, not `info` — this one needs a human.
			console.warn(
				`[otta]   ${where} — SKIPPED, ${outcome.reason}. It will NOT appear in the storefront. Nothing was written to it: this script never publishes a product it is not pricing, because that would put back on sale what you may have deliberately taken off it. Publish it in the CMS, or activate it from Pricing & inventory.`,
			);
			continue;
		}
		if (outcome.kind === "skipped-unstocked") {
			stranded.push(row.slug);
			// `warn`, not `info` — priced, active and at zero stock is INVISIBLY
			// broken: the product lists normally and only fails at add-to-cart.
			console.warn(
				`[otta]   ${where} — SKIPPED, ${outcome.reason}. It is on sale but UNBUYABLE — every add-to-cart will fail. This is what a run interrupted between pricing and restocking leaves behind. Nothing was written to it: the stock level is yours to set, from Pricing & inventory.`,
			);
			continue;
		}
		if (outcome.kind === "skipped") {
			skipped++;
			console.info(`[otta]   ${where} — SKIPPED, ${outcome.reason}; left untouched`);
			continue;
		}
		priced++;
		console.info(
			`[otta]   ${where} — ${row.sku}, ${row.price.amount} ${row.price.currency} minor units, ${outcome.stocked} added to stock${outcome.activated ? ", active" : " (NOT ACTIVE)"}`,
		);
	}

	// The summary must never read as success while a product is stranded — priced
	// but inactive, or priced but at zero stock. Both states look fine from the
	// admin list and are exactly what the old "left as-is" wording papered over.
	if (stranded.length > 0) {
		console.warn(
			`[otta] done — ${priced} priced, ${skipped} left as-is, and ${stranded.length} STRANDED and not buyable (not active, or zero stock): ${stranded.join(", ")}. See the lines above.`,
		);
		return;
	}
	console.info(
		skipped === 0
			? `[otta] done — ${priced} demo product(s) priced, stocked and buyable.`
			: `[otta] done — ${priced} priced, ${skipped} left as-is (already priced and active; this script never overwrites a price you set).`,
	);
}

// Only run when invoked directly, so the pure helpers above stay importable.
// `pathToFileURL` rather than a `file://` string concat: any path needing URL
// encoding (a space, a non-ASCII character) would fail the comparison and turn
// the whole script into a silent no-op.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		console.error("[otta] seed-demo-commerce failed:", err);
		process.exitCode = 1;
	});
}
