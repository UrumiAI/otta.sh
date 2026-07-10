/**
 * Collision-free id source (Phase 0, risk R5): the domain defines only the
 * port; adapters inject a concrete generator (`crypto.randomUUID()` is fine),
 * tests inject a deterministic counter.
 */
export interface IdGen {
	newId(): string;
}
