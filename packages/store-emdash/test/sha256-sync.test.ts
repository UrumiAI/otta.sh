/**
 * The synchronous SHA-256 answers exactly what WebCrypto's does, so the
 * agent-session ids it derives are the same hex `hashToken` would give.
 */
import { expect, test } from "vitest";
import { sha256HexSync } from "../src/sha256-sync.js";
import { hashToken } from "../src/token-hash.js";

test("known vectors (FIPS 180-4)", () => {
	expect(sha256HexSync("")).toBe(
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	);
	expect(sha256HexSync("abc")).toBe(
		"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
	);
	expect(sha256HexSync("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
		"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
	);
});

test("matches WebCrypto across block boundaries, multi-byte text and NULs", async () => {
	const inputs = ["agent-create\u0000net\u0000key", "é✓😀", "x".repeat(10_000)];
	for (let n = 50; n <= 130; n++) inputs.push("a".repeat(n));
	for (const text of inputs) expect(sha256HexSync(text)).toBe(await hashToken(text));
});
