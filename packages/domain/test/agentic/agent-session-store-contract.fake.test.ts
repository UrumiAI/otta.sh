import {
	agentSessionSecretsContract,
	agentSessionStoreContract,
	InMemoryAgentSessionStore,
} from "@urumi.ai/otta-domain/testing";
import { FakeSecrets } from "./fake-secrets.js";

agentSessionStoreContract(async () => ({ store: new InMemoryAgentSessionStore() }), {
	dialect: "fake",
});

agentSessionSecretsContract(async (serverKey) => new FakeSecrets(serverKey), { dialect: "fake" });
