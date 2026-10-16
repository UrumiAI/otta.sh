/** Checked by `pnpm typecheck`: incomplete cron implementations must be rejected. */
import { expectTypeOf } from "vitest";
import type { HostCronAccess } from "@urumi.ai/otta-store-emdash";
import type { CronAccess, CronTaskInfo } from "../src/types.js";

declare function acceptHostCron(cron: HostCronAccess): void;
declare const withoutCancel: Omit<CronAccess, "cancel">;
declare const withoutNextRunAt: Omit<CronAccess, "list"> & {
	list(): Promise<Omit<CronTaskInfo, "nextRunAt">[]>;
};

// Mutual assignment can miss narrower method parameters.
expectTypeOf<CronAccess>().toEqualTypeOf<HostCronAccess>();

// @ts-expect-error — the host requires cancellation support.
acceptHostCron(withoutCancel);

// @ts-expect-error — every listed task must report its next run.
acceptHostCron(withoutNextRunAt);
