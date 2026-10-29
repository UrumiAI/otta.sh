import type { Logger } from "../ports/logger.js";

export interface LogEntry {
	level: "info" | "warn" | "error";
	message: string;
	fields: Record<string, unknown> | undefined;
}

/** A Logger test double that records every call instead of writing anywhere. */
export class RecordingLogger implements Logger {
	readonly entries: LogEntry[] = [];

	info(message: string, fields?: Record<string, unknown>): void {
		this.entries.push({ level: "info", message, fields });
	}

	warn(message: string, fields?: Record<string, unknown>): void {
		this.entries.push({ level: "warn", message, fields });
	}

	error(message: string, fields?: Record<string, unknown>): void {
		this.entries.push({ level: "error", message, fields });
	}
}
