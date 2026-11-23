#!/usr/bin/env node
/**
 * Registry size gate for Otta Core.
 *
 *   pnpm -C packages/core size        (runs `emdash-plugin bundle`, then this)
 *
 * Reads the tarball the real registry CLI wrote (dist/<slug>-<version>.tar.gz)
 * and measures what the registry measures: the DECOMPRESSED size of each entry.
 * Fails (exit 1) when backend.js (the sandbox runtime) is over 72 KiB or the
 * bundle total (backend.js + manifest.json + README.md + any icon/screenshots)
 * is over 128 KiB. The registry's own caps are 128 KiB per file and 256 KiB in
 * total; these are the project's tighter budgets. Exit 2: no tarball, or more
 * than one (stale dist/).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

// 72 KiB, about 56% of the registry's 128 KiB per-file cap. PR 1 is ~61 kB and later features
// (variants, tax, JSON-LD) need room; raise only with a size table in ADR 0047.
const RUNTIME_LIMIT = 72 * 1024;
const TOTAL_LIMIT = 128 * 1024;
const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");

const tarballs = readdirSync(dist).filter((f) => f.endsWith(".tar.gz"));
if (tarballs.length !== 1) {
	console.error(
		`size: expected exactly one tarball in ${dist}, found ${tarballs.length}: run \`emdash-plugin bundle\` on a clean dist/`,
	);
	process.exit(2);
}

// Minimal ustar reader: 512-byte headers, octal size at offset 124, data padded to 512.
const tar = gunzipSync(readFileSync(join(dist, tarballs[0])));
const entries = [];
for (let off = 0; off + 512 <= tar.length;) {
	const header = tar.subarray(off, off + 512);
	if (header.every((b) => b === 0)) break;
	const field = (start, len) => {
		const raw = header.subarray(start, start + len);
		const nul = raw.indexOf(0);
		return raw.subarray(0, nul === -1 ? len : nul).toString("utf8");
	};
	const name = (field(345, 155) ? `${field(345, 155)}/` : "") + field(0, 100);
	const size = Number.parseInt(field(124, 12).trim() || "0", 8);
	const type = field(156, 1) || "0";
	if (type === "0") entries.push({ name: name.replace(/^\.\//, ""), size });
	off += 512 + Math.ceil(size / 512) * 512;
}

const kib = (n) => `${(n / 1024).toFixed(1)} KiB`;
const total = entries.reduce((s, e) => s + e.size, 0);
const runtime = entries.find((e) => e.name === "backend.js");
for (const e of entries.toSorted((a, b) => b.size - a.size))
	console.log(`${String(e.size).padStart(8)}  ${kib(e.size).padStart(10)}  ${e.name}`);
console.log(
	`${String(total).padStart(8)}  ${kib(total).padStart(10)}  total (${entries.length} files)`,
);

const failures = [];
if (!runtime) failures.push("backend.js is missing from the bundle");
else if (runtime.size > RUNTIME_LIMIT)
	failures.push(
		`backend.js is ${runtime.size} bytes, over the ${RUNTIME_LIMIT}-byte runtime budget by ${runtime.size - RUNTIME_LIMIT}`,
	);
if (total > TOTAL_LIMIT)
	failures.push(
		`the bundle is ${total} bytes, over the ${TOTAL_LIMIT}-byte total budget by ${total - TOTAL_LIMIT}`,
	);

const summary = `Otta Core bundle: backend.js ${kib(runtime?.size ?? 0)} / ${kib(RUNTIME_LIMIT)}, total ${kib(total)} / ${kib(TOTAL_LIMIT)}`;
if (process.env.GITHUB_STEP_SUMMARY) {
	const { appendFileSync } = await import("node:fs");
	appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
if (failures.length > 0) {
	for (const f of failures) console.error(`FAIL: ${f}`);
	process.exit(1);
}
console.log(`OK: ${summary}`);
