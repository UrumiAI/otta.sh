/**
 * The SITE half of the dev-only login-link capture (e2e follow-up to issue
 * #378). The twin of `e2e-stripe-offline.ts`, gate for gate.
 *
 * WHY IT EXISTS. The e2e suite signs a shopper in through the real UI, and that
 * needs the magic link from the sign-in email. The plugin's email egress is
 * `ctx.http`, which refuses loopback, so no local mailbox can receive it. With
 * the build-time define `__OTTA_DEV_LOGIN_CAPTURE__` baked as `true` in a Vite
 * DEV build, and no email API URL configured, the plugin keeps the link in its
 * own kv instead of mailing it (`packages/plugin/src/email/dev-login-capture.ts`),
 * and the harness reads it from the dev server's local D1 file. No route ever
 * serves it.
 *
 * THIS MODULE DECIDES THE DEFINE, from the same two things as the offline
 * gateway's:
 *
 *  - the Astro COMMAND, which only an integration hook can see. `true` under
 *    `astro dev` and nowhere else; `astro build` with the variable set is
 *    REFUSED, not quietly baked `false`;
 *  - `OTTA_E2E_LOGIN_CAPTURE` set to exactly "1" in the ENVIRONMENT. It is not
 *    read from `.env`, so a line left in a local file cannot arm it, and a plain
 *    `astro dev` keeps the honest "login email is not configured" path.
 *
 * The plugin checks `import.meta.env.DEV` as well, independently, so even a
 * hand-edited config could not arm it in a production bundle.
 */
import type { AstroIntegration } from "astro";

/** The environment variable that asks for the capture under `astro dev`. */
export const E2E_LOGIN_CAPTURE_VAR = "OTTA_E2E_LOGIN_CAPTURE";

/** The define the plugin reads (`dev-login-capture.ts`). Spelled once, here. */
export const DEV_LOGIN_CAPTURE_DEFINE = "__OTTA_DEV_LOGIN_CAPTURE__";

/**
 * Whether to bake the define `true`. Exactly "1" asks; anything else does not.
 * A BUILD that asks throws.
 */
export function resolveDevLoginCapture(command: string, value: string | undefined): boolean {
	const asked = value === "1";
	if (asked && command === "build") {
		throw new Error(
			`${E2E_LOGIN_CAPTURE_VAR}=1 is set for \`astro build\`. The login-link capture is for ` +
				`\`astro dev\` e2e runs only and can never be part of a built site. Unset it and ` +
				`build again.`,
		);
	}
	return asked && command === "dev";
}

/**
 * The integration that bakes the define. It ALWAYS bakes it, as a JSON
 * boolean, like the other `__OTTA_*__` defines. `env` is injectable for the
 * test; the config passes `process.env`.
 */
export function devLoginCaptureIntegration(
	env: Record<string, string | undefined> = process.env,
): AstroIntegration {
	return {
		name: "otta-dev-login-capture",
		hooks: {
			"astro:config:setup": ({ command, updateConfig, logger }) => {
				const on = resolveDevLoginCapture(command, env[E2E_LOGIN_CAPTURE_VAR]);
				updateConfig({ vite: { define: { [DEV_LOGIN_CAPTURE_DEFINE]: JSON.stringify(on) } } });
				if (on) {
					logger.warn(
						`${E2E_LOGIN_CAPTURE_VAR}=1: sign-in links are KEPT in the local database instead ` +
							`of being emailed (when no email provider is configured). This is for e2e ` +
							`runs only.`,
					);
				}
			},
		},
	};
}
