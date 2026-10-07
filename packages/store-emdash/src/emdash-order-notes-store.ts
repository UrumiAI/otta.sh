/**
 * `OrderNotesStore` over one document per note, keyed by the note's idempotency
 * key.
 *
 * The SQL was two statements and one constraint: an `INSERT … ON CONFLICT
 * (idempotency_key) DO NOTHING RETURNING`, with a reload of the stored note when
 * the insert was refused, and a `SELECT … WHERE order_id = ? ORDER BY created_at,
 * id`. Here the key is the document id, so the once-only is the storage table's
 * primary key and `append` is a single create-if-absent; the list is a bounded
 * paged read on the declared `orderId` index, ordered in code.
 *
 * **One document, so no seam.** Append writes exactly one document and reads
 * exactly one back, which is why this store has no crash-seam of its own: there is
 * no pair of writes a crash can land between. That is a consequence of keying on the
 * idempotency key rather than on a composite id — see `order-notes-documents.ts`.
 *
 * **The hot order document is never touched.** Not on append, not on list. That is
 * the whole reason notes are a child collection: support volume on an order must not
 * enlarge the document the money path compare-and-sets.
 */
import type {
	AppendOrderNoteInput,
	AppendOrderNoteResult,
	Clock,
	IdGen,
	OrderId,
	OrderNote,
	OrderNotesStore,
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
	ORDER_NOTES_COLLECTION,
	sortOrderNotes,
	toOrderNote,
	type OrderNoteDoc,
} from "./order-notes-documents.js";
import type { StorageAccess, StorageCollection } from "./storage-access.js";

/** The host clamps `limit` at 100, so a page larger than that is not askable. */
const NOTES_PAGE_SIZE = 100;

/**
 * Page ceiling for one order's notes. Reaching it is a typed
 * {@link ScanPageLimitError} rather than a silently short list — a truncated note
 * list reads as "nobody wrote that", which is exactly the wrong answer for an
 * annotation trail an operator is about to act on.
 */
const MAX_NOTE_PAGES = 100;

export interface EmdashOrderNotesStoreOptions {
	/** The collections the descriptor declared (`ORDER_NOTES_COLLECTIONS`). */
	storage: StorageAccess;
	/** Mints the note's own id. The document id is the idempotency key. */
	idGen: IdGen;
	/** Stamps `createdAt` — server-assigned, never client-supplied. */
	clock: Clock;
	/** Override the compare-and-set attempt ceiling (see `CAS_MAX_ATTEMPTS`). */
	maxCasAttempts?: number;
	/** Observer for the attempt depth each step spent — how contention is measured. */
	onCasAttempts?: (operation: string, attempts: number) => void;
	/** Override the retry backoff sleep (a suite on fake timers supplies its own). */
	sleep?: CasRetryOptions["sleep"];
	/** Override the backoff jitter source, to make a retry schedule deterministic. */
	random?: CasRetryOptions["random"];
	/** Page ceiling for one order's note list. Default 100. */
	maxNotePages?: number;
}

export class EmdashOrderNotesStore implements OrderNotesStore {
	readonly #notes: StorageCollection<OrderNoteDoc>;
	readonly #idGen: IdGen;
	readonly #clock: Clock;
	readonly #retry: CasRetryOptions;
	readonly #maxNotePages: number;

	constructor(options: EmdashOrderNotesStoreOptions) {
		this.#notes = collectionOf<OrderNoteDoc>(options.storage, ORDER_NOTES_COLLECTION);
		this.#idGen = options.idGen;
		this.#clock = options.clock;
		this.#retry = {
			maxAttempts: options.maxCasAttempts,
			onAttempts: options.onCasAttempts,
			sleep: options.sleep,
			random: options.random,
		};
		this.#maxNotePages = options.maxNotePages ?? MAX_NOTE_PAGES;
	}

	/**
	 * Append one note, once only per idempotency key.
	 *
	 * A replay returns the STORED note with `appended: false` and writes nothing —
	 * including a replay whose body differs, which is the SQL's behaviour too: the key
	 * decides, not the payload. Of N concurrent appends carrying one key, exactly one
	 * create-if-absent applies and every loser reads the same note back.
	 */
	async append(input: AppendOrderNoteInput): Promise<AppendOrderNoteResult> {
		const id = input.idempotencyKey;
		return this.#cas<AppendOrderNoteResult>("appendOrderNote", async () => {
			const existing = await this.#notes.get(id);
			if (existing !== null) return casDone({ appended: false, note: toOrderNote(existing) });
			const doc: OrderNoteDoc = {
				noteId: this.#idGen.newId(),
				orderId: input.orderId,
				author: input.author,
				body: input.body,
				createdAt: this.#clock.now().toISOString(),
			};
			const written = await this.#notes.compareAndSet(id, null, doc);
			// A refusal means a peer with the same key committed first; the next attempt
			// reads its note back, so both callers return the one stored note.
			return written.applied ? casDone({ appended: true, note: toOrderNote(doc) }) : CAS_RETRY;
		});
	}

	/** One order's notes in append order. An order with no notes returns `[]`. */
	async listForOrder(orderId: OrderId): Promise<OrderNote[]> {
		const docs: OrderNoteDoc[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < this.#maxNotePages; page++) {
			const result = await this.#notes.query({
				where: { orderId },
				limit: NOTES_PAGE_SIZE,
				cursor,
			});
			for (const { data } of result.items) docs.push(data);
			if (!result.hasMore || result.cursor === undefined) {
				return sortOrderNotes(docs).map(toOrderNote);
			}
			cursor = result.cursor;
		}
		throw new ScanPageLimitError(
			"listNotesForOrder",
			this.#maxNotePages,
			docs.length,
			"maxNotePages",
		);
	}

	#cas<T>(operation: string, step: () => Promise<CasStep<T>>): Promise<T> {
		return withCasRetry(operation, step, this.#retry);
	}
}
