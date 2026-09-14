/**
 * The workerd suites' document store: a REAL `PluginStorageRepository` per
 * declared collection, over in-memory SQLite migrated by the host's own
 * migration set, exposed to the isolate over a loopback JSON bridge.
 *
 * WHY A BRIDGE. A document store is a database, and the isolate has neither a
 * driver nor any business acquiring one — in a deploy the host holds the database
 * and the plugin is handed collection objects across its own bridge. These suites
 * mirror that: the store lives HERE, in Node, and the worker's `ctx.storage` is a
 * proxy whose nine methods are one round trip each. So the suites exercise the
 * plugin's real storage code paths against the real implementation, which is what
 * the sandbox suites exist to prove. They prove nothing about the HOST's own
 * bridge, and must not be read as doing so.
 *
 * REAL DATABASE, NEVER A FAKE, and it is built by the adapter package's own
 * dialect harness rather than by a second copy of that wiring here — which is
 * where the rules that make it correct live (the schema always comes from the
 * host's migrations, because the revision a guarded write compares is assigned by
 * a trigger only they create), and which is what keeps the host and the driver out
 * of this package's dependencies entirely.
 *
 * ONE STORE PER PROCESS, reused across boots. The migration set is large and each
 * suite boots the worker repeatedly; paying for it once per worker process is the
 * difference between seconds and minutes. Cases address disjoint ids, exactly as
 * the sandbox suites already do for kv.
 *
 * ERRORS CROSS THE BRIDGE STRUCTURALLY. The adapters test storage failures by
 * SHAPE rather than by `instanceof` — a retryable serialization abort carries a
 * `code` and a `retryable` flag, a non-indexed-field error carries a `name` — for
 * exactly this reason: an error that travelled over a bridge is a plain object on
 * the other side. The reply therefore carries those fields and the proxy rebuilds
 * an `Error` with them, so the structural tests hold inside the isolate.
 */
import { createServer, type Server } from "node:http";
import { makeSqliteStorage } from "@otta-sh/store-emdash/testing";
import type { StorageAccess } from "@otta-sh/store-emdash";
import { commerceStorageLayout } from "./storage-layout.js";

/** The nine methods a collection answers. Anything else is rejected by name. */
const METHODS = [
	"get",
	"put",
	"delete",
	"query",
	"count",
	"updateIf",
	"getVersioned",
	"compareAndSet",
	"compareAndDelete",
] as const;

export interface StorageBridge {
	/** Base URL the worker's proxy calls, e.g. `http://127.0.0.1:1234`. */
	readonly baseUrl: string;
	/** The Node-side store, for a test that wants to assert on documents directly. */
	readonly storage: StorageAccess;
}

let started: Promise<StorageBridge> | undefined;

/** The failure fields the proxy needs to rebuild a structurally-equivalent error. */
function serializeError(err: unknown): Record<string, unknown> {
	const source = (err ?? {}) as Record<string, unknown>;
	return {
		message: err instanceof Error ? err.message : String(err),
		name: err instanceof Error ? err.name : "Error",
		...(source.code === undefined ? {} : { code: source.code }),
		...(source.retryable === undefined ? {} : { retryable: source.retryable }),
		...(source.sqlState === undefined ? {} : { sqlState: source.sqlState }),
		...(source.field === undefined ? {} : { field: source.field }),
		...(source.suggestion === undefined ? {} : { suggestion: source.suggestion }),
	};
}

/**
 * Start the bridge, or hand back the one this process already started. Never torn
 * down inside a run: it is process-scoped by design, and the process exit closes
 * the socket and drops the in-memory database with it.
 */
export function storageBridge(): Promise<StorageBridge> {
	started ??= start();
	return started;
}

async function start(): Promise<StorageBridge> {
	const { storage } = await makeSqliteStorage(commerceStorageLayout());

	const server: Server = createServer((req, res) => {
		void (async () => {
			const chunks: Buffer[] = [];
			for await (const chunk of req) chunks.push(chunk as Buffer);
			const reply = (status: number, body: unknown): void => {
				res.writeHead(status, { "content-type": "application/json" });
				res.end(JSON.stringify(body));
			};
			try {
				const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
					collection?: unknown;
					method?: unknown;
					args?: unknown;
				};
				const name = typeof call.collection === "string" ? call.collection : "";
				const collection = storage[name];
				if (collection === undefined) {
					reply(404, { error: serializeError(new Error(`unknown collection '${name}'`)) });
					return;
				}
				const method = METHODS.find(
					(candidate) => typeof call.method === "string" && candidate === call.method,
				);
				if (method === undefined) {
					reply(400, {
						error: serializeError(new Error(`unknown method '${String(call.method)}'`)),
					});
					return;
				}
				const args = Array.isArray(call.args) ? call.args : [];
				const target = collection as unknown as Record<string, (...rest: unknown[]) => unknown>;
				// The name came from the closed list above, and the collection must
				// actually answer it — a repository missing one of the nine is a wiring
				// fault worth a loud reply rather than "x is not a function" in the isolate.
				if (typeof target[method] !== "function") {
					reply(400, { error: serializeError(new Error(`collection cannot ${method}`)) });
					return;
				}
				const result = await target[method]!(...args);
				// `undefined → null`, because JSON has no undefined: `put` and `delete`
				// resolve void/boolean, and a void reply crosses as null and is read back
				// as a void. The methods that return a document already answer `null` for
				// "absent", so nothing ambiguous is created by the coercion.
				reply(200, { result: result ?? null });
			} catch (err) {
				reply(500, { error: serializeError(err) });
			}
		})();
	});

	const port = await new Promise<number>((resolve, reject) => {
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			resolve(typeof address === "object" && address !== null ? address.port : 0);
		});
	});
	// The bridge must never hold the test process open after the run finishes.
	server.unref();

	return { baseUrl: `http://127.0.0.1:${port}`, storage };
}

/**
 * The module the harness writes over the scratch copy of `src/sandbox-storage.ts`
 * — the worker side of the bridge, so the REAL source keeps its single sanctioned
 * `fetch` call site and the egress guard stays as strict as it is.
 *
 * Every collection is a proxy: one method call, one round trip, arguments and
 * results as JSON. The documents are JSON by construction (dates are ISO text,
 * never `Date` instances), so nothing is lost across it.
 */
export function sandboxStorageSource(
	bridgeBaseUrl: string,
	collections: readonly string[],
): string {
	return [
		`const BRIDGE = ${JSON.stringify(bridgeBaseUrl)};`,
		`const COLLECTIONS = ${JSON.stringify([...collections])};`,
		`const METHODS = ${JSON.stringify([...METHODS])};`,
		"",
		"async function call(collection, method, args) {",
		"\tconst res = await globalThis.fetch(BRIDGE, {",
		'\t\tmethod: "POST",',
		'\t\theaders: { "content-type": "application/json" },',
		"\t\tbody: JSON.stringify({ collection, method, args }),",
		"\t});",
		"\tconst body = await res.json();",
		"\tif (body.error !== undefined) {",
		"\t\t// Rebuilt with its fields, because the adapters test storage failures by",
		"\t\t// SHAPE: a retryable abort must still look retryable on this side.",
		"\t\tconst err = new Error(body.error.message);",
		"\t\tfor (const [key, value] of Object.entries(body.error)) {",
		'\t\t\tif (key !== "message") err[key] = value;',
		"\t\t}",
		"\t\tthrow err;",
		"\t}",
		"\treturn body.result;",
		"}",
		"",
		"const STORAGE = Object.fromEntries(",
		"\tCOLLECTIONS.map((name) => [",
		"\t\tname,",
		"\t\tObject.fromEntries(",
		"\t\t\tMETHODS.map((method) => [method, (...args) => call(name, method, args)]),",
		"\t\t),",
		"\t]),",
		");",
		"",
		"export function sandboxStorage() {",
		"\treturn STORAGE;",
		"}",
		"",
	].join("\n");
}
