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
 * WHY PRICING IS TWO WRITES AND NOT ONE. Pricing alone leaves the products
 * UNBUYABLE. `PUT /products/:id/commerce` deliberately never touches `active`
 * (a stale or replayed CMS sync must never resurrect a soft-deleted row), and
 * the storefront's purchasability rule is `commerce !== null && commerce.active`
 * (`joinProduct`). So each product needs its price AND a separate, guarded
 * `POST /products/:id/commerce/activate`.
 *
 * RE-RUNNING IS SAFE, AND THE IDEMPOTENCY KEY IS NOT WHAT MAKES IT SO. Each
 * product is READ first and skipped if its row already has a SKU — see
 * `shouldPrice`. Without that read a second run would silently overwrite a
 * merchant's prices: `product_commerce` has one shared `idempotency_key`
 * column, the `activate` call overwrites it, and the upsert body carries no
 * `contentUpdatedAt`, so neither the replay guard nor the ordering guard stops
 * the write. That is the exact clobber class "one home per field" removed from
 * the CMS sync, and it must not come back through the quickstart.
 *
 * WHY THE UPSERT ALSO CARRIES THE TITLE. `product_commerce.title` is normally
 * written by the CMS content sync — but no hook fires for a seeded product, so
 * the row would be born `title = NULL`, and `createOrderFromCart` rejects a
 * null-title line with `PRODUCT_NOT_PRICED`. The demo products would otherwise
 * be listed, priced, active and IMPOSSIBLE TO BUY, with the failure invisible
 * until a shopper reaches the last step of checkout. `PUT …/commerce` is the
 * same channel the sync uses, so the title written here is the value the first
 * real CMS save would write.
 *
 * WHY THE IDS COME FROM THE CMS AND NOT FROM `seed/seed.json`. **A seed entry's
 * `id` is not the stored id.** em-dash's seed applier generates a ULID for every
 * entry and keeps the declared id only as a seed-local reference
 * (`seedIdMap: seed id -> real entry id`, `packages/core/src/seed/apply.ts`), so
 * `product:urumi-tee` never exists in the content database. Addressing the
 * commerce service with it "succeeds" — `PUT …/commerce` mints a row for any id
 * — and creates three ORPHAN rows no CMS product will ever join to, leaving the
 * storefront showing "Not currently available for purchase" with no error
 * anywhere. So the ids are resolved from the CMS at run time, matched by SLUG.
 * `seed/seed.json` remains the source of truth for WHICH products get priced,
 * and a slug it declares that the CMS does not have is a hard error.
 *
 * USAGE
 *
 *   # after the service is running and the site's seed has been applied
 *   SITE_URL=http://localhost:4321 COMMERCE_SERVICE_URL=http://127.0.0.1:3000 \
 *     pnpm dlx tsx@4 sites/staging/scripts/seed-demo-commerce.ts
 *
 * AUTH, two gates, both optional depending on how you started things:
 *  - reading the CMS needs an em-dash credential. Set `EMDASH_TOKEN` to an API
 *    token (sent as `Authorization: Bearer …`). With no token the script falls
 *    back to `/_emdash/api/auth/dev-bypass`, which signs in as the dev admin and
 *    does nothing else. That route IS registered in a production build — it just
 *    returns 403 there — so a deployed site needs `EMDASH_TOKEN`.
 *  - both commerce writes are non-GET, so they need `X-Service-Token` when the
 *    service was started with `SERVICE_API_TOKEN` set (the write gate — see
 *    DEPLOYMENT.md). Export the same value here and the script sends it. The
 *    read is a GET and is never gated.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
	"urumi-tee": { sku: "URUMI-TEE", price: { amount: 3200, currency: "USD" }, initialOnHand: 25 },
	"urumi-mug": { sku: "URUMI-MUG", price: { amount: 1800, currency: "USD" }, initialOnHand: 40 },
	"urumi-stickers": {
		sku: "URUMI-STICKERS",
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

/** The upsert wire body for one demo product. Exported so a test can assert the
 *  shape — in particular that `title` is on it, because a title-less row fails
 *  ONLY at the last step of checkout, where nothing short of an actual purchase
 *  would notice. */
export function priceBody(row: DemoRow): Record<string, unknown> {
	return { title: row.title, sku: row.sku, price: row.price, initialOnHand: row.initialOnHand };
}

/**
 * A payload-derived idempotency key for the upsert. It is a courtesy, NOT the
 * re-run guard — see `shouldPrice`.
 *
 * THE IDEMPOTENCY KEY CANNOT MAKE THIS SCRIPT RE-RUNNABLE, and assuming it
 * could was a real bug in an earlier revision. `product_commerce` carries ONE
 * shared `idempotency_key` column, and step 2 of this loop (`activate`)
 * OVERWRITES it with the activate key. So on any re-run the stored key is the
 * activate key, the upsert's replay guard (`idempotency_key != :key`) passes
 * whatever this function returns, and the write applies. The ordering guard
 * cannot help either: this body deliberately carries no `contentUpdatedAt`.
 *
 * Unguarded, that is the F4 clobber class this release exists to eliminate,
 * re-introduced by the quickstart script — a merchant reprices `urumi-tee` to
 * $50, someone re-runs the script to add a fourth demo product, and the tee
 * silently reverts to $32 with its sku and title reset. `shouldPrice` is the
 * actual guard.
 */
function priceIdempotencyKey(row: DemoRow): string {
	const digest = createHash("sha256")
		.update(JSON.stringify(priceBody(row)))
		.digest("hex")
		.slice(0, 16);
	return `seed-demo-commerce:price:${row.id}:${digest}`;
}

/** The commerce row as `GET /products/:id/commerce` reports it — `null` when the
 *  product has none. Only the fields this script reasons about. */
export interface ExistingCommerce {
	sku: string | null;
	active: boolean;
}

/**
 * Narrow the GET payload, and FAIL LOUDLY on anything unrecognised.
 *
 * The endpoint returns a bare `serialize(row)` or a bare `null` today — a
 * missing row is `200 null`, not a 404 (`routes/product-commerce.ts`). But the
 * admin reads next door already use an `{ ok, product }` envelope, and if this
 * one ever grew one, an unchecked `as ExistingCommerce | null` would leave
 * `sku` as `undefined` — which `shouldPrice` reads as "already priced". The
 * quickstart would then price NOTHING while cheerfully printing "3 left as-is
 * (already priced)".
 *
 * So an unknown shape must never resolve to "skip". Skipping is the harmful
 * direction here: it is the one outcome that looks like success.
 */
export function parseExistingCommerce(
	payload: unknown,
	productId: string,
): ExistingCommerce | null {
	if (payload === null || payload === undefined) return null;
	if (typeof payload === "object") {
		const row = payload as Record<string, unknown>;
		const skuOk = typeof row["sku"] === "string" || row["sku"] === null;
		if (skuOk && typeof row["active"] === "boolean") {
			return { sku: (row["sku"] as string | null) ?? null, active: row["active"] };
		}
	}
	throw new Error(
		`GET /products/${productId}/commerce returned a shape this script does not recognise (expected \`null\` or a row with \`sku\` and \`active\`, got ${JSON.stringify(payload)?.slice(0, 200)}). Refusing to guess — treating it as "already priced" would silently skip every product and report success.`,
	);
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

/**
 * Whether the publish gate still needs opening. Skipping an already-active row
 * keeps the success line honest — `activate` is a no-op there.
 *
 * Note what this is NOT used for: it is never consulted on the skip path. A
 * product this script skips is one a merchant owns, and re-activating it on
 * every run would flip on a row the merchant priced but deliberately never
 * published (`active_updated_at` still NULL, so the epoch watermark applies).
 * That trades a visible problem for an invisible one. The skip path REPORTS the
 * inactive state instead — see `SeedOutcome`.
 */
export function shouldActivate(existing: ExistingCommerce | null): boolean {
	return existing === null || !existing.active;
}

/**
 * The publish-gate ORDERING WATERMARK this script sends with `activate`.
 *
 * Deliberately the UNIX epoch, not `new Date()`. The store's gate is
 * `active_updated_at IS NULL OR active_updated_at <= :t`, so on a freshly
 * created row (NULL) an epoch watermark applies fine — and it leaves the gate
 * at the oldest possible value, so EVERY subsequent real CMS lifecycle event
 * carries a strictly newer watermark and wins. Stamping "now" here would do the
 * opposite: a later unpublish, whose watermark is the content's own `updatedAt`
 * (set when the seed was applied, i.e. in the past), would be rejected as stale
 * and the demo product would stay purchasable after being unpublished.
 */
export const ACTIVATE_WATERMARK = new Date(0).toISOString();

const DEFAULT_SITE_URL = "http://localhost:4321";
const DEFAULT_SERVICE_URL = "http://127.0.0.1:3000";

function trimUrl(value: string): string {
	return value.replace(/\/+$/, "");
}

/** Authenticate against the CMS and return the headers to read content with. */
async function cmsAuthHeaders(siteUrl: string): Promise<Record<string, string>> {
	const token = process.env["EMDASH_TOKEN"];
	if (token !== undefined && token.length > 0) {
		console.info("[urumi] reading the CMS with EMDASH_TOKEN");
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
	console.info("[urumi] reading the CMS via the dev auth bypass (no EMDASH_TOKEN set)");
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
 * FAILURE PATH. If a first run's PUT succeeds and its `activate` then fails
 * (service restart, transient 5xx), the row has a SKU, so every later run takes
 * the `!shouldPrice` early return and never reaches the activate. The product
 * sits priced-but-inactive: listed, unbuyable, and the old summary line
 * ("N left as-is; this script never overwrites a price you set") read as
 * success. Before the skip guard existed, a re-run healed it.
 *
 * That is "listed, priced, impossible to buy" a third time in this change — the
 * plan's missing title, the orphan rows, and now the fix for the clobber. The
 * script cannot safely heal it (see `shouldActivate`), so it must SAY it, and
 * the summary must not be able to read as success while one exists.
 */
export type SeedOutcome =
	| { kind: "priced"; activated: boolean }
	| { kind: "skipped"; reason: string }
	| { kind: "skipped-inactive"; reason: string };

export interface SeedDeps {
	serviceUrl: string;
	serviceToken?: string | undefined;
	fetchImpl?: typeof fetch;
}

/**
 * Price, stock and activate one demo product — or skip it, if a merchant has
 * already priced it. The whole per-product flow lives here, with an injectable
 * `fetch`, so the RE-RUN behaviour is pinned by a test rather than by prose.
 */
export async function seedOneProduct(row: DemoRow, deps: SeedDeps): Promise<SeedOutcome> {
	const { serviceUrl, serviceToken } = deps;
	const doFetch = deps.fetchImpl ?? fetch;
	const id = encodeURIComponent(row.id);

	const writeHeaders = (idempotencyKey: string): Record<string, string> => {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			"Idempotency-Key": idempotencyKey,
		};
		// The write gate (`SERVICE_API_TOKEN`) blocks every non-GET without it.
		if (serviceToken !== undefined && serviceToken.length > 0) {
			headers["X-Service-Token"] = serviceToken;
		}
		return headers;
	};

	// 0. READ FIRST. This is the re-run guard (`shouldPrice`) — without it a
	//    second run overwrites a merchant's prices, because the idempotency key
	//    cannot dedupe here (see `priceIdempotencyKey`).
	const readRes = await doFetch(`${serviceUrl}/products/${id}/commerce`, { method: "GET" });
	if (!readRes.ok) {
		throw new Error(
			`GET /products/${row.id}/commerce → HTTP ${readRes.status}: ${await readRes.text()}`,
		);
	}
	const existing = parseExistingCommerce(await readRes.json(), row.id);

	if (!shouldPrice(existing)) {
		// It has a SKU, so it has been priced — by Pricing & inventory or by an
		// earlier run. Those values are the merchant's; leave them alone.
		const sku = existing?.sku ?? "?";
		if (existing !== null && !existing.active) {
			// Priced but NOT active. Most likely a previous run whose PUT landed and
			// whose activate did not. This script will never heal it — activating
			// here would also flip on a row a merchant priced and deliberately never
			// published — so report it loudly instead of counting it as "left as-is".
			return {
				kind: "skipped-inactive",
				reason: `already priced (sku ${sku}) but NOT ACTIVE`,
			};
		}
		return { kind: "skipped", reason: `already priced (sku ${sku})` };
	}

	// 1. Title + price + initial stock. The title is NOT optional garnish here:
	//    without it checkout rejects the line with PRODUCT_NOT_PRICED (see the
	//    module header). `initialOnHand` is a create-if-absent seed.
	const putRes = await doFetch(`${serviceUrl}/products/${id}/commerce`, {
		method: "PUT",
		headers: writeHeaders(priceIdempotencyKey(row)),
		body: JSON.stringify(priceBody(row)),
	});
	if (!putRes.ok) {
		throw new Error(
			`PUT /products/${row.id}/commerce → HTTP ${putRes.status}: ${await putRes.text()}`,
		);
	}

	// 2. Open the publish gate, when it is not already open. Its OWN idempotency
	//    key — the row carries a single `idempotency_key` column, so sharing one
	//    would make the second call look like a replay of the first.
	if (!shouldActivate(existing)) return { kind: "priced", activated: false };
	const actRes = await doFetch(`${serviceUrl}/products/${id}/commerce/activate`, {
		method: "POST",
		headers: writeHeaders(`seed-demo-commerce:activate:${row.id}`),
		body: JSON.stringify({ contentUpdatedAt: ACTIVATE_WATERMARK }),
	});
	if (!actRes.ok) {
		throw new Error(
			`POST /products/${row.id}/commerce/activate → HTTP ${actRes.status}: ${await actRes.text()}`,
		);
	}
	return { kind: "priced", activated: true };
}

async function main(): Promise<void> {
	const siteUrl = trimUrl(process.env["SITE_URL"] ?? DEFAULT_SITE_URL);
	const serviceUrl = trimUrl(process.env["COMMERCE_SERVICE_URL"] ?? DEFAULT_SERVICE_URL);
	const serviceToken = process.env["SERVICE_API_TOKEN"];
	const seedPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../seed/seed.json");

	const slugs = seededProductSlugs(seedPath);
	const page = await fetchCmsProducts(siteUrl, await cmsAuthHeaders(siteUrl));
	const rows = demoRows(slugs, page);
	console.info(`[urumi] ${rows.length} demo product(s) against ${serviceUrl}`);

	let priced = 0;
	let skipped = 0;
	const stranded: string[] = [];
	for (const row of rows) {
		const outcome = await seedOneProduct(row, { serviceUrl, serviceToken });
		const where = `${row.title} (${row.slug} → ${row.id})`;
		if (outcome.kind === "skipped-inactive") {
			stranded.push(row.slug);
			// `warn`, not `info` — this one needs a human.
			console.warn(
				`[urumi]   ${where} — SKIPPED, ${outcome.reason}. It will NOT appear in the storefront. This script does not activate a product it did not price (that would publish a product you may have deliberately left unpublished). Publish it in the CMS, or activate it from Pricing & inventory.`,
			);
			continue;
		}
		if (outcome.kind === "skipped") {
			skipped++;
			console.info(`[urumi]   ${where} — SKIPPED, ${outcome.reason}; left untouched`);
			continue;
		}
		priced++;
		console.info(
			`[urumi]   ${where} — ${row.sku}, ${row.price.amount} ${row.price.currency} minor units, ${row.initialOnHand} on hand${outcome.activated ? ", activated" : " (already active)"}`,
		);
	}

	// The summary must never read as success while a product is stranded
	// priced-but-inactive — that state is invisible in the storefront and was
	// exactly what the old "left as-is" wording papered over.
	if (stranded.length > 0) {
		console.warn(
			`[urumi] done — ${priced} priced, ${skipped} left as-is, and ${stranded.length} PRICED BUT NOT ACTIVE and therefore not on sale: ${stranded.join(", ")}. See the lines above.`,
		);
		return;
	}
	console.info(
		skipped === 0
			? `[urumi] done — ${priced} demo product(s) priced, stocked and buyable.`
			: `[urumi] done — ${priced} priced, ${skipped} left as-is (already priced and active; this script never overwrites a price you set).`,
	);
}

// Only run when invoked directly, so the pure helpers above stay importable.
// `pathToFileURL` rather than a `file://` string concat: any path needing URL
// encoding (a space, a non-ASCII character) would fail the comparison and turn
// the whole script into a silent no-op.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		console.error("[urumi] seed-demo-commerce failed:", err);
		process.exitCode = 1;
	});
}
