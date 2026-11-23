import { currencyDigits, currencyPaymentIncrement } from "@urumi.ai/otta-domain/money/currencies";
import type { PluginContext } from "emdash/plugin";
import type { Fail } from "./model.js";

/** A storage collection, as Core uses it (a structural subset of EmDash's). */
export interface Coll<T> {
	get(id: string): Promise<T | null>;
	put(id: string, data: T): Promise<void>;
	delete(id: string): Promise<boolean>;
	deleteMany(ids: string[]): Promise<number>;
	getMany(ids: string[]): Promise<Map<string, T>>;
	count(where?: Record<string, unknown>): Promise<number>;
	query(o?: {
		where?: Record<string, unknown>;
		orderBy?: Record<string, "asc" | "desc">;
		limit?: number;
		cursor?: string;
	}): Promise<{ items: Array<{ id: string; data: T }>; cursor?: string; hasMore: boolean }>;
	getVersioned(id: string): Promise<{ value: T; revision: string } | null>;
	compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: T,
	): Promise<{ applied: true; revision: string } | { applied: false }>;
}

export function coll<T>(ctx: PluginContext, name: string): Coll<T> {
	const c = (ctx.storage as unknown as Record<string, Coll<T>> | undefined)?.[name];
	if (!c) throw new Error(`storage collection ${name} is not available`);
	return c;
}

export const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

/**
 * Which part of a client address identifies one buyer: the full IPv4 address,
 * or the /64 prefix of an IPv6 one (a single subscriber controls a whole /64).
 * null for anything that is not a public address (empty, loopback, private,
 * link-local: a host behind a proxy that does not forward the client IP), so
 * the per-buyer cap is skipped rather than lumping every buyer together.
 */
export function buyerAddress(ip: string | null | undefined): string | null {
	if (typeof ip !== "string") return null;
	let a = ip.trim().toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
	if (mapped) a = mapped[1]!;
	const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
	if (v4) {
		const [p, q] = [Number(v4[1]), Number(v4[2])];
		if (v4.slice(1).some((x) => Number(x) > 255)) return null;
		// 100.64/10 is carrier-grade NAT space: never a client address an edge would see.
		if (
			p === 10 ||
			p === 127 ||
			p === 0 ||
			(p === 100 && q >= 64 && q <= 127) ||
			(p === 172 && q >= 16 && q <= 31) ||
			(p === 192 && q === 168) ||
			(p === 169 && q === 254)
		)
			return null;
		return a;
	}
	if (!a.includes(":") || !/^[0-9a-f:]+$/.test(a)) return null;
	const halves = a.split("::");
	if (halves.length > 2) return null;
	const head = halves[0] ? halves[0].split(":") : [];
	const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
	const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
	const groups = [...head, ...Array(Math.max(0, fill)).fill("0"), ...tail];
	if (groups.length !== 8 || groups.some((g) => g.length === 0 || g.length > 4)) return null;
	const first = parseInt(groups[0]!, 16);
	if (groups.every((g) => parseInt(g, 16) === 0)) return null; // ::
	if (groups.slice(0, 7).every((g) => parseInt(g, 16) === 0)) return null; // ::1
	if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return null; // ULA, link-local
	return `${groups
		.slice(0, 4)
		.map((g) => parseInt(g, 16).toString(16))
		.join(":")}::/64`;
}

/**
 * This install's store tag: HMAC(per-install salt, "store"), 16 hex. Sent to
 * Stripe as metadata.otta_store and in the idempotency key, recorded on every
 * order, and required on every session that settles one: two Core stores on one
 * Stripe account can never settle each other's orders (same client-minted id).
 */
export const storeTag = (salt: string): Promise<string> => ipTag("otta-core-store", salt);

/** A stable, non-reversible tag for a buyer address: HMAC-SHA256(per-install salt, address), 16 hex. */
export async function ipTag(ip: string, salt: string): Promise<string> {
	const enc = new TextEncoder();
	const k = await crypto.subtle.importKey(
		"raw",
		enc.encode(salt),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(ip)));
	let s = "";
	for (const x of sig.subarray(0, 8)) s += x.toString(16).padStart(2, "0");
	return s;
}

export function randomHex(bytes: number): string {
	const b = crypto.getRandomValues(new Uint8Array(bytes));
	let s = "";
	for (const x of b) s += x.toString(16).padStart(2, "0");
	return s;
}

/** Constant-time string equality (lengths are not secret here). */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

export const nowIso = (): string => new Date().toISOString();

export function asRecord(v: unknown): Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v)
		? (v as Record<string, unknown>)
		: {};
}

export function asString(v: unknown, max = 200): string | null {
	return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

/** Ids Core mints or EmDash content ids: short, URL-safe. */
export function asId(v: unknown): string | null {
	const s = asString(v, 100);
	return s !== null && /^[A-Za-z0-9_-]+$/.test(s) ? s : null;
}

export function asInt(v: unknown, min: number, max: number): number | null {
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/**
 * Full Otta's currency table (pure data, bundled in): the ONLY currencies Core
 * sells in. A code it does not list (ISK, UGX: Stripe takes them as two-decimal
 * amounts) is refused, never given a guessed exponent.
 */
export function minorExponent(currency: string): number {
	const d = currencyDigits(currency);
	if (d === undefined) throw new Error(`unsupported currency ${currency}`);
	return d;
}

/** Payments in a three-decimal currency are multiples of 10 minor units. */
export const paymentIncrement = (currency: string): number =>
	currencyPaymentIncrement(currency) ?? 1;

/** Largest price Core accepts, in minor units (Stripe's unit_amount ceiling). */
export const MAX_MINOR = 99_999_999;

/**
 * A content price in MAJOR units as integer minor units, by decimal-string
 * parsing, never float arithmetic. A number field arrives as a JS number; its
 * shortest round-trip form (`String(19.99)` = "19.99") is the decimal the
 * editor typed. Rejects negatives, exponent forms, more decimals than the
 * currency has, and anything over MAX_MINOR. null = not sellable.
 */
export function toMinor(v: unknown, currency: string): number | null {
	const s =
		typeof v === "number"
			? Number.isFinite(v)
				? String(v)
				: ""
			: typeof v === "string"
				? v.trim()
				: "";
	const m = /^(\d{1,9})(?:\.(\d+))?$/.exec(s);
	if (!m) return null;
	const digits = currencyDigits(currency);
	if (digits === undefined) return null;
	// Trailing zeros carry no value ("1.50" is 1.5). A loop, not /0+$/: that regex
	// is quadratic on a long run of zeros followed by another digit.
	let frac = m[2] ?? "";
	let end = frac.length;
	while (end > 0 && frac.charCodeAt(end - 1) === 48) end--;
	frac = frac.slice(0, end);
	if (frac.length > digits) return null;
	const minor = Number(m[1]) * 10 ** digits + Number(frac.padEnd(digits, "0") || "0");
	return Number.isSafeInteger(minor) &&
		minor <= MAX_MINOR &&
		minor % paymentIncrement(currency) === 0
		? minor
		: null;
}

export function isCurrency(v: unknown): v is string {
	return typeof v === "string" && currencyDigits(v) !== undefined;
}
