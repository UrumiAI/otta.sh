// Astro live-content wiring for EmDash (required: getEmDashCollection /
// getEmDashEntry ride astro:content's live loader) — verbatim from
// em-dash's templates/starter-cloudflare/src/live.config.ts.
import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export const collections = {
	_emdash: defineLiveCollection({ loader: emdashLoader() }),
};
