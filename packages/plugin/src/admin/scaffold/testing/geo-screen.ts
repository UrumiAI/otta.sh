import type { AccordionBlock, Block, FormBlock, SandboxedPlugin } from "../../../types.js";
import { screenActions } from "../actions.js";
import { failClosedResponse, noticeBanner, type Notice } from "../banner.js";
import { carriedForm, encodeCarrier } from "../carrier.js";
import {
	asRecord,
	createListDetailHandler,
	customAction,
	type CustomActionFn,
	leafLevel,
	listLevel,
	readString,
} from "../list-detail.js";
import { filterPanel } from "../layout.js";
import { backButton, decodePath, encodePath, PATH_FIELD, type NavPath } from "../nav.js";

/**
 * A SYNTHETIC 3-level screen (countries → cities → landmark) built on the
 * scaffold — the characterization-test fixture for the scaffold's own control
 * flow. Lives in `src` under the repo's fixtures-in-src `testing/` convention
 * (cf. `packages/domain/src/testing/*-contract.ts`) so the sandbox harness's
 * whole-`src` copy picks it up and `admin-scaffold-list-detail.sandbox.test.ts`
 * can boot it under the REAL workerd sandbox via `testing/geo-entry.ts`.
 * NEVER exported from the package barrel and never reachable from the
 * production entries (`index.ts` / `plugin.ts` / the default `sandbox-entry`).
 *
 * Why 3 levels: the production Orders screen only reaches depth 2, but the
 * scaffold exists for zones → methods → rates (depth 3) — this fixture is the
 * only place the N-level nav core (deep back-pop, deep cursor path-carry, deep
 * apply-filter) is exercised. IO-free: the "client" is an in-memory fake, so
 * the sandbox-clean guard stays green.
 */

export interface GeoCountry {
	id: string;
	name: string;
}
export interface GeoCity {
	id: string;
	name: string;
}
export interface GeoLandmark {
	id: string;
	name: string;
}

const COUNTRIES: GeoCountry[] = [
	{ id: "c1", name: "Alpha" },
	{ id: "c2", name: "Beta" },
	{ id: "c3", name: "Gamma" },
];
const CITIES: Record<string, GeoCity[]> = {
	c1: [
		{ id: "m1", name: "One" },
		{ id: "m2", name: "Two" },
		{ id: "m3", name: "Three" },
	],
};
const LANDMARK: GeoLandmark = { id: "m1", name: "Tower" };

/** Landmark ids whose leaf `render` / `notFound` deliberately throw, so the
 *  engine's containment of BLOCK-BUILDING failures is exercised rather than
 *  assumed (`load` failing was already covered). */
const THROWING_LANDMARK_ID = "m-throw";
const THROWING_MISSING_ID = "nope-throw";

/** City-list filter: a simple name-prefix search — enough to prove filter
 *  values + the drill path BOTH survive a deep `apply-filter` round trip. */
interface CityFilter {
	q?: string;
}

/**
 * This fixture's RENDER STATE — the screen-defined value a custom action hands
 * `showLeaf`/`showList`, modelled on the shape the production screens need (a
 * DA-3 stage/confirm/refuse cycle over one free-text field).
 *
 * `hostile` exists to prove the engine treats the value as OPAQUE: its `note` is a
 * getter that throws, so the only place it can blow up is the leaf's own `render`,
 * where the engine's containment already is.
 */
export type GeoRenderState =
	| { kind: "note"; stage: "collect" | "confirm"; note: string }
	| { kind: "list-note"; note: string }
	| { kind: "hostile"; note: string };

/** An in-memory fake whose "service cursors" are transparent offsets so tests
 *  can assert exact paging. No IO — the scaffold engine is what's under test. */
export class FakeGeoClient {
	#pageOf<T extends { id: string }>(
		all: T[],
		limit: number,
		cursor: string | undefined,
	): { items: T[]; nextCursor: string | null } {
		const start = cursor === undefined ? 0 : Number(cursor);
		const items = all.slice(start, start + limit);
		const next = start + limit;
		return { items, nextCursor: next < all.length ? String(next) : null };
	}
	listCountries(limit: number, cursor?: string) {
		return this.#pageOf(COUNTRIES, limit, cursor);
	}
	listCities(countryId: string, filter: CityFilter, limit: number, cursor?: string) {
		const all = (CITIES[countryId] ?? []).filter(
			(c) => filter.q === undefined || c.name.startsWith(filter.q),
		);
		return this.#pageOf(all, limit, cursor);
	}
	getLandmark(id: string): GeoLandmark | null {
		if (id === LANDMARK.id) return LANDMARK;
		// Resolves so the leaf's `render` is REACHED and can throw (the containment
		// probe); every other id is a genuine miss.
		return id === THROWING_LANDMARK_ID ? { id, name: "Boom" } : null;
	}
}

export const GEO_ACTIONS = screenActions("geo");
export const GEO_ACTION_PING = GEO_ACTIONS.custom("ping");
/** Reads its whole context out of the form's `block_id` — no visible field
 *  carries anything (the increment-2 carrier shape). */
export const GEO_ACTION_TAG = GEO_ACTIONS.custom("tag");
/** Throws from its own body: the probe for custom-action throw containment. */
export const GEO_ACTION_BOOM = GEO_ACTIONS.custom("boom");
/** DA-3 state 1 → 2: re-render the leaf with the typed note staged for confirm. */
export const GEO_ACTION_STAGE = GEO_ACTIONS.custom("stage");
/** A DA-3a refusal: a notice AND state 1 with the operator's input preserved. */
export const GEO_ACTION_REFUSE = GEO_ACTIONS.custom("refuse");
/** Passes a render state whose own property access throws (containment probe). */
export const GEO_ACTION_HOSTILE_STATE = GEO_ACTIONS.custom("hostile-state");
/** The list-level counterpart: render state through `showList`. */
export const GEO_ACTION_LIST_STAGE = GEO_ACTIONS.custom("list-stage");

/** Deep drills encode the FULL target path into the option value — the
 *  documented `parseOpen` pattern (the interaction is stateless). */
function targetOption(path: string[], label: string) {
	return { value: encodePath(path), label };
}

function openForm(
	actionId: string,
	label: string,
	options: Array<{ value: string; label: string }>,
) {
	return {
		type: "form" as const,
		fields: [{ type: "select" as const, action_id: "target", label, options }],
		submit: { label: "Open", action_id: actionId },
	};
}

/**
 * The DA-3 group a leaf renders when it was handed render state: the SAME form
 * remounted with the operator's own input as `initial_value`, plus a confirm
 * control in the `confirm` stage only.
 *
 * Both halves of the force-open (B-6): the key CHANGES with the stage so the group
 * remounts, and the remount is what re-reads `default_open`. The form itself goes
 * through `carriedForm`, so its own key tracks the prefilled note — the channel has
 * to COMPOSE with the prefill digest, since a re-render whose new `initial_value`
 * the operator cannot see would defeat the point of carrying the state at all.
 */
function stagedNoteGroup(id: string, staged: GeoRenderState & { kind: "note" }): AccordionBlock {
	const confirming = staged.stage === "confirm";
	const body: Block[] = [
		carriedForm({
			namespace: "geo:note-form",
			context: { landmarkId: id },
			form: {
				type: "form",
				fields: [
					{ type: "text_input", action_id: "note", label: "Note", initial_value: staged.note },
				],
				submit: { label: "Review note", action_id: GEO_ACTION_STAGE },
			},
		}),
	];
	if (confirming) {
		body.push({
			type: "actions",
			block_id: `geo:${id}:note-confirm`,
			elements: [{ type: "button", action_id: GEO_ACTION_PING, label: "Confirm note" }],
		});
	}
	return {
		type: "accordion",
		block_id: `geo:${id}:note:${confirming ? "review" : "redo"}`,
		label: "Note",
		default_open: true,
		blocks: body,
	};
}

/** The staging pair (`stage`/`refuse`): both re-render the leaf the interaction
 *  came from with the typed note in render state; the refusal adds the notice, and
 *  renders state 1 rather than state 2. */
function noteStageAction(
	stage: "collect" | "confirm",
	notice?: Notice,
): CustomActionFn<unknown, GeoRenderState> {
	return customAction<FakeGeoClient, GeoRenderState>(
		({ input, carriedPath, showLeaf, showList }) => {
			const payload = asRecord(input.value);
			const encoded = readString(payload?.path);
			const decoded = encoded === undefined ? null : decodePath(encoded);
			const path: NavPath = decoded ?? carriedPath ?? [];
			const note = readString(payload?.note) ?? readString(input.values?.note) ?? "";
			// Nothing to re-render a leaf at ⇒ the list, with the notice only (DA-3b's
			// "never a silent redirect" is the screen's business, not the channel's).
			if (path.length === 0) return showList(undefined, notice);
			return showLeaf(path, notice, { kind: "note", stage, note });
		},
	);
}

export function createGeoScreenHandler() {
	const client = new FakeGeoClient();
	// The screen NAMES its render-state type: this call site is the one place the
	// levels and the custom actions meet, so a disagreement between them is an
	// error here rather than a value arriving somewhere that cannot use it.
	return createListDetailHandler<GeoRenderState>({
		actions: GEO_ACTIONS,
		createClient: () => client,
		parseOpen(input) {
			const encoded = readString(input.values?.target);
			const targetPath = encoded === undefined ? null : decodePath(encoded);
			return targetPath === null ? undefined : { targetPath };
		},
		levels: [
			// level 0 — countries (unfiltered root list). Renders the notice and the
			// render state a LIST-scoped custom action can hand it (`showList`); both
			// are undefined on every open/back/page/apply-filter render, so this level's
			// output is unchanged whenever no custom action is involved.
			listLevel<FakeGeoClient, Record<string, never>, GeoCountry, GeoRenderState>({
				limit: 2,
				filterFromValues: () => ({}),
				fetchPage: (c, _path, _filter, opts) =>
					Promise.resolve(c.listCountries(opts.limit, opts.cursor)),
				render: ({ actions, items, nextToken, notice, renderState }) => {
					const blocks: Block[] = [
						{ type: "header", text: "Countries" },
						{
							type: "table",
							columns: [{ key: "id", label: "id" }],
							rows: items.map((x) => ({ id: x.id })),
							page_action_id: actions.page,
							...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
						},
						{
							type: "form",
							fields: [],
							submit: { label: "Apply", action_id: actions.applyFilter },
						},
						openForm(
							actions.open,
							"Open country",
							items.map((x) => targetOption([x.id], x.name)),
						),
					];
					if (notice !== undefined) blocks.push(noticeBanner(notice));
					if (renderState?.kind === "list-note") {
						blocks.push({ type: "context", text: `staged: ${renderState.note}` });
					}
					return blocks;
				},
				onError: () =>
					failClosedResponse({ header: "Countries", title: "down", description: "down" }),
			}),
			// level 1 — cities of the country at path[0], with a q-prefix filter.
			// NOTE: the filter form below deliberately does NOT add a path carrier —
			// proving the engine's auto-injection makes deep apply-filter work
			// without the screen author remembering anything.
			listLevel<FakeGeoClient, CityFilter, GeoCity>({
				limit: 2,
				filterFromValues: (values) => {
					const q = readString(values.q);
					return q !== undefined && q.length > 0 ? { q } : {};
				},
				fetchPage: (c, path, filter, opts) =>
					Promise.resolve(c.listCities(path[0] ?? "", filter, opts.limit, opts.cursor)),
				render: ({ actions, path, filter, items, nextToken }) => {
					const carriedPath = { [PATH_FIELD]: encodePath(path) };
					const filterForm = (label: string): FormBlock => ({
						type: "form",
						fields: [
							{
								type: "text_input",
								action_id: "q",
								label: "Name starts with",
								...(filter.q !== undefined ? { initial_value: filter.q } : {}),
							},
						],
						submit: { label, action_id: actions.applyFilter },
					});
					const blocks: Block[] = [
						{ type: "header", text: `Cities of ${path[0] ?? "?"}` },
						backButton(actions.back, "← Back to countries", path),
						filterForm("Apply"),
						// A SECOND filter form that carries its drill path INVISIBLY in
						// `block_id` — the engine must recognise the carry and skip
						// injecting the visible "Scope" select into this one.
						carriedForm({
							namespace: "geo:city-filter",
							context: carriedPath,
							form: filterForm("Apply (carried)"),
						}),
						// A THIRD filter form, COLLAPSED behind `filterPanel` and carrying
						// nothing — the engine's path-carry guarantee has to reach inside
						// the accordion, or collapsing a deep filter would silently
						// re-filter the root list.
						filterPanel({
							// Through `carriedForm` because this form PREFILLS `q` — collapsed
							// in an accordion it would otherwise be index-0-forever, so a
							// cleared filter would leave the old value on screen. `filterPanel`
							// enforces that rather than trusting the author (it throws), which
							// is why the carrier here has no `__path`: the digest satisfies the
							// prefill rule while the engine still injects the visible path
							// field, as the accordion-recursion test asserts.
							form: carriedForm({
								namespace: "geo:city-filter-collapsed",
								form: filterForm("Apply (collapsed)"),
							}),
							blockId: "geo:city-filters",
							label: "Filters",
							activeFilters: [filter.q !== undefined && `name: ${filter.q}`],
							inlineUpTo: 0,
						}),
						// A FOURTH and FIFTH, nested in the other two container kinds — the
						// traversal has to reach every one of them, not just `accordion`.
						{
							type: "columns",
							columns: [[filterForm("Apply (column)")], [{ type: "context", text: "spacer" }]],
						},
						{
							type: "tab",
							panels: [
								{
									label: "Nested",
									// Two deep: a tab panel holding an accordion holding the form.
									blocks: [
										{
											type: "accordion",
											label: "Deeper",
											blocks: [filterForm("Apply (tab)")],
										},
									],
								},
							],
						},
						{
							type: "table",
							// A table's `block_id` is echoed back on its own block_actions
							// (sort / load-more), so it states which level it belongs to.
							block_id: encodeCarrier("geo:city-table", carriedPath),
							columns: [{ key: "id", label: "id" }],
							rows: items.map((x) => ({ id: x.id })),
							page_action_id: actions.page,
							...(nextToken !== undefined ? { next_cursor: nextToken } : {}),
						},
						openForm(
							actions.open,
							"Open city",
							items.map((x) => targetOption([...path, x.id], x.name)),
						),
					];
					return blocks;
				},
				onError: () => failClosedResponse({ header: "Cities", title: "down", description: "down" }),
			}),
			// level 2 — a landmark leaf
			leafLevel<FakeGeoClient, GeoLandmark, GeoRenderState>({
				load: (c, _path, id) => Promise.resolve(c.getLandmark(id)),
				render: ({ actions, path, detail, notice, renderState }) => {
					// A leaf `render` is BLOCK-BUILDING screen code, and block builders
					// throw (a rejected carrier namespace, a filter form over its field
					// budget). The engine must contain that: an escaping throw is a non-2xx,
					// which replaces the whole tree with a raw status panel — worst of all
					// right after a side effect applied, since the operator cannot then tell
					// whether it did. `m-throw` is the probe for the render path.
					if (detail.id === THROWING_LANDMARK_ID) {
						throw new Error("geo fixture: leaf render blew up");
					}
					const blocks: Block[] = [
						{ type: "header", text: `Landmark ${detail.id}` },
						backButton(actions.back, "← Back to cities", path),
					];
					if (notice !== undefined) blocks.push(noticeBanner(notice));
					// The RENDER-STATE channel: which group to open and what to prefill,
					// decided by the custom action that re-rendered this leaf.
					if (renderState?.kind === "hostile") {
						// Reading `.note` THROWS by construction. The engine never touched
						// this value, so a screen's own `render` is the only place a hostile
						// one can blow up — and that is inside this level's containment.
						blocks.push({ type: "context", text: renderState.note });
					}
					if (renderState?.kind === "note") blocks.push(stagedNoteGroup(detail.id, renderState));
					return blocks;
				},
				notFound: ({ actions, path, id }) => {
					// ...and so is `notFound` — same containment requirement.
					if (id === THROWING_MISSING_ID) throw new Error("geo fixture: notFound blew up");
					return [
						{ type: "header", text: "Not found" },
						backButton(actions.back, "← Back", path),
						{ type: "banner", variant: "error", title: "Not found", description: id },
					];
				},
				onError: () =>
					failClosedResponse({ header: "Landmark", title: "down", description: "down" }),
			}),
		],
		customActions: {
			// A side-effect stand-in: re-render the leaf at the carried path with a
			// non-error notice (the transition/add-note re-render shape).
			[GEO_ACTION_PING]: customAction<FakeGeoClient>(({ input, showLeaf }) => {
				const encoded = readString(
					input.value !== null && typeof input.value === "object"
						? (input.value as Record<string, unknown>).path
						: undefined,
				);
				const path: NavPath = (encoded === undefined ? null : decodePath(encoded)) ?? [];
				return showLeaf(path, {
					variant: "default",
					title: "Pinged",
					description: "side effect ran",
				});
			}),
			// The carrier counterpart of `ping`: BOTH the target level and the
			// payload come out of the form's `block_id`, so the form shows the
			// operator no plumbing field at all. A missing/hostile carrier degrades
			// to the root list rather than throwing.
			[GEO_ACTION_TAG]: customAction<FakeGeoClient>(
				({ carried, carriedPath, showLeaf, showList }) => {
					// `carriedPath` is the sanctioned way to learn the drill level: the
					// engine recovers it (from `value.__path`, `values.__path`, or the
					// carrier) and STRIPS the reserved keys from `carried`, so a screen
					// never reads `__path`/`__v` itself.
					const path = carriedPath ?? [];
					if (path.length === 0) return showList();
					return showLeaf(path, {
						variant: "default",
						title: "Tagged",
						// Proves the reserved keys are gone: only the screen's own fields
						// are here, so this is what an operator-visible notice can echo.
						description: `${carried?.label ?? "none"} (${Object.keys(carried ?? {}).join(",")})`,
					});
				},
			),
			// A custom action whose OWN BODY throws AFTER its side effect would have
			// applied — the money-path shape (a refund commits, then rebuilding the
			// detail throws). The engine must not let this become a non-2xx.
			//
			// NOTE it is still declared WITHOUT a render-state type, like `ping` and
			// `tag` above: a stateless custom action in a screen that has render state
			// is written exactly as it was before the channel existed.
			[GEO_ACTION_BOOM]: customAction<FakeGeoClient>(() => {
				throw new Error("geo fixture: custom action blew up after its side effect");
			}),
			// DA-3 state 1 → 2: stage what the operator typed, write nothing.
			[GEO_ACTION_STAGE]: noteStageAction("confirm"),
			// DA-3a: a refusal re-renders STATE 1 — the notice says what happened, the
			// render state keeps the group open and the operator's input in the form.
			[GEO_ACTION_REFUSE]: noteStageAction("collect", {
				variant: "error",
				title: "Refused",
				description: "Nothing was changed — the record moved under you.",
			}),
			// A render state whose own property access throws: the engine must forward
			// it without inspecting it, and the leaf's containment must catch the read.
			[GEO_ACTION_HOSTILE_STATE]: customAction<FakeGeoClient, GeoRenderState>(
				({ input, showLeaf }) => {
					const encoded = readString(asRecord(input.value)?.path);
					const path: NavPath = (encoded === undefined ? null : decodePath(encoded)) ?? [];
					return showLeaf(path, undefined, {
						kind: "hostile",
						get note(): string {
							throw new Error("geo fixture: hostile render state read");
						},
					});
				},
			),
			// The LIST-level counterpart: state (and a notice) through `showList`.
			[GEO_ACTION_LIST_STAGE]: customAction<FakeGeoClient, GeoRenderState>(
				({ input, showList }) => {
					const note = readString(asRecord(input.value)?.note) ?? "";
					return showList(
						undefined,
						{ variant: "default", title: "Staged", description: note },
						{ kind: "list-note", note },
					);
				},
			),
		},
	});
}

/** The fixture plugin the harness boots (route key `admin`, same as production).
 *  `as never` per `plugin.ts`'s registration convention (RouteHandler input
 *  contravariance vs the untyped `RouteEntry` record). */
export const geoScaffoldPlugin: SandboxedPlugin = {
	routes: { admin: createGeoScreenHandler() as never },
};
