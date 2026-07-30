import {
	couponStoreContract,
	shippingRulesStoreContract,
	taxRulesStoreContract,
} from "@otta-sh/domain/testing";
import { afterEach } from "vitest";
import {
	makePgCouponHarness,
	makePgShippingHarness,
	makePgTaxHarness,
	makeSqliteCouponHarness,
	makeSqliteShippingHarness,
	makeSqliteTaxHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

afterEach(teardownDialects);

// SQLite runs everywhere; Postgres only when PG_CONNECTION_STRING is present.
shippingRulesStoreContract(makeSqliteShippingHarness, { dialect: "sqlite" });
taxRulesStoreContract(makeSqliteTaxHarness, { dialect: "sqlite" });
couponStoreContract(makeSqliteCouponHarness, { dialect: "sqlite" });

if (PG_ENABLED) {
	shippingRulesStoreContract(makePgShippingHarness, { dialect: "postgres" });
	taxRulesStoreContract(makePgTaxHarness, { dialect: "postgres" });
	couponStoreContract(makePgCouponHarness, { dialect: "postgres" });
}
