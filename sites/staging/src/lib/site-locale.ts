/**
 * The storefront's one locale — the language `<html lang>` declares
 * (every theme's `themes/<id>/Layout.astro`), the checkout summary formats money in, and the
 * delivery country picker names countries in. One constant so they cannot
 * drift apart. The site negotiates no per-request locale yet; when it does,
 * this is the value to replace. Canonical form (see `site-locale.test.ts`), so
 * the plugin's `sanitizeLocale` passes it through unchanged.
 */
export const SITE_LOCALE = "en";
