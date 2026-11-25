/**
 * The domain's `AgentSessionStore` contract (ADR-0047) against the document
 * adapter on every Node dialect, plus the WebCrypto secrets adapter against the
 * secrets contract. The contract is the spec: no case is skipped or narrowed.
 *
 * The crash hooks are real crashes on real storage (`agent-session-harness.ts`),
 * never skipped. The single-winner claim and the slot caps under REAL
 * concurrency are Postgres-only (`agent-session-redeem-race.pg.test.ts`); here
 * SQLite verifies the statements and the contract's interleaving races.
 */
import { agentSessionId, currency } from "@urumi.ai/otta-domain";
import {
	agentSessionSecretsContract,
	agentSessionStoreContract,
} from "@urumi.ai/otta-domain/testing";
import { expect, test } from "vitest";
import {
	AGENT_SESSION_LINKS_COLLECTION,
	AGENT_SESSION_SLOTS_COLLECTION,
	AGENT_SESSIONS_COLLECTION,
	base64UrlDecode,
	base64UrlEncode,
	EmdashAgentSessionStore,
	randomBase64Url,
	WebCryptoAgentSessionSecrets,
} from "../src/index.js";
import { AGENT_SESSION_LAYOUT } from "./agent-session-collections.js";
import { emdashAgentSessionHarness, freshEmdashAgentSessionHarness } from "./agent-session-harness.js";
import { describeEachDialect } from "./describe-each-dialect.js";

const SERVER_KEY = new Uint8Array(32).fill(7);

describeEachDialect("EmdashAgentSessionStore", (ctx) => {
	const bound = ctx.useStorage(AGENT_SESSION_LAYOUT);
	agentSessionStoreContract(() => freshEmdashAgentSessionHarness(bound.storage), {
		dialect: ctx.dialect,
	});

	test(`a purge removes the session's token pointers and slots too [${ctx.dialect}]`, async () => {
		const store = new EmdashAgentSessionStore({ storage: bound.storage });
		const createdAt = "2026-01-01T00:00:00.000Z";
		const inserted = await store.insert(
			{
				id: agentSessionId("cs_purge_links"),
				revision: 0,
				status: "requires_escalation",
				currency: currency("USD"),
				lines: [],
				orderSecretHash: "o",
				linkGeneration: 2,
				handoffTokenHash: "h-now",
				redeemedHandoffs: [{ tokenHash: "h-then", usedAt: createdAt }],
				channel: "other",
				networkKey: "net",
				createdAt,
				updatedAt: createdAt,
				expiresAt: "2026-01-02T00:00:00.000Z",
				purgeAt: "2026-01-31T00:00:00.000Z",
				writes: [],
				retiredWriteKeys: [],
			},
			{ now: createdAt, maxLive: 10, maxLivePerNetwork: 10 },
		);
		expect(inserted.ok).toBe(true);
		const links = bound.collection<unknown>(AGENT_SESSION_LINKS_COLLECTION);
		const slots = bound.collection<unknown>(AGENT_SESSION_SLOTS_COLLECTION);
		expect(await links.get("h-now")).not.toBeNull();
		expect(await slots.count()).toBe(2);
		expect(await store.purge(agentSessionId("cs_purge_links"), "2026-02-01T00:00:00.000Z")).toBe(
			true,
		);
		expect(await links.get("h-now")).toBeNull();
		expect(await links.get("h-then")).toBeNull();
		expect(await slots.count()).toBe(0);
	});

	test(`a hidden session document answers no index lookup [${ctx.dialect}]`, async () => {
		const h = emdashAgentSessionHarness(bound.storage);
		const createdAt = "2026-01-01T00:00:00.000Z";
		const crash = h.crashInsertBeforeLanding;
		if (typeof crash !== "function") throw new Error("crash hook missing");
		await crash(
			{
				id: agentSessionId("cs_hidden_idx"),
				revision: 0,
				status: "requires_escalation",
				currency: currency("USD"),
				lines: [],
				orderSecretHash: "o",
				linkGeneration: 1,
				handoffTokenHash: "h-hidden",
				redeemedHandoffs: [],
				cartId: "cart-hidden",
				shopperCartId: "cart-hidden-shopper",
				channel: "other",
				networkKey: "net-hidden",
				createdAt,
				updatedAt: createdAt,
				expiresAt: "2026-01-02T00:00:00.000Z",
				purgeAt: "2026-01-02T01:00:00.000Z",
				writes: [],
				retiredWriteKeys: [],
			},
			{ now: createdAt, maxLive: 10, maxLivePerNetwork: 10 },
		);
		const sessions = bound.collection<{ admission: string }>(AGENT_SESSIONS_COLLECTION);
		expect((await sessions.get("cs_hidden_idx"))?.admission).toBe("hidden");
		expect(await h.store.get(agentSessionId("cs_hidden_idx"))).toBeNull();
		expect(await h.store.findByCartId("cart-hidden")).toBeNull();
		expect(await h.store.findByCartId("cart-hidden-shopper")).toBeNull();
		expect(await h.store.findByHandoffTokenHash("h-hidden")).toBeNull();
		expect(await h.store.countLive(createdAt)).toBe(0);
		expect(await h.store.countCreatedSince("net-hidden", createdAt)).toBe(0);
		// The sweep lands it; from then on every lookup answers it.
		await h.store.purgeSlotsDue(createdAt, 100);
		expect((await sessions.get("cs_hidden_idx"))?.admission).toBe("admitted");
		expect((await h.store.findByCartId("cart-hidden-shopper"))?.id).toBe("cs_hidden_idx");
		expect(await h.store.countLive(createdAt)).toBe(1);
	});
});

agentSessionSecretsContract((serverKey) => new WebCryptoAgentSessionSecrets(serverKey), {
	dialect: "webcrypto",
});

test("WebCrypto secrets: base64url output; the stored key text round-trips to its bytes", async () => {
	const id = agentSessionId("cs_aaaaaaaaaaaaaaaaaaaaaa");
	const secrets = new WebCryptoAgentSessionSecrets(SERVER_KEY);
	expect(await secrets.derive("handoff", id, 1)).toMatch(/^[A-Za-z0-9_-]{43}$/);
	const text = randomBase64Url(32);
	expect(base64UrlDecode(text)?.byteLength).toBe(32);
	expect(base64UrlEncode(base64UrlDecode(text) ?? new Uint8Array())).toBe(text);
	for (const bad of ["not base64!", "a", "ab=c"]) expect(base64UrlDecode(bad)).toBeNull();
});
