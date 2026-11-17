/**
 * The admin operations: the decision half of each admin write, shared by the
 * Block Kit / React console actions and the MCP tools (`@urumi.ai/otta-mcp`).
 * See `orders.ts` for what an operation is and is not responsible for.
 */
export {
	addOrderNote,
	cancelOrder,
	recordFulfillment,
	refundOrder,
	resolveReconciliation,
	resolveUnverifiedRefund,
	revokeDownloadAccess,
	transitionOrder,
	type AddNoteInput,
	type CancelInput,
	type CancelOutcome,
	type OrderSettlement,
	type RecordFulfillmentInput,
	type RefundInput,
	type RefundOutcome,
	type ResolveReconciliationInput,
	type ResolveUnverifiedRefundInput,
	type RevokeDownloadAccessInput,
	type TransitionInput,
	type TransitionOutcome,
} from "./orders.js";
export {
	deriveEditIdempotencyKey,
	editProduct,
	NONCE_PATTERN,
	removeStock,
	restock,
	stockMovementKey,
	type ProductEditOutcome,
	type StockMovementInput,
	type StockOutcome,
} from "./products.js";
