import {
	agentSessionSecretsContract,
	agentSessionStoreContract,
	InMemoryAgentSessionStore,
} from "@urumi.ai/otta-domain/testing";
import { FakeSecrets } from "./fake-secrets.js";

agentSessionStoreContract(async () => ({ store: new InMemoryAgentSessionStore() }), {
	dialect: "fake",
});

agentSessionSecretsContract(async () => new FakeSecrets(), { dialect: "fake" });
