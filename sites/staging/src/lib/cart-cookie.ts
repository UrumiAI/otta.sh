/**
 * The cart-cookie shim: plugin cart routes cannot set headers (ADR-0003),
 * so `storefront/cart/create` returns a cookie DESCRIPTOR in its JSON body
 * and THIS site owns the actual `Set-Cookie`. Every descriptor attribute
 * is applied verbatim — httpOnly, secure, sameSite, path — with the one
 * deliberate rename `maxAgeSeconds` → Astro's `maxAge` (both are seconds).
 * A dropped attribute here is a security bug (session-hijackable or
 * plaintext-leaked cart cookie); the unit test asserts exact equality.
 */
import type { CartCookieDescriptor } from "@urumi/plugin";

export interface CookieSetOptions {
	httpOnly: boolean;
	secure: boolean;
	sameSite: "lax" | "strict" | "none";
	path: string;
	maxAge: number;
}

/** The slice of Astro's `AstroCookies` this shim needs — injectable so the
 *  unit test can observe the exact set() call. */
export interface CookieJar {
	set(name: string, value: string, options: CookieSetOptions): void;
}

export function applyCartCookie(cookies: CookieJar, descriptor: CartCookieDescriptor): void {
	cookies.set(descriptor.name, descriptor.value, {
		httpOnly: descriptor.httpOnly,
		secure: descriptor.secure,
		sameSite: descriptor.sameSite,
		path: descriptor.path,
		maxAge: descriptor.maxAgeSeconds,
	});
}
