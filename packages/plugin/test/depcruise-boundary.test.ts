import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

/**
 * The dependency boundary, executed rather than read.
 *
 * `sandbox-clean-guard.test.ts` is a TEXT SCAN over `src/` and stays that way —
 * it catches ambient globals (`fetch`, `XMLHttpRequest`) that no import graph
 * can see. This file is its complement from the other side: it runs the REPO'S
 * OWN `.dependency-cruiser.cjs` — the same file `pnpm lint` cruises with, copied
 * verbatim, never a re-declaration of its rules — over a tiny tree of PLANTED
 * imports, and asserts on the NAME of the rule each one violates. A rule that
 * fires for the wrong reason, or a rule that silently stops matching (which is
 * exactly what the `^node:`-only builtin clause did for months), fails here.
 *
 * Why a generated tree instead of planting files in a real package `src/`: a fixture
 * under a real `src/` is a file `pnpm lint`, `pnpm typecheck` and `pnpm build`
 * would all pick up, and a forbidden import committed to the tree is the very
 * thing the rules exist to prevent. The tree is built in `os.tmpdir()` per run
 * and removed afterwards, so nothing forbidden ever exists inside the repo.
 *
 * How the tree resolves, and why that matters: the rules are written in TWO
 * spellings for every ban — a resolved `node_modules/...` path AND a bare
 * specifier left unresolved by pnpm's strict isolation — and the two halves
 * catch different things. Workspace packages here are reachable through
 * `node_modules/@otta-sh/<name>` symlinks into the fixture's own `packages/`,
 * which is how pnpm links them in the real repo, so enhanced-resolve follows
 * the symlink and dependency-cruiser reports the `^packages/<name>/` path the
 * third clause of each rule matches. `emdash` is a resolvable stub because the
 * `import type` allowance is expressed as `dependencyTypesNot: ["type-only"]`,
 * and an UNRESOLVED module is not tagged `type-only` at all — verified: with
 * `emdash` unresolved, the type-only case wrongly reports a violation. `pg` and
 * `node:fs` are deliberately left unresolved, which is what exercises the
 * bare-specifier half.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../../..");
const CONFIG = ".dependency-cruiser.cjs";
const DEPCRUISE_BIN = path.join(REPO_ROOT, "node_modules", ".bin", "depcruise");

/** The workspace packages the planted imports name. */
const STUB_PACKAGES = [
	"domain",
	"admin-react",
	"store-emdash",
	"store-postgres",
	"plugin",
] as const;

interface CruiseViolation {
	readonly rule: { readonly name: string };
	readonly from: string;
	readonly to: string;
}

interface CruiseResult {
	readonly summary: { readonly violations: readonly CruiseViolation[] };
}

let root = "";

/**
 * A tree shaped like the workspace: a root `tsconfig.json`, the repo's real
 * cruiser config, stub packages under `packages/`, and the `node_modules`
 * links that make the bare `@otta-sh/*` specifiers resolve into them.
 *
 * The `tsconfig.json` is **deliberately minimal and is not a copy of the repo's
 * own root config**, which is solution-style (`files: []` plus project
 * references) and carries no `compilerOptions` at all. The cruiser config names
 * a tsconfig by filename and reads compilerOptions out of it, so the fixture
 * supplies the few a TS parse needs and nothing more. Nothing under test turns
 * on them: the rules match module paths and dependency types, not type
 * checking.
 */
function buildFixtureTree(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "otta-depcruise-"));
	copyFileSync(path.join(REPO_ROOT, CONFIG), path.join(dir, CONFIG));
	writeFileSync(
		path.join(dir, "tsconfig.json"),
		`{
	"compilerOptions": {
		"module": "esnext",
		"moduleResolution": "bundler",
		"target": "esnext",
		"strict": true
	}
}
`,
	);
	mkdirSync(path.join(dir, "node_modules", "@otta-sh"), { recursive: true });
	for (const name of STUB_PACKAGES) {
		mkdirSync(path.join(dir, "packages", name, "src"), { recursive: true });
		writeFileSync(
			path.join(dir, "packages", name, "package.json"),
			`{ "name": "@otta-sh/${name}", "type": "module", "exports": { ".": "./src/index.ts" } }\n`,
		);
		writeFileSync(path.join(dir, "packages", name, "src", "index.ts"), "export const stub = 1;\n");
		symlinkSync(
			path.join("..", "..", "packages", name),
			path.join(dir, "node_modules", "@otta-sh", name),
		);
	}
	// A resolvable host stub, for the `type-only` reason explained above.
	mkdirSync(path.join(dir, "node_modules", "emdash", "src"), { recursive: true });
	writeFileSync(
		path.join(dir, "node_modules", "emdash", "package.json"),
		`{ "name": "emdash", "type": "module", "exports": { ".": "./src/index.ts" } }\n`,
	);
	writeFileSync(
		path.join(dir, "node_modules", "emdash", "src", "index.ts"),
		"export class PluginStorageRepository {}\n",
	);
	return dir;
}

/** Plant one module and return the names of the rules it violates. */
function rulesViolatedBy(pkg: (typeof STUB_PACKAGES)[number], source: string): string[] {
	for (const name of STUB_PACKAGES) {
		rmSync(path.join(root, "packages", name, "src", "_fixture.ts"), { force: true });
	}
	writeFileSync(path.join(root, "packages", pkg, "src", "_fixture.ts"), source);
	const run = spawnSync(DEPCRUISE_BIN, ["--config", CONFIG, "--output-type", "json", "packages"], {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	if (run.error !== undefined) {
		throw new Error(
			`could not run the dependency-cruiser binary at ${DEPCRUISE_BIN} — run the workspace install first (${run.error.message})`,
		);
	}
	if (run.stdout === "") throw new Error(`depcruise produced no output: ${run.stderr}`);
	const parsed = JSON.parse(run.stdout) as CruiseResult;
	return parsed.summary.violations
		.filter((violation) => violation.from.includes("_fixture"))
		.map((violation) => violation.rule.name);
}

beforeAll(() => {
	root = buildFixtureTree();
});

afterAll(() => {
	if (root !== "") rmSync(root, { recursive: true, force: true });
});

describe("plugin-is-sandbox-clean: what the plugin perimeter forbids", () => {
	test("a database driver is forbidden", () => {
		expect(
			rulesViolatedBy("plugin", 'import type { Pool } from "pg";\nexport type P = Pool;\n'),
		).toEqual(["plugin-is-sandbox-clean"]);
	});

	test("a node builtin is forbidden — in the `node:` spelling", () => {
		expect(
			rulesViolatedBy(
				"plugin",
				'import { readFileSync } from "node:fs";\nexport const read = readFileSync;\n',
			),
		).toEqual(["plugin-is-sandbox-clean"]);
	});

	test("the React console package is forbidden — the one-hop escape stays shut", () => {
		expect(
			rulesViolatedBy(
				"plugin",
				'import { stub } from "@otta-sh/admin-react";\nexport const x = stub;\n',
			),
		).toEqual(["plugin-is-sandbox-clean"]);
	});

	test("an unresolved future store adapter is forbidden — the specifier clause, not the path clause", () => {
		// No node_modules link for this name, so pnpm's strict isolation is
		// reproduced: the import stays a bare specifier and never resolves to a
		// packages/ path. Only the `^@otta-sh/…` clause can catch it.
		expect(
			rulesViolatedBy(
				"plugin",
				'import { stub } from "@otta-sh/store-d1";\nexport const x = stub;\n',
			),
		).toEqual(["plugin-is-sandbox-clean"]);
	});

	test("an unresolved service import is forbidden, for the same reason", () => {
		expect(
			rulesViolatedBy(
				"plugin",
				'import { stub } from "@otta-sh/service";\nexport const x = stub;\n',
			),
		).toEqual(["plugin-is-sandbox-clean"]);
	});

	test("a SQL store adapter is still forbidden — narrowing admitted one store, not every store", () => {
		expect(
			rulesViolatedBy(
				"plugin",
				'import { stub } from "@otta-sh/store-postgres";\nexport const x = stub;\n',
			),
		).toEqual(["plugin-is-sandbox-clean"]);
	});
});

describe("plugin-is-sandbox-clean: what the plugin perimeter now admits", () => {
	test("the domain is admitted — it is IO-free by construction, enforced separately", () => {
		expect(
			rulesViolatedBy(
				"plugin",
				'import { stub } from "@otta-sh/domain";\nexport const x = stub;\n',
			),
		).toEqual([]);
	});

	test("the storage adapter package is admitted", () => {
		expect(
			rulesViolatedBy(
				"plugin",
				'import { stub } from "@otta-sh/store-emdash";\nexport const x = stub;\n',
			),
		).toEqual([]);
	});
});

describe("the store-emdash perimeter", () => {
	test("running host code is forbidden", () => {
		expect(
			rulesViolatedBy(
				"store-emdash",
				'import { PluginStorageRepository } from "emdash";\nexport const repo = PluginStorageRepository;\n',
			),
		).toEqual(["store-emdash-runs-no-host-code"]);
	});

	test("naming the host's types is permitted — a type import emits no code", () => {
		expect(
			rulesViolatedBy(
				"store-emdash",
				'import type { PluginStorageRepository } from "emdash";\nexport type R = PluginStorageRepository;\n',
			),
		).toEqual([]);
	});

	test("importing the plugin is forbidden — the layering cannot be inverted", () => {
		expect(
			rulesViolatedBy(
				"store-emdash",
				'import { stub } from "@otta-sh/plugin";\nexport const x = stub;\n',
			),
		).toEqual(["store-emdash-is-sandbox-clean"]);
	});

	test("an unresolved sibling store adapter is forbidden here too", () => {
		expect(
			rulesViolatedBy(
				"store-emdash",
				'import { stub } from "@otta-sh/store-d1";\nexport const x = stub;\n',
			),
		).toEqual(["store-emdash-is-sandbox-clean"]);
	});

	test("a type-only database driver import is forbidden — the allowance is the host's alone", () => {
		expect(
			rulesViolatedBy("store-emdash", 'import type { Pool } from "pg";\nexport type P = Pool;\n'),
		).toEqual(["store-emdash-is-sandbox-clean"]);
	});
});
