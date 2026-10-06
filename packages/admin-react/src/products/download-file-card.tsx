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
 * A SAVE THAT FAILS AFTER AN UPLOAD keeps the uploaded descriptor and offers
 * "Save file again", so a lost answer or a concurrent edit never costs the
 * merchant a second 100 MB upload. The attach is keyed on its content, so a
 * re-send writes once. A save refused because the product moved under it (the
 * CMS saved the entry, which moves the watermark) is retried once on its own
 * with a fresh read.
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
			/** An uploaded file whose save failed — offered for "Save file again". */
			readonly held: UploadedAsset | null;
	  }
	| { readonly step: "done"; readonly text: string };

/** The save's outcome, before it is shown. */
type SaveOutcome =
	| { readonly ok: true; readonly text: string }
	| {
			readonly ok: false;
			readonly title: string;
			readonly description: string;
			readonly moved: boolean;
	  };

/** Save an uploaded descriptor: read the product's latest watermark, then
 *  attach. Never throws. */
async function attach(productId: string, asset: UploadedAsset): Promise<SaveOutcome> {
	const fresh = await fetchProductDetail(productId);
	if (isFailure(fresh)) {
		return { ok: false, title: fresh.title, description: fresh.description, moved: false };
	}
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
		return { ok: false, title: result.title, description: result.description, moved: false };
	}
	const notice = result.notice;
	if (notice !== null && notice.variant === "error") {
		return {
			ok: false,
			title: notice.title,
			description: notice.description,
			moved: result.recordMoved === true,
		};
	}
	return {
		ok: true,
		text: notice?.description || `Buyers' download links now serve ${asset.filename}.`,
	};
}

export function DownloadFileCard({
	record,
	titleId,
	onAttached,
}: {
	record: ProductRecord;
	/** The id the card's heading carries, for `aria-labelledby`. */
	titleId: string;
	/** Called once a new file is attached, so the editor re-reads the product. */
	onAttached: () => void;
}): React.ReactElement {
	const [phase, setPhase] = React.useState<Phase>({ step: "idle" });
	const picker = React.useRef<HTMLInputElement | null>(null);
	const busy = phase.step === "uploading" || phase.step === "saving";
	const current: DownloadAssetView | null = record.downloadAsset ?? null;

	// Leaving mid-upload throws the upload away; the browser asks first.
	React.useEffect(() => {
		if (!busy) return;
		const warn = (event: BeforeUnloadEvent): void => {
			event.preventDefault();
			event.returnValue = "";
		};
		window.addEventListener("beforeunload", warn);
		return () => {
			window.removeEventListener("beforeunload", warn);
		};
	}, [busy]);

	const save = async (asset: UploadedAsset): Promise<void> => {
		setPhase({ step: "saving", name: asset.filename });
		let outcome = await attach(record.productId, asset);
		// The product moved between the read and the write (the CMS saved the
		// entry): once more on a fresh read. A second move is shown, not chased.
		if (!outcome.ok && outcome.moved) outcome = await attach(record.productId, asset);
		if (outcome.ok) {
			setPhase({ step: "done", text: outcome.text });
			onAttached();
			return;
		}
		setPhase({
			step: "failed",
			title: outcome.title,
			description: `${outcome.description} The file is uploaded; save it again to attach it.`,
			held: asset,
		});
	};

	const choose = async (file: File): Promise<void> => {
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
		await save(uploaded.asset);
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
								Save file again
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
						? `Uploading ${phase.name} — ${String(percent)}%`
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
