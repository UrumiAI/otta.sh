/**
 * THE CMS REPEATER IS THE VARIANT NAME (ADR-0016, applying ADR-0013 one level
 * down). A product that sells in several sizes declares them in ONE content
 * field — a repeater whose rows carry exactly two sub-fields, a stable key and
 * a display name — and this module is the projection of that field onto the
 * commerce layer.
 *
 * IT CARRIES PRESENCE AND THE NAME CACHE, AND NOTHING ELSE. Stock and price are
 * sku-level facts owned by `product_variants` and edited from the admin's
 * Pricing & inventory surface; the declare's wire type (`UpsertProductVariantInput`)
 * has no `sku` and no `price`, so putting money in the repeater does not
 * compile — the same enforcement ladder the product title already stands on.
 *
 * THE TWO TRANSITIONS, on one channel and one watermark:
 *  - a row the repeater DECLARES is upserted (`PUT …/variants/:key`). That is
 *    also what brings a variant into existence, and what RESURRECTS one the CMS
 *    had stopped declaring — a variant exists exactly while the CMS says it
 *    does.
 *  - a row the repeater NO LONGER declares is DEACTIVATED
 *    (`POST …/variants/:key/deactivate`), never deleted. An orphaned variant may
 *    still hold stock and still sit on live order lines, so the row is retained
 *    with its sku, its price and its inventory, and the console surfaces the
 *    orphan rather than hiding it.
 *
 * HOW THE DROPPED SET IS COMPUTED. A content hook carries only the document as
 * saved — em-dash's `ContentHookEvent` is `{content, collection, isNew}` and has
 * no "before" — so "which keys did this save stop declaring?" cannot be answered
 * from the event. It is answered by the commerce side instead: read the LIVE
 * variants of the product (`GET …/variants`, the public projection, which is
 * live rows only because this client sends no internal token) and orphan every
 * live key the repeater no longer carries. Already-orphaned rows are absent from
 * that read and so are never re-orphaned, which is exactly right — the orphan
 * transition is idempotent at the store too, but not paying for it is better.
 *
 * SAME CHANNEL, SAME POSTURE AS THE PRODUCT TITLE. This rides the existing
 * `content:afterSave` / `content:afterPublish` hooks (no new hook, no new
 * capability, no new host), over `ctx.http` to the commerce service, and it is
 * FIRE-AND-FORGET: a failure is logged and never thrown into the CMS save path.
 * There is still no reconcile job anywhere in the repo, so a failed variant sync
 * — presence and name alike — is lost until the product is saved or published
 * again, with the same "the idempotent upsert makes that replay safe" caveat the
 * product title carries. PUBLISH IS THE STRONGER VERB, and on a
 * revision-supporting collection it is sometimes the only one that works: a
 * draft-only save can leave `updatedAt` frozen, and the resurrect half of the
 * presence axis applies only on a STRICTLY NEWER watermark.
 */
import type {
	ProductVariantSummaryWire,
	ProductVariantWire,
	UpsertProductVariantInput,
} from "../product-commerce/commerce-client.js";

/**
 * The content field carrying the variant repeater.
 *
 * `data.variants` IS A HARD ASSUMPTION, stated here for the same reason
 * `TITLE_FIELD` states its own: a repeater is an ordinary user-defined
 * collection field, so `mapRow()` copies it into the hook record's `data` bag
 * and it is NEVER a top-level field on em-dash's `ContentItem`. The staging
 * seed declares it on `products` (`sites/staging/seed/seed.json`), and a
 * collection that names it something else simply declares no variants — which
 * is the state of the entire live catalogue and is why this lands inert.
 */
export const VARIANTS_FIELD = "variants";

/** The repeater row's stable, immutable identity sub-field. */
export const VARIANT_KEY_SUBFIELD = "key";

/** The repeater row's customer-facing display name sub-field — translated, and
 *  the label a storefront picker renders. */
export const VARIANT_NAME_SUBFIELD = "name";

/**
 * Mirrors `@otta-sh/service`'s `upsertProductVariantBody.title` bound
 * (`z.string().min(1).max(500)`), restated rather than imported for the reason
 * `parse-product-title.ts` restates its own: the plugin declares no dependency
 * on the service package.
 */
const NAME_MAX_LENGTH = 500;

/** One repeater row, projected onto the declare channel.
 *
 *  `title` follows `UpsertProductVariantInput.title` exactly: `undefined`
 *  PRESERVES whatever name is stored, an explicit `null` CLEARS it. Those are
 *  different facts and the difference is load-bearing — see
 *  {@link parseVariantName}. */
export interface DeclaredVariant {
	variantKey: string;
	title?: string | null;
}

/** The outcome of reading one product's repeater. `problems` are LOG LINES,
 *  never refusals: a content problem must never veto the sync (the rule
 *  `parseProductTitle` established, applied again here). */
export interface ParsedRepeater {
	declared: DeclaredVariant[];
	problems: string[];
}

/** What one document says about the repeater. THREE outcomes, because the third
 *  used to hide inside the first: a field that is present but is not an array is
 *  a content problem worth a log line, not the same fact as a document that
 *  never declared the field. */
export type RepeaterRead =
	| { kind: "absent" }
	| { kind: "rows"; rows: unknown[] }
	| { kind: "unusable"; problem: string };

/**
 * Read the repeater out of the saved content record's `data` bag.
 *
 * `absent` MEANS "THIS DOCUMENT DECLARES NO REPEATER AT ALL", and it is the
 * whole of the inert-on-the-live-catalogue guarantee: the caller does nothing —
 * not one extra request — so a product with no variants syncs byte-identically
 * to how it did before variants existed. Defensive about the `data` overlay
 * shape for the same reason `readContentTitle` is: a hook must never fail a CMS
 * save.
 *
 * THE ONE THING THIS CANNOT DISTINGUISH, stated so nobody has to discover it:
 * em-dash's `mapRow()` EXCLUDES null columns from `data`, so a collection with
 * no repeater field and a repeater the merchant emptied to null look identical
 * here — both are `absent`, both sync nothing. An emptied repeater that persists
 * as `[]` (a real, present, empty array) IS distinguishable and DOES orphan
 * every live variant, which is the intended reading of "the merchant deleted
 * every row". The conservative branch is deliberate: silently orphaning every
 * size of every product on a collection that never had a repeater would be
 * catastrophic, and being wrong in the other direction merely leaves a variant
 * live until the next save that carries rows.
 */
export function readVariantRows(content: Record<string, unknown>): RepeaterRead {
	const data = content["data"];
	if (typeof data !== "object" || data === null) return { kind: "absent" };
	const raw = (data as Record<string, unknown>)[VARIANTS_FIELD];
	if (raw === undefined || raw === null) return { kind: "absent" };
	if (!Array.isArray(raw)) {
		// PRESENT BUT NOT A LIST. Nothing can be read out of it, so nothing is
		// declared and — critically — nothing is dropped: a value this module
		// cannot parse is not evidence that the merchant deleted anything.
		return {
			kind: "unusable",
			problem: `\`data.${VARIANTS_FIELD}\` is ${typeof raw}, not a list of repeater rows`,
		};
	}
	return { kind: "rows", rows: raw };
}

/** Read one sub-field off a repeater row, tolerating a non-object row. */
function readSubField(row: unknown, subField: string): unknown {
	return typeof row === "object" && row !== null
		? (row as Record<string, unknown>)[subField]
		: undefined;
}

/**
 * Validate a repeater row's display name.
 *
 * ABSENT IS NOT EMPTY, and getting that wrong is the one way this module could
 * destroy data. The name is a CACHE whose only writer is this channel, so an
 * `undefined` that reached the wire as an explicit `null` would BLANK the stored
 * name of every variant, on every save, for any document that stopped carrying
 * the sub-field — a renamed sub-field, an importer that never wrote it, a client
 * that posts a partial row. And a blanked variant name is not merely a display
 * regression: every order line placed afterwards freezes the blank at purchase
 * time, and the snapshot rule forbids rewriting it. So the sibling rule applies
 * unchanged (`parseProductTitle`): a field that is not there omits itself, and
 * the store preserves what it holds.
 *
 * FOUR OUTCOMES, and the first two are the whole of the rule:
 *  - the sub-field is ABSENT (`undefined`) ⇒ OMIT it and report a problem. The
 *    store preserves the stored name. This is the case a collection whose
 *    repeater sub-fields are named something else lands in, on every row, on
 *    every save — it syncs no names rather than erasing them.
 *  - an EXPLICIT `null`, or an empty / whitespace-only string ⇒ send `null`,
 *    which CLEARS the stored cache. The merchant's document said the name is
 *    gone, which is a statement rather than an absence, and the service's own
 *    schema documents this exact mapping ("a repeater row whose name sub-field
 *    is empty"). NOT A PATH THE EDITOR CAN TAKE: the name sub-field is declared
 *    `required`, so the content editor will not save a row without one. It is
 *    reachable by the clients that bypass that validation — an API or CLI write,
 *    an importer, a seed — and it is handled here so those writes clear the cache
 *    honestly rather than stranding a name the document no longer carries.
 *  - a NON-STRING, or a string past the service's 500-character bound ⇒ OMIT and
 *    report. Sending it would be a 400, and a 400 is a TRANSPORT failure: a
 *    content problem must never masquerade as one.
 *
 * A null name is NOT fatal and NOT a reason to withhold the variant. Unlike the
 * product title — whose absence makes checkout reject the line with
 * `PRODUCT_NOT_PRICED` — an unnamed variant sells perfectly well and simply
 * prints a blank size on the receipt. ADR-0016 recorded that asymmetry as an
 * open question; this module answers it the non-blocking way, because the
 * alternative (refusing to declare a size because its name is missing) hides a
 * sellable unit from the operator who would fix it.
 */
export function parseVariantName(value: unknown): { title: string | null } | { problem: string } {
	// ABSENT ⇒ OMIT. Never a clear: see the rule above — this is what stops a
	// renamed or missing sub-field from blanking every stored variant name.
	if (value === undefined) {
		return {
			problem: `no \`${VARIANT_NAME_SUBFIELD}\` sub-field on the row (expected \`data.${VARIANTS_FIELD}[].${VARIANT_NAME_SUBFIELD}\`)`,
		};
	}
	// An EXPLICIT null is the document saying the name is gone.
	if (value === null) return { title: null };
	if (typeof value !== "string") {
		return { problem: `\`${VARIANT_NAME_SUBFIELD}\` is ${typeof value}, not a string` };
	}
	const title = value.trim();
	if (title.length === 0) return { title: null };
	if (title.length > NAME_MAX_LENGTH) {
		return {
			problem: `\`${VARIANT_NAME_SUBFIELD}\` is ${title.length} characters; the service accepts at most ${NAME_MAX_LENGTH}`,
		};
	}
	return { title };
}

/**
 * Project the repeater's rows onto the declare channel.
 *
 * THE KEY IS TRIMMED, AND THAT IS AN IDENTITY DECISION. `(product_id,
 * variant_key)` is the primary key and the store compares it as plain text, so
 * `"large"` and `"large "` would be two variants — one of them created by a
 * stray keystroke, the other orphaned by it. Normalising once, here, at the
 * single point the key enters the system, is what makes the key stable in
 * practice as well as in the schema. Everything downstream (the declare, the
 * drop set, the duplicate check) uses the normalised form, so the two can never
 * disagree.
 *
 * A ROW WITH NO USABLE KEY DECLARES NOTHING. It is skipped and reported: a key
 * is the variant's identity, and a row that cannot be addressed could never be
 * priced, re-declared or orphaned again.
 *
 * A DUPLICATE KEY IS AMBIGUOUS, AND THE FIRST ROW WINS. Two rows claiming one
 * key do not describe two sellable units — they describe one, twice, with two
 * names, and nothing in the document says which name is meant. Declaring both
 * would make the outcome depend on request ordering; declaring neither would
 * orphan a live size over a typo. So the first occurrence is taken and the rest
 * are reported.
 *
 * THIS IS THE RULE, not a stand-in for one. A repeater sub-field is declared
 * with a slug, a type, a label, a required flag and an option list — the CMS has
 * no uniqueness constraint to express here — so resolving the ambiguity
 * deterministically at this point is what keeps the stored name independent of
 * request ordering (ADR-0016, amended 2026-08-09; see the module note in
 * `hooks.ts`).
 */
export function parseVariantRepeater(rows: readonly unknown[]): ParsedRepeater {
	const declared: DeclaredVariant[] = [];
	const problems: string[] = [];
	const seen = new Set<string>();

	for (const [index, row] of rows.entries()) {
		const rawKey = readSubField(row, VARIANT_KEY_SUBFIELD);
		if (typeof rawKey !== "string" || rawKey.trim().length === 0) {
			problems.push(
				`row ${index} has no usable \`${VARIANT_KEY_SUBFIELD}\` (a variant key must be a non-empty string) — the row declares no variant`,
			);
			continue;
		}
		const variantKey = rawKey.trim();
		if (seen.has(variantKey)) {
			problems.push(
				`row ${index} REUSES the variant key "${variantKey}" already declared by an earlier row — only the first row's name is synced`,
			);
			continue;
		}
		seen.add(variantKey);

		const parsed = parseVariantName(readSubField(row, VARIANT_NAME_SUBFIELD));
		if ("problem" in parsed) {
			problems.push(`row ${index} ("${variantKey}"): ${parsed.problem} — its stored name is kept`);
			declared.push({ variantKey });
			continue;
		}
		declared.push({ variantKey, title: parsed.title });
	}

	return { declared, problems };
}

/**
 * The declare's idempotency key. Same construction as
 * `deriveSaveIdempotencyKey` — and it degrades the same way on a host that emits
 * no `version` — with the VARIANT KEY carried so that one save's declares of N
 * sizes are N distinct keys rather than one, and with the transition infix
 * placed BEFORE the variant key so no opaque CMS text can ever be crafted to
 * collide the two key-spaces.
 *
 * A redelivered save replays the identical record, hence the identical key, and
 * the store's per-row replay guard makes it a no-op. A genuinely newer save
 * mints a fresh key that applies.
 */
export function deriveVariantDeclareKey(
	collection: string,
	productId: string,
	variantKey: string,
	updatedAt: unknown,
	version?: unknown,
): string {
	const base = `${collection}:${productId}:variant:${variantKey}:${String(updatedAt)}`;
	return version === undefined || version === null ? base : `${base}:${String(version)}`;
}

/** The ORPHAN transition's idempotency key — the declare's mirror, in a disjoint
 *  key-space (`variant-orphaned`), because presence has two opposing transitions
 *  and they share one per-row `idempotency_key` column. The store dedupes a
 *  replayed drop on this key ahead of every other guard, which is what keeps a
 *  redelivered "the row is gone" from orphaning a variant that has since come
 *  back. */
export function deriveVariantOrphanKey(
	collection: string,
	productId: string,
	variantKey: string,
	updatedAt: unknown,
	version?: unknown,
): string {
	const base = `${collection}:${productId}:variant-orphaned:${variantKey}:${String(updatedAt)}`;
	return version === undefined || version === null ? base : `${base}:${String(version)}`;
}

/** The narrow slice of `CommerceClient` this sync uses — one method per WRITER
 *  plus the read that computes the drop set. Deliberately NOT the whole client:
 *  the two methods it omits are the admin edit (which owns sku and price) and
 *  everything else, so this module structurally cannot become a second writer of
 *  a commercial field. */
export interface VariantSyncClient {
	listProductVariants(productId: string): Promise<ProductVariantSummaryWire[]>;
	upsertProductVariant(
		productId: string,
		variantKey: string,
		input: UpsertProductVariantInput,
		idempotencyKey: string,
	): Promise<ProductVariantWire>;
	deactivateProductVariant(
		productId: string,
		variantKey: string,
		idempotencyKey: string,
		contentUpdatedAt: string,
	): Promise<void>;
}

export interface SyncVariantsInput {
	client: VariantSyncClient;
	collection: string;
	productId: string;
	content: Record<string, unknown>;
	/** The normalized save watermark (`normalize-watermark.ts`). REQUIRED: see
	 *  the skip below. */
	watermark: string | undefined;
	/** The hook name, for the log lines — so a failure says which delivery lost
	 *  it, exactly as the product sync's lines do. */
	hook: string;
	allowedHosts: readonly string[];
}

/**
 * Project one save's repeater onto the commerce layer. NEVER THROWS — it is
 * called from inside a fire-and-forget content hook and must not fail a CMS
 * save, nor disturb the product-level sync it runs beside.
 *
 * ORDER: declare every key the repeater still carries, then read the live set,
 * then orphan what is no longer declared. Declaring first means a resurrect has
 * already landed before the drop set is read, so a key that was orphaned and is
 * now back cannot appear in it.
 *
 * NO WATERMARK ⇒ NO VARIANT SYNC, logged. The deactivate route REQUIRES a
 * watermark (presence has two opposing transitions arriving as independent
 * fire-and-forget POSTs, and only the watermark orders them), so half of this
 * channel simply cannot be sent without one. Running the other half alone would
 * declare sizes while being unable to retire any — a divergence that persists
 * until the next save — so both halves skip together. Same posture, and the same
 * honest "lost until the next save/publish" caveat, that
 * `content:afterUnpublish` takes on an unparseable `updatedAt`.
 *
 * TWO GUARDS ON THE DROP PHASE, because it is the only destructive half of this
 * channel and the cost of being wrong is asymmetric:
 *  - a repeater that is PRESENT WITH ROWS but yields NO USABLE KEY drops
 *    nothing. Rows that are all malformed are a content problem, not the
 *    merchant's statement that every size is gone — the same conservative
 *    reading `readVariantRows` gives an absent field, applied one step later.
 *    A DELIBERATELY EMPTIED repeater (`[]`, present, zero rows) is a different
 *    fact and DOES orphan everything, which is the whole point of the
 *    distinction.
 *  - a row the read already reports as ORPHANED is skipped rather than
 *    re-dropped.
 */
export async function syncVariants({
	client,
	collection,
	productId,
	content,
	watermark,
	hook,
	allowedHosts,
}: SyncVariantsInput): Promise<void> {
	const read = readVariantRows(content);
	// THE LIVE CATALOGUE'S PATH: no repeater, no requests, no behavior change.
	if (read.kind === "absent") return;
	if (read.kind === "unusable") {
		console.warn(
			`[otta] ${hook}: product_id=${productId} variant repeater problem — ${read.problem}. No variant was declared and NOTHING was dropped: a value this sync cannot read is not evidence that a size was removed.`,
		);
		return;
	}
	const rows = read.rows;

	if (watermark === undefined) {
		console.error(
			`[otta] ${hook} for product_id=${productId} carried no parseable updatedAt watermark — variant sync skipped (the orphan transition requires one). No reconcile cron exists yet — this sync is lost until the product is saved/published again.`,
		);
		return;
	}

	const { declared, problems } = parseVariantRepeater(rows);
	for (const problem of problems) {
		// NOT fatal, and never a reason to withhold the other rows. Logged because
		// a size that silently fails to appear in Pricing & inventory is otherwise
		// unexplainable from the merchant's side.
		console.warn(
			`[otta] ${hook}: product_id=${productId} variant repeater problem — ${problem}. The variant name is read from the content field \`data.${VARIANTS_FIELD}[].${VARIANT_NAME_SUBFIELD}\` and its key from \`data.${VARIANTS_FIELD}[].${VARIANT_KEY_SUBFIELD}\`.`,
		);
	}

	const updatedAt = content["updatedAt"];
	const version = content["version"];
	try {
		for (const variant of declared) {
			await client.upsertProductVariant(
				productId,
				variant.variantKey,
				// The name cache (or an explicit clear) plus the ordering watermark,
				// and NOTHING else. `sku` and `price` are absent from this input type
				// by design — the sync cannot write them, so it can never race the
				// admin's edit.
				{
					...(variant.title !== undefined ? { title: variant.title } : {}),
					contentUpdatedAt: watermark,
				},
				deriveVariantDeclareKey(collection, productId, variant.variantKey, updatedAt, version),
			);
		}

		// THE DROP PHASE IS WITHHELD when the repeater carried rows and not one of
		// them yielded a usable key. "Every row is malformed" is a content problem;
		// "there are no rows" is the merchant deleting the last size. Reading the
		// first as the second would orphan a product's entire range over a bad
		// import or a renamed sub-field — the same catastrophe the absent-field
		// branch exists to avoid, one step further in.
		if (rows.length > 0 && declared.length === 0) {
			console.warn(
				`[otta] ${hook}: product_id=${productId} declared ${rows.length} variant repeater row(s) and NONE carried a usable \`${VARIANT_KEY_SUBFIELD}\` — no variant was dropped. An intentionally emptied repeater (zero rows) is what retires every size.`,
			);
			return;
		}

		// The drop set: every LIVE variant this save stopped declaring.
		const declaredKeys = new Set(declared.map((variant) => variant.variantKey));
		const live = await client.listProductVariants(productId);
		for (const row of live) {
			if (declaredKeys.has(row.variantKey)) continue;
			// Belt and braces. THE LOAD-BEARING FILTER IS THE SERVICE'S: this client
			// sends no internal token, so it receives the public projection, which is
			// live rows only. This line makes the invariant local, so re-orphaning
			// does not silently start happening if that header choice ever changes
			// three files away.
			if (row.orphanedAt !== null) continue;
			// DEACTIVATION, NEVER DELETION: the row keeps its sku, its price and its
			// inventory, because an orphan may still hold stock and still sit on live
			// order lines. Surfacing that state in the console is a later increment;
			// this sets it.
			await client.deactivateProductVariant(
				productId,
				row.variantKey,
				deriveVariantOrphanKey(collection, productId, row.variantKey, updatedAt, version),
				watermark,
			);
		}
	} catch (err) {
		// Fire-and-forget, one line, same shape as the product sync's — including
		// the honest caveat. A partial application is safe to re-run: every call on
		// this channel is idempotent under its key and ordered by the watermark.
		console.error(
			`[otta] ${hook} variant sync failed for product_id=${productId} (host allowlist: ${allowedHosts.join(", ")}). No reconcile cron exists yet — this sync is lost until the product is saved/published again:`,
			err,
		);
	}
}
