/**
 * The GitHub star prompt the playground adds next to its note.
 *
 * A small otter peeks over a card in the corner a moment after the first
 * page loads; dismissing it leaves a quiet pill with the star count. The
 * choice is remembered in localStorage, so later pages open on the pill.
 * Without script the pill alone shows.
 *
 * The count is fetched by the Worker, not the browser: the admin's CSP is
 * `connect-src 'self'`, so a client-side call to api.github.com is refused.
 */
export const STAR_MARKER = "otta-star";

export const REPO_URL = "https://github.com/UrumiAI/otta.sh";
const REPO_API = "https://api.github.com/repos/UrumiAI/otta.sh";
const FRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1500;

let cached: { stars: number | null; until: number } | null = null;

/** Null when GitHub is slow, rate-limited or down; the prompt then shows no count. */
export async function githubStars(now = Date.now()): Promise<number | null> {
	if (cached !== null && cached.until > now) return cached.stars;
	let stars: number | null = null;
	try {
		const response = await fetch(REPO_API, {
			headers: { accept: "application/vnd.github+json", "user-agent": "otta-playground" },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (response.ok) {
			const body: unknown = await response.json();
			const count =
				typeof body === "object" && body !== null
					? (body as { stargazers_count?: unknown }).stargazers_count
					: undefined;
			if (typeof count === "number" && Number.isFinite(count) && count >= 0) stars = count;
		}
	} catch {
		// Timeout or network failure: fall through to the retry window.
	}
	cached = { stars, until: now + (stars === null ? RETRY_MS : FRESH_MS) };
	return stars;
}

export function formatStars(stars: number): string {
	if (stars < 1000) return String(stars);
	const k = Math.floor(stars / 100) / 10;
	return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`;
}

const GITHUB_MARK = `<svg class="${STAR_MARKER}-gh" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

const STAR_ICON = `<svg class="${STAR_MARKER}-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l1.95 3.95 4.36.63-3.15 3.08.74 4.34L8 11.55 4.1 13.6l.74-4.34L1.69 6.18l4.36-.63z"/></svg>`;

const OTTER = `<svg class="${STAR_MARKER}-otter" viewBox="0 0 56 46" aria-hidden="true">
<ellipse cx="11.5" cy="17" rx="3.4" ry="3" fill="#7a4e33"/><ellipse cx="44.5" cy="17" rx="3.4" ry="3" fill="#7a4e33"/>
<ellipse cx="28" cy="26" rx="19.5" ry="15.5" fill="#8a5a3b"/>
<ellipse cx="28" cy="31" rx="12.5" ry="8.5" fill="#ecd3ae"/>
<g class="${STAR_MARKER}-eyes" fill="#14120b"><circle cx="20" cy="23" r="2.2"/><circle cx="36" cy="23" r="2.2"/></g>
<circle cx="20.8" cy="22.2" r=".7" fill="#fff"/><circle cx="36.8" cy="22.2" r=".7" fill="#fff"/>
<ellipse cx="28" cy="27.6" rx="3.2" ry="2.1" fill="#14120b"/>
<path d="M25 31q1.5 1.6 3 0q1.5 1.6 3 0" fill="none" stroke="#14120b" stroke-width="1.1" stroke-linecap="round"/>
<g stroke="#f4f0e6" stroke-width=".8" stroke-linecap="round" opacity=".75"><path d="M19 30.5l-8-1.5M19 32.5l-7.5 1.5M37 30.5l8-1.5M37 32.5l7.5 1.5"/></g>
<ellipse cx="15" cy="29.5" rx="2.4" ry="1.5" fill="#e9a08a" opacity=".5"/><ellipse cx="41" cy="29.5" rx="2.4" ry="1.5" fill="#e9a08a" opacity=".5"/>
<ellipse cx="17" cy="43" rx="5.5" ry="3.6" fill="#7a4e33"/><ellipse cx="39" cy="43" rx="5.5" ry="3.6" fill="#7a4e33"/>
</svg>`;

const CLOSE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

const M = STAR_MARKER;

const STYLE = `<style>
.${M}{--s-bg:#1c1a12;--s-ink:#f4f0e6;--s-mute:rgba(244,240,230,.7);--s-line:rgba(244,240,230,.12);--s-accent:#ffd59a;--s-ease:cubic-bezier(.16,1,.3,1);position:fixed;right:20px;bottom:20px;z-index:9999;font:14px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--s-ink);-webkit-font-smoothing:antialiased}
.${M} *{box-sizing:border-box}
.${M} svg{display:block}
.${M} a,.${M} button{font:inherit;color:inherit;-webkit-tap-highlight-color:transparent}
.${M} :focus-visible{outline:2px solid var(--s-accent);outline-offset:2px}
.${M}-card{position:relative;width:min(304px,calc(100vw - 32px));padding:16px 16px 14px;background:var(--s-bg);border:1px solid var(--s-line);border-radius:16px;box-shadow:0 1px 2px rgba(0,0,0,.25),0 12px 32px -8px rgba(0,0,0,.45);transform-origin:85% 100%}
.${M}-peek{position:absolute;left:18px;bottom:calc(100% - 7px);width:56px;height:46px;overflow:hidden;pointer-events:none}
.${M}-otter{width:56px;height:46px}
.${M}-title{margin:0 28px 2px 0;font-weight:600;letter-spacing:-.01em}
.${M}-body{margin:0 0 14px;color:var(--s-mute);text-wrap:pretty}
.${M}-row{display:flex;align-items:center;gap:10px;white-space:nowrap}
.${M}-cta{display:inline-flex;align-items:stretch;height:34px;border-radius:999px;background:var(--s-ink);color:#14120b !important;text-decoration:none;font-weight:600;overflow:hidden;transition:transform .2s var(--s-ease),box-shadow .2s var(--s-ease)}
.${M}-cta:hover{transform:translateY(-1px);box-shadow:0 6px 16px -6px rgba(255,213,154,.5)}
.${M}-cta:active{transform:translateY(0) scale(.98)}
.${M}-cta-label{display:inline-flex;align-items:center;gap:7px;padding:0 12px 0 11px}
.${M}-cta-count{display:inline-flex;align-items:center;gap:5px;padding:0 12px 0 10px;border-left:1px solid rgba(20,18,11,.14);font-variant-numeric:tabular-nums}
.${M}-gh{width:16px;height:16px}
.${M}-icon{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.4;stroke-linejoin:round;transition:transform .35s var(--s-ease),fill .2s}
.${M}-cta:hover .${M}-icon,.${M}-pill:hover .${M}-icon{fill:#e0a23a;stroke:#e0a23a;transform:rotate(72deg) scale(1.12)}
.${M}-later{border:0;background:none;padding:6px 2px;color:var(--s-mute);cursor:pointer;border-radius:6px}
.${M}-later:hover{color:var(--s-ink)}
.${M}-close{position:absolute;top:10px;right:10px;width:26px;height:26px;display:grid;place-items:center;border:0;border-radius:999px;background:none;color:var(--s-mute);cursor:pointer;transition:background .15s,color .15s}
.${M}-close:hover{background:var(--s-line);color:var(--s-ink)}
.${M}-close svg{width:14px;height:14px}
.${M}-pill{white-space:nowrap;display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 13px 0 11px;border-radius:999px;background:var(--s-bg);border:1px solid var(--s-line);box-shadow:0 1px 2px rgba(0,0,0,.25),0 8px 20px -8px rgba(0,0,0,.45);text-decoration:none;font-weight:600;font-variant-numeric:tabular-nums;transition:transform .2s var(--s-ease),border-color .2s}
.${M}-pill:hover{transform:translateY(-1px);border-color:rgba(255,213,154,.4)}
.${M}-pill .${M}-icon{color:var(--s-accent)}
.${M}-pill .${M}-sep{width:1px;height:14px;background:var(--s-line)}
.${M}[data-state="pill"] .${M}-card,.${M}[data-state="card"] .${M}-pill,.${M}[data-state="hidden"]>*{display:none}
.${M}[data-state="card"] .${M}-card{animation:${M}-in .6s var(--s-ease) both}
.${M}[data-state="card"] .${M}-otter{animation:${M}-up .7s var(--s-ease) .28s both}
.${M}[data-state="pill"].${M}-fresh .${M}-pill{animation:${M}-in .45s var(--s-ease) both}
.${M}-eyes{transform-box:fill-box;transform-origin:center;animation:${M}-blink 5s 1.4s infinite}
@keyframes ${M}-in{from{opacity:0;transform:translateY(10px) scale(.97);filter:blur(4px)}}
@keyframes ${M}-up{from{transform:translateY(100%)}}
@keyframes ${M}-blink{0%,94%,100%{transform:none}96.5%{transform:scaleY(.1)}}
@media (max-width:480px){.${M}{right:16px;bottom:16px}}
@media (prefers-reduced-motion:reduce){.${M} *,.${M} *::before{animation:none !important;transition:none !important}}
@media print{.${M}{display:none}}
</style>`;

const SCRIPT = `<script>(function(){var r=document.currentScript&&document.currentScript.previousElementSibling;if(!r||!r.classList.contains("${M}"))return;var K="${M}:dismissed",d=false;try{d=localStorage.getItem(K)==="1"}catch(e){}if(d)return;r.dataset.state="hidden";var t=setTimeout(function(){r.dataset.state="card"},1800);function done(){clearTimeout(t);try{localStorage.setItem(K,"1")}catch(e){}r.classList.add("${M}-fresh");r.dataset.state="pill"}r.addEventListener("click",function(e){var x=e.target.closest("[data-${M}-dismiss],.${M}-cta");if(x)done()});r.addEventListener("keydown",function(e){if(e.key==="Escape"&&r.dataset.state==="card")done()})})();</script>`;

export function starPrompt(stars: number | null): string {
	const count =
		stars === null ? "" : `<span class="${M}-cta-count">${STAR_ICON}${formatStars(stars)}</span>`;
	const pillCount = stars === null ? "Star" : `<span class="${M}-sep"></span>${formatStars(stars)}`;
	const label = stars === null ? "" : ` (${stars} stars)`;
	return `<aside class="${M}" data-state="pill" aria-label="Otta on GitHub"><div class="${M}-card" role="dialog" aria-labelledby="${M}-title"><div class="${M}-peek">${OTTER}</div><button type="button" class="${M}-close" data-${M}-dismiss aria-label="Dismiss">${CLOSE_ICON}</button><p class="${M}-title" id="${M}-title">Otta is open source</p><p class="${M}-body">If the playground helped, a star on GitHub helps other builders find it.</p><div class="${M}-row"><a class="${M}-cta" href="${REPO_URL}" target="_blank" rel="noopener" aria-label="Star Otta on GitHub${label}"><span class="${M}-cta-label">${GITHUB_MARK}Star on GitHub</span>${count}</a><button type="button" class="${M}-later" data-${M}-dismiss>Not now</button></div></div><a class="${M}-pill" href="${REPO_URL}" target="_blank" rel="noopener" aria-label="Star Otta on GitHub${label}">${GITHUB_MARK}${STAR_ICON}${pillCount}</a></aside>${SCRIPT}${STYLE}`;
}
