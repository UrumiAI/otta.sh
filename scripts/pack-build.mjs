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
 * the output, source maps included (the scrub guard's concern: the builder's
 * PATH, the scratch dir). It logs the template commit it built.
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
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = args.includes("--keep");
const templateArg = args.indexOf("--template");
const TEMPLATE =
	(templateArg >= 0 ? args[templateArg + 1] : undefined) ||
	process.env.OTTA_TEMPLATE_DIR ||
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

const SKIP = new Set([".git", "node_modules", "dist", ".astro", ".wrangler"]);

/**
 * The publishable packages: every non-private package that the workspace globs
 * in pnpm-workspace.yaml (`dir/*` or a plain directory) match. A new publishable
 * package is therefore packed, and installed from its tarball, without editing
 * this script.
 */
function workspacePackages() {
	const yaml = readFileSync(path.join(ROOT, "pnpm-workspace.yaml"), "utf8");
	const block = /^packages:[ \t]*\n((?:[ \t]+-.*\n?)+)/m.exec(yaml);
	if (!block) throw new Error("no `packages:` list in pnpm-workspace.yaml");
	const globs = [...block[1].matchAll(/^[ \t]+-\s*["']?([^"'\s#]+)["']?/gm)].map((m) => m[1]);
	const dirs = [];
	for (const glob of globs) {
		if (glob.startsWith("!")) continue;
		const clean = glob.replace(/\/$/, "");
		if (clean.endsWith("/*")) {
			const base = clean.slice(0, -2);
			if (/[*?{[]/.test(base)) throw new Error(`unsupported workspace glob: ${glob}`);
			if (!existsSync(path.join(ROOT, base))) continue;
			for (const name of readdirSync(path.join(ROOT, base)).toSorted())
				dirs.push(`${base}/${name}`);
		} else if (/[*?{[]/.test(clean)) {
			throw new Error(`unsupported workspace glob: ${glob}`);
		} else {
			dirs.push(clean);
		}
	}
	const found = [];
	for (const dir of dirs) {
		const manifest = path.join(ROOT, dir, "package.json");
		if (!existsSync(manifest)) continue;
		const { name, version, private: isPrivate } = JSON.parse(readFileSync(manifest, "utf8"));
		if (!isPrivate && name && version) found.push({ dir, name, version });
	}
	return found;
}

const work = mkdtempSync(
	path.join(process.env.OTTA_PACK_BUILD_TMP || tmpdir(), "otta-pack-build-"),
);
// Signals: remove only the mkdtemp result, then exit with the conventional code.
for (const [signal, code] of [
	["SIGINT", 130],
	["SIGTERM", 143],
]) {
	process.on(signal, () => {
		if (!keep) rmSync(work, { recursive: true, force: true });
		process.exit(code);
	});
}
let failed = false;
try {
	if (!existsSync(path.join(TEMPLATE, "astro.config.mjs"))) {
		throw new Error(`template not found at ${TEMPLATE} (pass --template or OTTA_TEMPLATE_DIR)`);
	}
	// The template commit this run built, so a red run can be reproduced.
	// Only the template's own repository: a copy inside another checkout would
	// otherwise report that checkout's commit.
	let templateCommit = "unknown (not a git checkout)";
	try {
		const top = run("git", ["rev-parse", "--show-toplevel"], TEMPLATE).trim();
		if (realpathSync(top) === realpathSync(TEMPLATE)) {
			templateCommit = run("git", ["rev-parse", "HEAD"], TEMPLATE).trim();
			if (run("git", ["status", "--porcelain"], TEMPLATE).trim() !== "") {
				templateCommit += " (with uncommitted changes)";
			}
		} else {
			templateCommit = `unknown (not the root of a git checkout; inside ${top})`;
		}
	} catch {
		// Not a git checkout: keep "unknown".
	}
	step(`template ${TEMPLATE} at ${templateCommit}`);

	// 1. Pack everything (prepack builds each package's dist/).
	const tarballs = path.join(work, "tarballs");
	const packages = workspacePackages();
	if (packages.length === 0) throw new Error("no publishable workspace packages found");
	const byName = {};
	for (const { dir, name, version } of packages) {
		step(`pnpm pack ${dir}`);
		pnpm(["pack", "--pack-destination", tarballs], path.join(ROOT, dir));
		// pnpm names the tarball `<scope>-<name>-<version>.tgz`.
		const file = `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
		if (!existsSync(path.join(tarballs, file))) {
			throw new Error(`expected tarball ${file} was not produced for ${name}`);
		}
		byName[name] = `file:${path.join(tarballs, file)}`;
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
	// Merged into the template's own overrides. A direct dependency is referenced
	// with `$name`; the rest (internal packages the template does not list) get the
	// `file:` spec directly, so they are not added as dependencies.
	const direct = new Set([
		...Object.keys(pkg.dependencies ?? {}),
		...Object.keys(pkg.devDependencies ?? {}),
	]);
	pkg.overrides = { ...pkg.overrides };
	for (const name of Object.keys(byName)) {
		pkg.overrides[name] = direct.has(name) ? `$${name}` : byName[name];
	}
	writeFileSync(pkgPath, `${JSON.stringify(pkg, null, "\t")}\n`);

	// 3. npm install and astro build.
	const npmEnv = {
		npm_config_cache: path.join(work, "npm-cache"),
		npm_config_audit: "false",
		npm_config_fund: "false",
		npm_config_update_notifier: "false",
	};
	step(
		existsSync(path.join(site, "package-lock.json"))
			? "npm install (mode: template package-lock.json, @urumi.ai/* re-resolved)"
			: "npm install (mode: no package-lock.json, full resolution)",
	);
	run("npm", ["install", "--no-progress"], site, npmEnv);
	step("astro build");
	try {
		run("npx", ["--no-install", "astro", "build"], site, npmEnv);
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
	// The scratch dir, the whole PATH, the home directory, and each PATH entry under
	// the home directory (the builder's own tools, e.g. setup-pnpm). System entries
	// such as /usr/local/bin are left out: library code names them on purpose.
	const home = homedir();
	const homeEntries = (process.env.PATH ?? "")
		.split(path.delimiter)
		.filter((entry) => home.length > 1 && entry.startsWith(`${home}/`));
	const leaks = [...new Set([work, process.env.PATH ?? "", home, ...homeEntries])].filter(
		(v) => v.length > 8,
	);
	for (const rel of listFiles(path.join(site, "dist"))) {
		// The scrub's scope (build-path-scrub.ts): code, markup, data and every
		// source map (server and client), not `wrangler.json` (local deploy metadata).
		if (rel === "server/wrangler.json") continue;
		if (!/\.(m?js|json|html|txt|css|map)$/.test(rel)) continue;
		const text = readFileSync(path.join(site, "dist", rel), "utf8");
		for (const leak of leaks) {
			if (text.includes(leak)) {
				problems.push(`dist/${rel} contains a build-environment value (${leak.slice(0, 40)}...)`);
			}
		}
	}
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
