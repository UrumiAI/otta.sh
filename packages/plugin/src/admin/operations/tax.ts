/**
 * The admin TAX operation: the decision half of the Tax options save, with no
 * form parsing and no notice.
 *
 * The options are saved WHOLE behind a compare-and-set on their value: the
 * caller passes the {@link taxSettingsDigest} of the options it read, and
 * options that changed since come back `stale`, never overwritten. Each save
 * attempt gets its own idempotency key, never shared by two different saves.
 * The Tax options screen (`tax-options-screen.ts`) passes the digest its form
 * loaded with; an MCP route that read nothing may omit it, and the options in
 * force are read here and used as the token.
 *
 * Tax classes and tax rates have no rule above the surface, so their writes
 * stay straight surface calls (the console's and MCP's alike).
 */
import {
	taxSettingsDigest,
	type AdminRulesSurface,
	type TaxSettingsUpdateResult,
} from "../admin-rules-surface.js";

/**
 * Replace the tax options. `settings` is unvalidated on purpose: the domain
 * validates it, and a bad block comes back `{ ok: false, reason: "invalid",
 * field }`. Returns the surface's own result — `ok` with the options as stored,
 * `invalid`, or `stale` with the options in force.
 */
export async function updateTaxSettings(
	client: AdminRulesSurface,
	settings: unknown,
	opts: { expected?: string } = {},
): Promise<TaxSettingsUpdateResult> {
	const expected = opts.expected ?? taxSettingsDigest((await client.getTaxSettings()).settings);
	return client.updateTaxSettings(settings, {
		expected,
		// One key per save attempt, never shared by two different saves (B5).
		idempotencyKey: `tax-options-${crypto.randomUUID()}`,
	});
}
