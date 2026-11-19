/**
 * The domain's `AgentSessionStore` contract (ADR-0047) against the document
 * adapter on every Node dialect, plus the WebCrypto secrets adapter against the
 * secrets contract. The contract is the spec: no case is skipped or narrowed.
 *
 * The single-winner hand-off mark under REAL concurrency is Postgres-only
 * (`agent-session-redeem-race.pg.test.ts`); here SQLite verifies the statements.
 */
import { agentSessionId, currency } from "@urumi.ai/otta-domain";
import {
	agentSessionSecretsContract,
	agentSessionStoreContract,
} from "@urumi.ai/otta-domain/testing";
import { expect, test } from "vitest";
import {
	AGENT_SESSION_LINKS_COLLECTION,
	base64UrlDecode,
	base64UrlEncode,
	EmdashAgentSessionStore,
	randomBase64Url,
	WebCryptoAgentSessionSecrets,
} from "../src/index.js";
import { AGENT_SESSION_LAYOUT } from "./agent-session-collections.js";
import { describeEachDialect } from "./describe-each-dialect.js";

const SERVER_KEY = new Uint8Array(32).fill(7);

describeEachDialect("EmdashAgentSessionStore", (ctx) => {
	const bound = ctx.useStorage(AGENT_SESSION_LAYOUT);
	agentSessionStoreContract(
		async () => ({ store: new EmdashAgentSessionStore({ storage: bound.storage }) }),
		{ dialect: ctx.dialect },
	);

	test(`a purge removes the session's token pointers too [${ctx.dialect}]`, async () => {
		const store = new EmdashAgentSessionStore({ storage: bound.storage });
		const createdAt = "2026-01-01T00:00:00.000Z";
		const written = await store.write(
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
			null,
		);
		expect(written.ok).toBe(true);
		const links = bound.collection<unknown>(AGENT_SESSION_LINKS_COLLECTION);
		expect(await links.get("h-now")).not.toBeNull();
		expect(await store.purge(agentSessionId("cs_purge_links"), "2026-02-01T00:00:00.000Z")).toBe(
			true,
		);
		expect(await links.get("h-now")).toBeNull();
		expect(await links.get("h-then")).toBeNull();
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
