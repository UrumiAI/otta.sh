/**
 * ADR-0044 §7 (round 2, M1/N3): what the plugin itself reads off a COD place
 * request — the attestation only the site's in-process dispatch carries, and the
 * client network from `cf-connecting-ip` — and the network's stored key, an HMAC
 * under the store's own secret (never a bare, reversible hash of the address).
 */
import { describe, expect, test } from "vitest";
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

	test("Cloudflare's pseudo-IPv4 reads the real IPv6, cut to its /64", () => {
		expect(
			codRequestFacts(
				request({
					"cf-connecting-ip": "240.1.2.3",
					"cf-connecting-ipv6": "2001:db8:aaaa:bbbb:1:2:3:4",
				}),
			).network,
		).toBe("2001:db8:aaaa:bbbb::/64");
	});

	test("the network rule: IPv4 whole, IPv6 by /64, mapped forms to their IPv4", () => {
		expect(clientNetwork("198.51.100.9")).toBe("198.51.100.9");
		expect(clientNetwork("2001:db8::1")).toBe("2001:db8:0:0::/64");
		expect(clientNetwork("2001:db8::ffff")).toBe(clientNetwork("2001:db8::1"));
		expect(clientNetwork("::ffff:192.0.2.1")).toBe("192.0.2.1");
		expect(clientNetwork(null)).toBeNull();
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
