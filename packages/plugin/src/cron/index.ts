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
 * The host fires `plugin:activate` from the admin's enable toggle (`setPluginStatus`)
 * and from the marketplace/registry install and update lifecycles — and, since
 * EmDash 1.2, once at the first boot of a config-array plugin with no state row
 * (see `createActivateHandler`). Otta is registered in the SITE CONFIG's `plugins`
 * array; before EmDash 1.2 it is enabled by absence (`isPluginEnabled` treats a
 * plugin with no status row as active), its hooks and routes run from the first
 * request, and nobody ever toggles it. A config-array deployment before 1.2 therefore
 * reaches `plugin:activate` NEVER, and even on 1.2+ that single attempt is not
 * retried by the host. The first cut of this file scheduled the task only from there and from the tick — a tick
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
 * The tick goes through the same latched bootstrap, so a cron-only isolate (one
 * that served no request) still re-affirms once. Re-affirming READS first and
 * upserts only when the host's row differs, so a schedule CHANGE lands on the
 * first isolate after a deploy at the cost of one write, and an unchanged one
 * costs a read per isolate — not a write per minute.
 */
import type { HostCronAccess } from "@urumi.ai/otta-store-emdash";
import { encryptStoredPaymentSecrets } from "../encrypt-payment-secrets.js";
import type { CronAccess, CronEvent, CronTaskInfo, HookHandler, PluginContext } from "../types.js";
import type { PluginLifecycleEvent } from "../types.js";
import {
	runCommerceSweeps,
	type CommerceSweepOptions,
	type CommerceSweepSummary,
} from "./sweeps.js";

/** The task name this plugin registers. One task drives all twelve legs: they share
 *  a store composition and a clock, and splitting them would buy nothing but twelve
 *  rows contending on the same documents.
 *
 *  Splitting would NOT buy isolation from a slow leg either, which is the obvious
 *  reason to want it: EmDash 1.0.1's executor (`src/plugins/cron.ts`, `tick`) claims
 *  due rows and invokes their hooks ONE AFTER ANOTHER in a single scheduled event,
 *  each under its own timeout, and a timed-out hook is only raced, never cancelled
 *  (`src/plugins/hooks.ts`, `executeWithTimeout`) — it keeps running unobserved. Twelve
 *  tasks could therefore hold the event for twelve timeouts back to back. One task
 *  with its own time budget (`SWEEP_TICK_BUDGET_MS`) stops cleanly instead. */
export const SWEEP_TASK_NAME = "commerce-sweeps";

/**
 * Every minute — the resolution of the site's own Worker Cron Trigger, which
 * drives the host's EXECUTOR; this is what decides when the task is due.
 *
 * It was every fifteen minutes, carried over from the standalone service, whose reason (let a
 * serverless Postgres origin autosuspend between ticks) left with that service:
 * commerce lives in the site's own D1 now, which the executor already touches
 * every minute. Under a one-minute trigger the fifteen-minute task meant a
 * fifteen-minute cart or order hold actually lasted fifteen to thirty, and a
 * queued email waited up to fifteen. The scans whose read cost the old cadence
 * was bounding keep it, per leg (`MAINTENANCE_LEGS` in `sweeps.ts`).
 *
 * A deployment registered under the old cadence moves on its own: the
 * per-isolate bootstrap re-affirms the task, and finding the old schedule it
 * upserts the new one.
 */
export const SWEEP_SCHEDULE = "* * * * *";

/**
 * The `cron` hook's timeout, DECLARED on the hook (`plugin.ts`) rather than
 * inherited from the host's 5000 ms default, because the tick's budget is derived
 * from it and a test pins the two together.
 *
 * FIFTEEN SECONDS, raised from the default so that one email send of a
 * slow-but-working provider fits inside a tick (`SWEEP_EMAIL_SEND_TIMEOUT_MS`,
 * 5 s, under a 9.5 s budget). The cost, accepted: EmDash 1.0.1's executor runs due
 * tasks one after another in a single scheduled event, so a long tick delays any
 * OTHER plugin's task due in the same minute by up to this much. That is
 * acceptable because the tick budgets itself well inside it (it ends at 9.5 s,
 * and usually far sooner — on Workers Free the query budget ends it first), cron
 * granularity is a minute anyway, and the time is wall time spent waiting on I/O,
 * not CPU, so Workers Free's CPU limit is unaffected.
 *
 * On timeout the host only stops WAITING (a `Promise.race`); the hook's work may
 * carry on unobserved in the background, or be cut off when the scheduled event
 * ends — neither is something to rely on, which is why the tick budgets itself.
 */
export const SWEEP_HOOK_TIMEOUT_MS = 15_000;

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
	const cron: HostCronAccess | undefined = ctx.cron;
	if (cron === undefined) {
		return { scheduled: false, task: SWEEP_TASK_NAME, schedule: SWEEP_SCHEDULE, tasks: [] };
	}
	// Check the reverse assignment too, so neither shape can silently lose a method.
	const mirrored: CronAccess = cron;
	void mirrored;
	// READ FIRST, write only on a difference. The host's `schedule` is an upsert
	// that also resets the row's `next_run_at`; issued from inside a running tick it
	// nudges the very row the executor is about to reschedule, and issued on every
	// request path it is a database write per isolate for nothing. A row that
	// already says this name at this cadence needs no write at all.
	const existing = await cron.list();
	if (existing.some((task) => task.name === SWEEP_TASK_NAME && task.schedule === SWEEP_SCHEDULE)) {
		return { scheduled: true, task: SWEEP_TASK_NAME, schedule: SWEEP_SCHEDULE, tasks: existing };
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

/** How long `plugin:activate`, and the first-request bootstrap, may spend
 *  registering the task before giving up (activate reports `scheduled: false`; the
 *  bootstrap lets the request proceed). The bootstrap's share comes out of a
 *  content after-hook's 5 s host timeout (after-hooks run in waitUntil, so a save
 *  is not blocked). Well under the host's 5000 ms default hook
 *  timeout: a timeout is a FAILED hook to the host, with the same consequence as a
 *  throw (see `createActivateHandler`). */
export const ACTIVATE_SCHEDULE_BUDGET_MS = 3_000;

/** Sentinel for a registration that outran its budget. */
const SCHEDULE_TIMED_OUT = Symbol("schedule-timed-out");

/**
 * Race a registration against `ACTIVATE_SCHEDULE_BUDGET_MS`. Resolves to the
 * attempt's value, rejects with its error, or resolves to `SCHEDULE_TIMED_OUT`.
 * Shared by activate and the bootstrap so the two cannot drift. The attempt is not
 * cancelled (it cannot be); a late rejection has nobody awaiting it, so it is
 * observed here rather than surfacing as an unhandled rejection — each caller
 * logs the failure it cares about. The timer is always cleared.
 */
async function raceScheduleBudget<T>(attempt: Promise<T>): Promise<T | typeof SCHEDULE_TIMED_OUT> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	attempt.catch(() => {});
	const deadline = new Promise<typeof SCHEDULE_TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(SCHEDULE_TIMED_OUT), ACTIVATE_SCHEDULE_BUDGET_MS);
	});
	try {
		return await Promise.race([attempt, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Ensure the task exists, at most once per isolate, never throwing.
 *
 * The latch is set BEFORE the await and cleared on failure: concurrent first
 * requests then make one attempt between them rather than a thundering herd, and a
 * failed attempt still leaves the next request free to retry.
 *
 * BOUNDED by `ACTIVATE_SCHEDULE_BUDGET_MS`: every first request in the isolate
 * awaits this, so a stalled cron table must not hang the storefront. A timeout is
 * logged and the caller proceeds, but the latch STAYS SET: it follows the attempt,
 * not the timer. Releasing it on the timer would make a slow-but-working table (or
 * a stalled one) loop forever — every ~3 s one request per isolate would pay the
 * budget, log, and start another `list()`. Instead the abandoned attempt keeps
 * running, and settles the latch itself: a late SUCCESS leaves it set (the isolate
 * is done); a late REJECTION clears it, with a log line, so a later request
 * retries. The abandoned attempt never SETS the latch, it only clears it. So at
 * most one attempt is ever in flight per isolate.
 *
 * Caveat, stated plainly: an attempt that never settles leaves the latch set for
 * the isolate's lifetime (as before this budget existed), and the cron tick does
 * not rescue that isolate, because the tick runs this same latched bootstrap. A
 * fresh isolate re-affirms. In sandboxed mode the abandoned bridge call is cut off
 * when its request ends and rejects, which clears the latch.
 */
export async function bootstrapSweepTask(ctx: PluginContext): Promise<void> {
	if (bootstrapped) return;
	bootstrapped = true;
	const attempt = ensureSweepTaskScheduled(ctx);
	try {
		const outcome = await raceScheduleBudget(attempt);
		if (outcome === SCHEDULE_TIMED_OUT) {
			console.error(
				`[otta] cron sweep task registration exceeded ${String(ACTIVATE_SCHEDULE_BUDGET_MS)} ms (continuing; a late failure will release the latch)`,
			);
			// Also keeps the late rejection observed (no unhandled rejection).
			attempt.catch((err: unknown) => {
				bootstrapped = false;
				console.error(
					"[otta] cron sweep task registration failed after its budget (will retry):",
					err,
				);
			});
		} else if (!outcome.scheduled) {
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

/** The `plugin:activate` handler: the host's own registration moment — an
 *  operator's admin enable toggle, a marketplace install, and, since EmDash 1.2,
 *  the FIRST BOOT of a config-array deployment (the host runs install → activate
 *  once for a config plugin with no state row). Not the only moment: before
 *  EmDash 1.2 a config-array deployment never reaches it, hence the bootstrap.
 *
 *  NEVER FAILS — neither rejects nor outruns the host's hook timeout. On that
 *  first-boot path a failed hook (a throw OR a timeout) makes the host DISABLE the
 *  plugin and its cron, and never retry — so a transient or stalled cron-table call
 *  would take the whole store offline until an operator re-enabled it. A failure
 *  here, or a registration slower than `ACTIVATE_SCHEDULE_BUDGET_MS`, is logged and
 *  reported as unscheduled instead. The activate path does not touch the
 *  bootstrap latch, so the next request (or tick, once a task row exists) retries
 *  the registration through `bootstrapSweepTask`. */
export function createActivateHandler(): HookHandler<PluginLifecycleEvent> {
	return async (_event, ctx) => {
		const unscheduled: SweepScheduleOutcome = {
			scheduled: false,
			task: SWEEP_TASK_NAME,
			schedule: SWEEP_SCHEDULE,
			tasks: [],
		};
		try {
			const result = await raceScheduleBudget(ensureSweepTaskScheduled(ctx));
			if (result === SCHEDULE_TIMED_OUT) {
				console.error(
					`[otta] cron sweep task registration on activate exceeded ${String(ACTIVATE_SCHEDULE_BUDGET_MS)} ms (will retry)`,
				);
				return unscheduled;
			}
			return result;
		} catch (err) {
			console.error("[otta] cron sweep task registration on activate failed (will retry):", err);
			return unscheduled;
		}
	};
}

/**
 * The `cron` handler.
 *
 * DISPATCHES ON `event.name`, like every multi-task cron plugin: a task this
 * plugin did not register is not this plugin's work, and answering it would be a
 * lie about what ran.
 *
 * NEVER REJECTS on a leg failure — `runCommerceSweeps` catches per leg and reports
 * — because a rejected hook is logged by the host as `Hook failed` for the whole
 * task, hiding which leg broke (for a recurring task the executor simply moves on
 * to its next scheduled run; only one-shot tasks are retried). And never
 * OVERRUNS: the legs share a budget, started at this handler's ENTRY, below the
 * hook's declared timeout (`SWEEP_HOOK_TIMEOUT_MS`).
 *
 * THE RE-AFFIRMATION IS THE PER-ISOLATE BOOTSTRAP, latched and never throwing —
 * not a write on every tick. Every tick re-affirming cost a database write (and a
 * `next_run_at` nudge on the running row) per minute for nothing; the bootstrap
 * reads first and writes only on a difference, once per isolate, which is still
 * how a schedule change reaches a deployment. Its time counts against the budget,
 * which starts before it.
 */
export function createCronHandler(options: CommerceSweepOptions = {}): HookHandler<CronEvent> {
	return async (event, ctx): Promise<CommerceSweepSummary | { task: string; skipped: true }> => {
		const tickClock = options.tickClock ?? (() => Date.now());
		const startedAtMs = tickClock();
		const name = typeof event?.name === "string" ? event.name : "";
		if (name !== SWEEP_TASK_NAME) return { task: name, skipped: true };
		await bootstrapSweepTask(ctx);
		// Once per isolate (again for any key whose revision changed since the
		// marker), never throws: see encrypt-payment-secrets.ts (ADR-0037).
		await encryptStoredPaymentSecrets(ctx);
		return await runCommerceSweeps(ctx, name, { ...options, tickClock, startedAtMs });
	};
}

export {
	MAINTENANCE_LEG_INTERVAL_MS,
	MAINTENANCE_LEGS,
	runCommerceSweeps,
	SWEEP_EMAIL_SEND_TIMEOUT_MS,
	SWEEP_LEGS,
	SWEEP_STATE_KV_KEY,
	SWEEP_TICK_BUDGET_MS,
	SWEEP_TICK_QUERY_BUDGET,
	SWEEP_TICK_RESERVE_MS,
	type CommerceSweepOptions,
	type CommerceSweepSummary,
	type SweepCursorStore,
	type SweepLeg,
	type SweepLegOutcome,
} from "./sweeps.js";
