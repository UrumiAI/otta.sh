/**
 * The e2e stack's Worker config (ADR-0044 decision C1): cash on delivery is
 * offered only where the site has the `RATE_LIMIT_WRITES` binding, which the
 * tracked template (`wrangler.jsonc`) leaves commented out, so the Playwright
 * stack runs on `wrangler.e2e.jsonc` instead — the template plus that one
 * binding (pinned by `test/e2e-wrangler.test.ts`).
 *
 * Opt-in by `OTTA_E2E_WRITE_LIMIT=1` (playwright.config.ts sets it for the stack
 * it boots), and for `astro dev` only: `astro build` refuses to run with it set,
 * as it refuses `OTTA_E2E_STRIPE_OFFLINE` (`e2e-stripe-offline.ts`), so the e2e
 * config can never become a deploy's. Production behaviour is unchanged.
 */
import type { AstroIntegration } from "astro";

/** The environment variable that selects the e2e Worker config. */
export const E2E_WRITE_LIMIT_VAR = "OTTA_E2E_WRITE_LIMIT";

/** The e2e Worker config, relative to the site root. */
export const E2E_WRANGLER_CONFIG = "wrangler.e2e.jsonc";

/** The config the adapter is pointed at for this run: the e2e one when asked
 *  for (exactly "1"), else undefined (the caller's own choice stands). */
export function e2eWranglerConfig(value: string | undefined): string | undefined {
	return value === "1" ? E2E_WRANGLER_CONFIG : undefined;
}

/** Throws for `astro build` with the variable set; anything else passes. */
export function assertE2eWranglerNotBuilt(command: string, value: string | undefined): void {
	if (value === "1" && command === "build") {
		throw new Error(
			`${E2E_WRITE_LIMIT_VAR}=1 is set for \`astro build\`. ${E2E_WRANGLER_CONFIG} is the ` +
				"e2e stack's `astro dev` config and can never be part of a built site. Unset it and " +
				"build again.",
		);
	}
}

/** The integration that holds the line above (only a hook can see the command). */
export function e2eWranglerIntegration(
	env: Record<string, string | undefined> = process.env,
): AstroIntegration {
	return {
		name: "otta-e2e-wrangler",
		hooks: {
			"astro:config:setup": ({ command, logger }) => {
				assertE2eWranglerNotBuilt(command, env[E2E_WRITE_LIMIT_VAR]);
				if (env[E2E_WRITE_LIMIT_VAR] === "1") {
					logger.warn(
						`${E2E_WRITE_LIMIT_VAR}=1: running on ${E2E_WRANGLER_CONFIG} (the template plus ` +
							"the RATE_LIMIT_WRITES binding), so cash on delivery can be offered. e2e only.",
					);
				}
			},
		},
	};
}
