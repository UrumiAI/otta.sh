/**
 * `SessionStore` over one document per session, keyed by the HASH of its token.
 *
 * The SQL's guard was `WHERE token_hash = :hash AND revoked_at IS NULL AND
 * expires_at > :now`, over a table with a UNIQUE `token_hash`. Here the hash IS
 * the document id, so the lookup is a single read and the uniqueness is the
 * storage table's primary key; the other two clauses are field reads on the
 * document that read returned (ADR-0019 §7.17).
 *
 * **No plaintext token is stored, logged or returned twice.** `create` mints an
 * opaque token, hands it back once, and persists only `hashToken(token)`. A
 * session is therefore reachable by exactly two routes: the hash of a token
 * somebody holds, or the `customerId` index the port's own history read requires.
 * Nothing else can enumerate it, and the history rows carry a separate `sessionId`
 * precisely so an admin surface can name a session without holding anything that
 * could be presented as one.
 *
 * The revoke is a compare-and-set guarded on `revokedAt` still being absent, which
 * is the exact scope of the SQL's `SET revoked_at = :now WHERE token_hash = :hash
 * AND revoked_at IS NULL` — including its idempotence: a second revoke, or a revoke
 * of a token that was never issued, writes nothing and raises nothing.
 */
import type {
	Clock,
	CustomerId,
	IdGen,
	Session,
	SessionStore,
	SessionSummary,
} from "@otta-sh/domain";
import {
	CAS_RETRY,
	casDone,
	withCasRetry,
	type CasRetryOptions,
	type CasStep,
} from "./cas-retry.js";
import { collectionOf } from "./collection-of.js";
import { ScanPageLimitError } from "./errors.js";
import {
	isLiveSession,
	normalizeSessionDoc,
	SESSIONS_COLLECTION,
	sortSessionHistory,
	toSessionSummary,
	type SessionDoc,
} from "./identity-documents.js";
import { hashToken } from "./token-hash.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

/** Default session lifetime — long-lived, as the SQL adapter's default is. */
export const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** The host clamps `limit` at 100, so a page larger than that is not askable. */
const HISTORY_PAGE_SIZE = 100;

/**
 * Page ceiling for the per-customer history read. Reaching it is a typed
 * {@link ScanPageLimitError} rather than a silently short history — a truncated
 * audit list is worse than a loud refusal, because it reads as "no such session".
 */
const MAX_HISTORY_PAGES = 100;

export interface EmdashSessionStoreOptions {
	/** The collections the descriptor declared (`IDENTITY_COLLECTIONS`). */
	storage: StorageAccess;
	/** Mints the opaque token and the session's own id. */
	idGen: IdGen;
	/** Stamps `createdAt`, computes the expiry, and answers `validate`. */
	clock: Clock;
	/** Session lifetime. Defaults to {@link DEFAULT_SESSION_TTL_MS}. */
	ttlMs?: number;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/** Page ceiling for the per-customer history read. Default 100. */
	maxHistoryPages?: number;
}

export class EmdashSessionStore implements SessionStore {
	readonly #sessions: StorageCollection<SessionDoc>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #ttlMs: number;
	readonly #retry: CasRetryOptions;
	readonly #maxHistoryPages: number;

	constructor(options: EmdashSessionStoreOptions) {
		this.#sessions = collectionOf<SessionDoc>(options.storage, SESSIONS_COLLECTION);
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#ttlMs = options.ttlMs ?? DEFAULT_SESSION_TTL_MS;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
		this.#maxHistoryPages = options.maxHistoryPages ?? MAX_HISTORY_PAGES;
	}

	/**
	 * Mint a session. The document is written create-if-absent under the token's
	 * hash, which is the UNIQUE constraint the SQL had: a hash that is somehow
	 * already taken refuses rather than overwriting a live session belonging to
	 * somebody else, and the caller sees the retry budget's typed failure rather
	 * than a silently stolen token.
	 */
	async create(customerId: CustomerId): Promise<Session> {
		const token = this.#idGen.newId();
		const now = this.#clock.now();
		const expiresAt = new Date(now.getTime() + this.#ttlMs).toISOString();
		const doc: SessionDoc = {
			sessionId: this.#idGen.newId(),
			customerId,
			createdAt: now.toISOString(),
			expiresAt,
			revokedAt: null,
		};
		const id = await hashToken(token);
		await this.#cas<void>("createSession", async () => {
			const written = await this.#sessions.compareAndSet(id, null, doc);
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
		return { token, expiresAt };
	}

	/** The sole authority on liveness: unknown, revoked and expired are all `null`. */
	async validate(token: string): Promise<CustomerId | null> {
		const doc = await this.#sessions.get(await hashToken(token));
		if (doc === null) return null;
		const session = normalizeSessionDoc(doc);
		return isLiveSession(session, this.#clock.now().toISOString())
			? (session.customerId as CustomerId)
			: null;
	}

	/** Idempotent by the guard, exactly as the SQL's `WHERE revoked_at IS NULL` was. */
	async revoke(token: string): Promise<void> {
		const id = await hashToken(token);
		await this.#cas<void>("revokeSession", async () => {
			const current = await this.#sessions.getVersioned(id);
			if (current === null) return casDone(undefined);
			const session = normalizeSessionDoc(current.value);
			if (session.revokedAt !== null) return casDone(undefined);
			const written = await this.#sessions.compareAndSet(id, current.revision, {
				...session,
				revokedAt: this.#clock.now().toISOString(),
			});
			return written.applied ? casDone(undefined) : CAS_RETRY;
		});
	}

	/**
	 * The token-free history, newest-first, including expired and revoked sessions.
	 *
	 * The filter is the declared `customerId` index; the `createdAt DESC, id DESC`
	 * ordering is applied in code after a bounded paged read, because the pair has
	 * to be sorted together and a session id's own sort order is meaningless to a
	 * reader. Nothing selected here is derived from the document id — the summary is
	 * built from the four metadata fields and the separate `sessionId`, so no
	 * credential material has a path onto an admin surface even by accident.
	 */
	async listForCustomer(customerId: CustomerId): Promise<SessionSummary[]> {
		const docs: SessionDoc[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxHistoryPages; page++) {
			const result = await this.#sessions.query({
				where: { customerId },
				limit: HISTORY_PAGE_SIZE,
				cursor,
			});
			for (const { data } of result.items) docs.push(normalizeSessionDoc(data));
			if (!result.hasMore || result.cursor === undefined) {
				return sortSessionHistory(docs).map(toSessionSummary);
			}
			cursor = result.cursor;
		}
		throw new ScanPageLimitError(
			"listSessionsForCustomer",
			this.#maxHistoryPages,
			docs.length,
			"maxHistoryPages",
		);
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}
