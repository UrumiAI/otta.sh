#!/usr/bin/env node
/**
 * Pack-and-build test of the template (ADR-0045).
 *
 * Packs every publishable package with `pnpm pack` (which applies
 * `publishConfig` and runs `prepack`), copies the template repository's files
 * into a scratch site, points its `@urumi.ai/*` dependencies at the tarballs,
 * installs with npm (what merchants use) and runs `astro build`.
 *
 * WHAT IT CATCHES. Every other test loads `@urumi.ai/otta-store` through the
 * workspace link (`src/integration.ts`). A merchant gets `dist/integration.mjs`
 * from `node_modules`, where `import.meta.resolve("astro")`, `packageRoot()`
 * and the seed and `public/` paths resolve differently. Only a build of the
 * packed form exercises them, together with the build guards.
 *
 * ASSERTS: the build exits 0 (so the integration's guards passed), the sample
 * photographs the seed names are in the client output at their URLs, the seed
 * ships in the installed package, and no build-environment value leaked into
 * the output (the scrub guard's concern: the builder's PATH, the scratch dir).
 *
 * Needs the registry (emdash, astro, ... at the template's pins), unlike
 * `pack-consume-types.mjs`.
 *
 *   node scripts/pack-build.mjs [--keep] [--template <dir>]
 *
 * `OTTA_TEMPLATE_DIR` also sets the template (default ~/otta-store-template);
 * `OTTA_PACK_BUILD_TMP` sets the temp root (default the OS temp dir).
 */

import { execFileSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = [
	"packages/admin-presentation",
	"packages/admin-react",
	"packages/domain",
	"packages/payments-cod",
	"packages/payments-stripe",
	"packages/plugin",
	"packages/store-emdash",
	"sites/store",
];
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const templateArg = args.indexOf("--template");
const TEMPLATE =
	(templateArg >= 0 ? args[templateArg + 1] : undefined) ??
	process.env.OTTA_TEMPLATE_DIR ??
	path.join(homedir(), "otta-store-template");

function run(cmd, cmdArgs, cwd, env = {}) {
	return execFileSync(cmd, cmdArgs, {
		cwd,
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, ...env },
	});
}

/** The pnpm that launched this script, else the one on PATH. */
function pnpm(pnpmArgs, cwd) {
	const exec = process.env.npm_execpath;
	if (exec && /pnpm/.test(path.basename(exec))) {
		return /\.c?js$/.test(exec)
			? run(process.execPath, [exec, ...pnpmArgs], cwd)
			: run(exec, pnpmArgs, cwd);
	}
	return run("pnpm", pnpmArgs, cwd);
}

function step(message) {
	console.log(`pack-build: ${message}`);
}

/** Every regular file under `dir`, as `/`-separated paths relative to it. */
function listFiles(dir, rel = "") {
	if (!existsSync(path.join(dir, rel))) return [];
	return readdirSync(path.join(dir, rel)).flatMap((name) => {
		const next = rel ? `${rel}/${name}` : name;
		return statSync(path.join(dir, next)).isDirectory() ? listFiles(dir, next) : [next];
	});
}

const SKIP = new Set([".git", "node_modules", "dist", ".astro", ".wrangler", "package-lock.json"]);

const work = mkdtempSync(
	path.join(process.env.OTTA_PACK_BUILD_TMP ?? tmpdir(), "otta-pack-build-"),
);
let failed = false;
try {
	if (!existsSync(path.join(TEMPLATE, "astro.config.mjs"))) {
		throw new Error(`template not found at ${TEMPLATE} (pass --template or OTTA_TEMPLATE_DIR)`);
	}

	// 1. Pack everything (prepack builds each package's dist/).
	const tarballs = path.join(work, "tarballs");
	for (const pkg of PACKAGES) {
		step(`pnpm pack ${pkg}`);
		pnpm(["pack", "--pack-destination", tarballs], path.join(ROOT, pkg));
	}
	const byName = {};
	for (const file of readdirSync(tarballs).filter((f) => f.endsWith(".tgz"))) {
		const match = /^urumi\.ai-(otta-[a-z-]+?)-\d+\.\d+\.\d+.*\.tgz$/.exec(file);
		if (!match) throw new Error(`unexpected tarball name: ${file}`);
		byName[`@urumi.ai/${match[1]}`] = `file:${path.join(tarballs, file)}`;
	}
	if (!byName["@urumi.ai/otta-store"]) throw new Error("no @urumi.ai/otta-store tarball");

	// 2. The scratch site: the template's files, @urumi.ai/* from the tarballs.
	const site = path.join(work, "site");
	cpSync(TEMPLATE, site, {
		recursive: true,
		filter: (src) => !SKIP.has(path.basename(src)),
	});
	const pkgPath = path.join(site, "package.json");
	const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	for (const section of ["dependencies", "devDependencies"]) {
		for (const name of Object.keys(pkg[section] ?? {})) {
			if (byName[name]) pkg[section][name] = byName[name];
		}
	}
	// The packed packages name each other by version; send those to the tarballs.
	// An override must reference a direct dependency, so add the ones the template omits.
	pkg.overrides = {};
	for (const name of Object.keys(byName)) {
		pkg.dependencies[name] ??= byName[name];
		pkg.overrides[name] = `$${name}`;
	}
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);

	// 3. npm install and astro build.
	const npmEnv = {
		npm_config_cache: path.join(work, "npm-cache"),
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
	step("npm install");
	run("npm", ["install", "--no-progress"], site, npmEnv);
	step("astro build");
	let buildLog = "";
	try {
		buildLog = run("npx", ["--no-install", "astro", "build"], site, npmEnv);
	} catch (error) {
		console.error("pack-build: FAILED — astro build on the packed packages:");
		console.error(String(error.stdout ?? "") + String(error.stderr ?? ""));
		throw Object.assign(new Error("astro build failed"), { reported: true });
	}

	// 4. Assertions.
	const problems = [];
	const installed = path.join(site, "node_modules", "@urumi.ai", "otta-store");
	const exportsMap = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")).exports;
	if (!String(exportsMap["."]?.default ?? "").endsWith("dist/integration.mjs")) {
		problems.push(
			"installed otta-store does not export dist/integration.mjs (publishConfig not applied)",
		);
	}
	if (!existsSync(path.join(installed, "seed", "seed.json"))) {
		problems.push("installed otta-store has no seed/seed.json");
	}
	// The sample photos: every file the package's public/playground-products ships,
	// and every one the seed names, must be in the client output at the same URL.
	const publicFiles = listFiles(path.join(installed, "public"));
	const photos = publicFiles.filter((f) => f.startsWith("playground-products/"));
	const seed = readFileSync(path.join(installed, "seed", "seed.json"), "utf8");
	const named = [...new Set(seed.match(/playground-products\/[\w.-]+\.jpg/g) ?? [])];
	if (named.length === 0) problems.push("seed.json names no playground-products photos");
	const client = path.join(site, "dist", "client");
	for (const rel of new Set([
		...photos,
		...named,
		...publicFiles.filter((f) => f.startsWith("scripts/")),
	])) {
		const file = path.join(client, ...rel.split("/"));
		if (!existsSync(file) || statSync(file).size === 0) {
			problems.push(`dist/client/${rel} is missing or empty`);
		}
	}
	// No builder value in the output (the build scrub's concern, checked again from outside).
	const leaks = [work, process.env.PATH ?? ""].filter((v) => v.length > 8);
	for (const rel of listFiles(path.join(site, "dist"))) {
		// The scrub's scope (build-path-scrub.ts): code, markup, data and the worker's
		// source maps, not `wrangler.json` (local deploy metadata).
		if (rel === "server/wrangler.json") continue;
		if (rel.endsWith(".map") && !rel.startsWith("server/")) continue;
		if (!/\.(m?js|json|html|txt|css|map)$/.test(rel)) continue;
		const text = readFileSync(path.join(site, "dist", rel), "utf8");
		for (const leak of leaks) {
			if (text.includes(leak)) {
				problems.push(`dist/${rel} contains a build-environment value (${leak.slice(0, 40)}...)`);
			}
		}
	}
	// Client maps are outside the scrub's scope; report them, do not fail.
	const leakyMaps = listFiles(path.join(site, "dist")).filter(
		(rel) =>
			rel.endsWith(".map") &&
			!rel.startsWith("server/") &&
			readFileSync(path.join(site, "dist", rel), "utf8").includes(work),
	);
	if (leakyMaps.length > 0) {
		console.warn(
			`pack-build: WARNING — ${leakyMaps.length} source map(s) in dist/ carry the build path: ${leakyMaps.join(", ")}`,
		);
	}
	if (/\bERR(OR)?\b.*(leak|scrub)/i.test(buildLog))
		problems.push("build log reports a scrub failure");

	if (problems.length > 0) {
		console.error("pack-build: FAILED — assertions on the packed build:");
		for (const p of problems) console.error(`  ${p}`);
		throw Object.assign(new Error("assertions failed"), { reported: true });
	}
	step(
		`OK — packed build passed its guards; ${photos.length} sample photo(s), the seed and public scripts ship from node_modules`,
	);
} catch (error) {
	failed = true;
	if (!error.reported) console.error(error);
} finally {
	if (keep) console.log(`kept ${work}`);
	else rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
