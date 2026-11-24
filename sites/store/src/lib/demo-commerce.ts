/**
 * The demo products' pricing, and the pure steps that apply it: join the CMS
 * rows to the demo prices, build the console payloads, read the console's
 * answer, and decide whether a product may be priced at all.
 *
 * Two callers share it: the quick-start script (`scripts/seed-demo-commerce.ts`,
 * plain Node, whose header explains the whole flow and why each step is there)
 * and the playground (`playground-commerce.ts`, inside the Worker).
 *
 * It lives in `src/lib`, not `scripts/`, because the Worker imports it (#732).
 * Nothing here may do IO or touch `import.meta.url`, `process` or `node:*`:
 * the scripts resolve files from `import.meta.url` at load, which is undefined
 * in the bundled Worker, and importing them from here crashed every request.
 * `test/worker-module-graph.test.ts` holds that line.
 */
import { formatMinorUnitsInput } from "@urumi.ai/otta-plugin";

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
			`seed/seed.json declares product(s) with no entry in DEMO_PRICING: ${unpriced.join(", ")}. Add them to DEMO_PRICING in src/lib/demo-commerce.ts — a seeded product with no commerce row is listed but cannot be bought.`,
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
		price: formatMinorUnitsInput(row.price.amount, row.price.currency),
		currency: row.price.currency,
	};
}

/** The `products:restock` payload. `onHand` is the count this script just
 *  observed — not the target, and not a precondition: a restock is not pinned to
 *  it (an add is commutative), but the route still requires it. `qty` is how many
 *  to ADD. `nonce` is the movement's idempotency key, one per decision: the
 *  route refuses a movement without one. */
export function restockBody(
	row: DemoRow,
	onHand: number,
	nonce: string = crypto.randomUUID(),
): Record<string, string> {
	return { productId: row.id, onHand: String(onHand), qty: String(row.initialOnHand), nonce };
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
			// NOT dropped. A row priced without a title is listed but not for sale
			// (every sell path refuses it with PRODUCT_NOT_PRICED), so this must
			// surface as its own failure rather than as "no such product".
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
