/**
 * Production entrypoint for the Node target (root `Dockerfile`).
 *
 * Two jobs, in order: make DATABASE_URL reachable by the built server (see
 * pg-env.mjs for why the built server cannot read it itself), then fork
 * WEB_CONCURRENCY workers across the pod's CPU allocation.
 *
 * The Cloudflare target has no equivalent — Workers are the runtime there, and
 * `src/worker.ts` is its entry.
 */
import cluster from "node:cluster";
import { applyPostgresEnv } from "./pg-env.mjs";

const SERVER_ENTRY = "../dist/server/entry.mjs";

const applied = applyPostgresEnv(process.env);
if (applied.length > 0) {
	// Names only — never the values, one of which is the database password.
	console.log(`cluster: derived ${applied.join(", ")} from DATABASE_URL`);
} else if (!process.env["PGHOST"]) {
	console.warn(
		"cluster: no PGHOST and no usable DATABASE_URL — the CMS will fail to reach its content database",
	);
}

function workerCount() {
	const configured = Number.parseInt(process.env["WEB_CONCURRENCY"] ?? "", 10);
	return Number.isInteger(configured) && configured > 0 ? configured : 1;
}

const workers = workerCount();

if (workers === 1 || !cluster.isPrimary) {
	await import(SERVER_ENTRY);
} else {
	console.log(`cluster: starting ${workers} workers`);
	for (let i = 0; i < workers; i += 1) cluster.fork();

	// Replace workers that die unexpectedly, but NOT during a SIGTERM shutdown:
	// Kubernetes is draining the pod at that point, and respawning would keep
	// the container alive past its termination grace period.
	let shuttingDown = false;

	cluster.on("exit", (worker, code, signal) => {
		if (shuttingDown) return;
		console.warn(`cluster: worker ${worker.process.pid} exited (${signal || code}); restarting`);
		cluster.fork();
	});

	for (const signal of ["SIGTERM", "SIGINT"]) {
		process.on(signal, () => {
			shuttingDown = true;
			for (const worker of Object.values(cluster.workers ?? {})) worker.kill(signal);
		});
	}
}
