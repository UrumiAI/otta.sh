/**
 * DATABASE_URL → PG* translation for the Node target.
 *
 * WHY THIS EXISTS. The emdash Astro integration serializes the `database`
 * descriptor from astro.config.ts straight into the bundle, and astro.config.ts
 * is evaluated at BUILD time — inside an image build that has no database. So
 * the baked descriptor carries no connection string, and emdash's
 * `createDialect()` reads only `config.connectionString`: it has no runtime
 * environment fallback.
 *
 * Baking a URL in at build time would be wrong even if it were possible: QA and
 * production are separate databases deployed from the SAME image tag, so the
 * connection cannot be a build-time constant.
 *
 * The recovery relies on `pg`'s documented behaviour rather than anything
 * internal to emdash — when a Pool option is undefined, `pg` falls back to the
 * corresponding PG* environment variable. `cluster.mjs` applies these before
 * forking any worker, so every worker inherits them.
 *
 * Plain `.mjs`, not TypeScript: this runs from the runtime image where nothing
 * compiles. Kept separate from cluster.mjs so `test/pg-env.test.ts` can pin the
 * parsing without forking a process.
 */

/**
 * The PG* pairs implied by a DATABASE_URL.
 *
 * Returns `{}` for a missing or unparseable URL — the caller decides whether
 * that is fatal. Percent-encoded credentials are decoded, because `pg` reads
 * these variables literally (an encoded `%40` would otherwise become part of
 * the password).
 *
 * @param {string | undefined} raw
 * @returns {Record<string, string>}
 */
export function postgresEnvFrom(raw) {
	if (!raw) return {};

	let url;
	try {
		url = new URL(raw);
	} catch {
		return {};
	}

	/** @type {Record<string, string>} */
	const env = {};
	const set = (key, value) => {
		if (value) env[key] = value;
	};

	set("PGHOST", url.hostname);
	set("PGPORT", url.port || "5432");
	set("PGUSER", url.username ? decodeURIComponent(url.username) : "");
	set("PGPASSWORD", url.password ? decodeURIComponent(url.password) : "");
	set("PGDATABASE", url.pathname.replace(/^\//, ""));

	// RDS terminates TLS with a certificate chain the container's default trust
	// store does not carry, so `sslmode` has to survive the translation — it is
	// the only way the caller can relax verification.
	const sslmode = url.searchParams.get("sslmode");
	set("PGSSLMODE", sslmode ?? "");

	return env;
}

/**
 * Fill PG* gaps in `target` from DATABASE_URL. Explicit PG* values already in
 * the environment always win, and PGHOST being set at all is taken as "the
 * operator configured this by hand" — the whole translation is skipped.
 *
 * @param {Record<string, string | undefined>} target - normally process.env
 * @returns {string[]} the variable names actually set, for logging
 */
export function applyPostgresEnv(target) {
	if (target["PGHOST"]) return [];

	const env = postgresEnvFrom(target["DATABASE_URL"]);
	const applied = [];
	for (const [key, value] of Object.entries(env)) {
		if (!target[key]) {
			target[key] = value;
			applied.push(key);
		}
	}
	return applied;
}
