import { afterEach, describe, expect, test, vi } from "vitest";
import { injectBanner } from "../src/lib/playground-banner.js";
import { REPO_URL, formatStars, starPrompt, starsResponse } from "../src/lib/playground-star.js";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("starPrompt", () => {
	test("links the repo, loads the script, and has no count of its own", () => {
		const html = starPrompt();
		expect(html).toContain(`href="${REPO_URL}"`);
		expect(html).toContain('rel="noopener noreferrer"');
		expect(html).toContain('<script src="/scripts/playground-star.js" defer></script>');
		expect(html).toContain('data-state="pill"');
		expect(html).not.toContain('role="dialog"');
		expect(html.indexOf("<style>")).toBeLessThan(html.indexOf("<aside"));
	});
});

describe("formatStars", () => {
	test("abbreviates thousands and millions", () => {
		expect(formatStars(57)).toBe("57");
		expect(formatStars(999)).toBe("999");
		expect(formatStars(1000)).toBe("1k");
		expect(formatStars(1249)).toBe("1.2k");
		expect(formatStars(12_960)).toBe("12.9k");
		expect(formatStars(999_999)).toBe("999.9k");
		expect(formatStars(1_000_000)).toBe("1m");
		expect(formatStars(2_450_000)).toBe("2.4m");
	});
});

const github = (body: unknown, status = 200) =>
	vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("starsResponse", () => {
	test("answers the count and label, cached by the browser", async () => {
		const fetchImpl = github({ stargazers_count: 1249 });
		const response = await starsResponse(fetchImpl);
		expect(await response.json()).toEqual({ stars: 1249, label: "1.2k" });
		expect(response.headers.get("cache-control")).toBe("public, max-age=600");
		const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
		expect(url).toBe("https://api.github.com/repos/UrumiAI/otta.sh");
		expect(init.cf).toEqual({
			cacheEverything: true,
			cacheTtlByStatus: { "200-299": 3600, "400-599": 600 },
		});
	});

	test.each([
		["a rate limit", github({ message: "API rate limit exceeded" }, 403)],
		["a body without a count", github({ full_name: "UrumiAI/otta.sh" })],
		["a negative count", github({ stargazers_count: -1 })],
		["a fractional count", github({ stargazers_count: 1.5 })],
		[
			"a network failure",
			vi.fn(async () => {
				throw new TypeError("network");
			}) as unknown as typeof fetch,
		],
	])("answers nulls on %s, briefly cached", async (_, fetchImpl) => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const response = await starsResponse(fetchImpl);
		expect(await response.json()).toEqual({ stars: null, label: null });
		expect(response.headers.get("cache-control")).toBe("public, max-age=60");
	});
});

describe("injectBanner with the star prompt", () => {
	test("adds the prompt once, after the note", () => {
		const once = injectBanner("<html><body><p>Hi</p></body></html>");
		expect(once.indexOf("otta-playground-note")).toBeLessThan(once.indexOf('class="otta-star"'));
		expect(injectBanner(once)).toBe(once);
		expect(once.match(/class="otta-star"/g)).toHaveLength(1);
	});
});
