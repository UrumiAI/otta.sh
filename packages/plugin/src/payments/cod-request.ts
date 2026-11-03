/**
 * ADR-0044 §7 (review round 2, M1/N3): who is placing a cash-on-delivery order,
 * decided by the PLUGIN from the request — never from the body.
 *
 * THE PROOF OF THE RATE-LIMITED PATH. The plugin's place route is public and also
 * reachable directly at `/_emdash/api/plugins/otta/storefront/checkout/place`, so a
 * body field cannot prove the site's per-IP write limit ran. The site's
 * `/checkout/place` adds {@link COD_ATTEST_HEADER} on its IN-PROCESS dispatch, and
 * only when its `RATE_LIMIT_WRITES` binding exists; the site middleware refuses
 * (400) every incoming HTTP request that carries the header, so no outside caller
 * can present it. A COD placement without it is "COD not offered here". (A site
 * other than the reference one that hosts this plugin must strip or refuse the
 * header at its edge too, or it does not offer COD safely — ADR-0044.)
 *
 * THE NETWORK. Read from `cf-connecting-ip` (with Cloudflare's pseudo-IPv4 mapped
 * back to `cf-connecting-ipv6`), which the site forwards on its synthetic request
 * and Cloudflare sets on a direct one — the same rule the site's limiter keys by:
 * IPv4 whole, IPv6 cut to its /64. It is stored only as an HMAC-SHA-256 under a
 * per-store secret ({@link COD_NETWORK_KEY_SECRET_KEY}, random, created on first
 * use): a bare hash of an IPv4 address is reversible by enumeration.
 */
import { header } from "../edge-token.js";
import type { PluginContext, SandboxedRequest } from "../types.js";

/** The header only the site's in-process dispatch may carry (ADR-0044 §7). */
export const COD_ATTEST_HEADER = "x-otta-cod-attest";
/** Its value. A marker, not a secret: the middleware is what makes it unforgeable. */
export const COD_ATTEST_VALUE = "rate-limited";

/** Plugin kv: the per-store HMAC key for network keys (hex, 32 random bytes). */
export const COD_NETWORK_KEY_SECRET_KEY = "settings:codNetworkKeySecret";

export interface CodRequestFacts {
	/** The call came through the site's rate-limited path. */
	attested: boolean;
	/** The client's network (IPv4, or an IPv6 /64), or null when none is known. */
	network: string | null;
}

/** What the request itself says about a COD placement. */
export function codRequestFacts(request: SandboxedRequest | undefined): CodRequestFacts {
	if (request === undefined) return { attested: false, network: null };
	const attested = header(request, COD_ATTEST_HEADER)?.trim() === COD_ATTEST_VALUE;
	const ip = header(request, "cf-connecting-ip") ?? null;
	const ipv6 = header(request, "cf-connecting-ipv6") ?? null;
	const address =
		ip !== null && PSEUDO_IPV4.test(ip.trim()) && ipv6 !== null && ipv6.trim() !== "" ? ipv6 : ip;
	return { attested, network: clientNetwork(address) };
}

/**
 * The stored key of a network: HMAC-SHA-256 under the store's own secret, hex.
 * The secret is created on first use (two first uses racing may each write one;
 * the last wins, and orders keyed under the other under-count until they close).
 */
export async function networkKey(ctx: PluginContext, network: string): Promise<string> {
	const secret = await networkKeySecret(ctx);
	const key = await crypto.subtle.importKey(
		"raw",
		hexBytes(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(network));
	return toHex(new Uint8Array(mac));
}

async function networkKeySecret(ctx: PluginContext): Promise<string> {
	const stored = await ctx.kv.get<unknown>(COD_NETWORK_KEY_SECRET_KEY);
	if (typeof stored === "string" && /^[0-9a-f]{64}$/.test(stored)) return stored;
	const fresh = toHex(crypto.getRandomValues(new Uint8Array(32)));
	await ctx.kv.set(COD_NETWORK_KEY_SECRET_KEY, fresh);
	return fresh;
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
	for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

// -- the client's network: the site limiter's own rule (sites/store/src/lib/rate-limit.ts)

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEXTET = /^[0-9a-f]{1,4}$/;
const RAW_KEY_MAX = 64;
/** The NAT64 well-known prefix (RFC 6052): `64:ff9b::/96` carries an IPv4 host. */
const NAT64 = ["64", "ff9b", "0", "0", "0", "0"];
/** Cloudflare's pseudo-IPv4 range (240.0.0.0/4 as it assigns it): the real
 *  address is in `cf-connecting-ipv6`. */
const PSEUDO_IPV4 = /^2(4\d|5[0-5])\./;

function isIpv4(value: string): boolean {
	const octets = IPV4.exec(value);
	return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

function ipv6Groups(value: string): number[] | null {
	let text = value;
	const tail: string[] = [];
	const lastColon = text.lastIndexOf(":");
	const last = text.slice(lastColon + 1);
	if (last.includes(".")) {
		if (!isIpv4(last)) return null;
		const [a, b, c, d] = last.split(".").map(Number) as [number, number, number, number];
		tail.push(((a << 8) | b).toString(16), ((c << 8) | d).toString(16));
		// Drop the dotted tail: `x::a.b.c.d` leaves `x::`, `x:y:a.b.c.d` leaves `x:y`.
		text = text.slice(0, lastColon + 1);
		if (!text.endsWith("::")) text = text.slice(0, -1);
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] === "" ? [] : (halves[0] ?? "").split(":");
	const rest = halves.length === 2 && halves[1] !== "" ? (halves[1] ?? "").split(":") : [];
	const after = [...rest, ...tail];
	const groups =
		halves.length === 2
			? [...head, ...Array<string>(Math.max(0, 8 - head.length - after.length)).fill("0"), ...after]
			: [...head, ...after];
	if (groups.length !== 8 || !groups.every((group) => HEXTET.test(group))) return null;
	return groups.map((group) => Number.parseInt(group, 16));
}

/** IPv4 whole; IPv6 cut to its /64 (mapped, compatible and NAT64 forms collapse to
 *  their IPv4 host); anything else bounded and tagged `raw:`. `null` for none. */
export function clientNetwork(ip: string | null): string | null {
	const value = (ip ?? "").trim().toLowerCase();
	if (value === "") return null;
	if (isIpv4(value)) return value;
	const groups = value.includes(":") ? ipv6Groups(value) : null;
	if (groups === null) return `raw:${value.slice(0, RAW_KEY_MAX)}`;
	const hex = groups.map((group) => group.toString(16));
	const zeroFive = groups.slice(0, 5).every((group) => group === 0);
	const mapped = zeroFive && groups[5] === 0xffff;
	const compat = zeroFive && groups[5] === 0 && value.includes(".");
	const nat64 = hex.slice(0, 6).join(":") === NAT64.join(":");
	if (mapped || compat || nat64) {
		const high = groups[6] ?? 0;
		const low = groups[7] ?? 0;
		return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
	}
	return `${hex.slice(0, 4).join(":")}::/64`;
}
