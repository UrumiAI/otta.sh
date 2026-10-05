/**
 * Which lines of an order get a Download link (issue #376, increment 3) — for
 * `/orders/<orderId>` and `/account/orders/<id>`.
 *
 * ── Why the page asks the gate ────────────────────────────────────────────
 * The order wire says which lines are DIGITAL, and nothing more. Whether a line
 * is downloadable now takes four further facts: an active grant (a full refund
 * revokes it), a deliverable order state, the product still being digital, and a
 * file attached to it. Those are exactly what the plugin's `entitlements/download`
 * gate reads, and the order read carries none of them — adding a "has file" flag
 * there would mean a plugin wire change AND the same product reads, and would
 * still not know about the grant. So the page asks the gate itself, the
 * narrowest way:
 *  - only when a link could work at all: this deployment has a `DOWNLOADS`
 *    binding, and the order is in a deliverable state (a pending order's page
 *    polls itself every few seconds and asks nothing);
 *  - once per DISTINCT digital sku — never for a physical line;
 *  - in parallel, each a few storage reads, in-process.
 * A link is drawn iff the gate authorizes, so the page never offers a link the
 * endpoint would refuse. The endpoint re-runs the gate on the click regardless.
 *
 * BUSY draws the link: the gate could not answer, the buyer most likely owns the
 * file, and hiding a purchase is worse than a click that says "try again". A
 * dispatch that failed outright draws none.
 */
import type { EntitlementDownloadResult } from "@otta-sh/plugin";
import { ENTITLEMENT_DOWNLOAD_ROUTE } from "@otta-sh/plugin";
import type { PublicPluginApiRouteHandler } from "emdash/plugin-utils";
import { downloadHref } from "./download-delivery.js";
import { dispatchOttaRouteOnce } from "./otta-api.js";

/**
 * The order states that can deliver — the gate's own `DELIVERABLE_ORDER_STATES`
 * (`packages/plugin/src/entitlements/download-route.ts`). Only a PREFILTER, so a
 * page does not ask about an order that cannot deliver: the gate stays the
 * authority, and a state added there but missed here hides a link, never opens
 * one.
 */
const DELIVERABLE_STATES: ReadonlySet<string> = new Set([
	"paid",
	"processing",
	"shipped",
	"delivered",
	"completed",
]);

export interface DownloadLinksInput {
	handler: PublicPluginApiRouteHandler | undefined;
	/** Whether this deployment has a `DOWNLOADS` binding at all. */
	bucketPresent: boolean;
	order: { id: string; state: string; lines: readonly { sku: string; fulfillmentKind: string }[] };
	baseUrl: URL;
}

/** sku → download href, for the lines that get a link. */
export async function downloadLinks(input: DownloadLinksInput): Promise<Map<string, string>> {
	const { order } = input;
	const links = new Map<string, string>();
	if (!input.bucketPresent || !DELIVERABLE_STATES.has(order.state)) return links;
	const skus = [
		...new Set(order.lines.filter((l) => l.fulfillmentKind === "digital").map((l) => l.sku)),
	];
	const answers = await Promise.all(
		skus.map((sku) =>
			// One ask each, no automatic retry: a BUSY answer draws the link anyway.
			dispatchOttaRouteOnce<EntitlementDownloadResult>(
				input.handler,
				ENTITLEMENT_DOWNLOAD_ROUTE,
				{ orderId: order.id, sku },
				input.baseUrl,
			),
		),
	);
	skus.forEach((sku, i) => {
		const answer = answers[i];
		if (answer === null || answer === undefined) return;
		if (answer.authorized || answer.reason === "BUSY") links.set(sku, downloadHref(order.id, sku));
	});
	return links;
}
