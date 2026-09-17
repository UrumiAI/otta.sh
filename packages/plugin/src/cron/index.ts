/**
 * The `cron` hook and the moment its task is registered (INC-C4).
 *
 * TWO HALVES, and both are needed. `ctx.cron` is capability-free — there is no
 * `cron` string in the host's capability vocabulary, exactly as there is none for
 * `storage` — but a hook with no registered task NEVER FIRES: the executor claims
 * DUE ROWS from its own task table (`_emdash_cron_tasks`) and invokes the `cron`
 * hook once per due row. It collects nothing from the plugins themselves. So the
 * plugin must both DECLARE the hook and SCHEDULE the task, and if it never
 * schedules, every sweep in this directory is dead code in production.
 *
 * WHY `plugin:activate` IS NOT ENOUGH, which is the defect this file used to have.
 * The host fires `plugin:activate` from exactly one place — `setPluginStatus(id,
 * "active")`, reached only from the admin's `POST /api/admin/plugins/{id}/enable`
 * route. Otta is registered in the SITE CONFIG's `plugins` array, so it is enabled
 * by absence: `isPluginEnabled` treats a plugin with no status row as active, its
 * hooks and routes run from the first request, and nobody ever toggles it. A
 * config-array deployment therefore reaches `plugin:activate` NEVER, and the first
 * cut of this file scheduled the task only from there and from the tick — a tick
 * that cannot happen until something schedules. Registration could not bootstrap
 * itself.
 *
 * SO REGISTRATION HANGS OFF A PATH THAT ACTUALLY FIRES. The host wires
 * `cronReschedule` into BOTH the hook-pipeline context factory and the per-route
 * `PluginRouteRegistry`, so `ctx.cron` is present on every hook invocation and
 * every route invocation. `withSweepBootstrap` wraps handlers that a live
 * deployment is certain to reach — the four content-sync hooks and the two public
 * storefront routes — and each wrapped handler ensures the task exists before
 * doing its own work. No host hook list changes and no call site outside this
 * package is touched: the plugin bootstraps its own schedule.
 *
 * MEMOIZED PER ISOLATE, because those paths fire on every product save and every
 * PDP render and the registration is a database UPSERT. A module-scoped latch
 * makes it one write per isolate; a failure CLEARS the latch so the next request
 * retries rather than leaving the deployment permanently unscheduled.
 *
 * AND IT NEVER FAILS ITS HOST HANDLER. A storefront page must not 500 because the
 * sweep schedule could not be written. The bootstrap swallows and logs, which is
 * safe precisely because it is retried on the next request.
 *
 * The tick still RE-AFFIRMS its own registration on top of all that.
 * `CronAccess.schedule` is an upsert on `(plugin, task)`, so re-affirming is free
 * and idempotent, and it means a schedule CHANGE lands on the next tick instead of
 * waiting for a redeploy.
 */
import type { CronEvent, CronTaskInfo, HookHandler, PluginContext } from "../types.js";
import type { PluginLifecycleEvent } from "../types.js";
import {
	runCommerceSweeps,
	type CommerceSweepOptions,
	type CommerceSweepSummary,
} from "./sweeps.js";

/** The task name this plugin registers. One task drives all nine legs: they share
 *  a store composition and a clock, and splitting them would buy nothing but nine
 *  rows contending on the same documents. */
export const SWEEP_TASK_NAME = "commerce-sweeps";

/** Every fifteen minutes — the cadence the standalone service ran its
 *  `scheduled()` handler on (`packages/service/wrangler.jsonc`), carried over
 *  unchanged. The site's own Cron Trigger fires every minute; that drives the
 *  host's EXECUTOR, and this is what decides when the task is due. */
export const SWEEP_SCHEDULE = "*/15 * * * *";

/** What `ensureSweepTaskScheduled` reports, so a caller (and a suite) can see
 *  whether the runtime wired cron at all — and, through `tasks`, what the HOST
 *  now says is registered rather than merely what this call asked for. */
export interface SweepScheduleOutcome {
	readonly scheduled: boolean;
	readonly task: string;
	readonly schedule: string;
	/** The host's own `ctx.cron.list()`, read back after the upsert. Empty when the
	 *  runtime wired no cron. This is the only way anything — an operator, a
	 *  suite — can see that the registration actually took, since the executor
	 *  persists no hook result. */
	readonly tasks: readonly CronTaskInfo[];
}

/**
 * Register the sweep task, idempotently, and report what the host now holds.
 *
 * A runtime with no cron executor hands over no `ctx.cron`; that is reported as
 * `scheduled: false` rather than thrown, because a plugin is still perfectly
 * usable without a scheduler — it just has no sweeps, which is a deployment fact
 * the operator should see, not a boot failure.
 */
export async function ensureSweepTaskScheduled(ctx: PluginContext): Promise<SweepScheduleOutcome> {
	const cron = ctx.cron;
	if (cron === undefined) {
		return { scheduled: false, task: SWEEP_TASK_NAME, schedule: SWEEP_SCHEDULE, tasks: [] };
	}
	await cron.schedule(SWEEP_TASK_NAME, { schedule: SWEEP_SCHEDULE });
	// READ BACK. The upsert resolving proves the call was made; only the host's own
	// list proves a row exists, and that distinction is the whole bug this file had.
	return {
		scheduled: true,
		task: SWEEP_TASK_NAME,
		schedule: SWEEP_SCHEDULE,
		tasks: await cron.list(),
	};
}

/**
 * The per-isolate latch. Module scope is the right scope: it is one isolate's
 * lifetime, so a long-lived worker pays one write and a fresh isolate re-affirms —
 * which is also how a schedule change eventually reaches a deployment that is
 * never toggled.
 */
let bootstrapped = false;

/** Reset the latch. Exported for suites, which must be able to drive the
 *  bootstrap more than once in one process. */
export function resetSweepBootstrapForTest(): void {
	bootstrapped = false;
}

/**
 * Ensure the task exists, at most once per isolate, never throwing.
 *
 * The latch is set BEFORE the await and cleared on failure: concurrent first
 * requests then make one attempt between them rather than a thundering herd, and a
 * failed attempt still leaves the next request free to retry.
 */
export async function bootstrapSweepTask(ctx: PluginContext): Promise<void> {
	if (bootstrapped) return;
	bootstrapped = true;
	try {
		const outcome = await ensureSweepTaskScheduled(ctx);
		if (!outcome.scheduled) {
			// Not an error: a runtime with no cron executor is a valid deployment. But
			// it means no sweeps run, which an operator should be able to find out.
			console.info("[otta] cron sweep task not registered — this runtime wired no cron");
		}
	} catch (err) {
		bootstrapped = false;
		console.error("[otta] cron sweep task registration failed (will retry):", err);
	}
}

/**
 * Wrap a handler so that reaching it also ensures the sweep task is registered.
 *
 * Applied to handlers a live deployment certainly reaches (see this module's head
 * comment). Generic over both the handler's first argument and its return, because
 * a HOOK handler and a ROUTE handler differ in both — what they share is the
 * plugin context in second position, which is the only thing this wrapper needs.
 * The wrapped handler's own behaviour is untouched (same argument, same value,
 * same failures), since the bootstrap cannot throw.
 */
export function withSweepBootstrap<A, R>(
	handler: (first: A, ctx: PluginContext) => R,
): (first: A, ctx: PluginContext) => Promise<R> {
	return async (first, ctx) => {
		await bootstrapSweepTask(ctx);
		return handler(first, ctx);
	};
}

/** The `plugin:activate` handler: the host's own registration moment. Still
 *  declared — it IS the right moment when an operator toggles the plugin from the
 *  admin, and it is the path a marketplace install takes — but no longer the only
 *  one, because a config-array deployment never reaches it. */
export function createActivateHandler(): HookHandler<PluginLifecycleEvent> {
	return async (_event, ctx) => await ensureSweepTaskScheduled(ctx);
}

/**
 * The `cron` handler.
 *
 * DISPATCHES ON `event.name`, like every multi-task cron plugin: a task this
 * plugin did not register is not this plugin's work, and answering it would be a
 * lie about what ran.
 *
 * NEVER REJECTS on a leg failure — `runCommerceSweeps` catches per leg and reports
 * — because a rejected cron hook is a task the executor retries wholesale, which
 * would re-run the eight legs that worked.
 *
 * AND THE RE-AFFIRMATION IS INSIDE THE GUARD, which it was not in the first cut: an
 * `ensureSweepTaskScheduled` awaited before the try block would reject the whole
 * hook if the host's task table were briefly unavailable, taking down all nine
 * sweeps for a bookkeeping write none of them needs. The row that made this tick
 * happen already exists; re-affirming it is an optimisation, so it is reported as
 * a failed "leg" and stepped over.
 */
export function createCronHandler(options: CommerceSweepOptions = {}): HookHandler<CronEvent> {
	return async (event, ctx): Promise<CommerceSweepSummary | { task: string; skipped: true }> => {
		const name = typeof event?.name === "string" ? event.name : "";
		if (name !== SWEEP_TASK_NAME) return { task: name, skipped: true };
		try {
			// Free, upsert-shaped, and it lets a schedule change take effect on the next
			// tick rather than on the next isolate.
			await ensureSweepTaskScheduled(ctx);
		} catch (err) {
			console.error("[otta] cron sweep re-affirmation failed (sweeps still run):", err);
		}
		return await runCommerceSweeps(ctx, name, options);
	};
}

export {
	runCommerceSweeps,
	SWEEP_LEGS,
	type CommerceSweepOptions,
	type CommerceSweepSummary,
	type SweepCursorStore,
	type SweepLeg,
	type SweepLegOutcome,
} from "./sweeps.js";
