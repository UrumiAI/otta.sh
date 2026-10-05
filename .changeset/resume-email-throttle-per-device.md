---
"@otta-sh/plugin": minor
---

Resume-by-email guesses are throttled per device of an order as well as per order (issue
#364). Five wrong guesses used to lock the real buyer out of `/checkout/resume/email` for 15
minutes; now each device gets 5 tries per order per 15 minutes, and an order takes at most 20
from all devices together, so guessing from many browsers is still stopped.

`storefront/order/resume` accepts an optional `clientKey` (an id token; anything else is
ignored) and `ResumeProof` gains `clientKey`. It is not a proof: it only names the device whose
guesses these are. A request without one shares a single no-device window per order. The
reference site sends a random per-browser key from an `otta_resume_client` cookie (httpOnly,
`SameSite=Strict`, `Path=/checkout`), set by the email page. A custom site that sends no
`clientKey` keeps a per-order limit of 5 for all its callers together, as before. The order's
window is taken first, so a guess it refuses writes no per-device record. Keys are free, so
anyone holding the order link can still close the email route for 15 minutes with 20 requests.
ADR-0012 records the decision.
