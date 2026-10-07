import {
	InMemoryReportingStore,
	reportingStoreContract,
	type ReportingStoreHarness,
} from "@otta-sh/domain/testing";

// Proves the contract suite is real against the IO-free fake before any DB
// (mirrors the Phase-0/1 fake-first convention).
reportingStoreContract(
	async (): Promise<ReportingStoreHarness> => {
		const store = new InMemoryReportingStore();
		return {
			store,
			async seedOrder(row) {
				store.seedOrder(row);
			},
			async seedOrderItem(row) {
				store.seedOrderItem(row);
			},
			async seedInventory(row) {
				store.seedInventory(row);
			},
			async seedProduct(row) {
				store.seedProduct(row);
			},
			async seedRefund(row) {
				store.seedRefund(row);
			},
		};
	},
	{ dialect: "in-memory-fake" },
);
