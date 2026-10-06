/**
 * Addresses (ADR-0028 Decision 4): one comparison and one `payTo` projection.
 */

/** A bare EVM address: `0x` + 20 bytes of hex, any letter case. */
export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

/**
 * The same account as CAIP-10 (`<namespace>:<reference>:<address>`). The same
 * grammar the plugin's `isPlausiblePayTo` accepts for `settings:x402PayTo`
 * (`packages/plugin/src/payments/x402-wiring.ts`), so a value the Settings form
 * saved is a value this projection understands.
 */
const CAIP10_EVM_ACCOUNT = /^([-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}):(0x[0-9a-fA-F]{40})$/u;

/**
 * Two addresses are the same account when their 20 bytes are equal. EIP-55
 * checksums are only letter case, so a case-sensitive comparison would refuse a
 * correct, checksummed address — and a lowercase one would be just as right.
 * Both sides must be well-formed; anything else is never equal to anything.
 */
export function sameAddress(a: unknown, b: unknown): boolean {
	return (
		typeof a === "string" &&
		typeof b === "string" &&
		EVM_ADDRESS.test(a) &&
		EVM_ADDRESS.test(b) &&
		a.toLowerCase() === b.toLowerCase()
	);
}

/**
 * Where `settings:x402PayTo` points on `network`, or `undefined` when it does
 * not point there at all.
 *
 * - A bare address is used as-is on every network.
 * - A CAIP-10 account projects to its address only on the network whose CAIP-2
 *   id is its `<namespace>:<reference>`, compared as an EXACT string: the chain
 *   reference `08453` is not `8453`. Guessing that two spellings mean the same
 *   chain is exactly the kind of leniency a fund destination must not have.
 * - Anything else projects nowhere, so the gate offers nothing (fail closed).
 *
 * The result keeps the stored letter case byte for byte. The stored setting is
 * never rewritten: the projection is computed on every read, for the reason
 * `x402-wiring.ts` records — normalising a payment destination in storage would
 * be a worse bug than refusing one.
 */
export function projectPayTo(stored: string, network: string): string | undefined {
	if (EVM_ADDRESS.test(stored)) return stored;
	const caip10 = CAIP10_EVM_ACCOUNT.exec(stored);
	if (caip10 === null) return undefined;
	const [, chain, address] = caip10;
	return chain === network ? address : undefined;
}
