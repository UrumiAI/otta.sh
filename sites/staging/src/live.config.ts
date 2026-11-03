// Astro reads live collections from the site's own src/live.config.ts, and
// hands the real defineLiveCollection only to this file; the EmDash wiring is
// the store's (sites/store/src/live-config.ts explains).
import { defineLiveCollection } from "astro:content";
import { ottaLiveCollections } from "@urumi.ai/otta-store/live-config";

export const collections = ottaLiveCollections(defineLiveCollection);
