import {
	attemptThrottleContract,
	FixedClock,
	InMemoryAttemptThrottle,
} from "@otta-sh/domain/testing";

attemptThrottleContract(
	async () => {
		const clock = new FixedClock(new Date("2026-10-02T12:00:00.000Z"));
		const windowMs = 1000;
		const maxAttempts = 3;
		return {
			throttle: new InMemoryAttemptThrottle({ clock, windowMs, maxAttempts }),
			advance: (ms) => clock.advance(ms),
			windowMs,
			maxAttempts,
		};
	},
	{ dialect: "fake" },
);
