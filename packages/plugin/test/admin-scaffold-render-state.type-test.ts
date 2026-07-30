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
 * THE TWO ASYMMETRIES IT PINS, both of which a review probe showed are load-bearing:
 *
 *  - the SENDING side (`CustomActionApi`, `customAction`, the screen config)
 *    defaults to `never`, so a screen that declared no render state has no channel
 *    at all: a stray third argument is a compile error rather than a value silently
 *    arriving at a `render` that ignores it;
 *  - a LEVEL defaults to `unknown` and its `render` is an arrow-typed PROPERTY, so
 *    `strictFunctionTypes` checks it contravariantly: a level that ignores the
 *    channel drops into any screen, while a level declaring a state WIDER than the
 *    screen can send is rejected. With `render` as a method that second case
 *    compiled clean and threw at runtime — see `Wider` below.
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

/**
 * A state a level might declare that is WIDER than what this screen's custom
 * actions can ever send it — the shape of the real hazard, not a contrived one:
 * on Orders, `refund-staged` carries `amountCents: number` while `refund-draft`
 * carries `amountInput: string`, so a level typed against the wrong member reads a
 * `number`-typed property that is `undefined` at runtime and calls `.toFixed()` on
 * it — on the money path, immediately after the refusal the channel exists to
 * render.
 */
interface Wider {
	kind: "draft";
	note: string;
	amountCents: number;
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
		// @ts-expect-error — THE VARIANCE HOLE, pinned shut. A level may not declare a
		// state WIDER than what this screen's actions can send: `renderState.amountCents`
		// would be typed `number`, be `undefined` at runtime, and throw on `.toFixed()`.
		// Rejected only because `render` is an arrow-typed property (contravariant under
		// `strictFunctionTypes`) and `levels` is `NoInfer`; as a method it compiled clean.
		leafLevel<unknown, unknown, Wider>({
			load: () => Promise.resolve({}),
			render: ({ renderState }) =>
				renderState === undefined
					? NO_BLOCKS
					: [{ type: "context", text: renderState.amountCents.toFixed(2) }],
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

// -- the cost of contravariance: a level declares the WHOLE union and narrows ---

/** The second member of a real screen's union (Orders: `refund-*` vs `cancel-*`). */
interface CancelDraft {
	kind: "cancel";
	reason: string;
}
type UnionState = Draft | CancelDraft;

const unionScreen = screenActions("type-test-render-state-union");
const unionHandler = createListDetailHandler<UnionState>({
	actions: unionScreen,
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
		// THE DISCIPLINE: a level that renders one member still declares the whole
		// union and narrows on `kind`. It has to — its `render` must accept anything
		// any of the screen's actions can send it.
		leafLevel<unknown, unknown, UnionState>({
			load: () => Promise.resolve({}),
			render: ({ renderState }) =>
				renderState?.kind === "draft" ? [{ type: "context", text: renderState.note }] : NO_BLOCKS,
			notFound: () => NO_BLOCKS,
			onError: () => DOWN,
		}),
		// @ts-expect-error — and it may NOT declare only the member it cares about:
		// `showLeaf` can hand this level a `cancel`, which this `render` says it cannot
		// take. This is the acknowledged cost of closing the variance hole, and it is
		// the same discipline the screens should follow anyway.
		leafLevel<unknown, unknown, Draft>({
			load: () => Promise.resolve({}),
			render: ({ renderState }) =>
				renderState === undefined ? NO_BLOCKS : [{ type: "context", text: renderState.note }],
			notFound: () => NO_BLOCKS,
			onError: () => DOWN,
		}),
	],
	customActions: {
		[unionScreen.custom("cancel")]: customAction<unknown, UnionState>(({ showLeaf }) =>
			showLeaf(["x1"], undefined, { kind: "cancel", reason: "customer_request" }),
		),
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

export { erased, legacyHelper, statefulHandler, statelessHandler, unionHandler };
