import {
	commerceRejectionMessage,
	scrubStaleSentinels,
} from "../product-commerce/commerce-rejection-message.js";
import { commerceSaveBlockers } from "../product-commerce/commerce-save-blockers.js";
import type { ContentHookEvent, HookHandler } from "../types.js";

/**
 * `content:beforeSave` — the UPSTREAM half of the money guard (ADR-0012).
 *
 * ── The bug this closes ────────────────────────────────────────────────────
 * The "Product data" widget's Price input is a Block Kit `number_input`, which
 * em-dash renders as `<Input type="number">` with `onChange = Number(value)`,
 * so a decimal or negative is a LEGAL widget value and no `min`/`step` is
 * forwarded. Typing `24.99` used to save cleanly into the CMS `commerce` JSON
 * while `content:afterSave`'s derive guard silently declined to upsert it — the
 * CMS said "Saved", the service kept the old price, and nothing said why.
 * Validation lived strictly DOWNSTREAM of the write, in a fire-and-forget hook
 * with no channel back to the editor. This handler adds a rejection point
 * UPSTREAM of the write; the derive guard is unchanged.
 *
 * ── THE INVARIANT (load-bearing, must hold in every mode, forever) ─────────
 * When the bag is blocked, the returned payload contains NO `commerce` key.
 * A key absent from the payload leaves the stored value untouched on BOTH em-dash
 * write paths — "only the present keys are written" on the column path, and the
 * `{...baseData, ...processedData}` merge on the draft-revision path that
 * `products` actually uses. So the CMS can never store a money value the service
 * would reject, and the last-good bag survives. Everything else here is
 * secondary.
 *
 * ── Why REJECTION IS RETURN-BASED, never a throw ──────────────────────────
 * Not a style choice. em-dash's SANDBOXED dispatcher swallows every throw from a
 * beforeSave hook and then proceeds with the ORIGINAL, bad payload — the
 * invariant would hold only in trusted mode. Both dispatchers honour the RETURN
 * value. ADR-0006 keeps sandboxed deployment a live option, so the design has to
 * be mode-independent.
 *
 * ── The event shape is NOT afterSave's (the obvious implementer trap) ──────
 * On `content:beforeSave`, `event.content` IS the submitted field bag keyed by
 * field slug — there is no `id`, no `updatedAt`, no `status`, and no wrapper
 * object around it. The commerce bag is at `event.content["commerce"]`, one
 * level up from where `sync/hooks.ts` reads it on afterSave. The handler is
 * therefore pure: no last-good lookup is possible, no watermark logic applies,
 * and it must stay free of `ctx.http`/`ctx.kv`/`Date`/crypto — it runs inline on
 * the save critical path.
 */

/** The content document's `json` field the "Product data" widget writes into. */
const COMMERCE_FIELD = "commerce";

/** The only collection this handler may touch. */
const PRODUCTS_COLLECTION = "products";

export function createBeforeSaveHandler(): HookHandler<ContentHookEvent> {
	return (event: ContentHookEvent) => {
		// SECURITY CONTROL, not tidiness (ADR-0012): registering this hook obliges
		// the plugin to declare `content:write`, which in trusted mode is
		// hook-free, transactional write access to EVERY collection. This early
		// return is what keeps a content-write-capable hook from ever rewriting
		// another collection's save payload.
		if (event.collection !== PRODUCTS_COLLECTION) return undefined;

		const content = event.content;
		if (typeof content !== "object" || content === null) return undefined;

		// Always-on, on every path: a sentinel left over from an earlier rejection
		// is removed BEFORE anything else, so em-dash's unknown-key validation
		// never sees one and a stale sentinel can never block a save.
		const cleaned = scrubStaleSentinels(content);

		const blockers = commerceSaveBlockers(cleaned[COMMERCE_FIELD]);
		if (blockers.length === 0) {
			// Zero-cost happy path: `undefined` means "save the payload untouched".
			// Return the cleaned bag only when the scrub actually removed something.
			return cleaned === content ? undefined : cleaned;
		}

		// Blocked: strip the invalid bag (THE invariant) and add exactly one
		// sentinel key, whose name is the merchant-facing message em-dash's
		// unknown-field validation surfaces as a toast.
		const rejected: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(cleaned)) {
			if (key !== COMMERCE_FIELD) rejected[key] = value;
		}
		rejected[commerceRejectionMessage(blockers)] = true;
		return rejected;
	};
}
