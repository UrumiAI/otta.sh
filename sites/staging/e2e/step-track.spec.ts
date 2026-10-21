import { expect, skipWithoutSite, test } from "./harness.js";

for (const width of [195, 319, 320, 390, 1280]) {
	test(`checkout progress fits at ${width} CSS pixels`, async ({ page }, testInfo) => {
		await skipWithoutSite(testInfo);
		await page.setViewportSize({ width, height: 900 });
		await page.goto("/dev/tempered#steps");
		await page.evaluate(() => document.fonts.ready);

		const tracks = page.locator("#steps").getByRole("list", { name: "Checkout progress" });
		await expect(tracks).toHaveCount(4);
		for (const track of await tracks.all()) {
			await expect(track.locator(".label")).toHaveText(["Cart", "Details", "Payment", "Order"]);
			const { bounds, labels, dots } = await track.evaluate((element) => {
				// This helper must travel with the browser callback.
				// oxlint-disable-next-line unicorn/consistent-function-scoping
				const rect = ({ left, right, top, bottom }: DOMRect) => ({ left, right, top, bottom });
				return {
					bounds: rect(element.getBoundingClientRect()),
					labels: Array.from(element.querySelectorAll(".label"), (label) => {
						// Measure the text itself: a shrinking flex box can still spill its label.
						const range = document.createRange();
						range.selectNodeContents(label);
						return rect(range.getBoundingClientRect());
					}),
					dots: Array.from(element.querySelectorAll(".dot"), (dot) =>
						rect(dot.getBoundingClientRect()),
					),
				};
			});

			expect(bounds.left).toBeGreaterThanOrEqual(0);
			expect(bounds.right).toBeLessThanOrEqual(width);
			expect(dots).toHaveLength(4);
			for (const box of [...labels, ...dots]) {
				expect(box.right - box.left).toBeGreaterThan(0);
				expect(box.bottom - box.top).toBeGreaterThan(0);
				expect(box.left).toBeGreaterThanOrEqual(bounds.left);
				expect(box.right).toBeLessThanOrEqual(bounds.right);
				expect(box.top).toBeGreaterThanOrEqual(bounds.top);
				expect(box.bottom).toBeLessThanOrEqual(bounds.bottom);
			}
			for (const [index, label] of labels.entries()) {
				for (const other of labels.slice(index + 1)) {
					expect(
						label.right <= other.left ||
							other.right <= label.left ||
							label.bottom <= other.top ||
							other.bottom <= label.top,
					).toBe(true);
				}
			}
			if (width >= 320) {
				expect(new Set(dots.map((dot) => dot.top)).size).toBe(1);
			}
		}
	});
}
