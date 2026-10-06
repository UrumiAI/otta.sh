/**
 * @vitest-environment happy-dom
 *
 * The product editor's Download file card (issue #376, increment 4), mounted
 * inside the Pricing & stock cards. Proves the wiring end to end in the
 * browser tier:
 *  - the card is on DIGITAL products only, and shows the attached file's name
 *    and size;
 *  - an upload is ONE request to the site endpoint (ADR-0029) carrying the file,
 *    its encoded name and the CSRF header, with progress shown;
 *  - the descriptor the endpoint answers is then saved through the `otta` admin
 *    route as `products:attach-download`, on a freshly read watermark;
 *  - every refusal is shown in words, and a save that fails AFTER an upload is
 *    retried without uploading again.
 * The network is faked at its two seams: EmDash's `apiFetch` (the admin route)
 * and `XMLHttpRequest` (the upload).
 */
import * as React from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fire, mount, type Mounted } from "./dom.js";

const apiFetch = vi.fn<(input: string, init?: RequestInit) => Promise<Response>>();

vi.mock("emdash/plugin-utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("emdash/plugin-utils")>();
	return { ...actual, apiFetch };
});

const { PricingStockEditor } = await import("../src/products/pricing-cards.js");
const { formatFileSize } = await import("../src/products/download-file-card.js");
const { MAX_DOWNLOAD_FILE_BYTES, downloadUploadUrl } =
	await import("../src/download-upload-api.js");
type ProductRecord = import("../src/console-api.js").ProductRecord;

const KEY_1 = "dl/p_ebook/01KAZQ3V8K4M2N6P7R8S9T0VWX";
const KEY_2 = "dl/p_ebook/01KAZQ4000000000000000000Z";

const BASE: ProductRecord = {
	productId: "p_ebook",
	sku: "EBOOK-01",
	title: "Field Guide",
	priceCents: 1200,
	currency: "USD",
	taxClass: null,
	compareAtCents: null,
	compareAtCurrency: null,
	unitCostCents: null,
	unitCostCurrency: null,
	inventoryPolicy: "deny",
	weightGrams: null,
	lengthMm: null,
	widthMm: null,
	heightMm: null,
	productKind: "digital",
	downloadAsset: null,
	active: true,
	deletedAt: null,
	onHand: null,
	createdAt: "2026-09-01T09:00:00.000Z",
	updatedAt: "2026-10-06T10:00:00.000Z",
};

function json(data: unknown): Response {
	return new Response(JSON.stringify({ data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function detail(over: Partial<ProductRecord> = {}): Response {
	return json({
		ok: true,
		product: { ...BASE, ...over },
		taxClasses: [],
		threshold: 5,
		vocabulary: { statuses: [], kinds: [], any: "any", pageLimit: 25 },
	});
}

function writes(): Array<Record<string, unknown>> {
	return apiFetch.mock.calls
		.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>)
		.filter((body) => body["type"] === "otta_console_act");
}

// ── the fake XMLHttpRequest ──────────────────────────────────────────────────

class FakeXhr {
	static instances: FakeXhr[] = [];
	method = "";
	url = "";
	headers: Record<string, string> = {};
	body: unknown = null;
	status = 0;
	responseText = "";
	private listeners = new Map<string, Array<(event: unknown) => void>>();
	private uploadListeners = new Map<string, Array<(event: unknown) => void>>();
	upload = {
		addEventListener: (type: string, fn: (event: unknown) => void) => {
			this.uploadListeners.set(type, [...(this.uploadListeners.get(type) ?? []), fn]);
		},
	};
	constructor() {
		FakeXhr.instances.push(this);
	}
	open(method: string, url: string): void {
		this.method = method;
		this.url = url;
	}
	setRequestHeader(name: string, value: string): void {
		this.headers[name] = value;
	}
	addEventListener(type: string, fn: (event: unknown) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
	}
	send(body: unknown): void {
		this.body = body;
	}
	/** Drive the upload from the test. */
	async progress(loaded: number, total: number): Promise<void> {
		await React.act(async () => {
			for (const fn of this.uploadListeners.get("progress") ?? []) {
				fn({ loaded, total, lengthComputable: true });
			}
		});
	}
	async respond(status: number, body: unknown): Promise<void> {
		this.status = status;
		this.responseText = JSON.stringify(body);
		await React.act(async () => {
			for (const fn of this.listeners.get("load") ?? []) fn({});
		});
	}
	async fail(): Promise<void> {
		await React.act(async () => {
			for (const fn of this.listeners.get("error") ?? []) fn({});
		});
	}
}

// ── mounting ─────────────────────────────────────────────────────────────────

let mounted: Mounted | null = null;

async function flush(): Promise<void> {
	for (let i = 0; i < 6; i++) await mounted?.rerender(<PricingStockEditor productId="p_ebook" />);
}

async function mountPanel(): Promise<HTMLElement> {
	mounted = await mount(<PricingStockEditor productId="p_ebook" />);
	await flush();
	return mounted.container;
}

function card(container: HTMLElement): HTMLElement | null {
	return container.querySelector<HTMLElement>("[data-testid='otta-download-card']");
}

function button(scope: HTMLElement, name: string): HTMLButtonElement {
	for (const el of scope.querySelectorAll("button")) {
		if (el.textContent?.trim() === name) return el;
	}
	throw new Error(`no button ${name}`);
}

/** Choose a file in the card's (hidden) picker, as the browser's dialog would. */
async function choose(container: HTMLElement, file: File): Promise<void> {
	const picker = container.querySelector<HTMLInputElement>("[data-testid='otta-download-input']")!;
	Object.defineProperty(picker, "files", { value: [file], configurable: true });
	await React.act(async () => {
		picker.dispatchEvent(new Event("change", { bubbles: true }));
	});
}

function fileOf(size: number, name = "Field Guide.pdf", type = "application/pdf"): File {
	const file = new File([new Uint8Array(Math.min(size, 16))], name, { type });
	if (size > 16) Object.defineProperty(file, "size", { value: size });
	return file;
}

beforeEach(() => {
	apiFetch.mockReset();
	FakeXhr.instances = [];
	vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(async () => {
	await mounted?.unmount();
	mounted = null;
	vi.unstubAllGlobals();
});

test("formats a size in the units a merchant's computer shows", () => {
	expect(formatFileSize(1)).toBe("1 byte");
	expect(formatFileSize(999)).toBe("999 bytes");
	expect(formatFileSize(1000)).toBe("1 KB");
	expect(formatFileSize(307_217)).toBe("307 KB");
	expect(formatFileSize(1_500_000)).toBe("1.5 MB");
	expect(formatFileSize(100_000_000)).toBe("100 MB");
	expect(formatFileSize(2_000_000_000)).toBe("2 GB");
});

test("a PHYSICAL product has no Download file card", async () => {
	apiFetch.mockResolvedValue(detail({ productKind: "physical" }));
	const container = await mountPanel();
	expect(container.querySelector("[data-testid='otta-pricing-cards']")).not.toBeNull();
	expect(card(container)).toBeNull();
	expect(container.textContent).not.toContain("Download file");
});

test("a digital product with no file says so and offers Upload file", async () => {
	apiFetch.mockResolvedValue(detail());
	const container = await mountPanel();
	const c = card(container)!;
	expect(c.textContent).toContain("No file yet");
	expect(c.querySelector("[data-testid='otta-download-badge']")?.textContent).toBe("No file");
	expect(button(c, "Upload file").disabled).toBe(false);
});

test("an attached file shows its name and size, and offers Replace file", async () => {
	apiFetch.mockResolvedValue(
		detail({
			downloadAsset: {
				key: KEY_1,
				filename: "Field Guide.pdf",
				contentType: "application/pdf",
				size: 307_217,
			},
		}),
	);
	const container = await mountPanel();
	const c = card(container)!;
	expect(c.querySelector("[data-testid='otta-download-name']")?.textContent).toBe(
		"Field Guide.pdf",
	);
	expect(c.querySelector("[data-testid='otta-download-size']")?.textContent).toBe("307 KB");
	expect(c.textContent).toContain(KEY_1);
	expect(c.querySelector("[data-testid='otta-download-badge']")?.textContent).toBe("Attached");
	button(c, "Replace file");
});

test("UPLOAD: one request to the site with the file, then the descriptor is saved through the admin route", async () => {
	let attached = false;
	apiFetch.mockImplementation(async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			attached = true;
			return json({
				ok: true,
				notice: {
					variant: "default",
					title: "File attached",
					description: "Buyers' download links now serve Field Guide.pdf.",
				},
			});
		}
		return attached
			? detail({
					updatedAt: "2026-10-06T10:05:00.000Z",
					downloadAsset: {
						key: KEY_1,
						filename: "Field Guide.pdf",
						contentType: "application/pdf",
						size: 2_500_000,
					},
				})
			: detail();
	});
	const container = await mountPanel();
	const file = fileOf(2_500_000, "Field Guide.pdf");
	await choose(container, file);

	// One upload request, to the site endpoint, carrying the file itself.
	expect(FakeXhr.instances).toHaveLength(1);
	const xhr = FakeXhr.instances[0]!;
	expect(xhr.method).toBe("POST");
	expect(xhr.url).toBe(downloadUploadUrl("p_ebook"));
	expect(xhr.url).toBe("/otta-admin/downloads/p_ebook");
	expect(xhr.headers).toEqual({
		"X-EmDash-Request": "1",
		"Content-Type": "application/pdf",
		"X-Otta-Filename": encodeURIComponent("Field Guide.pdf"),
	});
	expect(xhr.body).toBe(file);

	// Progress is shown while the bytes go out, and the button waits.
	await xhr.progress(1_250_000, 2_500_000);
	const c = card(container)!;
	expect(c.querySelector("progress")?.getAttribute("value")).toBe("50");
	expect(c.textContent).toContain("Uploading Field Guide.pdf — 50%");
	expect(button(c, "Upload file").disabled).toBe(true);
	expect(writes()).toEqual([]);

	await xhr.respond(201, {
		ok: true,
		asset: {
			key: KEY_1,
			filename: "Field Guide.pdf",
			contentType: "application/pdf",
			size: 2_500_000,
		},
	});
	await flush();

	// The descriptor, exactly as answered, saved on the watermark read just before.
	expect(writes()).toEqual([
		{
			type: "otta_console_act",
			action_id: "products:attach-download",
			value: {
				productId: "p_ebook",
				expectedUpdatedAt: "2026-10-06T10:00:00.000Z",
				key: KEY_1,
				filename: "Field Guide.pdf",
				contentType: "application/pdf",
				size: "2500000",
			},
		},
	]);
	// …and the card now shows the attached file from the re-read.
	const after = card(container)!;
	expect(after.querySelector("[data-testid='otta-download-name']")?.textContent).toBe(
		"Field Guide.pdf",
	);
	expect(after.querySelector("[data-testid='otta-download-size']")?.textContent).toBe("2.5 MB");
	expect(after.textContent).toContain("Buyers' download links now serve Field Guide.pdf.");
	expect(FakeXhr.instances).toHaveLength(1);
});

test("REPLACE: a new upload's new key is what gets saved", async () => {
	apiFetch.mockImplementation(async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			return json({
				ok: true,
				notice: { variant: "default", title: "File attached", description: "ok" },
			});
		}
		return detail({
			downloadAsset: { key: KEY_1, filename: "v1.pdf", contentType: "application/pdf", size: 10 },
		});
	});
	const container = await mountPanel();
	await choose(container, fileOf(20, "v2.pdf"));
	await FakeXhr.instances[0]!.respond(201, {
		ok: true,
		asset: { key: KEY_2, filename: "v2.pdf", contentType: "application/pdf", size: 20 },
	});
	await flush();
	expect(writes()).toHaveLength(1);
	expect((writes()[0]!["value"] as Record<string, string>)["key"]).toBe(KEY_2);
});

test("a file over 100 MB is refused in the browser, before any request", async () => {
	apiFetch.mockResolvedValue(detail());
	const container = await mountPanel();
	await choose(container, fileOf(MAX_DOWNLOAD_FILE_BYTES + 1, "huge.zip", "application/zip"));
	expect(FakeXhr.instances).toHaveLength(0);
	const error = container.querySelector("[data-testid='otta-download-error']")!;
	expect(error.textContent).toContain("This file is too large");
	expect(error.textContent).toContain("100 MB");
	expect(writes()).toEqual([]);
});

test("an empty file is refused in the browser, before any request", async () => {
	apiFetch.mockResolvedValue(detail());
	const container = await mountPanel();
	await choose(container, new File([], "empty.txt", { type: "text/plain" }));
	expect(FakeXhr.instances).toHaveLength(0);
	expect(container.querySelector("[data-testid='otta-download-error']")?.textContent).toContain(
		"This file is empty",
	);
});

test("the endpoint's refusal is shown in its own words, and nothing is saved", async () => {
	apiFetch.mockResolvedValue(detail());
	const container = await mountPanel();
	await choose(container, fileOf(100));
	await FakeXhr.instances[0]!.respond(409, {
		ok: false,
		error: { code: "NOT_DIGITAL", message: "Only a Digital product can have a download file." },
	});
	await flush();
	const error = container.querySelector("[data-testid='otta-download-error']")!;
	expect(error.textContent).toContain("The file wasn't uploaded");
	expect(error.textContent).toContain("Only a Digital product can have a download file.");
	expect(writes()).toEqual([]);
	// Nothing to re-save: only an upload that succeeded is held.
	expect(error.querySelector("button")).toBeNull();
	expect(button(card(container)!, "Upload file").disabled).toBe(false);
});

test("a dropped connection during the upload says so", async () => {
	apiFetch.mockResolvedValue(detail());
	const container = await mountPanel();
	await choose(container, fileOf(100));
	await FakeXhr.instances[0]!.fail();
	expect(container.querySelector("[data-testid='otta-download-error']")?.textContent).toContain(
		"Check that you are online",
	);
});

test("a save that fails AFTER the upload keeps the file: Save file again re-sends the same descriptor, no second upload", async () => {
	let acts = 0;
	apiFetch.mockImplementation(async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			acts += 1;
			if (acts === 1) return new Response("boom", { status: 500 });
			return json({
				ok: true,
				notice: { variant: "default", title: "File attached", description: "Attached." },
			});
		}
		return detail();
	});
	const container = await mountPanel();
	await choose(container, fileOf(100));
	await FakeXhr.instances[0]!.respond(201, {
		ok: true,
		asset: { key: KEY_1, filename: "Field Guide.pdf", contentType: "application/pdf", size: 100 },
	});
	await flush();
	const error = container.querySelector<HTMLElement>("[data-testid='otta-download-error']")!;
	expect(error.textContent).toContain("save it again");
	await fire(button(error, "Save file again"), "click");
	await flush();
	expect(FakeXhr.instances).toHaveLength(1);
	const sentKeys = writes().map((w) => (w["value"] as Record<string, string>)["key"]);
	expect(sentKeys).toEqual([KEY_1, KEY_1]);
	expect(card(container)!.textContent).toContain("Attached.");
});

test("a save refused because the product moved is retried once on a fresh read, by itself", async () => {
	let acts = 0;
	let reads = 0;
	apiFetch.mockImplementation(async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			acts += 1;
			return acts === 1
				? json({
						ok: true,
						notice: {
							variant: "error",
							title: "This product changed since you opened it",
							description: "Not applied.",
						},
						recordMoved: true,
					})
				: json({
						ok: true,
						notice: { variant: "default", title: "File attached", description: "Attached." },
					});
		}
		reads += 1;
		return detail({ updatedAt: `2026-10-06T10:0${String(Math.min(reads, 9))}:00.000Z` });
	});
	const container = await mountPanel();
	await choose(container, fileOf(100));
	await FakeXhr.instances[0]!.respond(201, {
		ok: true,
		asset: { key: KEY_1, filename: "Field Guide.pdf", contentType: "application/pdf", size: 100 },
	});
	await flush();
	const marks = writes().map((w) => (w["value"] as Record<string, string>)["expectedUpdatedAt"]);
	expect(marks).toHaveLength(2);
	expect(marks[0]).not.toBe(marks[1]);
	expect(container.querySelector("[data-testid='otta-download-error']")).toBeNull();
	expect(card(container)!.textContent).toContain("Attached.");
});

test("a plugin refusal of the descriptor is shown, with the file held for another try", async () => {
	apiFetch.mockImplementation(async (_url, init) => {
		const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		if (body["type"] === "otta_console_act") {
			return json({
				ok: true,
				notice: {
					variant: "error",
					title: "This file wasn't attached",
					description: "Only a Digital product can have a download file.",
				},
			});
		}
		return detail();
	});
	const container = await mountPanel();
	await choose(container, fileOf(100));
	await FakeXhr.instances[0]!.respond(201, {
		ok: true,
		asset: { key: KEY_1, filename: "a.pdf", contentType: "application/pdf", size: 100 },
	});
	await flush();
	const error = container.querySelector<HTMLElement>("[data-testid='otta-download-error']")!;
	expect(error.textContent).toContain("This file wasn't attached");
	expect(error.textContent).toContain("Only a Digital product can have a download file.");
	button(error, "Save file again");
});

test("switched to Digital but not yet saved: the card asks for the save first, with no picker", async () => {
	apiFetch.mockResolvedValue(detail({ productKind: "physical" }));
	const container = await mountPanel();
	const digital = [...container.querySelectorAll<HTMLInputElement>("input[type='radio']")].find(
		(radio) => radio.value === "digital",
	)!;
	await React.act(async () => {
		digital.click();
	});
	expect(container.textContent).toContain("Save this product as Digital first");
	expect(container.querySelector("[data-testid='otta-download-input']")).toBeNull();
});
