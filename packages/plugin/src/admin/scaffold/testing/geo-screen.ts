import type { Block, SandboxedPlugin } from "../../../types.js";
import { screenActions } from "../actions.js";
import { failClosedResponse, noticeBanner } from "../banner.js";
import {
	createListDetailHandler,
	customAction,
	leafLevel,
	listLevel,
	readString,
} from "../list-detail.js";
import { backButton, decodePath, encodePath, type NavPath } from "../nav.js";

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

/** City-list filter: a simple name-prefix search — enough to prove filter
 *  values + the drill path BOTH survive a deep `apply-filter` round trip. */
interface CityFilter {
	q?: string;
}

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
		return id === LANDMARK.id ? LANDMARK : null;
	}
}

export const GEO_ACTIONS = screenActions("geo");
export const GEO_ACTION_PING = GEO_ACTIONS.custom("ping");

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

export function createGeoScreenHandler() {
	const client = new FakeGeoClient();
	return createListDetailHandler({
		actions: GEO_ACTIONS,
		createClient: () => client,
		parseOpen(input) {
			const encoded = readString(input.values?.target);
			const targetPath = encoded === undefined ? null : decodePath(encoded);
			return targetPath === null ? undefined : { targetPath };
		},
		levels: [
			// level 0 — countries (unfiltered root list)
			listLevel<FakeGeoClient, Record<string, never>, GeoCountry>({
				limit: 2,
				filterFromValues: () => ({}),
				fetchPage: (c, _path, _filter, opts) =>
					Promise.resolve(c.listCountries(opts.limit, opts.cursor)),
				render: ({ actions, items, nextToken }) => {
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
					const blocks: Block[] = [
						{ type: "header", text: `Cities of ${path[0] ?? "?"}` },
						backButton(actions.back, "← Back to countries", path),
						{
							type: "form",
							fields: [
								{
									type: "text_input",
									action_id: "q",
									label: "Name starts with",
									...(filter.q !== undefined ? { initial_value: filter.q } : {}),
								},
							],
							submit: { label: "Apply", action_id: actions.applyFilter },
						},
						{
							type: "table",
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
			leafLevel<FakeGeoClient, GeoLandmark>({
				load: (c, _path, id) => Promise.resolve(c.getLandmark(id)),
				render: ({ actions, path, detail, notice }) => {
					const blocks: Block[] = [
						{ type: "header", text: `Landmark ${detail.id}` },
						backButton(actions.back, "← Back to cities", path),
					];
					if (notice !== undefined) blocks.push(noticeBanner(notice));
					return blocks;
				},
				notFound: ({ actions, path, id }) => [
					{ type: "header", text: "Not found" },
					backButton(actions.back, "← Back", path),
					{ type: "banner", variant: "error", title: "Not found", description: id },
				],
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
		},
	});
}

/** The fixture plugin the harness boots (route key `admin`, same as production).
 *  `as never` per `plugin.ts`'s registration convention (RouteHandler input
 *  contravariance vs the untyped `RouteEntry` record). */
export const geoScaffoldPlugin: SandboxedPlugin = {
	routes: { admin: createGeoScreenHandler() as never },
};
