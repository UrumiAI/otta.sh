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
