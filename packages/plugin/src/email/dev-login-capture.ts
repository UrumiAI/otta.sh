/**
 * The DEV-ONLY login-link capture — the e2e suite's way past the sign-in email
 * (follow-up to issue #378).
 *
 * WHY IT EXISTS. A signed-in `/account/orders` needs the magic link from the
 * sign-in email, and the plugin's only email egress is `ctx.http`, which
 * refuses non-public addresses. No loopback mailbox can ever receive the mail,
 * on a laptop or in CI, so the browser suite stopped at "a sign-in link is on
 * its way". This module lets a local e2e stack keep the link instead of
 * mailing it.
 *
 * WHAT IT DOES. {@link DevLoginCaptureSender} is an `EmailSender` that, for the
 * `customer-login-link` template and nothing else, writes the link to the
 * plugin's OWN kv under {@link devLoginCaptureKey} (the lower-cased recipient).
 * It refuses every other template, so an order email can never be swallowed
 * by it. Rows do not pile up across runs: each capture prunes all but the
 * newest {@link DEV_LOGIN_CAPTURE_MAX_ROWS}, from INSIDE the server, so the
 * harness never has to write to a database file workerd holds open.
 * `makeLoginEmailSender` returns it ONLY where it would otherwise have
 * returned "no sender" (the bundle has no email API URL) — a configured
 * provider always wins, exactly as a configured Stripe secret key beats the
 * offline gateway.
 *
 * NO ROUTE READS IT, deliberately. The e2e harness reads the row straight out
 * of the dev server's local D1 file (`sites/staging/e2e/login-link-capture.ts`).
 * So even if both gates below were somehow open in a deployment, the link
 * would sit in that deployment's own database, readable only by someone who
 * can already read every session in it, and no HTTP request could fetch it.
 *
 * TWO GATES, the same two the offline Stripe gateway uses
 * (`payments/stripe-wiring.ts`), checked independently:
 *
 *  - THE PRIMARY GATE: the site baked `__OTTA_DEV_LOGIN_CAPTURE__` as the
 *    literal `true`. The staging site bakes it only under `astro dev` with
 *    `OTTA_E2E_LOGIN_CAPTURE=1`, and REFUSES to build with that variable set
 *    (`sites/staging/src/lib/e2e-login-capture.ts`). A site that never bakes it
 *    can never arm this path.
 *  - DEFENCE IN DEPTH: `import.meta.env.DEV` is `true`. The published `dist`
 *    keeps the expression and the CONSUMER's bundler rewrites it: Vite folds it
 *    to `false` in production mode (`astro build`), and a bundle that never
 *    rewrites it (no Vite, the workerd sandbox) reads it as off.
 */
import type { EmailSender, SendEmailInput } from "@otta-sh/domain";
import type { PluginContext } from "../types.js";

/** Baked by the SITE's Vite config, never by this package — see
 *  {@link devLoginCaptureEnabled}. Undeclared in any other build. */
declare const __OTTA_DEV_LOGIN_CAPTURE__: unknown;

/**
 * Is the dev-only login-link capture armed in THIS bundle? Both guards, as the
 * module doc explains. Exported so a test pins each one.
 *
 * `import.meta.env` is SPELLED LITERALLY, for the reason
 * `devStripeOfflineEnabled` records: Vite and vitest rewrite it by its text,
 * and a cast form is left alone (it read the unstubbed `true` under vitest).
 */
export function devLoginCaptureEnabled(): boolean {
	const baked =
		typeof __OTTA_DEV_LOGIN_CAPTURE__ === "boolean" && __OTTA_DEV_LOGIN_CAPTURE__ === true;
	// `@ts-ignore`, not `@ts-expect-error`: see `devStripeOfflineEnabled`.
	// @ts-ignore -- `import.meta.env` is Vite's.
	const devBuild = import.meta.env?.DEV === true;
	return baked && devBuild;
}

/** Where a captured link lives in the plugin's kv. EmDash stores it in its
 *  `options` table as `plugin:<pluginId>:<key>`, which is where the harness
 *  looks. */
export const DEV_LOGIN_CAPTURE_KEY_PREFIX = "e2e:loginLink:";

/** The kv key for one recipient. Lower-cased, so the harness finds it by the
 *  address it typed. One key per address: a newer link replaces the older. */
export function devLoginCaptureKey(recipient: string): string {
	return `${DEV_LOGIN_CAPTURE_KEY_PREFIX}${recipient.toLowerCase()}`;
}

/** How many captured links a stack keeps. Each spec signs in with a fresh
 *  address, so without a cap a long-lived local stack would gain rows forever;
 *  a few runs' worth is plenty for a reader that wants the newest. */
export const DEV_LOGIN_CAPTURE_MAX_ROWS = 20;

/** What is stored: the link, and when, so a reader can refuse an older one. */
export interface CapturedLoginLink {
	loginUrl: string;
	capturedAt: string;
}

/** Keeps the sign-in link in kv instead of mailing it. Login links only. */
export class DevLoginCaptureSender implements EmailSender {
	readonly #kv: PluginContext["kv"];

	constructor(kv: PluginContext["kv"]) {
		this.#kv = kv;
	}

	async send(input: SendEmailInput): Promise<void> {
		// A THROW, not a silent drop: this sender is wired for the login email
		// alone, and anything else reaching it is a wiring mistake to hear about.
		if (input.template !== "customer-login-link") {
			throw new Error(
				`the dev login-link capture only takes customer-login-link, not ${input.template}`,
			);
		}
		const loginUrl = input.data["loginUrl"];
		if (typeof loginUrl !== "string" || loginUrl.length === 0) {
			throw new Error("the dev login-link capture got no loginUrl");
		}
		const key = devLoginCaptureKey(input.to);
		const captured: CapturedLoginLink = { loginUrl, capturedAt: new Date().toISOString() };
		await this.#kv.set(key, captured);
		// Best effort: a prune that fails leaves a few extra rows, which is no
		// reason to report the link (already saved) as unsent.
		try {
			await this.#prune(key);
		} catch (err) {
			console.warn(
				"[otta] dev login-link capture: pruning old captures failed:",
				err instanceof Error ? err.message : "unknown error",
			);
		}
	}

	/** Keep the newest {@link DEV_LOGIN_CAPTURE_MAX_ROWS} captures. The one just
	 *  written always stays, whatever its stamp; unreadable stamps go first. */
	async #prune(keep: string): Promise<void> {
		const others = (await this.#kv.list(DEV_LOGIN_CAPTURE_KEY_PREFIX))
			.filter(({ key }) => key.startsWith(DEV_LOGIN_CAPTURE_KEY_PREFIX) && key !== keep)
			.map(({ key, value }) => ({ key, at: capturedAtOf(value) }))
			.toSorted((a, b) => b.at - a.at);
		for (const stale of others.slice(DEV_LOGIN_CAPTURE_MAX_ROWS - 1)) {
			await this.#kv.delete(stale.key);
		}
	}
}

/** A capture's stamp in epoch ms; 0 (oldest) for anything unreadable. */
function capturedAtOf(value: unknown): number {
	const at =
		value !== null && typeof value === "object"
			? Date.parse(String((value as { capturedAt?: unknown }).capturedAt))
			: Number.NaN;
	return Number.isFinite(at) ? at : 0;
}
