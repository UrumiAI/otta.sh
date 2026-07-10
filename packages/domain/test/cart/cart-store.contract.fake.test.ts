import { cartStoreContract } from "@urumi/domain/testing";
import { makeFakeCartHarness } from "./fake-harness.js";

// The reusable cart behavioral spec (§1 cases 1–8) runs against its first
// adapter — the IO-free fake — before any DB dialect (re-run in store-postgres).
cartStoreContract(async () => makeFakeCartHarness(), { dialect: "fake" });
