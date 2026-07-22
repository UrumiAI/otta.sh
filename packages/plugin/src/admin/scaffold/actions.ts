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

export function screenActions(entity: string): ScreenActions {
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
