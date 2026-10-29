import { describe, expect, test } from "vitest";
import { injectBanner } from "../src/lib/playground-banner.js";
import { REPO_URL, formatStars, starPrompt } from "../src/lib/playground-star.js";

describe("starPrompt", () => {
	test("links the repo and shows the count", () => {
		const html = starPrompt(57);
		expect(html).toContain(`href="${REPO_URL}"`);
		expect(html).toContain("(57 stars)");
		expect(html).toContain('data-state="pill"');
	});

	test("drops the count when GitHub gave none", () => {
		const html = starPrompt(null);
		expect(html).not.toContain("stars)");
		expect(html).toContain(">Star</a>");
	});

	test("abbreviates thousands", () => {
		expect(formatStars(57)).toBe("57");
		expect(formatStars(999)).toBe("999");
		expect(formatStars(1000)).toBe("1k");
		expect(formatStars(1249)).toBe("1.2k");
		expect(formatStars(12_960)).toBe("12.9k");
	});
});

describe("injectBanner with the star prompt", () => {
	test("adds the prompt once, after the note", () => {
		const once = injectBanner("<html><body><p>Hi</p></body></html>", 57);
		expect(once.indexOf("otta-playground-note")).toBeLessThan(once.indexOf('class="otta-star"'));
		expect(injectBanner(once, 57)).toBe(once);
		expect(once.match(/class="otta-star"/g)).toHaveLength(1);
	});
});
