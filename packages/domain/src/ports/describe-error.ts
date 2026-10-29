/** Longest message kept in a log line. */
const LOG_MESSAGE_MAX = 160;
/** Longest input the scrubber reads (review round 3 polish, P-1): the message is
 *  cut to this BEFORE it is scrubbed, so the work per log line is bounded whatever
 *  a driver puts in its message. */
const SCRUB_INPUT_MAX = 1024;

/**
 * An error as a log line may carry it (review round 3, B I5): its `name`, a
 * string or numeric `code`, and a SHORT message with every quoted run and
 * anything shaped like an email replaced. Today's storage and domain errors carry
 * no stored values, but an adapter's driver message may quote one (a row's
 * text, a key), and this line goes to the worker log.
 */
export function describeErrorForLog(err: unknown): {
	name: string;
	code?: string;
	message: string;
} {
	const name = err instanceof Error ? err.name : typeof err;
	const rawCode =
		typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
	const code =
		typeof rawCode === "string" || typeof rawCode === "number"
			? scrub(String(rawCode)).slice(0, 32)
			: undefined;
	const message = scrub(err instanceof Error ? err.message : String(err));
	return {
		name: scrub(name).slice(0, 64),
		...(code === undefined ? {} : { code }),
		message: message.length > LOG_MESSAGE_MAX ? `${message.slice(0, LOG_MESSAGE_MAX)}…` : message,
	};
}

/**
 * Linear in its input, which is cut to {@link SCRUB_INPUT_MAX} first (review round
 * 3 polish, P-1: the unbounded email pattern backtracked quadratically on a long
 * run with no space, `@` or `<>`; 100k characters took seconds, a stalled tick).
 */
function scrub(text: string): string {
	return (
		cutAtWord(text)
			// Quoted runs: the usual place a driver puts a value.
			.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<value>")
			// A quote left open (or opened before the cut) runs to the end.
			.replace(/["'`][^"'`]*$/, "<value>")
			// Email-shaped text, with bounded repeats (RFC 5321's local and domain
			// limits) so it cannot backtrack quadratically.
			.replace(/[^\s@<>]{1,64}@[^\s@<>]{1,255}/g, "<value>")
			// Control characters, lone surrogates and the like: printable text only.
			.replace(/[^\x20-\x7E]/g, "?")
	);
}

/**
 * The text cut to {@link SCRUB_INPUT_MAX}, with a word the cut splits redacted
 * whole (final verify, F-1): an email that straddles the cut has lost its `@`, so
 * the email rule cannot see it, and scrubbing shortens what comes before, which
 * would bring it into the logged 160. A scan back to the last whitespace, not a
 * `\S*$` regex, so it stays linear.
 */
function cutAtWord(text: string): string {
	if (text.length <= SCRUB_INPUT_MAX) return text;
	const cut = text.slice(0, SCRUB_INPUT_MAX);
	let end = cut.length;
	while (end > 0 && !/\s/.test(cut.charAt(end - 1))) end--;
	return `${cut.slice(0, end)}<value>`;
}
