/**
 * `isRetryableStorageBusy` — the ONE structural predicate every route boundary
 * uses to tell "the store was too busy; nothing was written by the step that
 * gave up; try again" apart from a real fault.
 *
 * It is structural on purpose: an error crossing the sandbox bridge arrives as a
 * plain object carrying `code`/`retryable`, not as an instance of anything, so
 * each case below also runs against a plain-object copy of the error.
 */
import { describe, expect, test } from "vitest";
import {
	isRetryableStorageBusy,
	StorageContentionError,
	type StorageSerializationError,
} from "../src/index.js";

function serializationAbort(retryable: boolean): StorageSerializationError {
	return Object.assign(new Error("could not serialize access"), {
		code: "STORAGE_SERIALIZATION_FAILURE" as const,
		retryable: retryable as true,
		sqlState: "40001",
	});
}

/** What the same error looks like after a structured-clone hop. */
function bridged(err: object): Record<string, unknown> {
	return { ...err, name: (err as Error).name, message: (err as Error).message };
}

describe("isRetryableStorageBusy", () => {
	test("an exhausted compare-and-set budget is busy — as an instance and as a bridged plain object", () => {
		const err = new StorageContentionError("reserve", 24);
		expect(isRetryableStorageBusy(err)).toBe(true);
		expect(isRetryableStorageBusy(bridged(err))).toBe(true);
	});

	test("a retryable host serialization abort (40001/40P01) is busy — as an instance and bridged", () => {
		const err = serializationAbort(true);
		expect(isRetryableStorageBusy(err)).toBe(true);
		expect(isRetryableStorageBusy(bridged(err))).toBe(true);
	});

	test("a serialization abort the host did NOT mark retryable is not busy — it is a fault", () => {
		expect(isRetryableStorageBusy(serializationAbort(false))).toBe(false);
	});

	test("anything else is not busy: plain errors, look-alike codes, non-objects", () => {
		for (const value of [
			new Error("boom"),
			new RangeError("cents() out of range"),
			{ code: "STORAGE_CONTENTION_ISH" },
			{ code: "ROUTE_ERROR", retryable: true },
			"STORAGE_CONTENTION",
			null,
			undefined,
			42,
		]) {
			expect(isRetryableStorageBusy(value)).toBe(false);
		}
	});

	test("a busy error only NESTED as a cause is not busy: the outer failure may have written first", () => {
		const outer = new Error("settle failed", { cause: new StorageContentionError("reserve", 24) });
		expect(isRetryableStorageBusy(outer)).toBe(false);
	});
});
