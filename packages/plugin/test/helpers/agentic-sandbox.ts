/**
 * ADR-0047: what the two agentic sandbox suites share — a priced catalogue, one
 * shipping zone with a taxed flat method, a coupon, and route callers. Every id is
 * namespaced by the suite, and the document store is the suite's own.
 */
import { cents, currency, idempotencyKey, productId, sku } from "@urumi.ai/otta-domain";
import {
	CARTS_COLLECTION,
	collectionOf,
	EmdashCouponStore,
	EmdashInventoryStore,
	EmdashProductCommerceStore,
	EmdashShippingRulesStore,
	EmdashTaxRulesStore,
	systemClock,
	uuidIdGen,
	type StorageAccess,
} from "@urumi.ai/otta-store-emdash";
import { expect } from "vitest";
import type { SandboxHandle } from "../sandbox/harness.js";

export const PUBLISHED_AT = "2026-01-01T00:00:00.000Z";

export interface AgenticFixture {
	readonly ns: string;
	readonly products: readonly [
		{ id: string; sku: string; amount: number },
		{ id: string; sku: string; amount: number },
	];
	readonly methodId: string;
	readonly couponCode: string;
}

export function agenticFixture(ns: string): AgenticFixture {
	return {
		ns,
		products: [
			{ id: `prod-${ns}-mug`, sku: `SKU-${ns}-MUG`, amount: 1500 },
			{ id: `prod-${ns}-bowl`, sku: `SKU-${ns}-BOWL`, amount: 2250 },
		],
		methodId: `${ns}-ship`,
		couponCode: `${ns.toUpperCase()}-SAVE5`,
	};
}

/** A live, priced, activated product: physical with deep stock unless told. */
export async function seedProduct(
	storage: StorageAccess,
	product: { id: string; sku: string; amount: number },
	version = 1,
	options: { stock?: number; kind?: "physical" | "digital" } = {},
): Promise<void> {
	const commerce = new EmdashProductCommerceStore({ storage, clock: systemClock });
	await commerce.upsert(
		{
			productId: productId(product.id),
			sku: sku(product.sku),
			price: { amount: cents(product.amount), currency: currency("USD") },
			title: "Agentic test product",
			...(options.kind !== undefined ? { productKind: options.kind } : {}),
		},
		idempotencyKey(`seed-${product.id}-v${String(version)}`),
	);
	if (version === 1) {
		if (options.kind !== "digital") {
			await new EmdashInventoryStore({ storage, idGen: uuidIdGen, clock: systemClock }).seedOnHand(
				sku(product.sku),
				options.stock ?? 500,
			);
		}
		await commerce.activate(
			productId(product.id),
			idempotencyKey(`pub-${product.id}`),
			PUBLISHED_AT,
		);
	}
}

/** Unpublish a product (the CMS's afterUnpublish mirror): no longer sellable. */
export async function unpublishProduct(storage: StorageAccess, id: string): Promise<void> {
	await new EmdashProductCommerceStore({ storage, clock: systemClock }).deactivate(
		productId(id),
		idempotencyKey(`unpub-${id}`),
		"2026-06-01T00:00:00.000Z",
	);
}

/** A cart document's lines (the test's own read of the store), keyed by sku. */
export async function cartLines(
	storage: StorageAccess,
	cartId: string,
): Promise<Record<string, { qty: number }> | null> {
	const doc = await collectionOf<{ lines: Record<string, { qty: number }> }>(
		storage,
		CARTS_COLLECTION,
	).get(cartId);
	if (doc === null) return null;
	return Object.fromEntries(Object.entries(doc.lines).map(([k, v]) => [k, { qty: v.qty }]));
}

/** The catalogue, a US zone with a $5.99 flat method and 10% tax on everything,
 *  and a $5.00 coupon. */
export async function seedAgenticStore(storage: StorageAccess, f: AgenticFixture): Promise<void> {
	for (const product of f.products) await seedProduct(storage, product);
	const rules = new EmdashShippingRulesStore({ storage, clock: systemClock });
	const zoneId = `${f.ns}-zone`;
	await rules.createZone({ id: zoneId, name: "Agentic zone", regions: ["US"] });
	await rules.createMethod({ id: f.methodId, zoneId, name: "Flat", type: "flat_rate" });
	await rules.createRate({
		methodId: f.methodId,
		currency: currency("USD"),
		amountCents: cents(599),
		minSubtotalCents: null,
	});
	await new EmdashTaxRulesStore({ storage, clock: systemClock }).createRate({
		id: `${f.ns}-zone-standard`,
		taxClassId: "standard",
		zoneId,
		rateBps: 1000,
		appliesToShipping: true,
	});
	await new EmdashCouponStore({ storage, idGen: uuidIdGen, clock: systemClock }).create({
		id: `${f.ns}-save5`,
		code: f.couponCode,
		type: "fixed_amount",
		amountCents: cents(500),
		rateBps: null,
		capCents: null,
		currency: currency("USD"),
		minSubtotalCents: null,
		startsAt: null,
		expiresAt: null,
		maxUses: null,
		maxUsesPerCustomer: null,
	});
}

/** The ship-to an agent sends (and the COD place needs: a phone). */
export const AGENT_ADDRESS = {
	name: "Agent Buyer",
	line1: "1 Main St",
	city: "Springfield",
	region: "IL",
	postalCode: "62701",
	country: "US",
	phone: "+1 217 555 0100",
} as const;

/** An agent's request: Cloudflare's client address, no attestation. */
export function agentRequest(ip = "198.51.100.7"): { headers: Record<string, string> } {
	return { headers: { "cf-connecting-ip": ip } };
}

export function resultOf(outcome: unknown): Record<string, unknown> {
	expect(outcome).toHaveProperty("result");
	return (outcome as { result: Record<string, unknown> }).result;
}

export async function call(
	handle: SandboxHandle,
	route: string,
	input: Record<string, unknown>,
	request: { headers: Record<string, string> } = agentRequest(),
): Promise<Record<string, unknown>> {
	return resultOf(await handle.invokeRoute(route, input, request));
}

/** Switch agentic checkout on or off through the Settings form, as a merchant does. */
export async function saveAgentic(handle: SandboxHandle, enabled: boolean): Promise<void> {
	const saved = await handle.invokeRoute("admin", {
		type: "form_submit",
		action_id: "save-agentic-checkout",
		values: { agenticEnabled: enabled },
	});
	expect(saved).toHaveProperty("result");
}
