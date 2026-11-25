/**
 * The `AgentSessionStore` contract (ADR-0047) on **D1**, through the host's own
 * Kysely wiring — the dialect Otta ships on. It checks the declared-index read
 * contract (sessions behind `admission`, slots by `pool`/`sessionId`/`state`,
 * `purgeAt`) and the crash hooks against D1's SQLite build, and runs the WebCrypto secrets inside
 * `workerd`, the runtime that ruled out `node:crypto`.
 */
import {
	agentSessionSecretsContract,
	agentSessionStoreContract,
} from "@urumi.ai/otta-domain/testing";
import { WebCryptoAgentSessionSecrets } from "../../src/index.js";
import { AGENT_SESSION_LAYOUT } from "../agent-session-collections.js";
import { freshEmdashAgentSessionHarness } from "../agent-session-harness.js";
import { useD1Storage } from "./describe-d1.js";

const bound = useD1Storage(AGENT_SESSION_LAYOUT);

agentSessionStoreContract(() => freshEmdashAgentSessionHarness(bound.storage), {
	dialect: "d1",
});
agentSessionSecretsContract((serverKey) => new WebCryptoAgentSessionSecrets(serverKey), {
	dialect: "d1",
});
