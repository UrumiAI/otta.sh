/**
 * A workerd entry that drives the in-process commerce client for real, so the
 * suites can prove the composition works INSIDE the isolate and not merely in
 * Node: one commerce write and one read back, through the client, over the
 * document store `ctx.storage` hands it.
 *
 * WHY A FIXTURE RATHER THAN A PRODUCTION ROUTE. Nothing in the shipped plugin
 * reaches for the document store yet — the storefront still runs on the other
 * transport — so there is no production route whose behaviour would exercise it.
 * This fixture is the smallest thing that does, built through the EXACT production
 * bridge (`createSandboxWorker`: same dispatch, same egress gate, same context
 * shape), which is what makes the result evidence about the real wiring.
 *
 * Never part of any production bundle: it is not reachable from `index.ts`,
 * `plugin.ts` or the default sandbox entry, and it is not a build entry — the same
 * standing this package's other workerd fixture has.
 */

import { createSandboxWorker } from "../../sandbox-entry.js";
import type { PluginContext, SandboxedPlugin } from "../../types.js";
import { InProcessCommerceClient } from "../in-process-commerce-client.js";

/** The store, or a failure a route can report rather than a crash. */
function storageOf(ctx: PluginContext): NonNullable<PluginContext["storage"]> {
	if (ctx.storage === undefined) throw new Error("this fixture needs a document store");
	return ctx.storage;
}

const probePlugin: SandboxedPlugin = {
	routes: {
		"storage-probe/round-trip": async (routeCtx, ctx) => {
			const input = routeCtx.input as { productId?: string; sku?: string };
			const productId = input.productId ?? "probe-product";
			const sku = input.sku ?? "PROBE-SKU";
			const client = new InProcessCommerceClient(ctx);
			const written = await client.upsertProductCommerce(
				productId,
				{ sku, price: { amount: 2500, currency: "USD" }, initialOnHand: 2 },
				`probe-${productId}`,
			);
			const read = await client.getProductCommerce(productId);
			// The batch read as well, because it is the one storefront read that
			// depends on a JOIN across two collections rather than a single document.
			const batch = await client.getCommerceBatch([productId, "probe-absent"]);
			return { written, read, batch };
		},

		/**
		 * The CONDITIONAL WRITE, end to end through the bridge — the primitive every
		 * no-oversell guarantee rests on, and the one whose failure mode is silent: a
		 * store whose revisions never change agrees with every compare-and-set it is
		 * handed. So this drives a real one: create, read the revision, write against
		 * it, then write against the STALE revision and report what came back.
		 */
		"storage-probe/conditional-write": async (routeCtx, ctx) => {
			const input = routeCtx.input as { docId?: string };
			const docId = input.docId ?? "probe-doc";
			const settings = storageOf(ctx)["settings"];
			if (settings === undefined) throw new Error("the settings collection is not declared");

			const created = await settings.compareAndSet(docId, null, { round: 1 });
			const first = await settings.getVersioned(docId);
			const staleRevision = first?.revision ?? null;
			const applied = await settings.compareAndSet(docId, staleRevision, { round: 2 });
			// The same revision a second time: the row has moved on, so this must NOT
			// apply, and it must hand back the revision that won.
			const rejected = await settings.compareAndSet(docId, staleRevision, { round: 3 });
			const final = await settings.getVersioned(docId);
			return {
				created,
				applied,
				rejected,
				staleRevision,
				finalRevision: final?.revision ?? null,
				finalValue: final?.value ?? null,
			};
		},

		/**
		 * A TYPED failure crossing the bridge. The adapters test storage errors by
		 * SHAPE rather than by class, precisely because an error that travelled over a
		 * bridge arrives as data — so this asks a collection to filter on a field it
		 * never declared as an index (a programming error the store refuses) and
		 * reports what the isolate actually caught.
		 */
		"storage-probe/undeclared-index": async (_routeCtx, ctx) => {
			const settings = storageOf(ctx)["settings"];
			if (settings === undefined) throw new Error("the settings collection is not declared");
			try {
				await settings.query({ where: { neverDeclared: "x" } });
				return { threw: false };
			} catch (err) {
				const shape = err as { name?: unknown; message?: unknown; field?: unknown };
				return {
					threw: true,
					isError: err instanceof Error,
					name: typeof shape.name === "string" ? shape.name : null,
					message: typeof shape.message === "string" ? shape.message : null,
					field: typeof shape.field === "string" ? shape.field : null,
				};
			}
		},
	},
};

export default createSandboxWorker(probePlugin);
