/**
 * Guards for the container build of the Node entry (`Dockerfile.service`).
 *
 * Both assertions below are about a failure that only ever shows up in an
 * image build or at container start, i.e. nowhere near the test suite that
 * would normally catch it — hence pinning the source text.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const entrySource = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("container entry", () => {
	test("imports the sqlite-free store subpath, never the `.` barrel", () => {
		// The barrel re-exports `makeSqliteDb`, which statically imports the
		// `better-sqlite3` native addon. Two things break the moment this
		// regresses: `pnpm install --ignore-scripts` in Dockerfile.service
		// leaves the addon unbuilt, and tsdown.container.config.ts (which
		// inlines every dependency) cannot bundle a `.node` binary at all.
		expect(entrySource).toContain('} from "@otta-sh/store-postgres/pg";');
		expect(entrySource).not.toMatch(/} from "@otta-sh\/store-postgres";/);
	});

	test("the container config bundles @otta-sh/* rather than externalizing it", () => {
		// Externalized workspace imports resolve to TypeScript source through
		// the workspace `exports` maps — issue #44, and an immediate crash on
		// `node dist/container/index.mjs` in a runtime stage that has no
		// node_modules to resolve them from in the first place.
		const config = readFileSync(new URL("../tsdown.container.config.ts", import.meta.url), "utf8");
		expect(config).toMatch(/noExternal:\s*\[\/\.\*\/\]/);
	});
});
