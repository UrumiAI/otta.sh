/** Checked by `pnpm typecheck`: the plugin's cron mirrors must match the host exactly. */
import { expectTypeOf } from "vitest";
import type { HostCronAccess, HostCronEvent } from "@urumi.ai/otta-store-emdash";
import type { CronAccess, CronEvent, CronTaskInfo } from "../src/types.js";

declare function acceptCron(cron: CronAccess): void;
declare const withoutCancel: Omit<CronAccess, "cancel">;
declare const withoutNextRunAt: Omit<CronAccess, "list"> & {
	list(): Promise<Omit<CronTaskInfo, "nextRunAt">[]>;
};

// Mutual assignment can miss narrower method parameters.
expectTypeOf<CronAccess>().toEqualTypeOf<HostCronAccess>();

// The cron hook's event: a renamed `scheduledAt` or a required `data` must fail here.
expectTypeOf<CronEvent>().toEqualTypeOf<HostCronEvent>();

// @ts-expect-error — the plugin's cron type requires cancellation support.
acceptCron(withoutCancel);

// @ts-expect-error — every listed task must report its next run.
acceptCron(withoutNextRunAt);
