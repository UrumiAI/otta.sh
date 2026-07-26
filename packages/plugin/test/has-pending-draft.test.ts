import { describe, expect, test } from "vitest";
import { hasPendingDraft } from "../src/sync/hooks.js";

/**
 * Pure unit spec for the publish-atomicity discriminator (plan §2.2). The
 * predicate IS the fix, so it is tested without the sandbox: a table over the
 * six states an EmDash content record can present at `content:afterSave`, plus
 * one guard against a future refactor reaching for `liveData`.
 *
 * `true` means "this save staged a PENDING DRAFT over content that is LIVE" —
 * nothing live-affecting (neither the commerce upsert nor the activate) may be
 * sent until the merchant publishes.
 *
 * The pointers-ABSENT case (an older/different host that emits no revision
 * fields at all) is covered structurally by `sync-hooks.sandbox.test.ts`, whose
 * every fixture omits both pointer keys and whose continued green proves the
 * predicate is `false` there.
 */
describe("hasPendingDraft — the pending-draft-over-live discriminator (plan §2.2)", () => {
	const cases: Array<{ name: string; content: Record<string, unknown>; expected: boolean }> = [
		{
			name: "no draft pointer at all (a plain live save, or a non-revision collection)",
			content: { status: "published", liveRevisionId: "rev-live", draftRevisionId: null },
			expected: false,
		},
		{
			name: "draft pointer EQUALS the live pointer — EmDash's clean `published` state",
			content: { status: "published", liveRevisionId: "rev-1", draftRevisionId: "rev-1" },
			expected: false,
		},
		{
			name: "draft pointer DIFFERS from the live pointer — `published_with_changes` (clause 1)",
			content: { status: "published", liveRevisionId: "rev-live", draftRevisionId: "rev-draft" },
			expected: true,
		},
		{
			name: "draft pointer, NO live pointer, status draft — a never-published draft (keep syncing)",
			content: { status: "draft", liveRevisionId: null, draftRevisionId: "rev-draft" },
			expected: false,
		},
		{
			name: "draft pointer, NO live pointer, status published — the create-with-status hole (clause 2)",
			content: { status: "published", liveRevisionId: null, draftRevisionId: "rev-draft" },
			expected: true,
		},
		{
			name: "non-string / empty junk in the pointer fields fails safe",
			content: { status: "published", liveRevisionId: 7, draftRevisionId: "" },
			expected: false,
		},
		{
			// `hydrateDraftData` sets `liveData` whenever `draftRevisionId` is
			// non-null — INCLUDING for a never-published draft. Reaching for it
			// instead of the pointers would wrongly defer a draft-only product's
			// first sync, so pin that this row stays `false`.
			name: "`liveData` present on a never-published draft must NOT make it a pending draft",
			content: {
				status: "draft",
				liveRevisionId: null,
				draftRevisionId: "rev-draft",
				liveData: { commerce: { sku: "SKU-1" } },
			},
			expected: false,
		},
	];

	for (const { name, content, expected } of cases) {
		test(`${expected ? "defers" : "syncs"}: ${name}`, () => {
			expect(hasPendingDraft(content)).toBe(expected);
		});
	}
});
