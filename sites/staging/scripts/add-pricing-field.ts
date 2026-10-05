/**
 * Add the products collection's `pricing` field to a store created before the
 * Pricing & stock cards (ADR-0014, amendment 2026-10-01).
 *
 * The cards are the custom editor EmDash draws for a field whose `widget` is
 * `otta-console:pricing`. New stores get that field from the seed. An older
 * store does not have it, and EmDash 0.38's Content Types screen cannot set a
 * field's widget — a JSON field added there would show EmDash's raw JSON box
 * instead of the cards, inviting commerce data into the CMS. So this script adds
 * it through EmDash's schema API, which does accept `widget`:
 *
 *   SITE_URL=https://<your-site> EMDASH_TOKEN=<admin API token> \
 *     pnpm dlx tsx@4 sites/staging/scripts/add-pricing-field.ts
 *
 * (On a local dev site `SITE_URL` alone is enough: it signs in through the dev
 * bypass, like `seed-demo-commerce.ts`.)
 *
 * SAFE TO RE-RUN. It reads the collection's fields first: a correct field is
 * left alone, a `pricing` JSON field with the wrong or no widget is re-bound,
 * and anything else called `pricing` is refused rather than overwritten. A new
 * field is placed right after Images.
 */
import { pathToFileURL } from "node:url";
import { cmsAuthHeaders } from "./seed-demo-commerce.js";

export const PRICING_FIELD = {
	slug: "pricing",
	label: "Pricing & stock",
	type: "json",
	widget: "otta-console:pricing",
} as const;

export interface FieldInfo {
	readonly slug: string;
	readonly type?: string;
	readonly widget?: string | null;
}

export type PricingFieldPlan =
	| { readonly kind: "ok" }
	| { readonly kind: "create"; readonly order: readonly string[] }
	| { readonly kind: "bind" }
	| { readonly kind: "refuse"; readonly reason: string };

/** What to do, from the collection's current fields. Pure, so it is tested
 *  without a server. `order` is the field order to set after creating:
 *  `pricing` right after `images`, or last when there is no `images`. */
export function planPricingField(fields: readonly FieldInfo[]): PricingFieldPlan {
	const existing = fields.find((f) => f.slug === PRICING_FIELD.slug);
	if (existing !== undefined) {
		if (existing.type !== PRICING_FIELD.type) {
			return {
				kind: "refuse",
				reason: `the products collection already has a "pricing" field of type "${existing.type ?? "unknown"}". Rename or remove it first; this script will not change another field's type.`,
			};
		}
		return existing.widget === PRICING_FIELD.widget ? { kind: "ok" } : { kind: "bind" };
	}
	const slugs = fields.map((f) => f.slug);
	const at = slugs.indexOf("images");
	const order =
		at < 0
			? [...slugs, PRICING_FIELD.slug]
			: [...slugs.slice(0, at + 1), PRICING_FIELD.slug, ...slugs.slice(at + 1)];
	return { kind: "create", order };
}

const FIELDS_PATH = "/_emdash/api/schema/collections/products/fields";

async function call(
	siteUrl: string,
	headers: Record<string, string>,
	method: string,
	path: string,
	body?: unknown,
): Promise<unknown> {
	const res = await fetch(`${siteUrl}${path}`, {
		method,
		headers: {
			...headers,
			...(body === undefined
				? {}
				: { "Content-Type": "application/json", "X-EmDash-Request": "1" }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const text = await res.text();
	if (!res.ok)
		throw new Error(`${method} ${path} answered HTTP ${String(res.status)}: ${text.slice(0, 300)}`);
	return text.length === 0 ? null : (JSON.parse(text) as { data?: unknown }).data;
}

async function main(): Promise<void> {
	const siteUrl = (process.env["SITE_URL"] ?? "http://localhost:4321").replace(/\/+$/, "");
	const headers = await cmsAuthHeaders(siteUrl);
	const listed = (await call(siteUrl, headers, "GET", FIELDS_PATH)) as { items?: unknown } | null;
	// An answer without a field list is not "no fields": planning a create and a
	// reorder from it would rewrite the collection's field order.
	if (!Array.isArray(listed?.items)) {
		throw new Error(
			`the field list at ${FIELDS_PATH} came back without an items array; nothing was changed.`,
		);
	}
	const plan = planPricingField(listed.items as FieldInfo[]);
	switch (plan.kind) {
		case "ok":
			console.info(
				"[otta] the products collection already has the Pricing & stock field — nothing to do.",
			);
			return;
		case "refuse":
			throw new Error(plan.reason);
		case "bind":
			await call(siteUrl, headers, "PUT", `${FIELDS_PATH}/${PRICING_FIELD.slug}`, {
				widget: PRICING_FIELD.widget,
				label: PRICING_FIELD.label,
			});
			console.info("[otta] bound the existing `pricing` field to the Pricing & stock cards.");
			console.warn(
				"[otta] if anything was typed into that field's raw JSON box before, it is still stored in the CMS. The cards never read it and the storefront ignores it, but clear it if it holds anything you would not publish.",
			);
			return;
		case "create":
			await call(siteUrl, headers, "POST", FIELDS_PATH, { ...PRICING_FIELD, validation: null });
			await call(siteUrl, headers, "POST", `${FIELDS_PATH}/reorder`, { fieldSlugs: plan.order });
			console.info(
				"[otta] added the Pricing & stock field after Images. Open a product to see the cards.",
			);
	}
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((err: unknown) => {
		console.error("[otta] add-pricing-field failed:", err);
		process.exitCode = 1;
	});
}
