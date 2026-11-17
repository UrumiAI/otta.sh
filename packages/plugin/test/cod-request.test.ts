/**
 * ADR-0044 §7 (round 2, M1/N3): what the plugin itself reads off a COD place
 * request — the attestation only the site's in-process dispatch carries, and the
 * client network from `cf-connecting-ip` — and the network's stored key, an HMAC
 * under the store's own secret (never a bare, reversible hash of the address).
 */
import { describe, expect, test, vi } from "vitest";
import {
	clientNetwork,
	COD_ATTEST_HEADER,
	COD_ATTEST_VALUE,
	COD_NETWORK_KEY_SECRET_KEY,
	codRequestFacts,
	networkKey,
} from "../src/payments/cod-request.js";
import type { PluginContext, SandboxedRequest } from "../src/types.js";

function request(headers: Record<string, string>): SandboxedRequest {
	return { url: "https://shop.test/x", method: "POST", headers } as unknown as SandboxedRequest;
}

function kvCtx(seed: Record<string, unknown> = {}): {
	ctx: PluginContext;
	kv: Map<string, unknown>;
} {
	const kv = new Map<string, unknown>(Object.entries(seed));
	const ctx = {
		kv: {
			get: async (key: string) => kv.get(key) ?? null,
			set: async (key: string, value: unknown) => {
				kv.set(key, value);
			},
		},
	} as unknown as PluginContext;
	return { ctx, kv };
}

describe("codRequestFacts", () => {
	test("attested only by the exact marker; the network from cf-connecting-ip", () => {
		expect(
			codRequestFacts(
				request({ [COD_ATTEST_HEADER]: COD_ATTEST_VALUE, "cf-connecting-ip": "203.0.113.7" }),
			),
		).toEqual({ attested: true, network: "203.0.113.7" });
		expect(
			codRequestFacts(request({ [COD_ATTEST_HEADER]: "yes", "cf-connecting-ip": "1.2.3.4" })),
		).toEqual({ attested: false, network: "1.2.3.4" });
		expect(codRequestFacts(request({}))).toEqual({ attested: false, network: null });
		expect(codRequestFacts(undefined)).toEqual({ attested: false, network: null });
	});

	test("Cloudflare's pseudo-IPv4 reads the real IPv6, cut to its /48", () => {
		expect(
			codRequestFacts(
				request({
					"cf-connecting-ip": "240.1.2.3",
					"cf-connecting-ipv6": "2001:db8:aaaa:bbbb:1:2:3:4",
				}),
			).network,
		).toBe("2001:db8:aaaa::/48");
	});

	test("the network rule: IPv4 whole, IPv6 by /48, mapped forms to their IPv4", () => {
		expect(clientNetwork("198.51.100.9")).toBe("198.51.100.9");
		expect(clientNetwork("2001:db8::1")).toBe("2001:db8:0::/48");
		expect(clientNetwork("2001:db8::ffff")).toBe(clientNetwork("2001:db8::1"));
		expect(clientNetwork("::ffff:192.0.2.1")).toBe("192.0.2.1");
		expect(clientNetwork("64:ff9b::198.51.100.4")).toBe("198.51.100.4");
		expect(clientNetwork(null)).toBeNull();
	});

	/**
	 * #678: one host often holds a whole /48, so it can move between /64s at will.
	 * The cap's network is the /48: every /64 inside it is the same network, and
	 * the next /48 is another.
	 */
	test("rotating /64s inside one /48 stays one network; another /48 is another", () => {
		const home = clientNetwork("2001:db8:aaaa:1::1");
		expect(home).toBe("2001:db8:aaaa::/48");
		for (const rotated of ["2001:db8:aaaa:2::1", "2001:db8:aaaa:ffff:9:9:9:9", "2001:DB8:AAAA::"]) {
			expect(clientNetwork(rotated), rotated).toBe(home);
		}
		expect(clientNetwork("2001:db8:aaab:1::1")).not.toBe(home);
		expect(clientNetwork("2001:db9:aaaa:1::1")).not.toBe(home);
	});

	test("the /48 key is the same however the address is spelled, and junk never widens to a real network", () => {
		const home = "2001:db8:aaaa::/48";
		for (const spelling of [
			"2001:0db8:aaaa:0001:0000:0000:0000:0001",
			" 2001:db8:aaaa:1::1 ",
			"2001:db8:aaaa:1::198.51.100.4", // an IPv4 tail on an ordinary prefix stays IPv6
		]) {
			expect(clientNetwork(spelling), spelling).toBe(home);
		}
		// An IPv4 address in IPv6 dress is that IPv4 address, not a /48 of ::ffff.
		expect(clientNetwork("::ffff:198.51.100.4")).toBe(clientNetwork("198.51.100.4"));
		expect(clientNetwork("::ffff:c633:6404")).toBe("198.51.100.4");
		// Malformed: bounded and tagged, never parsed into some /48.
		for (const junk of ["2001:db8:::1", "2001:db8::1::2", "2001:db8:aaaa:zzzz::1", "not-an-ip"]) {
			expect(clientNetwork(junk), junk).toMatch(/^raw:/);
		}
		expect(clientNetwork(`2001:${"a".repeat(500)}`)?.length).toBeLessThanOrEqual(4 + 64);
	});
});

describe("networkKey", () => {
	test("an HMAC under a per-store secret made on first use: stable, not the address, not a bare SHA-256", async () => {
		const { ctx, kv } = kvCtx();
		const first = await networkKey(ctx, "203.0.113.7");
		expect(first).toMatch(/^[0-9a-f]{64}$/);
		expect(first).not.toContain("203");
		expect(kv.get(COD_NETWORK_KEY_SECRET_KEY)).toMatch(/^[0-9a-f]{64}$/);
		expect(await networkKey(ctx, "203.0.113.7")).toBe(first);
		expect(await networkKey(ctx, "203.0.113.8")).not.toBe(first);
		const bare = [
			...new Uint8Array(
				await crypto.subtle.digest("SHA-256", new TextEncoder().encode("203.0.113.7")),
			),
		]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		expect(first).not.toBe(bare);
	});

	test("a secret that cannot be read or saved is NO key (COD unavailable), never a throwaway one", async () => {
		// Hashing under a fresh secret that was never stored would key every request
		// differently, so the per-network cap could never trip.
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			const { ctx, kv } = kvCtx();
			(ctx.kv as { set: unknown }).set = async () => {
				throw new Error("kv write failed");
			};
			expect(await networkKey(ctx, "203.0.113.7")).toBeNull();
			expect(kv.has(COD_NETWORK_KEY_SECRET_KEY)).toBe(false);
			const unreadable = kvCtx().ctx;
			(unreadable.kv as { get: unknown }).get = async () => {
				throw new Error("kv read failed");
			};
			expect(await networkKey(unreadable, "203.0.113.7")).toBeNull();
			expect(errors).toHaveBeenCalledTimes(2);
		} finally {
			errors.mockRestore();
		}
	});

	test("another store's secret gives another key for the same network", async () => {
		const a = await networkKey(
			kvCtx({ [COD_NETWORK_KEY_SECRET_KEY]: "a".repeat(64) }).ctx,
			"1.2.3.4",
		);
		const b = await networkKey(
			kvCtx({ [COD_NETWORK_KEY_SECRET_KEY]: "b".repeat(64) }).ctx,
			"1.2.3.4",
		);
		expect(a).not.toBe(b);
	});
});
