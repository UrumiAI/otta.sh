import {
	AGENT_SESSION_MIN_SERVER_KEY_BYTES,
	type AgentSessionId,
	type AgentSessionSecrets,
} from "@urumi.ai/otta-domain";

/** The server key the use-case tests run under. */
export const TEST_SERVER_KEY = new Uint8Array(AGENT_SESSION_MIN_SERVER_KEY_BYTES).fill(7);

/**
 * Deterministic secrets for tests: counted 22-character ids, readable derived
 * secrets tagged with the server key (so a different key derives differently),
 * a "hash" that is never the token, and a compare that answers false on a
 * length mismatch. Refuses an empty or short key, as a real adapter must.
 */
export class FakeSecrets implements AgentSessionSecrets {
	#n = 0;
	/** A short, key-unique tag mixed into every derived secret. */
	readonly keyTag: string;
	/** Every id minted, in order. */
	readonly minted: string[] = [];

	constructor(serverKey: Uint8Array = TEST_SERVER_KEY) {
		if (serverKey.length < AGENT_SESSION_MIN_SERVER_KEY_BYTES) {
			throw new RangeError("server key too short");
		}
		this.keyTag = Array.from(serverKey, (b) => b.toString(16).padStart(2, "0")).join("");
	}

	mintId(): string {
		const id = `rnd${String(++this.#n).padStart(19, "0")}`;
		this.minted.push(id);
		return id;
	}

	/** The secret `derive` gives, for building expectations. */
	orderSecret(sessionId: string): string {
		return `order:${this.keyTag}:${sessionId}`;
	}

	/** The hand-off token `derive` gives for `generation`, for building expectations. */
	token(sessionId: string, generation: number): string {
		return `link:${this.keyTag}:${sessionId}:${generation}`;
	}

	derive(purpose: "order", sessionId: AgentSessionId): Promise<string>;
	derive(purpose: "handoff", sessionId: AgentSessionId, generation: number): Promise<string>;
	async derive(
		purpose: "order" | "handoff",
		sessionId: AgentSessionId,
		generation?: number,
	): Promise<string> {
		return purpose === "order"
			? this.orderSecret(sessionId)
			: this.token(sessionId, generation ?? Number.NaN);
	}

	async hash(secret: string): Promise<string> {
		return `h(${secret})`;
	}

	constantTimeEqual(a: string, b: string): boolean {
		let diff = a.length ^ b.length;
		for (let i = 0; i < Math.max(a.length, b.length); i++) {
			diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
		}
		return diff === 0;
	}
}
