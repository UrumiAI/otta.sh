/**
 * The trace an outbox email leaves when the 72 h age cap completes it unsent
 * (ADR-0031). The row is stored as plain `skipped`, so this log line is the only
 * record of WHICH emails a buyer never got: a count, plus each row's id and
 * template. Never the address or the body.
 */
import { emailTemplateForNotice, emailTemplateForState, type OutboxEmail } from "@otta-sh/domain";

/** `<row id> (<template>)`: what an operator needs to find the order, nothing personal. */
function describeExpired(row: OutboxEmail): string {
	const template =
		row.notice !== null
			? emailTemplateForNotice(row.notice.kind)
			: emailTemplateForState(row.toState);
	return `${row.id} (${template ?? "no template"})`;
}

/** One `console.warn` for every row expired by one sweep tick or inline call; silent for none. */
export function logExpiredEmails(source: string, rows: readonly OutboxEmail[]): void {
	if (rows.length === 0) return;
	console.warn(
		`[otta] ${source}: ${String(rows.length)} email(s) older than 72 h completed unsent (ADR-0031): ` +
			rows.map(describeExpired).join(", "),
	);
}
