/**
 * POST /otta-admin/downloads/<productId> — the merchant uploads a digital
 * product's file to the private `DOWNLOADS` bucket (issue #376, increment 4;
 * ADR-0029, which amends ADR-0014 Decision 3 to allow the console this one
 * second request).
 *
 * A thin shell over `lib/download-upload.ts`, where who may upload, what is
 * stored and every refusal are documented and unit-tested. This file only binds
 * the request to its collaborators: the signed-in user EmDash's auth middleware
 * put on `locals.user`, the plugin's admin read dispatched in-process, the
 * Worker's `DOWNLOADS` binding, the clock and `crypto.getRandomValues`.
 *
 * NOT under `/_emdash`: EmDash guards only its own paths, and the plugin can
 * neither read a request body as bytes nor reach R2. So, like every other
 * storefront write route, it runs the site's origin guard FIRST
 * (`rejectCrossOrigin`, ADR-0006's CSRF section), before the session, the body
 * or the bucket is touched; and `lib/download-upload.ts` additionally requires
 * the `X-EmDash-Request: 1` header a cross-site form cannot send. (When the
 * origin check moves into the site middleware — #390, default-deny — this call
 * moves with it and the route is listed in that table's GUARDED column.)
 *
 * The answer is private and never stored by a cache: it names a key, and it
 * belongs to one admin session.
 */
import type { APIRoute } from "astro";
import { env } from "virtual:emdash/env";
import {
	handleDownloadUpload,
	lookupProduct,
	uploadBucketFrom,
	type PluginRouteDispatcher,
	type UploadUser,
} from "../../../lib/download-upload.js";
import { keepPrivate } from "../../../lib/no-store.js";
import { rejectCrossOrigin } from "../../../lib/origin-guard.js";

export const prerender = false;

/** The signed-in user, if any, as far as the endpoint reads it. */
function signedInUser(user: unknown): UploadUser | undefined {
	if (typeof user !== "object" || user === null) return undefined;
	const { id, role } = user as { id?: unknown; role?: unknown };
	return typeof id === "string" && typeof role === "number" ? { id, role } : undefined;
}

export const POST: APIRoute = async (context) => {
	// CSRF FIRST — before the session is trusted or a byte of the body is read.
	const forbidden = rejectCrossOrigin(context);
	if (forbidden !== null) {
		keepPrivate({ response: forbidden, cache: context.cache });
		return forbidden;
	}
	const dispatch = (
		context.locals.emdash as { handlePluginApiRoute?: PluginRouteDispatcher } | undefined
	)?.handlePluginApiRoute;
	const response = await handleDownloadUpload(
		{
			user: signedInUser(context.locals.user),
			tokenAuthenticated: context.locals.tokenScopes !== undefined,
			bucket: uploadBucketFrom(env),
			// The FULL user record goes to the plugin as the caller, exactly as
			// EmDash's own plugin endpoint forwards it.
			lookup: (productId) =>
				lookupProduct(dispatch, productId, context.locals.user as UploadUser, context.url),
			now: () => Date.now(),
			random: (n) => crypto.getRandomValues(new Uint8Array(n)),
		},
		{
			productId: context.params.productId ?? "",
			headers: context.request.headers,
			body: context.request.body,
		},
	);
	keepPrivate({ response, cache: context.cache });
	return response;
};
