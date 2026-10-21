import { defineConfig } from "tsdown";

export default defineConfig({
	// `src/plugin.ts` is the standard-format descriptor entrypoint
	// (`@urumi.ai/otta-plugin/plugin` — default-exports the {hooks, routes} object
	// for em-dash's `plugins: []` / `adaptSandboxEntry`).
	// `src/trusted.ts` is the same object with `trustedHost` on, for an
	// in-process registration only (`@urumi.ai/otta-plugin/trusted`, issue #447).
	// `src/subdivisions.ts` (`@urumi.ai/otta-plugin/subdivisions`) carries the English
	// subdivision names for a storefront's region pick list. Its own entry, so the
	// names are emitted beside it and never into the chunk the sandbox entry loads.
	entry: [
		"src/index.ts",
		"src/plugin.ts",
		"src/sandbox-entry.ts",
		"src/subdivisions.ts",
		"src/testing.ts",
		"src/trusted.ts",
	],
	format: ["esm"],
	/**
	 * `build: true` — declaration emit goes through the TypeScript PROJECT, not
	 * through a per-file compile.
	 *
	 * WHY IT IS REQUIRED NOW. `src/` imports `@urumi.ai/otta-store-emdash` and
	 * `@urumi.ai/otta-domain` for their VALUES (the in-process commerce client
	 * constructs adapters and use-cases), and both are workspace packages whose
	 * `exports` point at TypeScript SOURCE. A per-file declaration compile tries
	 * to load those sources as if they belonged to this package and fails, because
	 * they belong to a referenced project and are compiled by it. Project mode
	 * reads the reference and consumes the emitted declarations instead, which is
	 * also what `pnpm typecheck` already does.
	 *
	 * It is the JS bundle's `noExternal` below that keeps the shipped artifact
	 * self-contained; this setting only concerns the `.d.mts` files beside it.
	 */
	dts: { build: true },
	/**
	 * BUNDLE the three commerce workspace packages into the emitted plugin rather
	 * than leaving them as bare specifiers. The in-process commerce client
	 * (work order 02, Phase B/C) constructs `@urumi.ai/otta-domain` use-cases over
	 * `@urumi.ai/otta-store-emdash` adapters, and the plugin runs inside workerd —
	 * which has no node resolution, so a surviving bare specifier fails at
	 * module instantiation inside the sandbox rather than anywhere readable.
	 * `test/bundle-imports.test.ts` asserts on the emitted output for exactly
	 * that reason. (`@urumi.ai/otta-admin-presentation` is deliberately NOT here: it
	 * is a real `dependencies` entry, IO-free, and shared with
	 * `@urumi.ai/otta-admin-react`.) `@urumi.ai/otta-payments-stripe` joined them at INC-C1b:
	 * the `webhooks/stripe/settle` route verifies the webhook HMAC INSIDE the
	 * isolate, so the adapter has to be in the bundle for the same reason the
	 * other two are.
	 */
	noExternal: [
		"@urumi.ai/otta-domain",
		// Its own subpath: matched as an exact id, so it is listed too.
		"@urumi.ai/otta-domain/subdivision-names",
		"@urumi.ai/otta-payments-stripe",
		"@urumi.ai/otta-store-emdash",
	],
	/**
	 * …but NOT into the `.d.mts` files (issue #510). Bundling is a runtime
	 * concern of workerd; declarations have no such constraint, and inlining them
	 * is actively wrong: domain's money and id types are BRANDED with
	 * `declare const XBrand: unique symbol`, and a copied declaration is a
	 * DIFFERENT symbol. A consumer that wrote a `TaxCalculator` against
	 * `@urumi.ai/otta-domain` could not pass it to `createOttaPlugin` (TS2322,
	 * "Property '[CurrencyBrand]' is missing"). Left external, the declarations
	 * `import … from "@urumi.ai/otta-*"` and resolve the one copy the consumer
	 * has, through the plugin's real `dependencies` entries (which publish
	 * rewrites from `workspace:*`).
	 *
	 * `deps.dts.neverBundle` applies only to imports made FROM a declaration file,
	 * so the JS bundle above is unchanged. `test/bundle-imports.test.ts` asserts
	 * both outcomes on the emitted files.
	 *
	 * The plugin declares no `@types/node` of its own: the root's copy serves it.
	 * Adding it here back makes pnpm resolve a second `emdash` (now a peer), which
	 * `sites/staging/test/host-pin.test.ts` refuses.
	 */
	deps: {
		dts: {
			neverBundle: [/^@urumi\.ai\/otta-/],
		},
	},
});
