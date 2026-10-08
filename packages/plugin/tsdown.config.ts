import { defineConfig } from "tsdown";

export default defineConfig({
	// `src/plugin.ts` is the standard-format descriptor entrypoint
	// (`@otta-sh/plugin/plugin` — default-exports the {hooks, routes} object
	// for em-dash's `plugins: []` / `adaptSandboxEntry`).
	// `src/subdivisions.ts` (`@otta-sh/plugin/subdivisions`) carries the English
	// subdivision names for a storefront's region pick list. Its own entry, so the
	// names are emitted beside it and never into the chunk the sandbox entry loads.
	entry: ["src/index.ts", "src/plugin.ts", "src/sandbox-entry.ts", "src/subdivisions.ts"],
	format: ["esm"],
	/**
	 * `build: true` — declaration emit goes through the TypeScript PROJECT, not
	 * through a per-file compile.
	 *
	 * WHY IT IS REQUIRED NOW. `src/` imports `@otta-sh/store-emdash` and
	 * `@otta-sh/domain` for their VALUES (the in-process commerce client
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
	 * (work order 02, Phase B/C) constructs `@otta-sh/domain` use-cases over
	 * `@otta-sh/store-emdash` adapters, and the plugin runs inside workerd —
	 * which has no node resolution, so a surviving bare specifier fails at
	 * module instantiation inside the sandbox rather than anywhere readable.
	 * `test/bundle-imports.test.ts` asserts on the emitted output for exactly
	 * that reason. (`@otta-sh/admin-presentation` is deliberately NOT here: it
	 * is a real `dependencies` entry, IO-free, and shared with
	 * `@otta-sh/admin-react`.) `@otta-sh/payments-stripe` joined them at INC-C1b:
	 * the `webhooks/stripe/settle` route verifies the webhook HMAC INSIDE the
	 * isolate, so the adapter has to be in the bundle for the same reason the
	 * other two are, and `@otta-sh/payments-x402` at INC-C5 for exactly the same
	 * reason: `payments/x402-wiring.ts` imports `X402PaymentGateway` as a VALUE,
	 * evaluated inside the isolate, where a surviving bare specifier has no
	 * resolver.
	 */
	noExternal: [
		"@otta-sh/domain",
		// Its own subpath: matched as an exact id, so it is listed too.
		"@otta-sh/domain/subdivision-names",
		"@otta-sh/payments-stripe",
		"@otta-sh/payments-x402",
		"@otta-sh/store-emdash",
	],
});
