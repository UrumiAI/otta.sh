---
"@otta-sh/admin-react": minor
---

The product editor gains a **Download file** card on Digital products (issue #376,
increment 4). It shows the attached file's name and size, uploads a first file or a
replacement with a progress bar, and shows every refusal in words. The bytes go to the
site's `POST /otta-admin/downloads/<productId>`, the console's one request outside the
`otta` admin route (ADR-0029, amending ADR-0014 Decision 3). It uses `XMLHttpRequest`
for upload progress. The descriptor the site answers is then saved through the admin
route as `products:attach-download`, on a freshly read watermark. A save that fails after
the upload keeps the file and offers "Save file again", so the merchant never has to
upload twice. Files over 100 MB and empty files are refused before any request.
`ProductRecord` gains an optional `downloadAsset`.

Review follow-ups: the card re-reads the product before every save — an upload whose
earlier save landed (answer lost) reports attached with no second write, and a file
someone else attached meanwhile stops the save and keeps the upload for a deliberate
"Save my file instead". "Save file again" is offered only when a retry can help (no
answer, a 5xx, a busy store, the product moving); a refused descriptor is shown alone.
The editor's Physical choice is disabled, with the reason, while the saved product has a
download file (replace only, never removed). Leaving mid-upload asks first, and the status
line announces the start and the end of an upload, not every percent.
