/**
 * `entitlements/download`'s delivery gate, the handler called in-process over a
 * real document store (SQLite). The same contract runs inside the workerd
 * sandbox in `download-route.sandbox.test.ts`; storage pressure is pinned in
 * `download-route-busy.test.ts`.
 */
import type { StorageAccess } from "@otta-sh/store-emdash";
import { email as toEmail } from "@otta-sh/domain";
import { afterAll, beforeAll } from "vitest";
import { createEntitlementDownloadHandler } from "../src/entitlements/download-route.js";
import { downloadRouteContract } from "./contracts/download-route-contract.js";
import {
	makeInProcessCommerce,
	type InProcessCommerceHarness,
} from "./helpers/in-process-commerce.js";

let harness: InProcessCommerceHarness;

beforeAll(async () => {
	harness = await makeInProcessCommerce();
});

afterAll(async () => {
	await harness?.close();
});

downloadRouteContract({
	name: "in-process",
	ns: "dlip",
	storage: () => harness.ctx.storage as StorageAccess,
	async invoke(input) {
		return createEntitlementDownloadHandler()(
			{ input: input as never, request: { method: "POST", url: "/route", headers: {} } },
			harness.ctx,
		);
	},
	async loginSession(address) {
		const issued = await harness.stores.credentialVerifier.issueChallenge(toEmail(address));
		if (!issued.ok) throw new Error("login: challenge not issued");
		const verified = await harness.client.verifyLogin(issued.challengeId, issued.token);
		if (!verified.ok) throw new Error("login: verify failed");
		return verified.sessionToken;
	},
});
