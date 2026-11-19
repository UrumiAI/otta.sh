import {
	agentSessionStoreContract,
	InMemoryAgentSessionStore,
} from "@urumi.ai/otta-domain/testing";

agentSessionStoreContract(async () => ({ store: new InMemoryAgentSessionStore() }), {
	dialect: "fake",
});
