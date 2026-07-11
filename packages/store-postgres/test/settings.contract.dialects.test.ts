import { settingsStoreContract } from "@urumi/domain/testing";
import { afterEach } from "vitest";
import {
	makePgSettingsHarness,
	makeSqliteSettingsHarness,
	PG_ENABLED,
	teardownDialects,
} from "./describe-each-dialect.js";

// Phase 7 §7 Step 3: the shared SettingsStore contract on BOTH dialects.
afterEach(teardownDialects);

settingsStoreContract(makeSqliteSettingsHarness, { dialect: "sqlite" });
if (PG_ENABLED) settingsStoreContract(makePgSettingsHarness, { dialect: "postgres" });
