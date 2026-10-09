/**
 * The address bar as the screen's state (F22, F23).
 *
 * Every function under test is PURE — string in, string or value out — which is
 * the whole reason the filter and tab plumbing was split this way. The half that
 * touches `window.history` is not testable here at all: `happy-dom` does not
 * model a session history, so pushing, popping and traversing entries do not
 * behave as a browser's do. Anything about history TRAVERSAL is proven in a real
 * browser instead, and deliberately has no test in this file — a green here
 * would mean nothing.
 */
import { describe, expect, it } from "vitest";
import { cursorQuery, readCursor, seedCursor } from "../src/accumulate.js";
import {
	ORDER_TAB_SLUGS,
	orderTabQuery,
	ordersFilterQuery,
	readOrderTab,
	readOrdersFilter,
} from "../src/orders/orders-screen.js";

describe("readOrdersFilter", () => {
	it("reads an empty query as the default filter, not as an error", () => {
		expect(readOrdersFilter("")).toEqual({});
		expect(readOrdersFilter("?")).toEqual({});
	});

	it("reads each parameter the orders list writes", () => {
		expect(
			readOrdersFilter("?status=paid&period=custom&from=2026-01-01&to=2026-02-01&q=ada"),
		).toEqual({
			status: "paid",
			period: "custom",
			from: "2026-01-01",
			to: "2026-02-01",
			search: "ada",
		});
	});

	it("ignores a date range that no custom period asked for", () => {
		// `from`/`to` are only part of the filter when the period is `custom` —
		// the same rule the panel itself applies, so a decoded filter is one the
		// list could have produced.
		expect(readOrdersFilter("?period=last7&from=2026-01-01&to=2026-02-01")).toEqual({
			period: "last7",
		});
	});

	it("falls back to the default for a value the panel could not have submitted", () => {
		// A URL is user input. An unrecognised status or period travelling to the
		// service would leave the request asking for something the panel above it
		// says it is not asking for.
		expect(readOrdersFilter("?status=banana")).toEqual({});
		expect(readOrdersFilter("?period=nonsense")).toEqual({});
		expect(readOrdersFilter("?status=PAID")).toEqual({});
		// The sentinel is the panel's word for "no constraint", never a filter.
		expect(readOrdersFilter("?status=any&period=any")).toEqual({});
		// A custom range hanging off a rejected period goes with it.
		expect(readOrdersFilter("?period=nonsense&from=2026-01-01&to=2026-02-01")).toEqual({});
		// One bad parameter costs that parameter and nothing else.
		expect(readOrdersFilter("?status=banana&period=last30&q=ada")).toEqual({
			period: "last30",
			search: "ada",
		});
	});

	it("treats an empty value as absent", () => {
		expect(readOrdersFilter("?status=&q=")).toEqual({});
	});

	it("ignores a parameter it does not own", () => {
		expect(readOrdersFilter("?order=abc&cursor=xyz&nonsense=1")).toEqual({});
	});
});

describe("ordersFilterQuery", () => {
	it("writes nothing for the default filter", () => {
		expect(ordersFilterQuery("", {})).toBe("");
	});

	it("round-trips every field it wrote", () => {
		const filter = {
			status: "failed",
			period: "custom",
			from: "2026-01-01",
			to: "2026-02-01",
			search: "ada lovelace",
		};
		expect(readOrdersFilter(`?${ordersFilterQuery("", filter)}`)).toEqual(filter);
	});

	it("encodes rather than concatenating — a search term may hold anything", () => {
		const query = ordersFilterQuery("", { search: "a&b=c d" });
		expect(query).toBe("q=a%26b%3Dc+d");
		expect(readOrdersFilter(`?${query}`)).toEqual({ search: "a&b=c d" });
	});

	it("writes no date range for a period that did not ask for one", () => {
		// The twin of the decode rule above, and the side that actually reaches the
		// address bar: a preset resolves its own window, so a `from` still sitting
		// in the draft from an abandoned custom range must not be written beside
		// it. Writing it produces a link whose dates the screen it opens ignores.
		const query = ordersFilterQuery("", {
			period: "last30",
			from: "2026-01-01",
			to: "2026-02-01",
		});
		const params = new URLSearchParams(query);
		expect(params.get("period")).toBe("last30");
		expect(params.get("from")).toBeNull();
		expect(params.get("to")).toBeNull();
	});

	it("clears a stale date range left in the address by a custom period", () => {
		// Switching custom → preset must take the old dates OUT of the URL, not
		// merely stop adding them.
		const query = ordersFilterQuery("?period=custom&from=2026-01-01&to=2026-02-01", {
			period: "last7",
		});
		expect(query).toBe("period=last7");
	});

	it("drops a filter that has gone back to its default", () => {
		expect(ordersFilterQuery("?status=paid&q=ada", {})).toBe("");
	});

	it("keeps the drill-in parameter and anything else it does not own", () => {
		const query = ordersFilterQuery("?order=abc&status=paid", { search: "ada" });
		const params = new URLSearchParams(query);
		expect(params.get("order")).toBe("abc");
		expect(params.get("status")).toBeNull();
		expect(params.get("q")).toBe("ada");
	});
});

describe("the tab a link was shared from", () => {
	it("lands on the first tab when no tab was named", () => {
		expect(readOrderTab("")).toBe(0);
	});

	it("lands on the first tab when the slug is not one it knows", () => {
		// A renamed or removed tab must keep an old link working rather than
		// erroring — the fallback IS the compatibility story.
		expect(readOrderTab("?tab=nonsense")).toBe(0);
		expect(readOrderTab("?tab=")).toBe(0);
		expect(readOrderTab("?tab=MONEY")).toBe(0);
	});

	it("resolves a slug to its tab", () => {
		expect(readOrderTab("?tab=money")).toBe(2);
		expect(readOrderTab("?tab=history")).toBe(3);
	});

	it("names tabs by slug, never by index", () => {
		// An index reorders silently the first time someone inserts a tab.
		expect(orderTabQuery("", 2)).toBe("tab=money");
	});

	it("omits the parameter for the default tab", () => {
		expect(orderTabQuery("", 0)).toBe("");
		expect(orderTabQuery("?tab=money", 0)).toBe("");
	});

	it("omits the parameter for a tab that does not exist", () => {
		expect(orderTabQuery("?tab=money", 99)).toBe("");
		expect(orderTabQuery("", -1)).toBe("");
	});

	it("keeps the record id beside the tab — that is the point of the link", () => {
		const params = new URLSearchParams(orderTabQuery("?order=abc&q=mug", 2));
		expect(params.get("order")).toBe("abc");
		expect(params.get("q")).toBe("mug");
		expect(params.get("tab")).toBe("money");
	});

	it("round-trips every slug it publishes", () => {
		for (const [index] of ORDER_TAB_SLUGS.entries()) {
			expect(readOrderTab(`?${orderTabQuery("", index)}`)).toBe(index);
		}
	});
});

/**
 * THE PAGE A LINK WAS SHARED FROM.
 *
 * The cursor is the one screen parameter this console does not author: it is a
 * token the service issued, and every function below moves it verbatim. Nothing
 * here parses it, validates its shape or synthesises one — a token this tier
 * "understood" would be a keyset predicate reimplemented in a browser, coupled
 * to an encoding it does not own.
 *
 * IT IS NOT SAFE BECAUSE IT IS UNREADABLE — it is unsigned base64url JSON, so
 * anyone can read one and anyone can mint one. It is safe because the ROUTE
 * re-validates the filter the token carries through the same schema a query
 * string is held to and re-clamps its limit, both failing closed. A minted token
 * can therefore only restate a query an operator was already allowed to make.
 */
describe("the page a link was shared from (the cursor)", () => {
	it("reads no cursor as page one — absent, not an empty string", () => {
		// The distinction is the whole of the default: `?cursor=` is a stale or
		// hand-trimmed link, and answering it with `""` would put an empty token on
		// the wire for the service to refuse, instead of simply asking for page one.
		expect(readCursor("")).toBeUndefined();
		expect(readCursor("?")).toBeUndefined();
		expect(readCursor("?cursor=")).toBeUndefined();
		expect(readCursor("?status=paid&order=abc")).toBeUndefined();
	});

	it("reads the token back exactly as the service issued it", () => {
		expect(readCursor("?cursor=abc")).toBe("abc");
		// A REAL TOKEN'S SHAPE — base64URL, so `+` and `/` are already `-` and `_`
		// and the padding is gone. It needs no escaping today, and this pins that it
		// survives the round trip unaltered rather than that it required rescuing.
		const real = "eyJwb3MiOnsiY3JlYXRlZEF0IjoiMjAyNi0wMy0wMlQxMDoyMDowMFoifSwibGltaXQiOjI1fQ";
		expect(cursorQuery("", real)).toBe(`cursor=${real}`);
		expect(readCursor(`?${cursorQuery("", real)}`)).toBe(real);
	});

	it("round-trips a token whose alphabet is NOT query-safe", () => {
		// WHY THE ENCODER IS USED ANYWAY, and it is not about today's token. The
		// alphabet belongs to the service: the day the token gains a signature, a
		// version prefix or a different encoding, hand concatenation would corrupt
		// it silently — a raw `+` decodes back as a SPACE — and the route would
		// refuse a value this tier had mangled. One `params.set` removes the
		// dependency on an assumption this tier is not entitled to make.
		const awkward = "a+b/c=d&e f";
		expect(readCursor(`?${cursorQuery("", awkward)}`)).toBe(awkward);
	});

	it("writes the cursor, and writes NOTHING for page one", () => {
		expect(cursorQuery("", "abc")).toBe("cursor=abc");
		// Page one is the absence of the parameter, so returning to it must DELETE
		// rather than write an empty value — the same rule every other parameter on
		// this screen follows.
		expect(cursorQuery("?cursor=abc", undefined)).toBe("");
		expect(cursorQuery("?cursor=abc", "def")).toBe("cursor=def");
	});

	it("composes with the filter and the drill-in, which share the address", () => {
		const params = new URLSearchParams(cursorQuery("?order=abc&status=paid&tab=money", "c2"));
		expect(params.get("order")).toBe("abc");
		expect(params.get("status")).toBe("paid");
		expect(params.get("tab")).toBe("money");
		expect(params.get("cursor")).toBe("c2");
		// And dropping the page keeps every one of them.
		const back = new URLSearchParams(cursorQuery(params.toString(), undefined));
		expect(back.get("order")).toBe("abc");
		expect(back.get("status")).toBe("paid");
		expect(back.get("cursor")).toBeNull();
	});

	it("survives a filtered, drilled-into address in one read", () => {
		const query = cursorQuery(ordersFilterQuery("?order=abc", { status: "paid" }), "c2");
		expect(readOrdersFilter(`?${query}`)).toEqual({ status: "paid" });
		expect(readCursor(`?${query}`)).toBe("c2");
		expect(new URLSearchParams(query).get("order")).toBe("abc");
	});

	it("takes the page OUT of the address when the filter changes", () => {
		// A filter change is page one of a NEW set, and the list clears its cursor
		// to say so. A cursor left in the address would then describe a page of the
		// previous predicate — the pairing `continuationCursor` exists to refuse,
		// preserved in a link and reloaded later as though it were valid.
		expect(ordersFilterQuery("?cursor=c2", { status: "paid" })).toBe("status=paid");
		expect(ordersFilterQuery("?cursor=c2&status=paid", {})).toBe("");
	});

	it("keeps the page across a tab change, which is not a page change", () => {
		const params = new URLSearchParams(orderTabQuery("?order=abc&cursor=c2", 2));
		expect(params.get("cursor")).toBe("c2");
		expect(params.get("tab")).toBe("money");
	});

	/**
	 * THE DEEP LINK'S SEED — the hazard this whole increment turns on.
	 *
	 * `PendingCursor` pairs a cursor with the REFERENCE of the filter it was
	 * issued under, and {@link continuationCursor} compares by identity. A cursor
	 * decoded from a URL has no such reference, so seeding it means binding it to
	 * the freshly-decoded filter object the list is about to apply. Bind it to
	 * anything else — a structurally equal copy, a per-render derivation — and
	 * every deep link degrades silently into a first-page reload.
	 */
	describe("seeding a decoded cursor", () => {
		it("binds the cursor to the filter object the list will apply", () => {
			const filter = readOrdersFilter("?status=paid");
			const seeded = seedCursor(filter, "c2");
			expect(seeded).not.toBeNull();
			// IDENTITY, not equality: this is exactly what `continuationCursor`
			// tests, so a copy here would be refused as a stale pairing.
			expect(seeded?.filter).toBe(filter);
			expect(seeded?.value).toBe("c2");
		});

		it("seeds nothing for page one", () => {
			expect(seedCursor({}, undefined)).toBeNull();
			// Belt and braces for a caller that hands over a raw parameter without
			// passing it through `readCursor` first.
			expect(seedCursor({}, "")).toBeNull();
		});
	});
});
