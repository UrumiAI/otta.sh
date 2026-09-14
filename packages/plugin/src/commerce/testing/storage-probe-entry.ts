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
import type { SandboxedPlugin } from "../../types.js";
import { InProcessCommerceClient } from "../in-process-commerce-client.js";

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
	},
};

export default createSandboxWorker(probePlugin);
