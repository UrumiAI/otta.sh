#!/usr/bin/env node
/**
 * Pack-and-consume type test (issue #510).
 *
 * Packs the published `@urumi.ai/otta-*` packages exactly as `pnpm publish`
 * would (`workspace:*` rewritten, `publishConfig.exports` applied, `files`
 * filtered), installs the tarballs into a scratch consumer, and type-checks the
 * snippet from the issue under the settings a site uses:
 * `--strict --module nodenext --moduleResolution nodenext --skipLibCheck`.
 *
 * WHAT IT CATCHES. 0.1.0 shipped `.d.mts` files that inlined their own copies
 * of domain's branded types (`declare const CurrencyBrand: unique symbol`), so a
 * `TaxCalculator` written against `@urumi.ai/otta-domain` was not assignable to
 * `createOttaPlugin`'s `taxCalculator` option. Nothing inside the workspace can
 * see that: the packages' `exports` point at TypeScript SOURCE there, so every
 * import resolves to one copy. Only a consumer of the TARBALLS sees what npm
 * serves.
 *
 * WHY IT IS CHEAP. No registry access: the consumer depends on the five tarballs
 * only (their dependencies are each other), peers are not auto-installed (the
 * declarations under test name no `emdash` import), and `tsc` is the
 * workspace's own. Run it after `pnpm -r build`; it reads `dist/`.
 *
 *   node scripts/pack-consume-types.mjs [--keep]
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["admin-presentation", "domain", "payments-stripe", "plugin", "store-emdash"];
const keep = process.argv.includes("--keep");

/** The issue's reproduction, plus the call a site actually writes. */
const SNIPPET = `import type { Currency, TaxCalculator } from "@urumi.ai/otta-domain";
import { createOttaPlugin } from "@urumi.ai/otta-plugin";

declare const calc: TaxCalculator;
type Opt = NonNullable<Parameters<typeof createOttaPlugin>[0]>;
export const x: Opt["taxCalculator"] = calc;

export const descriptor = createOttaPlugin({ taxCalculator: calc });

// The other direction: the plugin's own option type is the domain's type.
declare const fromPlugin: NonNullable<Opt["taxCalculator"]>;
export const y: TaxCalculator = fromPlugin;

// The brands themselves unify: domain's Currency is the plugin's request currency.
declare const code: Currency;
type PluginRequest = Parameters<NonNullable<Opt["taxCalculator"]>["calculate"]>[0];
export const currency: PluginRequest["currency"] = code;
`;

function run(cmd, args, cwd) {
	return execFileSync(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

/**
 * The pnpm that launched this script (`pnpm test:pack-types` sets
 * `npm_execpath`), so a run never depends on a global `pnpm` on PATH.
 */
function pnpm(args, cwd) {
	const exec = process.env.npm_execpath;
	if (exec && /pnpm/.test(path.basename(exec))) {
		return /\.c?js$/.test(exec)
			? run(process.execPath, [exec, ...args], cwd)
			: run(exec, args, cwd);
	}
	return run("pnpm", args, cwd);
}

const work = mkdtempSync(path.join(tmpdir(), "otta-pack-consume-"));
let failed = false;
try {
	const tarballs = path.join(work, "tarballs");
	for (const pkg of PACKAGES) {
		pnpm(["pack", "--pack-destination", tarballs], path.join(ROOT, "packages", pkg));
	}
	const files = readdirSync(tarballs).filter((f) => f.endsWith(".tgz"));
	const byName = Object.fromEntries(
		files.map((f) => {
			// urumi.ai-otta-domain-0.1.0.tgz -> @urumi.ai/otta-domain
			const match = /^urumi\.ai-(otta-[a-z-]+?)-\d+\.\d+\.\d+.*\.tgz$/.exec(f);
			if (!match) throw new Error(`unexpected tarball name: ${f}`);
			return [`@urumi.ai/${match[1]}`, `file:${path.join(tarballs, f)}`];
		}),
	);

	const consumer = path.join(work, "consumer");
	mkdirSync(consumer);
	writeFileSync(
		path.join(consumer, "package.json"),
		JSON.stringify(
			{
				name: "otta-pack-consumer",
				private: true,
				type: "module",
				dependencies: {
					"@urumi.ai/otta-domain": byName["@urumi.ai/otta-domain"],
					"@urumi.ai/otta-plugin": byName["@urumi.ai/otta-plugin"],
				},
			},
			null,
			"\t",
		),
	);
	// The tarballs name each other by version (publish rewrote `workspace:*`);
	// the overrides send those to the local tarballs instead of the registry.
	writeFileSync(
		path.join(consumer, "pnpm-workspace.yaml"),
		[
			"autoInstallPeers: false",
			"strictPeerDependencies: false",
			"overrides:",
			...Object.entries(byName).map(([name, spec]) => `  "${name}": "${spec}"`),
			"",
		].join("\n"),
	);
	writeFileSync(path.join(consumer, "index.ts"), SNIPPET);

	pnpm(["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"], consumer);

	const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
	try {
		run(
			process.execPath,
			[
				tsc,
				"--strict",
				"--module",
				"nodenext",
				"--moduleResolution",
				"nodenext",
				"--skipLibCheck",
				"--noEmit",
				"index.ts",
			],
			consumer,
		);
		console.log("pack-consume-types: OK — the packed types unify with @urumi.ai/otta-domain");
	} catch (error) {
		failed = true;
		console.error("pack-consume-types: FAILED — tsc on the packed packages:");
		console.error(String(error.stdout ?? "") + String(error.stderr ?? ""));
	}
} finally {
	if (keep) console.log(`kept ${work}`);
	else rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
