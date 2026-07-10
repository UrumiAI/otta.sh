/**
 * Minimal forward-looking placeholder (Phase 0 step 0.2b). Defined for
 * completeness; the real order model and this port's behavior arrive in
 * Phase 4, which owns extending or reshaping it.
 */
export interface OrderStore {
	getById(orderId: string): Promise<unknown>;
}
