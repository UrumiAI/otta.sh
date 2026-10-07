/**
 * The USDC asset table (ADR-0028 Decision 3): one row per network the gate can
 * offer, taken from the reference implementation's defaults (`coinbase/x402@dd927a26`,
 * `typescript/packages/mechanisms/evm/src/shared/defaultAssets.ts`,
 * `DEFAULT_STABLECOINS`).
 *
 * IN CODE, NEVER CONFIGURABLE. The asset address is what the buyer's signature
 * authorizes a transfer of; an operator-editable asset would let a typo, or a
 * hostile write to kv, point the gate at a lookalike token. A configured network
 * that is not a key here disables x402 rather than offering a 402 nobody can pay.
 *
 * `name` and `version` are the token's EIP-712 domain, which the client needs to
 * sign `transferWithAuthorization` and which travel in the requirements' `extra`.
 * They differ between the two rows ("USD Coin" on Base, "USDC" on Base Sepolia);
 * a payload carrying the other row's name is a mismatch, not a typo to forgive.
 */
export interface X402UsdcAsset {
	readonly asset: string;
	readonly name: string;
	readonly version: string;
	/** USDC has 6 decimals and a cent has 2, hence the 10^4 in `amount.ts`. */
	readonly decimals: 6;
}

export const X402_USDC_ASSETS: Readonly<Record<string, X402UsdcAsset>> = Object.freeze({
	/** Base mainnet. */
	"eip155:8453": Object.freeze({
		asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
		name: "USD Coin",
		version: "2",
		decimals: 6,
	}),
	/** Base Sepolia, for staging and tests. */
	"eip155:84532": Object.freeze({
		asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
		name: "USDC",
		version: "2",
		decimals: 6,
	}),
});

/** The row for `network`, or `undefined`. An own-property read, so a network
 *  named `__proto__` or `toString` is simply absent. */
export function usdcAssetFor(network: string): X402UsdcAsset | undefined {
	return Object.hasOwn(X402_USDC_ASSETS, network) ? X402_USDC_ASSETS[network] : undefined;
}
