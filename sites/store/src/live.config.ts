// Astro live-content wiring for EmDash (required: getEmDashCollection /
// getEmDashEntry ride astro:content's live loader), after em-dash's
// templates/starter-cloudflare/src/live.config.ts.
//
// Astro hands the real `defineLiveCollection` ONLY to the site's own
// `src/live.config.ts` (it compares the importer's path); any other module that
// imports it from "astro:content" gets a stub that throws, and the content
// runtime's top-level await on the live config never settles. So the site file
// imports it, and passes it in:
//
//   import { defineLiveCollection } from "astro:content";
//   import { ottaLiveCollections } from "@urumi.ai/otta-store/live-config";
//   export const collections = ottaLiveCollections(defineLiveCollection);
//
// THIS FILE'S NAME MATTERS TOO. The real `defineLiveCollection` reads its
// caller's file name off the stack and throws unless it contains "live.config":
// the call below is that caller. (A production build hid it, by inlining this
// module into a chunk named `live.config_*.mjs`; `astro dev` does not.)
import type { defineLiveCollection } from "astro:content";
import { emdashLoader } from "emdash/runtime";

export function ottaLiveCollections(define: typeof defineLiveCollection) {
	return {
		_emdash: define({ loader: emdashLoader() }),
	};
}
