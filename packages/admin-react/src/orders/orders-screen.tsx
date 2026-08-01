/**
 * The `/orders` console page — list or detail, and the navigation between them.
 *
 * THE DRILL-IN HAS A URL, which is the whole difference from the Block Kit
 * screen. There, "no client routing, no URL per drill-in, back is a rendered
 * button" (§0.5): every interaction POSTs and replaces the entire block tree, so
 * an order's detail is a transient render with no address. Here the selected
 * order lives in the query string, so a browser Back goes back, a reload lands
 * where the operator was, and an order can be sent to a colleague as a link.
 *
 * WHY A QUERY PARAMETER RATHER THAN A PATH SEGMENT. EmDash's admin router
 * resolves a plugin page by matching the derived path against the descriptor's
 * declared `adminPages`; `/orders/<uuid>` is not a declared page and would
 * resolve no component at all. `?order=<uuid>` stays on the declared `/orders`
 * page while still being a real, shareable, back-navigable address.
 *
 * `popstate` IS LISTENED TO, AND THE STATE IS STILL THE SOURCE OF TRUTH. The
 * admin SPA has its own router; rather than reach into it, this component pushes
 * history entries and reads them back, and renders from its own state either
 * way. If a future EmDash intercepts the history in a way that stops the
 * listener firing, the screen still works — it loses the browser Back button,
 * not the navigation.
 */
import * as React from "react";
import { ConsoleStyles } from "../ui.js";
import { OrderDetail } from "./order-detail.js";
import { OrdersList } from "./orders-list.js";

/** The query parameter carrying the drilled-into order. */
export const ORDER_PARAM = "order";

function readSelectedOrder(): string | null {
	if (typeof window === "undefined") return null;
	const value = new URLSearchParams(window.location.search).get(ORDER_PARAM);
	return value !== null && value.length > 0 ? value : null;
}

function pushSelectedOrder(orderId: string | null): void {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	if (orderId === null) url.searchParams.delete(ORDER_PARAM);
	else url.searchParams.set(ORDER_PARAM, orderId);
	window.history.pushState({ ottaOrder: orderId }, "", url);
}

export function OrdersScreen(): React.ReactElement {
	const [selected, setSelected] = React.useState<string | null>(() => readSelectedOrder());

	React.useEffect(() => {
		const onPop = () => setSelected(readSelectedOrder());
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	return (
		<div style={{ padding: 24, maxInlineSize: 1100, textAlign: "start" }}>
			<ConsoleStyles />
			{selected === null ? (
				<OrdersList
					onOpen={(orderId) => {
						pushSelectedOrder(orderId);
						setSelected(orderId);
					}}
				/>
			) : (
				<OrderDetail
					orderId={selected}
					onBack={() => {
						pushSelectedOrder(null);
						setSelected(null);
					}}
				/>
			)}
		</div>
	);
}
