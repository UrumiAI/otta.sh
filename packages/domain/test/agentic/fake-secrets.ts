import type { AgentSessionId, AgentSessionSecrets } from "@urumi.ai/otta-domain";

/**
 * Deterministic secrets for tests: counted 22-character ids, readable derived
 * secrets, a "hash" that is never the token, and a compare that answers false on
 * a length mismatch.
 */
export class FakeSecrets implements AgentSessionSecrets {
	#n = 0;
	/** Every id minted, in order. */
	readonly minted: string[] = [];
	mintId(): string {
		const id = `rnd${String(++this.#n).padStart(19, "0")}`;
		this.minted.push(id);
		return id;
	}
	async derive(
		purpose: "order" | "handoff",
		sessionId: AgentSessionId,
		generation?: number,
	): Promise<string> {
		return purpose === "order" ? `order:${sessionId}` : `link:${sessionId}:${generation ?? 0}`;
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
