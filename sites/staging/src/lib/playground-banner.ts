/**
 * The one sentence the playground adds to every HTML page, and the GitHub
 * star prompt (`playground-star.ts`), which goes at the end of the body.
 *
 * The sentence is specific about what this sandbox is and what it is not:
 * Otta is installed and the sample products can be bought as far as the
 * cart, and card payments are not connected. It does not mention
 * pay-per-crawl, MCP or x402 — none of those ship.
 */
import { starPrompt } from "./playground-star.js";

const MARKER = "otta-playground-note";

const BANNER = `<div class="${MARKER}" role="note"><p><strong>Otta playground.</strong> This is your own copy of the store for about an hour: EmDash, with the Otta commerce plugin installed, and the sample products priced and in stock. Card payments are not connected, so checkout will not charge a card. <a href="/products">Shop</a> · <a href="/_emdash/admin">Admin</a></p></div><style>.${MARKER}{position:sticky;top:0;z-index:10000;background:#14120b;color:#f4f0e6;font:14px/1.45 ui-sans-serif,system-ui,sans-serif;padding:10px 16px}html{scroll-padding-top:8rem}.otta-playground-note p{margin:0}.otta-playground-note a{color:#ffd59a}</style>`;

export async function injectPlaygroundBanner(response: Response): Promise<Response> {
	const type = response.headers.get("content-type") ?? "";
	if (!type.includes("text/html")) return response;
	const html = await response.text();
	if (html.includes(MARKER)) return new Response(html, response);
	const injected = injectBanner(html);
	return new Response(injected, response);
}

export function injectBanner(html: string): string {
	if (html.includes(MARKER)) return html;
	const opened = /<body[^>]*>/i.exec(html);
	const withNote =
		opened === null
			? BANNER + html
			: html.slice(0, opened.index + opened[0].length) +
				BANNER +
				html.slice(opened.index + opened[0].length);
	// The prompt is fixed-position, so it goes last: opening the body with it would put its
	// links ahead of the theme's skip link in the tab order.
	// Found on the original string: lowercasing can change its length ("İ"), and with it the cut.
	const closed = [...withNote.matchAll(/<\/body\s*>/gi)].at(-1)?.index;
	return closed === undefined
		? withNote + starPrompt()
		: withNote.slice(0, closed) + starPrompt() + withNote.slice(closed);
}

export function playgroundInterstitial(refreshPath: string): Response {
	const href = escapeHtml(refreshPath);
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<meta http-equiv="refresh" content="1;url=${href}" />
<title>Otta playground</title>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#14120b;color:#f4f0e6;font:16px/1.5 ui-sans-serif,system-ui,sans-serif">
<main style="max-width:28rem;padding:24px">
<h1 style="font-size:1.4rem;font-weight:650;letter-spacing:-0.02em">Setting up your Otta store</h1>
<p>Installing the sample products and giving each one a price and stock. This takes a moment.</p>
<p><a style="color:#ffd59a" href="${href}">Continue</a></p>
</main>
</body>
</html>`;
	return htmlResponse(html);
}

export function playgroundStuck(message: string): Response {
	const text = escapeHtml(message);
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<title>Otta playground</title>
</head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#14120b;color:#f4f0e6;font:16px/1.5 ui-sans-serif,system-ui,sans-serif">
<main style="max-width:32rem;padding:24px">
<h1 style="font-size:1.4rem;font-weight:650;letter-spacing:-0.02em">The store is up, the prices are not</h1>
<p>${text}</p>
<p><a style="color:#ffd59a" href="/products">Open the shop</a> · <a style="color:#ffd59a" href="/_emdash/admin">Open the admin</a></p>
</main>
</body>
</html>`;
	return htmlResponse(html);
}

function htmlResponse(html: string): Response {
	return new Response(html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-robots-tag": "noindex",
		},
	});
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}
