/**
 * The storefront's one locale — the language `<html lang>` declares
 * (every theme's `themes/<id>/Layout.astro`), the checkout summary formats money in, and the
 * delivery country picker names countries in, and the account pages format money in. One constant so they cannot
 * drift apart. The site negotiates no per-request locale yet; when it does,
 * this is the value to replace. Canonical form (see `site-locale.test.ts`), so
 * the plugin's `sanitizeLocale` passes it through unchanged. It IS the plugin's
 * `STOREFRONT_LOCALE`, so the account pages and the order emails format money
 * in the same locale as every other page.
 */
import { STOREFRONT_LOCALE } from "@otta-sh/plugin";

export const SITE_LOCALE = STOREFRONT_LOCALE;
