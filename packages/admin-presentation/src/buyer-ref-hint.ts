/**
 * The order's email as a page may SHOW it to whoever holds the order link (QA
 * U-2): one letter of the mailbox, one of the domain and its last label —
 * `jane.doe@gmail.com` → `j•••@g•••.com`.
 *
 * Why a hint and not the address. The order id is a bearer capability: anyone
 * holding the link reads the public order, and the public order deliberately
 * carries no email (`serializePublicOrder`). A page resumed from that link must
 * not grant more than the link already does, but the buyer still deserves to
 * see WHICH address the order — and its receipt — belongs to, and that it can no
 * longer be changed. This is enough to recognise your own address and not
 * enough to learn someone else's.
 *
 * Anything that is not shaped like `local@domain.tld` hides everything.
 *
 * WHY IT LIVES HERE (issue #377). It was written for the resume flow, in
 * `@otta-sh/plugin`, and the React Orders console now masks with it too — a
 * buyer's email is masked by default there, against a shoulder-surfer or a
 * screenshot. The console may not import the plugin (ADR-0014), and a second
 * masking rule is the drift this package exists to prevent, so the function
 * MOVED here unchanged and the plugin's old path re-exports it.
 */
const DOTS = "•••";

/** What {@link buyerRefHint} returns for a value it will not hint at all. */
export const BUYER_REF_HINT_HIDDEN = DOTS;

export function buyerRefHint(buyerRef: string): string {
	const at = buyerRef.lastIndexOf("@");
	if (at <= 0 || at === buyerRef.length - 1) return DOTS;
	const local = buyerRef.slice(0, at);
	const domain = buyerRef.slice(at + 1);
	const lastDot = domain.lastIndexOf(".");
	if (lastDot <= 0 || lastDot === domain.length - 1) return DOTS;
	const tld = domain.slice(lastDot + 1);
	return `${[...local][0]}${DOTS}@${[...domain][0]}${DOTS}.${tld}`;
}
