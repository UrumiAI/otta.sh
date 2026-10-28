/**
 * The storage paths run through a real D1 **session** handle — the handle EmDash
 * gives the plugin per request under `session: "primary-first"`. See
 * `describe-d1-session.ts` for how the handle is built and for what miniflare can
 * and cannot show: it has no replicas, so this file proves the code paths work over
 * a session, not that a replica read is never stale. Staging still has to show that
 * before read replication is switched on (#490).
 */
import { describe, expect, it } from "vitest";
import { BOOKMARK_COOKIE, useD1SessionStorage } from "./describe-d1-session.js";
import type { StorageLayout } from "./describe-d1.js";

/** `notes` is a scratch collection for the harness cases. */
const LAYOUT: StorageLayout = { notes: { indexes: [] } };

interface Note {
	text: string;
}

const sessions = useD1SessionStorage(LAYOUT);

describe("the session harness", () => {
	it("runs the statements through a session: the commit stores a bookmark", async () => {
		const request = sessions.request({ isWrite: true });
		await request.collection<Note>("notes").put("a", { text: "hello" });
		const bookmark = request.commit();
		expect(bookmark).toBeTypeOf("string");
		expect(bookmark?.length).toBeGreaterThan(0);
	});

	it("reads a document back through the same session", async () => {
		const request = sessions.request({ isWrite: true });
		await request.collection<Note>("notes").put("a", { text: "hello" });
		expect(await request.collection<Note>("notes").get("a")).toEqual({ text: "hello" });
		expect(BOOKMARK_COOKIE).toBe("__em_d1_bookmark");
	});
});
