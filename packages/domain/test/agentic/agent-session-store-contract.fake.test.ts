import {
	agentSessionSecretsContract,
	agentSessionStoreContract,
	InMemoryAgentSessionStore,
} from "@urumi.ai/otta-domain/testing";
import { FakeSecrets } from "./fake-secrets.js";

agentSessionStoreContract(
	async () => {
		const store = new InMemoryAgentSessionStore();
		return {
			store,
			crashInsertBeforeLanding: (session, capacity) =>
				store.insertCrashingBeforeLanding(session, capacity),
			crashInsertBeforeSessionWrite: (session, capacity) =>
				store.insertCrashingBeforeSessionWrite(session, capacity),
		};
	},
	{ dialect: "fake" },
);

agentSessionSecretsContract(async (serverKey) => new FakeSecrets(serverKey), { dialect: "fake" });
