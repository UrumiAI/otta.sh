import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { decodeCarrier, encodePath } from "../src/admin/scaffold/index.js";
import type { BlockResponse } from "../src/types.js";
import { loadPluginInSandbox, type SandboxHandle } from "./sandbox/harness.js";

/**
 * The RENDER-STATE CHANNEL, under the real workerd-on-Node sandbox.
 *
 * A custom action used to have exactly one way to say anything to the level it
 * re-renders: a `notice` banner. That is enough for "it worked" / "it failed" and
 * nothing else — so a refusal (DA-3a: the record moved, or the operator typed
 * `19,99`) re-rendered a leaf that had forgotten which group the banner was
 * pointing at and what the operator had typed, and the one screen that needed
 * more re-implemented the leaf's whole read-and-render path to get it.
 * `showLeaf`/`showList`'s third argument is that channel: an opaque,
 * SCREEN-DEFINED value handed straight to the target level's `render` as
 * `renderState`.
 *
 * The properties this suite pins, in order of how much they would cost to lose:
 *   1. it must not be storage — the value lives for ONE response, and the next
 *      interaction sees `undefined` again (statelessness is the whole design);
 *   2. omitting it must render byte-identically to today (this is additive to a
 *      merged, consumed scaffold);
 *   3. a hostile value must not escape containment — a throw from screen code is a
 *      non-2xx, which unmounts the whole tree;
 *   4. it must compose with `carriedForm`'s prefill digest, since the point of
 *      prefilling is that the operator sees their own typing again;
 *   5. `notice` must still work, alongside it and without it.
 *
 * Driven through the synthetic geo fixture (`src/admin/scaffold/testing/`), like
 * every other scaffold suite. Blocks are located by `type`, never by index.
 */

let sandbox: SandboxHandle;
beforeAll(async () => {
	sandbox = await loadPluginInSandbox({
		allowedHosts: ["127.0.0.1"],
		commerceServiceBaseUrl: "http://127.0.0.1:1",
		entry: "admin/scaffold/testing/geo-entry.ts",
	});
}, 60_000);
afterAll(async () => {
	await sandbox?.close();
});

async function invoke(input: unknown): Promise<BlockResponse> {
	const outcome = await sandbox.invokeRoute("admin", input);
	expect("result" in outcome, `sandbox error: ${JSON.stringify(outcome)}`).toBe(true);
	return (outcome as { result: BlockResponse }).result;
}

interface Blk extends Record<string, unknown> {
	type: string;
}
function blocksOf(res: BlockResponse): Blk[] {
	return res.blocks as unknown as Blk[];
}
function headerText(res: BlockResponse): unknown {
	return blocksOf(res).find((b) => b.type === "header")?.text;
}
function bannerOf(res: BlockResponse): Blk | undefined {
	return blocksOf(res).find((b) => b.type === "banner");
}
/**
 * The staged accordion the geo leaf renders ONLY when it was handed render state.
 *
 * Located by its `block_id` PREFIX and asserted UNIQUE — not by index, and not as
 * "the first accordion": the fixture is shared and grows, and the day it renders a
 * second accordion "the first one" would quietly start asserting against the wrong
 * group while still passing. Returns undefined when there is none, which is what
 * the no-render-state cases assert.
 */
function stagedGroup(res: BlockResponse, landmarkId = "m1"): Blk | undefined {
	const groups = blocksOf(res).filter(
		(b) => b.type === "accordion" && String(b.block_id).startsWith(`geo:${landmarkId}:note:`),
	);
	expect(groups.length, `expected at most one staged group, got ${groups.length}`).toBeLessThan(2);
	return groups[0];
}
function groupBlocks(group: Blk | undefined): Blk[] {
	return (group?.blocks ?? []) as Blk[];
}
function noteForm(group: Blk | undefined): Blk | undefined {
	return groupBlocks(group).find((b) => b.type === "form");
}
function noteValue(group: Blk | undefined): unknown {
	const fields = (noteForm(group)?.fields ?? []) as Array<{
		action_id?: string;
		initial_value?: string;
	}>;
	return fields.find((f) => f.action_id === "note")?.initial_value;
}
function contextTexts(res: BlockResponse): unknown[] {
	return blocksOf(res)
		.filter((b) => b.type === "context")
		.map((b) => b.text);
}

const LEAF = encodePath(["c1", "m1"]);

/** The plain leaf render — the baseline every "no render state" assertion is
 *  measured against. */
function openLeaf(): Promise<BlockResponse> {
	return invoke({ type: "form_submit", action_id: "geo:open", values: { target: LEAF } });
}

describe("render state reaches the re-rendered level", () => {
	test("a custom action re-renders the LEAF with screen-defined state (group open, values prefilled)", async () => {
		const res = await invoke({
			type: "block_action",
			action_id: "geo:stage",
			value: { path: LEAF, note: "spire" },
		});
		// Still the leaf the operator was on, rendered from the level's own `render`.
		expect(headerText(res)).toBe("Landmark m1");
		const group = stagedGroup(res);
		// The two halves of a DA-3 state-2 force-open (B-6): a CHANGED key so the
		// group remounts, and the flag the remount then re-reads.
		expect(group?.block_id).toBe("geo:m1:note:review");
		expect(group?.default_open).toBe(true);
		// ...and the operator's own input is back in the form.
		expect(noteValue(group)).toBe("spire");
		// The confirm control exists only in the `confirm` stage.
		expect(groupBlocks(group).some((b) => b.type === "actions")).toBe(true);
	});

	test("a REFUSAL carries a notice AND the staged input together (state 1, nothing lost)", async () => {
		// The shape every DA-3a refusal needs: the banner says what happened, the
		// group it points at is open, and what the operator typed is still there.
		const res = await invoke({
			type: "block_action",
			action_id: "geo:refuse",
			value: { path: LEAF, note: "spire" },
		});
		expect(headerText(res)).toBe("Landmark m1");
		const banner = bannerOf(res);
		expect(banner?.variant).toBe("error");
		expect(banner?.title).toBe("Refused");
		const group = stagedGroup(res);
		expect(group?.default_open).toBe(true);
		expect(noteValue(group)).toBe("spire");
		// State 1, not state 2: the group is re-collecting, so there is no confirm
		// button beside the form — and its key differs from the state-2 one.
		expect(group?.block_id).toBe("geo:m1:note:redo");
		expect(groupBlocks(group).some((b) => b.type === "actions")).toBe(false);
	});

	test("render state composes with `carriedForm`: a different value ⇒ a different form key", async () => {
		// Prefilled values are UNCONTROLLED (`defaultValue`) and the React key is
		// `block_id`, so a prefill that changes without the key changing is invisible
		// to the operator. The channel must not become a way to reintroduce that.
		const first = await invoke({
			type: "block_action",
			action_id: "geo:stage",
			value: { path: LEAF, note: "spire" },
		});
		const second = await invoke({
			type: "block_action",
			action_id: "geo:stage",
			value: { path: LEAF, note: "tower" },
		});
		const keyOf = (res: BlockResponse): unknown => noteForm(stagedGroup(res))?.block_id;
		expect(keyOf(first)).not.toBe(keyOf(second));
		// It is a carrier, and the digest is what moved (the namespace is stable).
		expect(decodeCarrier(keyOf(first))?.["__v"]).not.toBe(decodeCarrier(keyOf(second))?.["__v"]);
	});

	test("render state reaches a LIST level too, alongside a notice", async () => {
		const res = await invoke({
			type: "block_action",
			action_id: "geo:list-stage",
			value: { note: "pending-delete" },
		});
		expect(headerText(res)).toBe("Countries");
		expect(contextTexts(res)).toContain("staged: pending-delete");
		expect(bannerOf(res)?.title).toBe("Staged");
	});
});

describe("omitting render state behaves exactly as today", () => {
	test("a custom action that passes none re-renders the leaf identically to a plain open", async () => {
		const opened = await openLeaf();
		const pinged = await invoke({
			type: "block_action",
			action_id: "geo:ping",
			value: { path: LEAF },
		});
		// `ping` predates the channel and passes only a notice. Its response must be
		// the plain render PLUS that banner, and nothing else.
		expect(blocksOf(pinged).filter((b) => b.type !== "banner")).toEqual(blocksOf(opened));
		expect(bannerOf(pinged)?.title).toBe("Pinged");
		expect(stagedGroup(opened)).toBeUndefined();
	});

	test("a plain open/back/page render never sees render state (no group, no context line)", async () => {
		const opened = await openLeaf();
		expect(stagedGroup(opened)).toBeUndefined();
		const root = await invoke({ type: "page_load" });
		expect(contextTexts(root).some((t) => String(t).startsWith("staged:"))).toBe(false);
	});

	test("the channel is WITHIN-REQUEST only: the next interaction sees none of it", async () => {
		// Nothing is stored anywhere, so re-opening the same leaf right after a
		// staged render is back to state 1. This is what keeps every screen stateless
		// — the durable half of a stage/confirm flow is the payload the staged form
		// and its confirm button carry, exactly as before.
		const staged = await invoke({
			type: "block_action",
			action_id: "geo:stage",
			value: { path: LEAF, note: "spire" },
		});
		expect(stagedGroup(staged)).toBeDefined();
		expect(stagedGroup(await openLeaf())).toBeUndefined();
	});
});

describe("a hostile render state cannot throw uncontained", () => {
	test("a value whose own property access throws fails closed to the level's onError banner", async () => {
		// The engine treats render state as OPAQUE — it never reads it — so the only
		// place a hostile value can blow up is the screen's own `render`, which is
		// already inside the leaf's containment. Pinning it here means the channel
		// cannot become the one path that escapes: an escaping throw is a non-2xx,
		// which replaces the whole tree with a raw status panel.
		const res = await invoke({
			type: "block_action",
			action_id: "geo:hostile-state",
			value: { path: LEAF },
		});
		expect(headerText(res)).toBe("Landmark"); // the leaf's fail-closed header
		expect(bannerOf(res)?.variant).toBe("error");
		expect(bannerOf(res)?.title).toBe("down");
		// A well-formed BlockResponse, not an error escape.
		expect(Array.isArray(res.blocks)).toBe(true);
		expect(res.blocks.length).toBeGreaterThan(0);
	});

	test("render state pointing at a MISSING record still renders notFound, not a staged view", async () => {
		// `notFound` is deliberately not given the state: there is no record to stage
		// anything against, and a form prefilled for a deleted order is a lie.
		const res = await invoke({
			type: "block_action",
			action_id: "geo:stage",
			value: { path: encodePath(["c1", "nope"]), note: "spire" },
		});
		expect(headerText(res)).toBe("Not found");
		expect(stagedGroup(res)).toBeUndefined();
	});

	test("render state does not rescue a leaf `render` that throws for its own reasons", async () => {
		const res = await invoke({
			type: "block_action",
			action_id: "geo:stage",
			value: { path: encodePath(["c1", "m-throw"]), note: "spire" },
		});
		expect(headerText(res)).toBe("Landmark");
		expect(bannerOf(res)?.title).toBe("down");
	});
});
