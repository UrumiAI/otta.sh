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

/** The coil's `d` attribute out of a rendered panel. */
const coilPathOf = (html: string): string | undefined => /d="([^"]+)"/.exec(html)?.[1];

describe("MediaPanel — the coil", () => {
	test("draws a generated coil on the neutral panel when there is no image", async () => {
		const html = await render({ slug: "urumi-mug" });
		expect(html).toContain("<svg");
		expect(html).toContain('class="panel"');
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
		expect(html).toMatch(/--coil-tint: var\(--u-tint-(violet|straw|blue)\)/);
		expect(html).not.toMatch(/#[0-9a-f]{3,8}\b/i);
	});

	test("fill and opacity come from CSS, NOT from an SVG presentation attribute", async () => {
		// `fill="var(--u-tint-straw)"` has a long history of not resolving in
		// WebKit, and `fill` then falls back to its initial value — BLACK. The
		// failure mode is every card on the page rendering as a black square.
		const html = await render({ slug: "urumi-mug" });
		expect(html).not.toMatch(/fill="var\(/);
		expect(html).not.toMatch(/opacity="var\(/);
		expect(html).toContain('class="coil"');
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

describe("MediaPanel — the tint cycles by position (§5)", () => {
	test("an index takes the tint off the position, so a short catalog shows all three", async () => {
		const tints = await Promise.all(
			[0, 1, 2].map(async (index) => {
				const html = await render({ slug: `p-${index}`, index });
				return /--coil-tint: var\((--u-tint-\w+)\)/.exec(html)?.[1];
			}),
		);
		expect(new Set(tints).size).toBe(3);
	});

	test("the same product keeps its DRAWING wherever it lands in the list", async () => {
		const first = coilPathOf(await render({ slug: "urumi-mug", index: 0 }));
		const third = coilPathOf(await render({ slug: "urumi-mug", index: 2 }));
		expect(first).toBe(third);
	});

	test("with no index the tint still comes from the slug — a PDP has no list", async () => {
		expect(await render({ slug: "urumi-mug" })).toMatch(/--coil-tint: var\(--u-tint-\w+\)/);
	});
});

describe("MediaPanel — dimming is a PROP, not a parent's CSS", () => {
	test("dimmed marks the panel itself", async () => {
		// A parent cannot reach this element with a scoped rule: it carries
		// MediaPanel's hash, not the parent's.
		expect(await render({ slug: "x", dimmed: true })).toContain("dimmed");
	});

	test("undimmed by default", async () => {
		expect(await render({ slug: "x" })).not.toContain("dimmed");
	});

	test("a dimmed product with a photograph dims the photograph too", async () => {
		const html = await render({ slug: "x", image: "/m.jpg", dimmed: true });
		expect(html).toContain("dimmed");
		expect(html).toContain("/m.jpg");
	});
});

describe("MediaPanel — attributes pass through", () => {
	test("a caller can attach an id or a data attribute to the root", async () => {
		const html = await render({ slug: "x", id: "hero-media", "data-testid": "media" });
		expect(html).toContain('id="hero-media"');
		expect(html).toContain('data-testid="media"');
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
