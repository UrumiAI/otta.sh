// Astro live-content wiring for EmDash (required: getEmDashCollection /
// getEmDashEntry ride astro:content's live loader) — verbatim from
// em-dash's templates/starter-cloudflare/src/live.config.ts. Astro reads the
// SITE's `src/live.config.ts`, so a site re-exports this module from there
// (`export { collections } from "@urumi.ai/otta-store/live-config"`).
import { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export const collections = {
	_emdash: defineLiveCollection({ loader: emdashLoader() }),
};
