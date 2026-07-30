/**
 * Negative type-level test for the scaffold's RENDER-STATE channel (mirroring
 * `admin-scaffold-carrier.type-test.ts`, and checked by `pnpm typecheck` rather
 * than vitest: every `@ts-expect-error` must be triggered, so if the typing stops
 * being enforced the suppressed error vanishes, tsc reports the unused directive,
 * and typecheck fails).
 *
 * THE RULE IT PINS. Render state is opaque to the ENGINE but not to the SCREEN:
 * the value a custom action hands `showLeaf`/`showList` and the value that level's
 * `render` receives are the same screen-declared type, checked at the
 * `createListDetailHandler` call site — which is the one place a screen's levels
 * and its custom actions meet. Nothing here is `any`, and no cast carries the
 * value: `RenderState` is the one type parameter the scaffold does NOT erase, for
 * exactly that reason (`Client`/`Filter`/`Summary`/`Detail` are erased because
 * each is produced and consumed inside a single level; render state crosses from
 * one closure to another).
 *
 * A screen that declares no render state must have NO channel at all — the
 * default is `never`, not `unknown`, so a stray third argument is a compile error
 * rather than a value silently arriving at a `render` that ignores it.
 */
import {
	createListDetailHandler,
	customAction,
	leafLevel,
	listLevel,
	screenActions,
	type CustomActionApi,
	type LevelDef,
} from "../src/admin/scaffold/index.js";
import type { Block, BlockResponse } from "../src/types.js";

/** This screen's render state — one discriminated shape, as a real screen has. */
interface Draft {
	kind: "draft";
	note: string;
}

const NO_BLOCKS: Block[] = [];
const DOWN: BlockResponse = { blocks: [] };

function draftText(state: Draft | undefined): string {
	return state === undefined ? "" : state.note;
}

// -- a screen that declares NO render state has no channel ---------------------

const stateless = screenActions("type-test-render-state-none");
const statelessHandler = createListDetailHandler({
	actions: stateless,
	createClient: () => ({}),
	parseOpen: () => undefined,
	levels: [
		listLevel<unknown, unknown, unknown>({
			limit: 1,
			filterFromValues: () => ({}),
			fetchPage: () => Promise.resolve({ items: [], nextCursor: null }),
			render: () => NO_BLOCKS,
			onError: () => DOWN,
		}),
		leafLevel<unknown, unknown>({
			load: () => Promise.resolve({}),
			render: () => NO_BLOCKS,
			notFound: () => NO_BLOCKS,
			onError: () => DOWN,
		}),
	],
	customActions: {
		// The legacy surface, unchanged: a path and (optionally) a notice.
		[stateless.custom("plain")]: customAction(({ showLeaf }) =>
			showLeaf(["x1"], { variant: "error", title: "T", description: "D" }),
		),
		[stateless.custom("stray")]: customAction(({ showLeaf }) =>
			// @ts-expect-error — this screen declared no render state, so there is no
			// third channel to pass one through: `RenderState` is `never`, so the
			// optional parameter accepts nothing but `undefined`.
			showLeaf(["x1"], undefined, { kind: "draft", note: "n" }),
		),
	},
});

// -- a screen that declares one gets it, typed, at both ends -------------------

const stateful = screenActions("type-test-render-state-draft");
const statefulHandler = createListDetailHandler<Draft>({
	actions: stateful,
	createClient: () => ({}),
	parseOpen: () => undefined,
	levels: [
		listLevel<unknown, unknown, unknown, Draft>({
			limit: 1,
			filterFromValues: () => ({}),
			fetchPage: () => Promise.resolve({ items: [], nextCursor: null }),
			// `renderState` arrives as the screen's own type — no cast, no `any`.
			render: ({ renderState }) => [{ type: "context", text: draftText(renderState) }],
			onError: () => DOWN,
		}),
		leafLevel<unknown, unknown, Draft>({
			load: () => Promise.resolve({}),
			render: ({ renderState }) => [{ type: "context", text: draftText(renderState) }],
			notFound: () => NO_BLOCKS,
			onError: () => DOWN,
		}),
		// BACKWARD COMPATIBILITY, in the same screen: a level that ignores the channel
		// is written exactly as before and still belongs to a stateful screen's levels.
		leafLevel<unknown, unknown>({
			load: () => Promise.resolve({}),
			render: () => NO_BLOCKS,
			notFound: () => NO_BLOCKS,
			onError: () => DOWN,
		}),
	],
	customActions: {
		[stateful.custom("stage")]: customAction<unknown, Draft>(({ showLeaf }) =>
			showLeaf(["x1"], undefined, { kind: "draft", note: "n" }),
		),
		// A notice AND state together — the refusal shape (DA-3a).
		[stateful.custom("refuse")]: customAction<unknown, Draft>(({ showList }) =>
			showList(
				[],
				{ variant: "error", title: "T", description: "D" },
				{ kind: "draft", note: "n" },
			),
		),
		[stateful.custom("wrong-shape")]: customAction<unknown, Draft>(({ showLeaf }) =>
			// @ts-expect-error — the value must be THIS screen's render state, not any
			// object that happens to be at hand.
			showLeaf(["x1"], undefined, { qty: 1 }),
		),
		// A custom action that passes no state at all still type-checks in a stateful
		// screen (this is what every existing custom action looks like).
		[stateful.custom("plain")]: customAction(({ showList }) => showList()),
	},
});

// -- the erased level shape and the api type keep their one-argument spellings --

const erased: LevelDef = leafLevel<unknown, unknown>({
	load: () => Promise.resolve({}),
	render: () => NO_BLOCKS,
	notFound: () => NO_BLOCKS,
	onError: () => DOWN,
});

/** The spelling a screen already uses to type a helper that takes the api
 *  (`orders-page.ts`'s staged re-render); it must not need a second argument. */
type LegacyApi = CustomActionApi<{ id: string }>;
function legacyHelper(api: LegacyApi): Promise<BlockResponse> {
	return api.showLeaf(["x1"]);
}

export { erased, legacyHelper, statefulHandler, statelessHandler };
