/**
 * The `cron` hook and the moment its task is registered (INC-C4).
 *
 * TWO HALVES, and both are needed. `ctx.cron` is capability-free — there is no
 * `cron` string in the host's capability vocabulary, exactly as there is none for
 * `storage` — but a hook with no registered task never fires: the executor claims
 * DUE ROWS from its own task table and invokes the `cron` hook once per due task.
 * So the plugin must both DECLARE the hook and SCHEDULE the task.
 *
 * WHERE THE SCHEDULING HAPPENS. `plugin:activate` is the host's own answer, and it
 * is what EmDash's bundled plugins use. It is also not quite enough on its own: a
 * CONFIGURED (hand-registered) plugin has no install/activate handshake to hang
 * off — the runtime fires `plugin:activate` from `setPluginStatus(id, "active")`,
 * i.e. an admin toggle — so a deployment that never toggles the plugin could have
 * a declared hook and no row.
 *
 * Hence the tick RE-AFFIRMS its own registration. `CronAccess.schedule` is an upsert
 * on `(plugin, task)`, so re-affirming is free and idempotent, and it means a
 * schedule CHANGE lands on the next tick instead of waiting for a re-activation.
 * It does not bootstrap a plugin that was never scheduled at all; that gap is
 * reported rather than papered over, because closing it means a call site outside
 * this package.
 */
import type { CronEvent, HookHandler, PluginContext, PluginLifecycleEvent } from "../types.js";
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
 *  whether the runtime wired cron at all. */
export interface SweepScheduleOutcome {
	readonly scheduled: boolean;
	readonly task: string;
	readonly schedule: string;
}

/**
 * Register the sweep task, idempotently.
 *
 * A runtime with no cron executor hands over no `ctx.cron`; that is reported as
 * `scheduled: false` rather than thrown, because a plugin is still perfectly
 * usable without a scheduler — it just has no sweeps, which is a deployment fact
 * the operator should see, not a boot failure.
 */
export async function ensureSweepTaskScheduled(ctx: PluginContext): Promise<SweepScheduleOutcome> {
	if (ctx.cron === undefined) {
		return { scheduled: false, task: SWEEP_TASK_NAME, schedule: SWEEP_SCHEDULE };
	}
	await ctx.cron.schedule(SWEEP_TASK_NAME, { schedule: SWEEP_SCHEDULE });
	return { scheduled: true, task: SWEEP_TASK_NAME, schedule: SWEEP_SCHEDULE };
}

/** The `plugin:activate` handler: the host's own registration moment. */
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
 */
export function createCronHandler(options: CommerceSweepOptions = {}): HookHandler<CronEvent> {
	return async (event, ctx): Promise<CommerceSweepSummary | { task: string; skipped: true }> => {
		const name = typeof event?.name === "string" ? event.name : "";
		if (name !== SWEEP_TASK_NAME) return { task: name, skipped: true };
		// Free, upsert-shaped, and it lets a schedule change take effect on the next
		// tick rather than on the next activation.
		await ensureSweepTaskScheduled(ctx);
		return await runCommerceSweeps(ctx, name, options);
	};
}

export {
	runCommerceSweeps,
	SWEEP_LEGS,
	type CommerceSweepOptions,
	type CommerceSweepSummary,
	type SweepLeg,
	type SweepLegOutcome,
} from "./sweeps.js";
