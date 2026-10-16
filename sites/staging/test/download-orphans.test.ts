/**
 * The orphaned-upload sweep (issue #447) against a REAL R2 bucket — the local
 * simulator `wrangler`'s platform proxy runs in workerd, so `list`, prefixes,
 * cursors and `delete` are R2's own, not a fake's.
 *
 * Ages come from the key's ULID (the moment the upload endpoint minted it) and
 * the object's `uploaded` stamp, the younger of the two. The simulator stamps
 * `uploaded` with the real clock, so each case runs the sweep at `NOW`, a week
 * and a day after the objects were put, and sets each object's age through its
 * minted ULID.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintDownloadAssetKey, PRODUCT_NOT_FOUND_TITLE } from "@otta-sh/plugin";
import { getPlatformProxy } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { attachDownloadRefusal } from "../src/lib/download-attach-guard.js";
import { lookupProduct } from "../src/lib/download-upload.js";
import {
	ATTACH_MAX_AGE_MS,
	ORPHAN_MIN_AGE_MS,
	currentDownloadOf,
	isOrphanSweepTick,
	sweepDownloadOrphans,
	type CurrentDownload,
	type OrphanSweepBucket,
	type OrphanSweepCaps,
} from "../src/lib/download-orphans.js";

/** The simulator's R2 binding, as far as these cases use it. */
type TestBucket = OrphanSweepBucket & {
	put(key: string, value: string): Promise<unknown>;
	head(key: string): Promise<{ size: number; httpEtag: string; uploaded?: Date } | null>;
	list(options?: {
		prefix?: string;
		delimiter?: string;
		cursor?: string;
	}): ReturnType<OrphanSweepBucket["list"]>;
};

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now() + 8 * DAY;
const CAPS: OrphanSweepCaps = { products: 50, deletes: 100, prefixPages: 5 };

let dir: string;
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DOWNLOADS: TestBucket }>>>;
let bucket: TestBucket;
let seq = 0;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "otta-orphans-"));
	const config = join(dir, "wrangler.jsonc");
	writeFileSync(
		config,
		JSON.stringify({
			name: "otta-orphans-test",
			compatibility_date: "2025-01-01",
			r2_buckets: [{ binding: "DOWNLOADS", bucket_name: "otta-orphans-test" }],
		}),
	);
	proxy = await getPlatformProxy<{ DOWNLOADS: TestBucket }>({ configPath: config, persist: false });
	bucket = proxy.env.DOWNLOADS;
}, 60_000);

afterAll(async () => {
	await proxy?.dispose();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
	// Empty the bucket between cases.
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ cursor });
		if (page.objects.length > 0) await bucket.delete(page.objects.map((o) => o.key));
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor !== undefined);
});

/** Put an object for `productId` whose key was minted `ageDays` before NOW. */
async function upload(productId: string, ageDays: number): Promise<string> {
	seq += 1;
	const random = new Uint8Array(10);
	random[9] = seq % 256;
	random[8] = Math.floor(seq / 256);
	const key = mintDownloadAssetKey(
		productId as Parameters<typeof mintDownloadAssetKey>[0],
		NOW - ageDays * DAY,
		random,
	);
	await bucket.put(key, "bytes");
	return key;
}

async function keys(): Promise<string[]> {
	const page = await bucket.list();
	return page.objects.map((o) => o.key).toSorted();
}

function lookupFrom(
	answers: Record<string, CurrentDownload>,
): (productId: string) => Promise<CurrentDownload> {
	return (productId) => Promise.resolve(answers[productId] ?? { kind: "gone" });
}

function sweep(answers: Record<string, CurrentDownload>, caps = CAPS, tick = 0) {
	return sweepDownloadOrphans(
		{ bucket, currentDownload: lookupFrom(answers), now: NOW },
		{ tick, caps },
	);
}

describe("sweepDownloadOrphans", () => {
	test("deletes an abandoned upload older than a week; keeps the product's file and a recent upload", async () => {
		const current = await upload("P1", 30);
		const abandoned = await upload("P1", 20);
		const recent = await upload("P1", 2);

		const res = await sweep({ P1: { kind: "found", key: current } });

		expect(res.deleted).toEqual([abandoned]);
		expect(await keys()).toEqual([current, recent].toSorted());
	});

	test("an abandoned upload on a product that never got a file is deleted", async () => {
		const abandoned = await upload("P2", 10);
		const res = await sweep({ P2: { kind: "found", key: null } });
		expect(res.deleted).toEqual([abandoned]);
		expect(await keys()).toEqual([]);
	});

	test("never deletes the file a product names, however old", async () => {
		const current = await upload("P3", 400);
		await sweep({ P3: { kind: "found", key: current } });
		expect(await keys()).toEqual([current]);
	});

	test("keeps a replaced file while the product's current file is under a week old", async () => {
		// The replacement may have been saved moments ago, with a buyer's download
		// of the old file still in progress.
		const replaced = await upload("P4", 30);
		const current = await upload("P4", 3);
		const res = await sweep({ P4: { kind: "found", key: current } });
		expect(res.deleted).toEqual([]);
		expect(await keys()).toEqual([replaced, current].toSorted());
	});

	test("a product the plugin cannot find keeps every object", async () => {
		const a = await upload("P5", 30);
		const res = await sweep({ P5: { kind: "gone" } });
		expect(res.deleted).toEqual([]);
		expect(await keys()).toEqual([a]);
	});

	test("a busy or failed read stops the pass and deletes nothing after it", async () => {
		await upload("PA", 30);
		await upload("PB", 30);
		const res = await sweep({ PA: { kind: "busy" }, PB: { kind: "found", key: null } });
		expect(res.stopped).toBe("busy");
		expect(res.deleted).toEqual([]);
		expect(await keys()).toHaveLength(2);
	});

	test("an object whose key is not one the upload endpoint mints is never touched", async () => {
		await bucket.put("dl/P6/not-a-ulid", "bytes");
		await bucket.put("dl/P6/nested/01J9ZQ3V8K4M2N6P7R8S9T0VWX", "bytes");
		const res = await sweep({ P6: { kind: "found", key: null } });
		expect(res.deleted).toEqual([]);
		expect(await keys()).toHaveLength(2);
	});

	test("deletes at most `deletes` objects a pass", async () => {
		const current = await upload("P7", 60);
		for (let i = 0; i < 5; i++) await upload("P7", 30);
		const res = await sweep({ P7: { kind: "found", key: current } }, { ...CAPS, deletes: 2 });
		expect(res.deleted).toHaveLength(2);
		expect(await keys()).toHaveLength(4);
	});

	test("looks up at most `products` products a pass, moving on with the tick", async () => {
		for (const p of ["QA", "QB", "QC"]) await upload(p, 30);
		const answers: Record<string, CurrentDownload> = {
			QA: { kind: "found", key: null },
			QB: { kind: "found", key: null },
			QC: { kind: "found", key: null },
		};
		const caps = { ...CAPS, products: 1 };
		const first = await sweep(answers, caps, 0);
		const second = await sweep(answers, caps, 1);
		expect(first.deleted).toHaveLength(1);
		expect(second.deleted).toHaveLength(1);
		expect(first.deleted[0]?.split("/")[1]).not.toBe(second.deleted[0]?.split("/")[1]);
	});
});

describe("the sweep's timing", () => {
	test("an attach is refused before an upload is old enough to be swept", () => {
		// The attach guard refuses a file older than ATTACH_MAX_AGE_MS, so a file
		// the sweep may delete can never be newly attached while it runs.
		expect(ATTACH_MAX_AGE_MS).toBeLessThan(ORPHAN_MIN_AGE_MS);
	});

	test("runs once an hour", () => {
		const hour = Date.UTC(2026, 9, 12, 13, 0, 0);
		const ticks = Array.from({ length: 60 }, (_, m) => hour + m * 60_000).filter(isOrphanSweepTick);
		expect(ticks).toHaveLength(1);
	});
});

/** The plugin's `products.detail` answer, in EmDash's envelope. */
function dispatchAnswering(data: unknown) {
	const calls: unknown[][] = [];
	const dispatch = (...args: unknown[]) => {
		calls.push(args);
		return Promise.resolve({ success: true, data });
	};
	return { dispatch, calls };
}

describe("the product read the sweep makes", () => {
	test("reads the key of the product's file, with no user (the cron has none)", async () => {
		const { dispatch, calls } = dispatchAnswering({
			ok: true,
			product: {
				productId: "P1",
				productKind: "digital",
				deletedAt: null,
				downloadAsset: { key: "dl/P1/01J9ZQ3V8K4M2N6P7R8S9T0VWX", filename: "a.pdf" },
			},
		});
		const lookup = await lookupProduct(dispatch, "P1", undefined, new URL("https://internal/"));
		expect(currentDownloadOf(lookup)).toEqual({
			kind: "found",
			key: "dl/P1/01J9ZQ3V8K4M2N6P7R8S9T0VWX",
		});
		expect(calls[0]?.[4]).toBeUndefined();
	});

	test("a product with no file reads as none; an unknown product keeps its objects", async () => {
		const none = dispatchAnswering({
			ok: true,
			product: { productId: "P1", productKind: "digital", deletedAt: null, downloadAsset: null },
		});
		expect(
			currentDownloadOf(await lookupProduct(none.dispatch, "P1", undefined, new URL("https://x/"))),
		).toEqual({ kind: "found", key: null });
		const gone = dispatchAnswering({ ok: false, title: PRODUCT_NOT_FOUND_TITLE });
		expect(
			currentDownloadOf(await lookupProduct(gone.dispatch, "P1", undefined, new URL("https://x/"))),
		).toEqual({ kind: "gone" });
	});

	test("a file descriptor whose key is not a string is a failed read, never 'no file'", async () => {
		// Only a top-level `downloadAsset: null` means "no file". A descriptor
		// with a `null`, missing or non-string key is a reshaped answer: read as
		// "no file", the sweep would delete the live file (#502).
		for (const downloadAsset of [{ key: 7 }, { key: null }, {}, { key: undefined }]) {
			const odd = dispatchAnswering({
				ok: true,
				product: {
					productId: "P1",
					productKind: "digital",
					deletedAt: null,
					downloadAsset,
				},
			});
			expect(
				currentDownloadOf(
					await lookupProduct(odd.dispatch, "P1", undefined, new URL("https://x/")),
				),
				JSON.stringify(downloadAsset),
			).toEqual({ kind: "failed" });
		}
	});

	test("a downloadAsset that is neither an object nor null is a failed read, never 'no file'", async () => {
		// Fail closed: read as "no file", the sweep would delete the live file.
		for (const downloadAsset of ["dl/P1/01J9ZQ3V8K4M2N6P7R8S9T0VWX", 7, true, undefined]) {
			const odd = dispatchAnswering({
				ok: true,
				product: { productId: "P1", productKind: "digital", deletedAt: null, downloadAsset },
			});
			expect(
				currentDownloadOf(
					await lookupProduct(odd.dispatch, "P1", undefined, new URL("https://x/")),
				),
				String(downloadAsset),
			).toEqual({ kind: "failed" });
		}
	});

	test("a trashed product's file is kept: the product can be restored (#481)", async () => {
		const current = await upload("P9", 400);
		const { dispatch } = dispatchAnswering({
			ok: true,
			product: {
				productId: "P9",
				productKind: "digital",
				deletedAt: "2026-01-01T00:00:00.000Z",
				downloadAsset: { key: current, filename: "a.pdf" },
			},
		});
		const res = await sweepDownloadOrphans(
			{
				bucket,
				currentDownload: async (productId) =>
					currentDownloadOf(
						await lookupProduct(dispatch, productId, undefined, new URL("https://x/")),
					),
				now: NOW,
			},
			{ tick: 0, caps: CAPS },
		);
		expect(res.deleted).toEqual([]);
		expect(await keys()).toEqual([current]);
	});

	test("a product row with NO downloadAsset field is a failed read, never 'no file'", async () => {
		// Fail closed: read as "no file", the sweep would delete the live file.
		const bare = dispatchAnswering({
			ok: true,
			product: { productId: "P1", productKind: "digital", deletedAt: null },
		});
		expect(
			currentDownloadOf(await lookupProduct(bare.dispatch, "P1", undefined, new URL("https://x/"))),
		).toEqual({ kind: "failed" });
	});

	test("any refusal other than 'no such product' stops the pass", async () => {
		for (const refusal of [
			{ ok: false, title: "Pricing & inventory is unavailable", description: "Check settings." },
			{ ok: false, title: "That request could not be read" },
		]) {
			const { dispatch } = dispatchAnswering(refusal);
			expect(
				currentDownloadOf(await lookupProduct(dispatch, "P1", undefined, new URL("https://x/"))),
				refusal.title,
			).toEqual({ kind: "failed" });
		}
	});
});

describe("the attach guard refuses a file old enough to be swept", () => {
	test("an upload older than ATTACH_MAX_AGE_MS is not attached; a fresh one is", async () => {
		// Minted at the real clock, the moment the simulator stamps `uploaded`.
		const key = mintDownloadAssetKey(
			"P8" as Parameters<typeof mintDownloadAssetKey>[0],
			Date.now(),
			new Uint8Array(10).fill(3),
		);
		await bucket.put(key, "bytes");
		const claim = { productId: "P8", key, size: "5" };
		expect(await attachDownloadRefusal(bucket, claim, Date.now())).toBeNull();

		const stale = await attachDownloadRefusal(bucket, claim, Date.now() + ATTACH_MAX_AGE_MS + DAY);
		const body = (await stale?.json()) as { data?: { notice?: { description?: string } } };
		expect(body.data?.notice?.description).toMatch(/upload the file again/i);
	});

	test("with no `uploaded` stamp, the key's ULID age decides — the sweep's own rule", async () => {
		const key = mintDownloadAssetKey(
			"P9" as Parameters<typeof mintDownloadAssetKey>[0],
			Date.now() - ATTACH_MAX_AGE_MS - DAY,
			new Uint8Array(10).fill(4),
		);
		const noStamp = { head: () => Promise.resolve({ size: 5, httpEtag: "e" }) };
		const stale = await attachDownloadRefusal(noStamp, { productId: "P9", key, size: "5" });
		expect(stale).not.toBeNull();
	});
});
