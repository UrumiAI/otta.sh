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

function pushSelectedOrder(orderId: string): void {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	url.searchParams.set(ORDER_PARAM, orderId);
	window.history.pushState({ ottaOrder: orderId }, "", url);
}

/**
 * `← Back to orders` POPS the history entry the drill-in pushed. It does not
 * push a third one.
 *
 * The module doc above promises "a browser Back goes back", and pushing on the
 * way out would make that false in the most annoying way available: list →
 * detail → list would be three entries, so the browser's own Back would return
 * the operator to the DETAIL they just left, and a second press to the list
 * again. Two controls that both say "back" and disagree about where that is.
 *
 * `history.back()` is asynchronous and lands in the `popstate` listener, which
 * is what actually clears the selection — so the URL and the rendered state
 * change together, from one source, rather than from two writers that can
 * drift.
 *
 * THE GUARD: only pop when this component pushed the entry it would be popping.
 * An operator who arrived on `?order=…` directly — a pasted link, a reload, a
 * bookmark — has no pushed entry behind them, and `history.back()` would take
 * them out of the admin entirely. That case replaces the URL instead, which
 * clears the parameter without touching the stack.
 */
function popSelectedOrder(pushed: boolean): void {
	if (typeof window === "undefined") return;
	if (pushed) {
		window.history.back();
		return;
	}
	const url = new URL(window.location.href);
	url.searchParams.delete(ORDER_PARAM);
	window.history.replaceState({ ottaOrder: null }, "", url);
}

export function OrdersScreen(): React.ReactElement {
	const [selected, setSelected] = React.useState<string | null>(() => readSelectedOrder());
	/** Did THIS component push the entry currently on top? See
	 *  {@link popSelectedOrder} — an operator who arrived on `?order=…` directly
	 *  has nothing of ours to pop. */
	const pushed = React.useRef(false);

	React.useEffect(() => {
		const onPop = () => {
			pushed.current = false;
			setSelected(readSelectedOrder());
		};
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
						pushed.current = true;
						setSelected(orderId);
					}}
				/>
			) : (
				<OrderDetail
					orderId={selected}
					onBack={() => {
						const wasPushed = pushed.current;
						popSelectedOrder(wasPushed);
						pushed.current = false;
						// A pop is asynchronous and `popstate` will clear the selection;
						// a REPLACE fires no event, so that path clears it here.
						if (!wasPushed) setSelected(null);
					}}
				/>
			)}
		</div>
	);
}
