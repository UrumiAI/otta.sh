/**
 * `InProcessCommerceClient` — the END-STATE implementation of the plugin-local
 * `CommerceClient` port: commerce truth held on `ctx.storage` through the
 * `@otta-sh/store-emdash` adapters and the `@otta-sh/domain` use-cases, with no
 * commerce service and no egress at all.
 *
 * THIS INCREMENT SHIPS IT EMPTY, DELIBERATELY. INC-A6 is a pure refactor with
 * zero behavioural change: its whole job is to route every hand-rolled
 * `HttpCommerceClient` construction through one composition root so the later
 * switch is a one-line diff in one file. The bodies land in Phase B/C, one
 * aggregate at a time, each proven against the extracted
 * `commerceClientContract` (INC-A7) before the HTTP client is deleted at
 * INC-D3b.
 *
 * EVERY METHOD IS `async`, so a premature call REJECTS rather than throwing
 * synchronously. The port is promise-returning, and callers compose it —
 * `await (await makeCommerceClient(ctx)).listMyOrders(…)`, `Promise.all` over a
 * batch. A synchronous throw from a promise-returning method escapes those
 * shapes by a different path than a rejection does, so a stub that threw
 * synchronously would fail in places the real implementation never will.
 *
 * WHY `implements CommerceClient` MATTERS HERE. It makes `pnpm typecheck` the
 * coverage check: the compiler, not a reviewer, is what guarantees the stub
 * spans the whole port, so a method added to the port cannot be forgotten here.
 *
 * SANDBOX-CLEAN, AND IT MUST STAY SO. This module imports types only. It holds
 * no `pg`, no `fetch`, no `node:` builtin, nothing from the host — `ctx` is
 * injected, and the future storage adapters reach EmDash through the structural
 * `StorageAccess` seam, never by importing `emdash`.
 */

import type {
	AddressWire,
	AuthedResult,
	CartLineWire,
	CartResult,
	CartWire,
	CheckoutRequestWire,
	CheckoutResult,
	CommerceClient,
	LoginVerifyResult,
	OrderSummaryWire,
	ProductCommerce,
	ProductCommerceBatchItem,
	ProductVariantSummaryWire,
	ProductVariantWire,
	PublicOrderResult,
	QuoteRequestWire,
	QuoteResult,
	UpdateProductVariantFieldsInput,
	UpsertProductCommerceInput,
	UpsertProductVariantInput,
	VariantUpdateResult,
} from "../product-commerce/commerce-client.js";
import type { PluginContext } from "../types.js";

/** The single message every unimplemented method carries, so a premature
 *  cut-over produces one recognizable failure rather than twenty-five
 *  differently-worded ones. */
export const NOT_IMPLEMENTED_MESSAGE = "in-process commerce client lands in a later increment";

/**
 * Typed so a caller (and a test) can distinguish "this increment has not landed
 * yet" from a real commerce failure. Never surfaced to a shopper: in-process
 * mode is not deployed anywhere while this class is a stub.
 */
export class NotImplementedError extends Error {
	override readonly name = "NotImplementedError";

	constructor(message: string = NOT_IMPLEMENTED_MESSAGE) {
		super(message);
	}
}

function notImplemented(): never {
	throw new NotImplementedError();
}

export class InProcessCommerceClient implements CommerceClient {
	/**
	 * The injected plugin context — the ONLY thing this class will ever need
	 * from the host, and the reason the client lives in the plugin rather than
	 * in an adapter package: `ctx.storage` is where commerce truth moves to.
	 *
	 * Held and not yet read, on purpose. Taking `ctx` in the constructor NOW is
	 * what makes the factory's mode branch a one-line diff when the bodies land,
	 * and it is what the composition root's signature is already tested against.
	 * `private readonly`, not public and not `#ctx`: it is nobody's business
	 * outside this class, but a `#private` field that nothing reads YET is
	 * (correctly) reported dead by oxlint's `no-unused-private-class-members`,
	 * and silencing that with a disable comment would blind the same rule when
	 * it matters. `private` also keeps the PROTOTYPE's property set exactly the
	 * port's method set, which is what lets a test walk it.
	 *
	 * The method bodies that read it — the domain use-cases composed over
	 * `@otta-sh/store-emdash` adapters bound to `ctx.storage` — land in Phase
	 * B/C, one aggregate at a time, each proven against the extracted client
	 * contract before the HTTP transport is deleted.
	 */
	private readonly ctx: PluginContext;

	constructor(ctx: PluginContext) {
		this.ctx = ctx;
	}

	// ── product commerce ────────────────────────────────────────────────────
	async upsertProductCommerce(
		_productId: string,
		_input: UpsertProductCommerceInput,
		_idempotencyKey: string,
	): Promise<ProductCommerce> {
		return notImplemented();
	}

	async getProductCommerce(_productId: string): Promise<ProductCommerce | null> {
		return notImplemented();
	}

	async softDeleteProductCommerce(_productId: string, _idempotencyKey: string): Promise<void> {
		return notImplemented();
	}

	async activateProductCommerce(
		_productId: string,
		_idempotencyKey: string,
		_contentUpdatedAt: string,
	): Promise<void> {
		return notImplemented();
	}

	async deactivateProductCommerce(
		_productId: string,
		_idempotencyKey: string,
		_contentUpdatedAt: string,
	): Promise<void> {
		return notImplemented();
	}

	async getCommerceBatch(_productIds: string[]): Promise<ProductCommerceBatchItem[]> {
		return notImplemented();
	}

	// ── variants ────────────────────────────────────────────────────────────
	async listProductVariants(_productId: string): Promise<ProductVariantSummaryWire[]> {
		return notImplemented();
	}

	async upsertProductVariant(
		_productId: string,
		_variantKey: string,
		_input: UpsertProductVariantInput,
		_idempotencyKey: string,
	): Promise<ProductVariantWire> {
		return notImplemented();
	}

	async updateProductVariantFields(
		_productId: string,
		_variantKey: string,
		_input: UpdateProductVariantFieldsInput,
		_expectedUpdatedAt: string,
		_idempotencyKey: string,
	): Promise<VariantUpdateResult> {
		return notImplemented();
	}

	async deactivateProductVariant(
		_productId: string,
		_variantKey: string,
		_idempotencyKey: string,
		_contentUpdatedAt: string,
	): Promise<void> {
		return notImplemented();
	}

	// ── cart ────────────────────────────────────────────────────────────────
	async createCart(_currency?: string): Promise<{ cartId: string }> {
		return notImplemented();
	}

	async getCart(_cartId: string): Promise<CartResult<{ cart: CartWire }>> {
		return notImplemented();
	}

	async addCartLine(
		_cartId: string,
		_sku: string,
		_productId: string | null,
		_qty: number,
		_idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>> {
		return notImplemented();
	}

	async adjustCartLine(
		_cartId: string,
		_lineId: string,
		_qty: number,
		_idempotencyKey: string,
	): Promise<CartResult<{ line: CartLineWire }>> {
		return notImplemented();
	}

	async removeCartLine(
		_cartId: string,
		_lineId: string,
		_idempotencyKey: string,
	): Promise<CartResult<Record<string, never>>> {
		return notImplemented();
	}

	// ── customer account ────────────────────────────────────────────────────
	async requestLoginLink(_email: string): Promise<{ ok: true }> {
		return notImplemented();
	}

	async verifyLogin(_challengeId: string, _token: string): Promise<LoginVerifyResult> {
		return notImplemented();
	}

	async logout(_sessionToken: string): Promise<void> {
		return notImplemented();
	}

	async listMyOrders(_sessionToken: string): Promise<AuthedResult<{ orders: OrderSummaryWire[] }>> {
		return notImplemented();
	}

	async getMyOrder(
		_sessionToken: string,
		_orderId: string,
	): Promise<
		{ ok: true; order: OrderSummaryWire } | { ok: false; reason: "UNAUTHENTICATED" | "NOT_FOUND" }
	> {
		return notImplemented();
	}

	async listMyAddresses(
		_sessionToken: string,
	): Promise<AuthedResult<{ addresses: AddressWire[] }>> {
		return notImplemented();
	}

	// ── delivery authorization ──────────────────────────────────────────────
	async checkEntitlement(
		_scope: { orderId?: string },
		_sku: string,
		_opts?: { sessionToken?: string },
	): Promise<AuthedResult<{ active: boolean }>> {
		return notImplemented();
	}

	// ── checkout ────────────────────────────────────────────────────────────
	async quoteCheckout(_input: QuoteRequestWire): Promise<QuoteResult> {
		return notImplemented();
	}

	async createOrder(_input: CheckoutRequestWire, _idempotencyKey: string): Promise<CheckoutResult> {
		return notImplemented();
	}

	async getPublicOrder(_orderId: string): Promise<PublicOrderResult> {
		return notImplemented();
	}
}
