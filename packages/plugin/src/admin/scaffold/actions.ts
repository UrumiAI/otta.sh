/**
 * Action-id namespacing for a list/detail screen.
 *
 * EmDash resolves every admin interaction through the SINGLE `admin` route and
 * dispatches on `action_id` (see `admin-route.ts`). Each screen therefore
 * namespaces its actions `<entity>:<verb>` so none collides across screens and
 * none falls through the dispatcher to the `{blocks:[]}` dead-end. The four
 * NAV verbs below are the ones the scaffold itself wires; a screen adds its own
 * side-effecting verbs (e.g. `transition`, `add-note`) via {@link ScreenActions.custom}.
 */

/** The navigation verbs the scaffold dispatches on for every screen. */
export const NAV_VERBS = ["open", "back", "page", "apply-filter"] as const;

export interface ScreenActions {
	readonly entity: string;
	/** `<entity>:open` — a list row drills into the next level. */
	readonly open: string;
	/** `<entity>:back` — pop one level toward the root. */
	readonly back: string;
	/** `<entity>:page` — the table's keyset "Load more". */
	readonly page: string;
	/** `<entity>:apply-filter` — re-list the current level with a new filter. */
	readonly applyFilter: string;
	/** Namespace a screen-specific verb, e.g. `custom("transition")`. */
	custom(verb: string): string;
	/** The full `ReadonlySet` of this screen's action ids (the four nav verbs
	 *  plus any custom verbs), for registration in the admin-route dispatcher. */
	actionIds(...customVerbs: string[]): ReadonlySet<string>;
}

/**
 * The module-level registry of claimed entity namespaces. Two screens claiming
 * the same entity would emit IDENTICAL action ids — and because the admin-route
 * dispatcher routes purely on `action_id`, whichever screen registered first
 * would SILENTLY receive the other's interactions. Registration happens at
 * module load (each screen calls `screenActions` once at top level), so a
 * duplicate is a build-time authoring error, not a runtime condition — fail
 * loudly at import instead of mis-dispatching quietly forever.
 */
const CLAIMED_ENTITIES = new Set<string>();

export function screenActions(entity: string): ScreenActions {
	if (CLAIMED_ENTITIES.has(entity)) {
		throw new Error(
			`screenActions("${entity}"): entity namespace already claimed by another screen — ` +
				"duplicate action ids would silently mis-dispatch in the admin route.",
		);
	}
	CLAIMED_ENTITIES.add(entity);
	const id = (verb: string) => `${entity}:${verb}`;
	return {
		entity,
		open: id("open"),
		back: id("back"),
		page: id("page"),
		applyFilter: id("apply-filter"),
		custom: id,
		actionIds(...customVerbs: string[]): ReadonlySet<string> {
			return new Set([...NAV_VERBS.map(id), ...customVerbs.map(id)]);
		},
	};
}
