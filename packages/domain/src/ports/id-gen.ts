/**
 * Collision-free id source (Phase 0, risk R5): the domain defines only the
 * port; adapters inject a concrete generator (`crypto.randomUUID()` is fine),
 * tests inject a deterministic counter.
 *
 * IDS MUST START RANDOM. The order number shown to buyers and operators is the
 * first five characters of the order's id (`orders/order-number.ts`, #443,
 * ADR-0033), and it is only a usable label because those characters are
 * uniformly random. A generator whose ids share a prefix or lead with a
 * timestamp (UUIDv7, a ULID, a date-stamped counter) would give every order
 * placed in the same hour the same number. A new adapter must keep the leading
 * characters random; a sequence belongs at the end, or nowhere. (A test's
 * deterministic counter is exempt: its numbers are never shown to anyone.)
 */
export interface IdGen {
	newId(): string;
}
