/**
 * MediaPanel (docs/theme/TEMPERED.md §4, §5) — rendered for real through
 * Astro's Container API, so these are assertions about the markup a shopper's
 * browser receives, not about the source that produced it.
 */
import { experimental_AstroContainer as AstroContainer } from "astro/container";
import { beforeAll, describe, expect, test } from "vitest";
import MediaPanel from "../src/components/MediaPanel.astro";

let container: AstroContainer;

beforeAll(async () => {
	container = await AstroContainer.create();
});

const render = (props: Record<string, unknown>): Promise<string> =>
	container.renderToString(MediaPanel, { props });

describe("MediaPanel — the coil", () => {
	test("draws a generated coil on the neutral panel when there is no image", async () => {
		const html = await render({ slug: "urumi-mug" });
		expect(html).toContain("<svg");
		expect(html).toContain('fill="var(--u-panel)"');
		expect(html).toMatch(/d="M [\d.\-\sLZ]+"/);
	});

	test("the coil is aria-hidden — it carries no information (§5)", async () => {
		const html = await render({ slug: "urumi-mug" });
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain('focusable="false"');
	});

	test("is keyed to the slug: the same product always draws the same coil", async () => {
		expect(await render({ slug: "urumi-tee" })).toBe(await render({ slug: "urumi-tee" }));
	});

	test("different products draw different coils, so it never repeats like a logo", async () => {
		expect(await render({ slug: "urumi-tee" })).not.toBe(await render({ slug: "urumi-mug" }));
	});

	test("the tint is a token, never a raw colour", async () => {
		const html = await render({ slug: "urumi-mug" });
		expect(html).toMatch(/fill="var\(--u-tint-(violet|straw|blue)\)"/);
		expect(html).toContain('opacity="var(--u-coil-a)"');
		expect(html).not.toMatch(/fill="#[0-9a-f]/i);
	});

	test("is flat: no animation, no script, no interactivity (§5)", async () => {
		const html = await render({ slug: "urumi-mug" });
		expect(html).not.toContain("<animate");
		expect(html).not.toContain("<script");
	});
});

describe("MediaPanel — a real image replaces the coil entirely (§5)", () => {
	test("renders the image and draws no coil at all", async () => {
		const html = await render({ slug: "urumi-mug", image: "/media/mug.jpg", alt: "A mug" });
		expect(html).toContain('src="/media/mug.jpg"');
		expect(html).toContain('alt="A mug"');
		expect(html).not.toContain("<svg");
		expect(html).not.toContain("--u-tint");
	});

	test("alt defaults to empty — on a card the title beneath already says it", async () => {
		const html = await render({ slug: "urumi-mug", image: "/media/mug.jpg" });
		// Astro serializes an empty string attribute bare; `alt` and `alt=""`
		// are the same thing to a screen reader, and both are "decorative".
		expect(html).toMatch(/\salt(=""|[\s>])/);
		expect(html).not.toMatch(/alt="\w/);
	});

	test("the image is lazy and async-decoded, so a grid of them does not block", async () => {
		const html = await render({ slug: "urumi-mug", image: "/media/mug.jpg" });
		expect(html).toContain('loading="lazy"');
		expect(html).toContain('decoding="async"');
	});
});

describe("MediaPanel — the shape is the page's decision", () => {
	test("defaults to the catalog's 4/3", async () => {
		expect(await render({ slug: "x" })).toContain("--media-ratio: 4 / 3");
	});

	test("takes the PDP's 4/5 and the cart thumbnail's square", async () => {
		expect(await render({ slug: "x", ratio: "4 / 5" })).toContain("--media-ratio: 4 / 5");
		expect(await render({ slug: "x", ratio: "1" })).toContain("--media-ratio: 1");
	});
});
