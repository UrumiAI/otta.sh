/**
 * The HTTP tier of `commerceClientContract` (work order 02, INC-A7 / D7 tier
 * T5(a)).
 *
 * This file binds the transport-agnostic contract to `HttpCommerceClient` and
 * the four admin HTTP clients over a LIVE `@otta-sh/service` (Postgres-backed)
 * — the same harness the eight source client test files used, and the same
 * `PG_CONNECTION_STRING` gating, so a run without a database skips exactly what
 * it skipped before.
 *
 * It REPLACES the transport-agnostic cases of
 * `http-commerce-client.test.ts`, `http-commerce-client-cart.test.ts` and
 * `admin-rules-client.test.ts`. Each of those files keeps only its HTTP-wire
 * cases (request shape, headers, base-URL joining, status→error mapping); see
 * `test/contracts/README.md` for the classification rule.
 *
 * ⚠ THIS FILE IS DELETED AT INC-D3b together with the HTTP transport. The
 * contract it invokes is what survives — INC-B10a/b/c add a second tier that
 * runs the very same cases with no HTTP anywhere.
 */
import { afterAll, describe } from "vitest";
import { AdminOrdersClient } from "../src/admin/admin-orders-client.js";
import { AdminProductsClient } from "../src/admin/admin-products-client.js";
import { AdminRulesClient } from "../src/admin/admin-rules-client.js";
import { ReportingSettingsClient } from "../src/admin/reporting-client.js";
import type { CommerceClient } from "../src/product-commerce/commerce-client.js";
import { HttpCommerceClient } from "../src/product-commerce/http-commerce-client.js";
import {
	adminOrdersProductsClientContract,
	adminRulesReportingClientContract,
	type AdminClientSurfaces,
	type CommerceClientTier,
	storefrontCommerceClientContract,
} from "./contracts/commerce-client-contract.js";
import { startLiveService, type LiveService } from "./helpers/start-live-service.js";

const PG = process.env.PG_CONNECTION_STRING;

/** The admin gate + write gate secrets the admin tier's service enforces —
 *  exactly the pair `admin-rules-client.test.ts` booted its service with. */
const ADMIN_TOKEN = "admin-secret";
const ADMIN_SERVICE_TOKEN = "svc-secret";

interface HttpTierOptions {
	name: string;
	/** Boot the service with the admin + write gates closed, and thread both
	 *  tokens into every client. Omitted ⇒ a gate-open service and tokenless
	 *  clients, which is how the storefront client tests always ran. */
	gated?: boolean;
}

/**
 * The HTTP tier. `arrange` programs backend state the way the source files
 * already did — through the client's own writes against the live service — so
 * nothing here is invented: `arrange.product` is their `seedProduct` /
 * `parentProduct` helpers, and `arrange.cart` is their `createCart` setup call.
 */
function httpTier(options: HttpTierOptions): CommerceClientTier {
	let service: LiveService | undefined;
	let client: CommerceClient | undefined;

	function baseOptions(): { fetch: typeof globalThis.fetch; baseUrl: string } {
		if (service === undefined) throw new Error("tier not set up");
		return { fetch: globalThis.fetch, baseUrl: service.baseUrl };
	}

	async function clientOrThrow(): Promise<CommerceClient> {
		if (client === undefined) throw new Error("tier not set up");
		return client;
	}

	return {
		name: options.name,
		async setup() {
			if (service !== undefined) return; // one service per tier, however many slices ask
			service = await startLiveService(
				options.gated === true
					? { internalToken: ADMIN_TOKEN, serviceToken: ADMIN_SERVICE_TOKEN }
					: {},
			);
			client = new HttpCommerceClient({
				...baseOptions(),
				...(options.gated === true ? { serviceToken: ADMIN_SERVICE_TOKEN } : {}),
			});
		},
		async teardown() {
			if (service === undefined) return;
			await service.stop();
			service = undefined;
			client = undefined;
		},
		async reset() {
			// A DOCUMENTED NO-OP for this tier. The live service owns one isolated
			// Postgres schema for the whole slice and the lifted cases address
			// disjoint product ids, skus, cart ids and idempotency keys — which is
			// how they always ran. Dropping and re-migrating a schema per case
			// would be a behavioural change (and minutes of runtime) for no gained
			// assertion. A tier whose backend is cheap to rebuild does the real
			// thing here instead.
		},
		makeClient: clientOrThrow,
		async makeAdminClients(): Promise<AdminClientSurfaces> {
			const shared = {
				...baseOptions(),
				...(options.gated === true
					? { adminToken: ADMIN_TOKEN, serviceToken: ADMIN_SERVICE_TOKEN }
					: {}),
			};
			return {
				orders: new AdminOrdersClient(shared),
				products: new AdminProductsClient(shared),
				rules: new AdminRulesClient(shared),
				reporting: new ReportingSettingsClient(shared),
			};
		},
		arrange: {
			async product(spec) {
				const c = await clientOrThrow();
				await c.upsertProductCommerce(
					spec.productId,
					{
						sku: spec.sku,
						...(spec.price !== undefined ? { price: spec.price } : {}),
						...(spec.title !== undefined ? { title: spec.title } : {}),
						...(spec.onHand !== undefined ? { initialOnHand: spec.onHand } : {}),
					},
					spec.idempotencyKey,
				);
				return spec.productId;
			},
			async cart(currency) {
				const c = await clientOrThrow();
				const { cartId } = await c.createCart(currency);
				return cartId;
			},
		},
	};
}

const storefront = httpTier({ name: "http, live @otta-sh/service, Postgres" });
const admin = httpTier({ name: "http, live @otta-sh/service, Postgres", gated: true });

describe.skipIf(PG === undefined)("commerceClientContract over HttpCommerceClient", () => {
	afterAll(async () => {
		await storefront.teardown();
	});
	storefrontCommerceClientContract(storefront);
});

describe.skipIf(PG === undefined)("commerceClientContract over the admin HTTP clients", () => {
	afterAll(async () => {
		await admin.teardown();
	});
	adminRulesReportingClientContract(admin);
	// Bound to the GATED tier like its sibling slice: the admin surface needs both
	// the admin gate and the write gate closed, or INC-B10b's first case would be
	// written against a service that never enforces them. It contributes no cases
	// yet — it only holds this tier to the slice's requirements.
	adminOrdersProductsClientContract(admin);
});
