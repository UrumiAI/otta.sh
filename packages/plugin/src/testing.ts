/**
 * `@otta-sh/plugin/testing` — test helpers for code that sends email through
 * EmDash's `ctx.email`, and for authors of EmDash email-transport plugins.
 *
 * The shapes are structural mirrors of emdash's `EmailMessage` /
 * `EmailDeliverEvent` (`emdash/plugin`), so this package keeps no runtime or
 * type dependency on `emdash`. The example provider's test pins that the two
 * stay assignable (`examples/email-provider/test`).
 */

/** emdash `EmailMessage`: what `ctx.email.send` takes and `email:deliver` receives. */
export interface TestEmailMessage {
	to: string;
	/** Additional visible recipients (emdash 1.0). */
	cc?: string[];
	/** Where replies go instead of the sender (emdash 1.0). */
	replyTo?: string;
	subject: string;
	text: string;
	html?: string;
}

export interface RecordingEmailProvider {
	/** Every message that reached the transport, including failed and hanging ones. */
	readonly attempts: readonly TestEmailMessage[];
	/** Messages delivered successfully, in order. */
	readonly sent: readonly TestEmailMessage[];
	/** `ctx.email`-shaped: pass `{ send: provider.send }` (or the provider) as `ctx.email`. */
	send(message: TestEmailMessage): Promise<void>;
	/** `email:deliver`-shaped handler, for a stand-in transport plugin. */
	deliver(event: { message: TestEmailMessage; source: string }): Promise<void>;
	/** Deliver normally from now on (the default). */
	succeed(): void;
	/** Throw `error` on every send from now on, as a provider outage would. */
	fail(error?: Error): void;
	/** Never settle from now on, as a stuck provider would; the caller's timeout must fire. */
	hang(): void;
}

type Mode = { kind: "succeed" } | { kind: "fail"; error: Error } | { kind: "hang" };

/** A fake email transport that records what it is given and can fail or hang on demand. */
export function recordingEmailProvider(): RecordingEmailProvider {
	const attempts: TestEmailMessage[] = [];
	const sent: TestEmailMessage[] = [];
	let mode: Mode = { kind: "succeed" };
	const send = async (message: TestEmailMessage): Promise<void> => {
		// Like EmDash's pipeline: an empty to/subject/text is rejected before any provider sees it.
		for (const field of ["to", "subject", "text"] as const) {
			if (!message[field]) throw new Error(`Invalid email message: '${field}' is required`);
		}
		const copy = { ...message };
		attempts.push(copy);
		if (mode.kind === "fail") throw mode.error;
		if (mode.kind === "hang") return new Promise<never>(() => {});
		sent.push(copy);
	};
	return {
		attempts,
		sent,
		send,
		deliver: (event) => send(event.message),
		succeed: () => {
			mode = { kind: "succeed" };
		},
		fail: (error = new Error("recordingEmailProvider: configured to fail")) => {
			mode = { kind: "fail", error };
		},
		hang: () => {
			mode = { kind: "hang" };
		},
	};
}
