/**
 * The product editor's Download file card (issue #376, increment 4): the file a
 * buyer of a DIGITAL product downloads from their order page.
 *
 * It shows the file attached now (its name and size), and uploads a new one —
 * the first, or a replacement — in two steps:
 *  1. UPLOAD the bytes to the site (`uploadDownloadFile`, the console's one
 *     request outside the `otta` admin route — ADR-0029), which stores them in
 *     the private bucket under a fresh key and answers a descriptor;
 *  2. SAVE that descriptor through the admin route (`products:attach-download`),
 *     against a watermark read just before, as every product edit is.
 * Only step 2 changes what buyers get: every buyer's link (order + sku) serves
 * whatever the descriptor names, so a replaced file reaches them all at once.
 *
 * A SAVE THAT FAILS AFTER AN UPLOAD, for a reason a retry can fix — no answer,
 * a 5xx, a busy store, or the product moving under the write — keeps the
 * uploaded descriptor and offers "Save file again", so a lost answer never costs
 * the merchant a second 100 MB upload. A refusal of the descriptor itself (the
 * plugin's "invalid") clears it: saving it again would be refused again.
 *
 * NO LOST UPDATE, NO DOUBLE WRITE. The card remembers which file was attached
 * when the merchant picked theirs, and every save re-reads the product first:
 *  - already pointing at THIS upload's key → the earlier save landed and only its
 *    answer was lost: reported as attached, with no second write;
 *  - pointing at a file that is neither the remembered one nor this upload →
 *    someone attached another file meanwhile: the card stops and says so, keeping
 *    the upload for a deliberate "Save my file instead" (which then replaces the
 *    file now shown). There is no automatic retry that would paper over it.
 *
 * Every sentence a refusal shows is the endpoint's or the plugin's own; this
 * card adds only what to do next.
 */
import * as React from "react";
import {
	fetchProductDetail,
	isFailure,
	performAction,
	PRODUCTS_ACT_SUBJECT,
	type DownloadAssetView,
	type ProductRecord,
} from "../console-api.js";
import {
	MAX_DOWNLOAD_FILE_BYTES,
	uploadDownloadFile,
	type UploadedAsset,
} from "../download-upload-api.js";

/** The size of a file in the units the merchant's own computer shows (decimal,
 *  as the 100 MB limit is stated). */
export function formatFileSize(bytes: number): string {
	if (bytes < 1000) return `${String(bytes)} ${bytes === 1 ? "byte" : "bytes"}`;
	const units = ["KB", "MB", "GB"] as const;
	let value = bytes / 1000;
	let unit = 0;
	while (value >= 1000 && unit < units.length - 1) {
		value /= 1000;
		unit += 1;
	}
	const shown = value >= 100 ? value.toFixed(0) : value.toFixed(1);
	return `${shown.replace(/\.0$/, "")} ${units[unit]!}`;
}

/** An uploaded file not yet attached, and the attached key it was meant to
 *  replace (`null`: there was none). */
interface Held {
	readonly asset: UploadedAsset;
	readonly expectedKey: string | null;
}

type Phase =
	| { readonly step: "idle" }
	| {
			readonly step: "uploading";
			readonly name: string;
			readonly loaded: number;
			readonly total: number;
	  }
	| { readonly step: "saving"; readonly name: string }
	| {
			readonly step: "failed";
			readonly title: string;
			readonly description: string;
			/** An uploaded file a deliberate save may still attach, and that
			 *  button's label. `null` when nothing is worth re-sending. */
			readonly held: Held | null;
			readonly retryLabel?: string;
	  }
	| { readonly step: "done"; readonly text: string };

/** The save's outcome, before it is shown. */
type SaveOutcome =
	| { readonly ok: true; readonly text: string }
	/** A retry may succeed: no answer, a 5xx, a busy store, a moved product. */
	| {
			readonly ok: false;
			readonly kind: "retryable";
			readonly title: string;
			readonly description: string;
	  }
	/** Another file was attached after the merchant picked theirs. */
	| { readonly ok: false; readonly kind: "conflict"; readonly currentKey: string | null }
	/** A definitive no (the descriptor refused, a 4xx): re-sending is pointless. */
	| {
			readonly ok: false;
			readonly kind: "refused";
			readonly title: string;
			readonly description: string;
	  };

const attachedText = (asset: UploadedAsset): string =>
	`Buyers' download links now serve ${asset.filename}.`;

/** Is a transport/route failure worth a retry? No answer, a 5xx, or the
 *  plugin's retryable BUSY are; a 4xx (signed out, not allowed) is not. */
function retryable(failure: { status?: number; indeterminate?: true }): boolean {
	return (
		failure.indeterminate === true ||
		failure.status === undefined ||
		failure.status >= 500 ||
		(failure as { retryable?: unknown }).retryable === true
	);
}

/**
 * Save an uploaded descriptor. Re-reads the product first (its watermark, and
 * which file it points at now) — see the module doc for why that read decides
 * between "already attached", "someone else attached a file" and a write.
 * Never throws.
 */
async function attach(productId: string, held: Held): Promise<SaveOutcome> {
	const { asset, expectedKey } = held;
	const fresh = await fetchProductDetail(productId);
	if (isFailure(fresh)) {
		return {
			ok: false,
			kind: retryable(fresh) ? "retryable" : "refused",
			title: fresh.title,
			description: fresh.description,
		};
	}
	const currentKey = fresh.product.downloadAsset?.key ?? null;
	// An earlier save of THIS upload landed and its answer was lost.
	if (currentKey === asset.key) return { ok: true, text: attachedText(asset) };
	if (currentKey !== expectedKey) return { ok: false, kind: "conflict", currentKey };
	const result = await performAction(
		"products:attach-download",
		{
			productId,
			expectedUpdatedAt: fresh.product.updatedAt,
			key: asset.key,
			filename: asset.filename,
			contentType: asset.contentType,
			size: String(asset.size),
		},
		PRODUCTS_ACT_SUBJECT,
	);
	if (isFailure(result)) {
		return {
			ok: false,
			kind: retryable(result) ? "retryable" : "refused",
			title: result.title,
			description: result.description,
		};
	}
	const notice = result.notice;
	if (notice !== null && notice.variant === "error") {
		// The product moved between the read and the write. The plugin's stale
		// copy speaks of a form ("latest values are shown below") this card does
		// not have, so the card says what happened in its own words.
		if (result.recordMoved === true) {
			return {
				ok: false,
				kind: "retryable",
				title: "The product changed while the file was being attached",
				description: "Nothing was attached.",
			};
		}
		return { ok: false, kind: "refused", title: notice.title, description: notice.description };
	}
	return { ok: true, text: notice?.description || attachedText(asset) };
}

export function DownloadFileCard({
	record,
	titleId,
	onAttached,
	onBusyChange,
}: {
	record: ProductRecord;
	/** The id the card's heading carries, for `aria-labelledby`. */
	titleId: string;
	/** Called once a new file is attached (or another one is found attached),
	 *  so the editor re-reads the product. */
	onAttached: () => void;
	/** Told when an upload or its save starts and ends, so the editor's
	 *  leave-page guard can ask before throwing an upload away. */
	onBusyChange?: (busy: boolean) => void;
}): React.ReactElement {
	const [phase, setPhase] = React.useState<Phase>({ step: "idle" });
	const picker = React.useRef<HTMLInputElement | null>(null);
	const busy = phase.step === "uploading" || phase.step === "saving";
	const current: DownloadAssetView | null = record.downloadAsset ?? null;

	// Leaving mid-upload throws the upload away. The editor's own guard (the
	// browser's leave-page prompt, and a confirm on an in-app link) covers it.
	React.useEffect(() => {
		onBusyChange?.(busy);
	}, [busy, onBusyChange]);
	React.useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

	const save = async (held: Held): Promise<void> => {
		setPhase({ step: "saving", name: held.asset.filename });
		const outcome = await attach(record.productId, held);
		if (outcome.ok) {
			setPhase({ step: "done", text: outcome.text });
			onAttached();
			return;
		}
		switch (outcome.kind) {
			case "conflict":
				setPhase({
					step: "failed",
					title: "Another file was attached while you were uploading",
					description: `Buyers' links serve that file now. Your upload, ${held.asset.filename}, is kept: save it to replace that file.`,
					// A deliberate save replaces the file now attached, and no other.
					held: { asset: held.asset, expectedKey: outcome.currentKey },
					retryLabel: "Save my file instead",
				});
				onAttached();
				return;
			case "retryable":
				setPhase({
					step: "failed",
					title: outcome.title,
					description: `${outcome.description} The file is uploaded; save it again to attach it.`,
					held,
					retryLabel: "Save file again",
				});
				return;
			case "refused":
				setPhase({
					step: "failed",
					title: outcome.title,
					description: outcome.description,
					held: null,
				});
				return;
		}
	};

	const choose = async (file: File): Promise<void> => {
		// The file this upload replaces, as the merchant saw it when they chose.
		const expectedKey = record.downloadAsset?.key ?? null;
		if (file.size > MAX_DOWNLOAD_FILE_BYTES) {
			setPhase({
				step: "failed",
				title: "This file is too large",
				description: `Download files can be at most 100 MB. This one is ${formatFileSize(file.size)}.`,
				held: null,
			});
			return;
		}
		if (file.size === 0) {
			setPhase({
				step: "failed",
				title: "This file is empty",
				description: "Choose the file buyers should get.",
				held: null,
			});
			return;
		}
		setPhase({ step: "uploading", name: file.name, loaded: 0, total: file.size });
		const uploaded = await uploadDownloadFile(record.productId, file, (loaded, total) => {
			setPhase({ step: "uploading", name: file.name, loaded, total });
		});
		if (!uploaded.ok) {
			setPhase({
				step: "failed",
				title: uploaded.title,
				description: uploaded.description,
				held: null,
			});
			return;
		}
		await save({ asset: uploaded.asset, expectedKey });
	};

	const percent =
		phase.step === "uploading" && phase.total > 0
			? Math.min(100, Math.floor((phase.loaded / phase.total) * 100))
			: 0;

	return (
		<section
			className="otta-pricing-card"
			aria-labelledby={titleId}
			data-testid="otta-download-card"
		>
			<div className="otta-pricing-card-head">
				<h3 id={titleId} className="otta-pricing-card-title">
					Download file
				</h3>
				<span
					className="otta-pricing-badge"
					data-tone={current === null ? "warn" : "ok"}
					data-testid="otta-download-badge"
				>
					<span className="otta-pricing-dot" aria-hidden="true" />
					{current === null ? "No file" : "Attached"}
				</span>
			</div>

			{current === null ? (
				<p className="otta-pricing-hint">
					No file yet. Buyers see no download link until you upload one.
				</p>
			) : (
				<div className="otta-pricing-file" data-testid="otta-download-current">
					<span className="otta-pricing-file-icon" aria-hidden="true">
						<svg
							width="18"
							height="18"
							viewBox="0 0 16 16"
							fill="none"
							stroke="currentColor"
							strokeWidth="1.4"
							strokeLinejoin="round"
						>
							<path d="M4 1.75h5.25L12.5 5v9.25H4z" />
							<path d="M9 1.75V5.25h3.5" />
						</svg>
					</span>
					<span className="otta-pricing-file-text">
						<strong data-testid="otta-download-name">{current.filename}</strong>
						<span className="otta-pricing-hint">
							<span data-testid="otta-download-size">{formatFileSize(current.size)}</span>
							{" · "}
							<span title="Where the file is stored in the downloads bucket">{current.key}</span>
						</span>
					</span>
				</div>
			)}

			{phase.step === "uploading" && (
				<div className="otta-pricing-field">
					<progress
						className="otta-pricing-progress"
						max={100}
						value={percent}
						aria-label={`Uploading ${phase.name}`}
					/>
					{/* The running percent is for the eye; the progress element carries
					    it for assistive tech, and the status below announces only the
					    start and the end — not every percent. */}
					<span
						className="otta-pricing-hint"
						aria-hidden="true"
						data-testid="otta-download-percent"
					>
						{String(percent)}%
					</span>
				</div>
			)}

			{phase.step === "failed" && (
				<div className="otta-pricing-callout" data-tone="warn" data-testid="otta-download-error">
					<span role="alert">
						<strong>{phase.title}.</strong> {phase.description}
					</span>
					{phase.held !== null && (
						<div>
							<button
								type="button"
								className="otta-pricing-btn"
								onClick={() => {
									if (phase.held !== null) void save(phase.held);
								}}
							>
								{phase.retryLabel ?? "Save file again"}
							</button>
						</div>
					)}
				</div>
			)}

			<div className="otta-pricing-file-actions">
				<input
					ref={picker}
					type="file"
					className="otta-sr-only"
					tabIndex={-1}
					aria-hidden="true"
					data-testid="otta-download-input"
					onChange={(event) => {
						const file = event.currentTarget.files?.[0];
						// The same file chosen again must still fire next time.
						event.currentTarget.value = "";
						if (file !== undefined) void choose(file);
					}}
				/>
				<button
					type="button"
					className="otta-pricing-btn"
					disabled={busy}
					aria-busy={busy}
					onClick={() => {
						picker.current?.click();
					}}
				>
					{current === null ? "Upload file" : "Replace file"}
				</button>
				<span
					className="otta-pricing-status"
					role="status"
					data-tone={phase.step === "done" ? "ok" : "muted"}
				>
					{phase.step === "uploading"
						? `Uploading ${phase.name}…`
						: phase.step === "saving"
							? `Attaching ${phase.name}…`
							: phase.step === "done"
								? phase.text
								: "Up to 100 MB. Replacing it updates every buyer's download link."}
				</span>
			</div>
		</section>
	);
}
