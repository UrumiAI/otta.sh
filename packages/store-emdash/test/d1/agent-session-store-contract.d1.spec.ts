/**
 * The `AgentSessionStore` contract (ADR-0047) on **D1**, through the host's own
 * Kysely wiring — the dialect Otta ships on. It checks the declared-index read
 * contract (`status`/`expiresAt`, `networkKey`/`createdAt`, `cartId`/`createdAt`,
 * `purgeAt`) against D1's SQLite build, and runs the WebCrypto secrets inside
 * `workerd`, the runtime that ruled out `node:crypto`.
 */
import {
	agentSessionSecretsContract,
	agentSessionStoreContract,
} from "@urumi.ai/otta-domain/testing";
import { EmdashAgentSessionStore, WebCryptoAgentSessionSecrets } from "../../src/index.js";
import { AGENT_SESSION_LAYOUT } from "../agent-session-collections.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(AGENT_SESSION_LAYOUT);

agentSessionStoreContract(
	async () => ({ store: new EmdashAgentSessionStore({ storage: bound.storage }) }),
	{ dialect: "d1" },
);
agentSessionSecretsContract((serverKey) => new WebCryptoAgentSessionSecrets(serverKey), {
	dialect: "d1",
});
