/**
 * ONE sellability rule, two homes (#109, #166). The domain's `unsellableReasons`
 * gates every sell path; the admin console cannot import the domain, so
 * `@urumi.ai/otta-admin-presentation` restates it. This holds the two equal over
 * every combination of the facts, so the console can never call "active" what
 * checkout refuses — the drift #166 was.
 */
import { cents, currency, money, unsellableReasons } from "@urumi.ai/otta-domain";
import { unsellableReasons as adminUnsellableReasons } from "@urumi.ai/otta-admin-presentation";
import { describe, expect, test } from "vitest";

const DELETED_AT = "2026-07-01T00:00:00.000Z";

describe("the admin's sellability rule is the domain's", () => {
	const cases: Array<[boolean, boolean, boolean, string | null]> = [];
	for (const active of [true, false])
		for (const deleted of [true, false])
			for (const priced of [true, false])
				for (const title of ["Otta Tee", "", null]) cases.push([active, deleted, priced, title]);

	test.each(cases)("active=%s deleted=%s priced=%s title=%j", (active, deleted, priced, title) => {
		const domain = unsellableReasons({
			active,
			deletedAt: deleted ? new Date(DELETED_AT) : null,
			price: priced ? money(cents(1200), currency("USD")) : null,
			title,
		});
		const admin = adminUnsellableReasons({
			active,
			deletedAt: deleted ? DELETED_AT : null,
			sku: "OTTA-TEE",
			priceCents: priced ? 1200 : null,
			currency: priced ? "USD" : null,
			title,
		});
		expect(admin).toEqual(domain);
	});
});
