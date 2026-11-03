// Worker entry: Astro's fetch handler plus EmDash's scheduled() handler,
// which the Cron Trigger in wrangler.jsonc drives. PluginBridge is the
// sandbox Durable Object — re-exported so its binding resolves; with no
// LOADER binding configured it is never exercised (ADR-0006: no sandbox
// runner on this deployment).
//
// The scheduled() handler also runs the orphaned-upload sweep once an hour
// (issue #447, `src/lib/download-orphans.ts`): the site holds the private
// DOWNLOADS bucket, and EmDash's runtime lets it ask the plugin, outside any
// request, which file each product names.
import emdashWorker, { PluginBridge } from "@emdash-cms/cloudflare/worker";
import { withEmDashRuntime } from "emdash/middleware";
import {
	currentDownloadOf,
	isOrphanSweepTick,
	ORPHAN_SWEEP_CAPS,
	orphanSweepTickIndex,
	sweepDownloadOrphans,
	type OrphanSweepBucket,
} from "./lib/download-orphans.js";
import { lookupProduct } from "./lib/download-upload.js";
import { DOWNLOADS_BINDING } from "./lib/downloads-bucket.js";

export { PluginBridge };

/** The `DOWNLOADS` binding, or `undefined` when downloads are off. */
function sweepBucketFrom(env: unknown): OrphanSweepBucket | undefined {
	const candidate = (env as Record<string, unknown> | undefined)?.[DOWNLOADS_BINDING];
	if (typeof candidate !== "object" || candidate === null) return undefined;
	const { list, delete: remove } = candidate as Record<string, unknown>;
	return typeof list === "function" && typeof remove === "function"
		? (candidate as OrphanSweepBucket)
		: undefined;
}

async function sweepOrphans(bucket: OrphanSweepBucket, scheduledTime: number): Promise<void> {
	try {
		await withEmDashRuntime((runtime) =>
			sweepDownloadOrphans(
				{
					bucket,
					now: Date.now(),
					currentDownload: async (productId) =>
						currentDownloadOf(
							await lookupProduct(
								(pluginId, method, path, request) =>
									runtime.handlePluginApiRoute(pluginId, method, path, request),
								productId,
								undefined,
								new URL("https://internal/"),
							),
						),
				},
				{ tick: orphanSweepTickIndex(scheduledTime), caps: ORPHAN_SWEEP_CAPS },
			),
		);
	} catch (error) {
		console.error("[site-staging] download orphan sweep failed", error);
	}
}

export default {
	...emdashWorker,
	async scheduled(
		controller: { readonly scheduledTime: number },
		env: unknown,
		ctx: { waitUntil(promise: Promise<unknown>): void },
	): Promise<void> {
		await emdashWorker.scheduled(controller as never, env, ctx as never);
		const bucket = sweepBucketFrom(env);
		if (bucket !== undefined && isOrphanSweepTick(controller.scheduledTime)) {
			ctx.waitUntil(sweepOrphans(bucket, controller.scheduledTime));
		}
	},
};
