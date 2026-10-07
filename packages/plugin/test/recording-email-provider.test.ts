import { describe, expect, test } from "vitest";
import { recordingEmailProvider } from "../src/testing.js";

const message = {
	to: "buyer@example.com",
	subject: "Your order",
	text: "Thanks",
	html: "<p>Thanks</p>",
};

const settlesWithin = (p: Promise<void>, ms: number): Promise<boolean> =>
	Promise.race([
		p.then(
			() => true,
			() => true,
		),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
	]);

describe("recordingEmailProvider", () => {
	test("records delivered messages as copies, via ctx.email.send and email:deliver alike", async () => {
		const provider = recordingEmailProvider();
		const input = { ...message };
		await provider.send(input);
		await provider.deliver({
			message: { to: "b@example.com", subject: "s", text: "t" },
			source: "otta",
		});
		input.subject = "mutated after send";
		expect(provider.sent).toEqual([message, { to: "b@example.com", subject: "s", text: "t" }]);
		expect(provider.attempts).toEqual(provider.sent);
	});

	test("fail() throws on every send and records the attempt but not a delivery", async () => {
		const provider = recordingEmailProvider();
		const outage = new Error("provider down");
		provider.fail(outage);
		await expect(provider.send(message)).rejects.toBe(outage);
		await expect(provider.deliver({ message, source: "otta" })).rejects.toBe(outage);
		expect(provider.attempts).toHaveLength(2);
		expect(provider.sent).toEqual([]);
	});

	test("fail() without an argument throws a default error", async () => {
		const provider = recordingEmailProvider();
		provider.fail();
		await expect(provider.send(message)).rejects.toThrow(/configured to fail/);
	});

	test("rejects an empty to, subject or text without recording it, as EmDash does", async () => {
		const provider = recordingEmailProvider();
		await expect(provider.send({ ...message, to: "" })).rejects.toThrow(/'to' is required/);
		await expect(provider.send({ ...message, subject: "" })).rejects.toThrow(/'subject'/);
		await expect(
			provider.deliver({ message: { ...message, text: "" }, source: "otta" }),
		).rejects.toThrow(/'text'/);
		expect(provider.attempts).toEqual([]);
	});

	test("hang() never settles, and succeed() restores delivery", async () => {
		const provider = recordingEmailProvider();
		provider.hang();
		expect(await settlesWithin(provider.send(message), 20)).toBe(false);
		expect(provider.attempts).toEqual([message]);
		expect(provider.sent).toEqual([]);
		provider.succeed();
		await provider.send(message);
		expect(provider.sent).toEqual([message]);
	});
});
