/**
 * `buyerRefHint` — the order's email as a pay page may show it to whoever holds
 * the order link (QA U-2). Enough for the buyer to recognise their own address,
 * not enough to read it: the order id is a bearer capability, and the public
 * order deliberately carries no email.
 */
import { describe, expect, test } from "vitest";
import { buyerRefHint } from "../src/commerce/buyer-ref-hint.js";

const DOTS = "•••";

describe("buyerRefHint", () => {
	test.each([
		["jane.doe@gmail.com", `j${DOTS}@g${DOTS}.com`],
		["a@b.co", `a${DOTS}@b${DOTS}.co`],
		["Resume.Buyer@Example.test", `R${DOTS}@E${DOTS}.test`],
		["x@mail.example.co.uk", `x${DOTS}@m${DOTS}.uk`],
	])("%s → %s", (email, hint) => {
		expect(buyerRefHint(email)).toBe(hint);
	});

	test("never contains more of the local part or the domain than one letter each and the last label", () => {
		const hint = buyerRefHint("secret.name@private-company.example");
		expect(hint).not.toContain("secret");
		expect(hint).not.toContain("private");
		expect(hint).toBe(`s${DOTS}@p${DOTS}.example`);
	});

	test("something that is not an address hides everything", () => {
		expect(buyerRefHint("not-an-email")).toBe(DOTS);
		expect(buyerRefHint("@nolocal.com")).toBe(DOTS);
		expect(buyerRefHint("nodomain@")).toBe(DOTS);
		expect(buyerRefHint("")).toBe(DOTS);
	});
});
