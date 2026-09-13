import { defineConfig } from "tsdown";

export default defineConfig({
	// `src/plugin.ts` is the standard-format descriptor entrypoint
	// (`@otta-sh/plugin/plugin` — default-exports the {hooks, routes} object
	// for em-dash's `plugins: []` / `adaptSandboxEntry`).
	entry: ["src/index.ts", "src/plugin.ts", "src/sandbox-entry.ts"],
	format: ["esm"],
	dts: true,
	/**
	 * BUNDLE the two commerce workspace packages into the emitted plugin rather
	 * than leaving them as bare specifiers. The in-process commerce client
	 * (work order 02, Phase B/C) constructs `@otta-sh/domain` use-cases over
	 * `@otta-sh/store-emdash` adapters, and the plugin runs inside workerd —
	 * which has no node resolution, so a surviving bare specifier fails at
	 * module instantiation inside the sandbox rather than anywhere readable.
	 * `test/bundle-imports.test.ts` asserts on the emitted output for exactly
	 * that reason. (`@otta-sh/admin-presentation` is deliberately NOT here: it
	 * is a real `dependencies` entry, IO-free, and shared with
	 * `@otta-sh/admin-react`.)
	 */
	noExternal: ["@otta-sh/domain", "@otta-sh/store-emdash"],
	/**
	 * TRANSITIONAL (work order 02 D6): the default commerce mode for a plain
	 * `tsdown` build is the HTTP transport — exactly today's behaviour. A
	 * deploying site overrides it with its own bundler `define`
	 * (`sites/staging/astro.config.ts`). DELETED at INC-D3b, when in-process is
	 * the only mode.
	 */
	define: {
		__OTTA_COMMERCE_MODE__: JSON.stringify("http"),
	},
});
