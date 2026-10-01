/**
 * Regenerate the admin Themes screen's preview images —
 * `public/theme-previews/<id>.webp`, one per theme in `src/themes/manifest.ts`.
 *
 * WHAT A PREVIEW IS. The store's real home page in that theme, over the seeded
 * demo catalogue, the way a signed-out shopper first sees it: light scheme, a
 * 1200×900 viewport (WordPress's own theme-screenshot size) at device scale 2,
 * captured after the web fonts have loaded and every entrance animation has
 * finished, then downsampled 2:1 to 1200×900 WebP. The 2× capture is what keeps
 * type and hairlines crisp at card size on a high-density screen; a 1× capture
 * upscaled by the browser is what makes theme pickers look soft. (A 1440-wide
 * capture was tried first: at card width it shrinks every theme's type to
 * illegibility and leaves the lower half of the sparser homes empty.)
 *
 * HOW. It drives a running DEV server (`pnpm dev`), because it picks each theme
 * with the dev-only `?theme=` override (`src/themes/resolve.ts`) — no setting
 * is written, so the store's active theme is untouched. A fresh browser context
 * per theme means no session cookie, so no EmDash toolbar and no admin preview.
 *
 *   pnpm dev                                   # in another shell
 *   SITE_URL=http://127.0.0.1:4321 pnpm dlx tsx@4 scripts/seed-demo-commerce.ts
 *   pnpm capture:theme-previews                # SITE_URL defaults to :4321
 *
 * LOOPBACK ONLY, like the other scripts here: a shell that has deployed may
 * export a SITE_URL pointing at production, and a production home page is not
 * the seeded demo the previews promise.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import sharp from "sharp";
import { STORE_THEMES } from "../src/themes/manifest.ts";

/** Captured viewport (CSS px) and density. */
const VIEWPORT = { width: 1200, height: 900 } as const;
const SCALE = 2;
/** Written size — what `test/theme-previews.test.ts` pins. */
const PREVIEW_SIZE = { width: 1200, height: 900 } as const;
/** WebP quality ladder: the first rung under the budget wins. */
const QUALITIES = [86, 82, 78, 74, 70] as const;
const BUDGET_BYTES = 150 * 1024;

const SITE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(SITE_DIR, "public", "theme-previews");

function siteUrl(): URL {
	const url = new URL(process.env.SITE_URL ?? "http://127.0.0.1:4321");
	if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
		throw new Error(`SITE_URL must be a loopback dev server, got ${url.origin}`);
	}
	return url;
}

async function encode(png: Buffer): Promise<{ webp: Buffer; quality: number }> {
	let last: { webp: Buffer; quality: number } | undefined;
	for (const quality of QUALITIES) {
		const webp = await sharp(png)
			.resize(PREVIEW_SIZE.width, PREVIEW_SIZE.height, { fit: "cover", kernel: "lanczos3" })
			.webp({ quality, effort: 6, smartSubsample: true })
			.toBuffer();
		last = { webp, quality };
		if (webp.byteLength <= BUDGET_BYTES) break;
	}
	if (last === undefined) throw new Error("no quality rung configured");
	return last;
}

async function main(): Promise<void> {
	const base = siteUrl();
	await mkdir(OUT_DIR, { recursive: true });
	const browser = await chromium.launch();
	try {
		for (const theme of STORE_THEMES) {
			const context = await browser.newContext({
				viewport: VIEWPORT,
				deviceScaleFactor: SCALE,
				colorScheme: "light",
			});
			const page = await context.newPage();
			const url = new URL("/", base);
			url.searchParams.set("theme", theme.id);
			const response = await page.goto(url.href, { waitUntil: "networkidle" });
			if (response === null || !response.ok()) {
				throw new Error(`${theme.id}: ${url.href} answered ${String(response?.status())}`);
			}
			const served = await page.getAttribute("html", "data-theme-id");
			if (served !== theme.id) {
				throw new Error(
					`${theme.id}: the page rendered "${String(served)}" — is this a DEV server? ` +
						"The ?theme= override is dev-only.",
				);
			}
			// Fonts, then every running animation (entrance motion), then the
			// decode of every image that is in view.
			await page.evaluate(async () => {
				await document.fonts.ready;
				await Promise.all(
					document
						.getAnimations()
						.filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
						.map((animation) => animation.finished.catch(() => undefined)),
				);
				await Promise.all(
					[...document.images].map((img) =>
						img.complete ? undefined : img.decode().catch(() => undefined),
					),
				);
			});
			await page.waitForTimeout(400);
			const png = await page.screenshot({ type: "png", animations: "disabled" });
			const { webp, quality } = await encode(png);
			const file = path.join(OUT_DIR, `${theme.id}.webp`);
			await writeFile(file, webp);
			console.log(
				`[otta] ${theme.id}: ${path.relative(SITE_DIR, file)} — ${String(Math.round(webp.byteLength / 1024))} KiB at q${String(quality)}`,
			);
			await context.close();
		}
	} finally {
		await browser.close();
	}
}

main().catch((error: unknown) => {
	console.error("[otta] capture-theme-previews failed:", error);
	process.exitCode = 1;
});
