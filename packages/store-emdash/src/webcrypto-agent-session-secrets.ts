/**
 * `AgentSessionSecrets` on WebCrypto (ADR-0047). WebCrypto rather than
 * `node:crypto` because the plugin runs inside `workerd` (#274).
 *
 *  - `mintId`: 16 random bytes (128 bits), base64url — 22 characters.
 *  - `derive`: HMAC-SHA256 under the server key (raw bytes, at least
 *    `AGENT_SESSION_MIN_SERVER_KEY_BYTES`) over `purpose ‖ sessionId ‖
 *    generation`, NUL-separated, base64url (43 characters, 256 bits). Without the
 *    key a secret cannot be computed from the session id.
 *  - `hash`: SHA-256, lowercase hex (`hashToken`).
 *  - `constantTimeEqual`: a full-length XOR fold; a length mismatch answers
 *    `false` without throwing.
 */

import {
	AGENT_SESSION_MIN_SERVER_KEY_BYTES,
	type AgentSessionId,
	type AgentSessionSecretPurpose,
	type AgentSessionSecrets,
} from "@urumi.ai/otta-domain";
import { hashToken, tokenHashEquals } from "./token-hash.js";

const encoder = new TextEncoder();

/** Bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Unpadded (or padded) base64url as bytes; `null` for anything that is not base64url. */
export function base64UrlDecode(text: string): Uint8Array | null {
	if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) return null;
	const b64 = text.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
	if (b64.length % 4 === 1) return null;
	let binary: string;
	try {
		binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
	} catch {
		return null;
	}
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/** `n` random bytes from WebCrypto, as unpadded base64url. */
export function randomBase64Url(byteLength: number): string {
	const bytes = new Uint8Array(byteLength);
	globalThis.crypto.getRandomValues(bytes);
	return base64UrlEncode(bytes);
}

export class WebCryptoAgentSessionSecrets implements AgentSessionSecrets {
	readonly #key: Promise<CryptoKey>;

	/** `serverKey` is the raw server key, at least {@link AGENT_SESSION_MIN_SERVER_KEY_BYTES}
	 *  bytes (the plugin generates 32 random bytes). Empty or shorter is refused:
	 *  a weakly keyed derive would make every secret computable from the session id. */
	constructor(serverKey: Uint8Array) {
		if (serverKey.byteLength < AGENT_SESSION_MIN_SERVER_KEY_BYTES) {
			throw new RangeError("agent session server key is too short");
		}
		this.#key = globalThis.crypto.subtle.importKey(
			"raw",
			serverKey.slice(),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
	}

	mintId(): string {
		return randomBase64Url(16);
	}

	derive(purpose: "order", sessionId: AgentSessionId): Promise<string>;
	derive(purpose: "handoff", sessionId: AgentSessionId, generation: number): Promise<string>;
	async derive(
		purpose: AgentSessionSecretPurpose,
		sessionId: AgentSessionId,
		generation?: number,
	): Promise<string> {
		const message = `${purpose}\u0000${sessionId}\u0000${generation ?? ""}`;
		const signature = await globalThis.crypto.subtle.sign(
			"HMAC",
			await this.#key,
			encoder.encode(message),
		);
		return base64UrlEncode(new Uint8Array(signature));
	}

	hash(secret: string): Promise<string> {
		return hashToken(secret);
	}

	constantTimeEqual(a: string, b: string): boolean {
		return tokenHashEquals(a, b);
	}
}
