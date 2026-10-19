/**
 * The orphaned-upload sweep (issue #447): deletes download files in the private
 * `DOWNLOADS` bucket that no product names any more.
 *
 * ── Where orphans come from ─────────────────────────────────────────────────
 * An upload stores its bytes under a fresh `dl/{productId}/{ULID}` key and the
 * console then saves that descriptor on the product (`download-upload.ts`). An
 * upload whose save never happens (a closed tab) leaves an object nothing names,
 * and so does a replaced file: the save points the product at the new key and
 * the old object stays. Each is up to 100 MB. Nothing serves them — the download
 * gate reads only the key the product names — so they cost storage, never
 * access.
 *
 * ── Why the site, and why not a lifecycle rule ──────────────────────────────
 * Uploads land under their final `dl/` key, the same prefix as every live file,
 * so an R2 lifecycle rule (prefix + age) cannot tell an orphan from a file a
 * product names. And the plugin's own cron cannot reach R2 (its only egress is
 * `ctx.http`). The site holds the binding, and its `scheduled()` handler can
 * read the plugin through EmDash's runtime (`src/worker.ts`), so the sweep runs
 * there.
 *
 * ── What is deleted ─────────────────────────────────────────────────────────
 * An object under `dl/{productId}/` is deleted only when ALL of these hold:
 *  1. its key is exactly `dl/{productId}/{ULID}` — one the upload endpoint
 *     mints; anything else in the bucket was put there by hand and is left;
 *  2. the plugin's admin read FOUND the product and its download file is a
 *     different key (or none) — a product it cannot find, or a read that fails,
 *     keeps every object;
 *  3. it is older than {@link ORPHAN_MIN_AGE_MS}, and so is the product's own
 *     file. Age is from the younger of the key's ULID and the object's
 *     `uploaded` stamp.
 * Why 3 makes "never delete a file a product names" hold under concurrency:
 * the attach guard (`download-attach-guard.ts`) refuses to save a file older
 * than {@link ATTACH_MAX_AGE_MS}, a day less. So no object old enough to be
 * swept can become a product's file while the sweep runs. And a product's
 * current file was saved at most {@link ATTACH_MAX_AGE_MS} after its upload, so
 * when that file is older than {@link ORPHAN_MIN_AGE_MS} the replacement is over
 * a day old: no buyer is still downloading the file it replaced.
 *
 * ── Caps ────────────────────────────────────────────────────────────────────
 * Hourly ({@link isOrphanSweepTick}). Each pass lists at most `prefixPages`
 * pages of product prefixes, checks at most `products` products — a different
 * slice each hour, chosen by the tick, so the whole catalogue is covered with no
 * stored cursor — and deletes at most `deletes` objects. A busy or failed
 * product read stops the pass: the store is under pressure, and the next hour
 * tries again.
 */
import { isDownloadAssetKeyFor } from "@urumi-ai/otta-plugin";
import type { ProductLookup } from "./download-upload.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** How old an unnamed upload must be before it is deleted. */
export const ORPHAN_MIN_AGE_MS = 7 * DAY_MS;

/** How old an upload may be when it is attached to a product. Kept a day under
 *  {@link ORPHAN_MIN_AGE_MS}; see the module comment. */
export const ATTACH_MAX_AGE_MS = 6 * DAY_MS;

/** The defaults a deployment runs with. */
export const ORPHAN_SWEEP_CAPS: OrphanSweepCaps = { products: 20, deletes: 100, prefixPages: 10 };

const PREFIX = "dl/";
const HOUR_MS = 60 * 60 * 1000;
/** The minute of the hour the sweep runs at (off the hour, which is busy). */
const SWEEP_MINUTE = 23;

export interface OrphanSweepCaps {
	/** Products checked a pass. */
	readonly products: number;
	/** Objects deleted a pass. */
	readonly deletes: number;
	/** Pages of product prefixes listed a pass (R2 answers up to 1000 a page). */
	readonly prefixPages: number;
}

/** An object as R2's `list` answers it, as far as the sweep reads it. */
export interface OrphanSweepObject {
	readonly key: string;
	readonly uploaded?: Date;
}

/** The two R2 binding methods the sweep uses — structural, as the site's other
 *  bucket types are (the site has no ambient Workers types). */
export interface OrphanSweepBucket {
	list(options: { prefix?: string; delimiter?: string; cursor?: string }): Promise<{
		objects: OrphanSweepObject[];
		delimitedPrefixes: string[];
		truncated: boolean;
		cursor?: string;
	}>;
	delete(keys: string | string[]): Promise<void>;
}

/** What the plugin says about a product's download file. */
export type CurrentDownload =
	/** `key` is the file the product names, `null` when it names none. */
	| { readonly kind: "found"; readonly key: string | null }
	/** The plugin has no such product. Its objects are kept. */
	| { readonly kind: "gone" }
	/** The read could not be made. The pass stops. */
	| { readonly kind: "busy" }
	| { readonly kind: "failed" };

/** The upload endpoint's product read, as the sweep needs it. "No such
 *  product" keeps the product's objects and moves on; any other refusal is a
 *  failed read, which stops the pass. */
export function currentDownloadOf(lookup: ProductLookup): CurrentDownload {
	switch (lookup.kind) {
		case "found":
			return { kind: "found", key: lookup.downloadKey };
		case "refused":
			// Only "no such product" lets the sweep skip and carry on; any other
			// refusal (unreadable request, store unavailable) stops the pass.
			return lookup.notFound ? { kind: "gone" } : { kind: "failed" };
		case "busy":
			return { kind: "busy" };
		case "failed":
			return { kind: "failed" };
	}
}

export interface OrphanSweepDeps {
	readonly bucket: OrphanSweepBucket;
	readonly currentDownload: (productId: string) => Promise<CurrentDownload>;
	/** Milliseconds since the epoch. */
	readonly now: number;
}

export interface OrphanSweepResult {
	readonly deleted: string[];
	/** Set when a product read stopped the pass. */
	readonly stopped?: "busy" | "failed";
}

/** Whether the cron tick at `scheduledTime` runs the sweep: once an hour. */
export function isOrphanSweepTick(scheduledTime: number): boolean {
	return Math.floor(scheduledTime / 60_000) % 60 === SWEEP_MINUTE;
}

/** The hour index a tick passes to {@link sweepDownloadOrphans}. */
export function orphanSweepTickIndex(scheduledTime: number): number {
	return Math.floor(scheduledTime / HOUR_MS);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The millisecond time a ULID's first ten characters carry, or `null`. */
function ulidTime(ulid: string): number | null {
	let ms = 0;
	for (const char of ulid.slice(0, 10)) {
		const digit = CROCKFORD.indexOf(char);
		if (digit < 0) return null;
		ms = ms * 32 + digit;
	}
	return ms;
}

/**
 * When the object at `key` was uploaded, for the age rules: the LATER of the
 * key's ULID time and R2's `uploaded` stamp, so neither clock can make a file
 * look older than it is. `null` for a key with no readable ULID.
 */
export function downloadUploadTime(key: string, uploaded: Date | undefined): number | null {
	const minted = ulidTime(key.slice(key.lastIndexOf("/") + 1));
	if (minted === null) return null;
	return Math.max(minted, uploaded?.getTime() ?? 0);
}

/** Every product prefix (`dl/{productId}/`) in the bucket, up to the page cap. */
async function productPrefixes(bucket: OrphanSweepBucket, pages: number): Promise<string[]> {
	const prefixes: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < pages; page++) {
		const listed = await bucket.list({
			prefix: PREFIX,
			delimiter: "/",
			...(cursor !== undefined ? { cursor } : {}),
		});
		prefixes.push(...listed.delimitedPrefixes);
		if (!listed.truncated) break;
		cursor = listed.cursor;
	}
	return prefixes;
}

/** Run one pass. Never throws for a product read; a bucket error propagates. */
export async function sweepDownloadOrphans(
	deps: OrphanSweepDeps,
	options: { tick: number; caps: OrphanSweepCaps },
): Promise<OrphanSweepResult> {
	const { bucket, now } = deps;
	const { caps } = options;
	const deleted: string[] = [];
	const prefixes = await productPrefixes(bucket, caps.prefixPages);
	if (prefixes.length === 0) return { deleted };

	const count = Math.min(caps.products, prefixes.length);
	const start = (options.tick * caps.products) % prefixes.length;
	for (let i = 0; i < count && deleted.length < caps.deletes; i++) {
		const prefix = prefixes[(start + i) % prefixes.length];
		if (prefix === undefined) continue;
		const productId = prefix.slice(PREFIX.length, -1);
		// ONE page (up to 1000 objects) per product a pass: a product with more
		// objects is swept a page at a time over later passes, and its current
		// file, if on a later page, is aged by its ULID alone.
		const listed = await bucket.list({ prefix });
		const isOld = (key: string, uploaded: Date | undefined): boolean => {
			const time = downloadUploadTime(key, uploaded);
			return time !== null && now - time > ORPHAN_MIN_AGE_MS;
		};
		const candidates = listed.objects.filter(
			(o) =>
				isDownloadAssetKeyFor(productId as Parameters<typeof isDownloadAssetKeyFor>[0], o.key) &&
				isOld(o.key, o.uploaded),
		);
		// Nothing old enough here: no read of the product is needed.
		if (candidates.length === 0) continue;

		const current = await deps.currentDownload(productId);
		if (current.kind === "busy" || current.kind === "failed") {
			console.warn(`[site-staging] download orphan sweep stopped: product read ${current.kind}`);
			return { deleted, stopped: current.kind };
		}
		if (current.kind === "gone") continue;
		if (current.key !== null) {
			// The product's own file must be past the age too (module comment, rule 3).
			const own = listed.objects.find((o) => o.key === current.key);
			if (!isOld(current.key, own?.uploaded)) continue;
		}
		const doomed = candidates
			.map((o) => o.key)
			.filter((key) => key !== current.key)
			.slice(0, caps.deletes - deleted.length);
		if (doomed.length === 0) continue;
		await bucket.delete(doomed);
		deleted.push(...doomed);
	}
	if (deleted.length > 0) {
		console.log(`[site-staging] download orphan sweep deleted ${String(deleted.length)} object(s)`);
	}
	return { deleted };
}
