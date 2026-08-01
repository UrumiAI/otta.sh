/**
 * The `/products` console page — list or detail, and the navigation between
 * them (INC-21).
 *
 * THE DRILL-IN HAS A URL, which is the whole difference from the Block Kit
 * screen. There, "no client routing, no URL per drill-in, back is a rendered
 * button" (§0.5): every interaction POSTs and replaces the entire block tree, so
 * a product's detail is a transient render with no address. Here the selected
 * product lives in the query string, so a browser Back goes back, a reload lands
 * where the merchant was, and a product can be sent to a colleague as a link —
 * which on THIS screen is what a "please reprice this" message has always
 * needed and never had.
 *
 * WHY A QUERY PARAMETER RATHER THAN A PATH SEGMENT. EmDash's admin router
 * resolves a plugin page by matching the derived path against the descriptor's
 * declared `adminPages`; `/products/<uuid>` is not a declared page and would
 * resolve no component at all. `?product=<uuid>` stays on the declared
 * `/products` page while still being a real, shareable, back-navigable address.
 *
 * IT IS THE SAME MECHANISM `orders-screen.tsx` USES, deliberately and to the
 * line: the same push-on-drill, the same pop-on-back, the same guard for an
 * operator who arrived on a pasted link with nothing of ours to pop. Two
 * screens' navigation behaving differently is the kind of difference nobody
 * documents and everybody trips on. The parameter name differs and nothing
 * else.
 */
import * as React from "react";
import { ConsoleStyles } from "../ui.js";
import { ProductDetail } from "./product-detail.js";
import { ProductsList } from "./products-list.js";

/** The query parameter carrying the drilled-into product. */
export const PRODUCT_PARAM = "product";

function readSelectedProduct(): string | null {
	if (typeof window === "undefined") return null;
	const value = new URLSearchParams(window.location.search).get(PRODUCT_PARAM);
	return value !== null && value.length > 0 ? value : null;
}

function pushSelectedProduct(productId: string): void {
	if (typeof window === "undefined") return;
	const url = new URL(window.location.href);
	url.searchParams.set(PRODUCT_PARAM, productId);
	window.history.pushState({ ottaProduct: productId }, "", url);
}

/**
 * `← Back to pricing & inventory` POPS the history entry the drill-in pushed.
 * It does not push a third one — otherwise list → detail → list would be three
 * entries, so the browser's own Back would return the merchant to the DETAIL
 * they just left. Two controls that both say "back" and disagree about where
 * that is.
 *
 * THE GUARD: only pop when this component pushed the entry it would be popping.
 * A merchant who arrived on `?product=…` directly — a pasted link, a reload, a
 * bookmark — has no pushed entry behind them, and `history.back()` would take
 * them out of the admin entirely. That case replaces the URL instead.
 */
function popSelectedProduct(pushed: boolean): void {
	if (typeof window === "undefined") return;
	if (pushed) {
		window.history.back();
		return;
	}
	const url = new URL(window.location.href);
	url.searchParams.delete(PRODUCT_PARAM);
	window.history.replaceState({ ottaProduct: null }, "", url);
}

export function ProductsScreen(): React.ReactElement {
	const [selected, setSelected] = React.useState<string | null>(() => readSelectedProduct());
	/** Did THIS component push the entry currently on top? */
	const pushed = React.useRef(false);

	React.useEffect(() => {
		const onPop = () => {
			pushed.current = false;
			setSelected(readSelectedProduct());
		};
		window.addEventListener("popstate", onPop);
		return () => window.removeEventListener("popstate", onPop);
	}, []);

	return (
		<div style={{ padding: 24, maxInlineSize: 1100, textAlign: "start" }}>
			<ConsoleStyles />
			{selected === null ? (
				<ProductsList
					onOpen={(productId) => {
						pushSelectedProduct(productId);
						pushed.current = true;
						setSelected(productId);
					}}
				/>
			) : (
				<ProductDetail
					productId={selected}
					onBack={() => {
						const wasPushed = pushed.current;
						popSelectedProduct(wasPushed);
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
