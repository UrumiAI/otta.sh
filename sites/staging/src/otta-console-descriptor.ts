/**
 * ADR-0014's SECOND descriptor — `otta-console`, native format, React admin
 * pages. The `otta` descriptor next door is untouched by its existence.
 *
 * Everything about this file is a boundary, so each field is written literally
 * rather than inherited:
 *
 *  - **`format: "native"` is declared, not defaulted.** EmDash defaults
 *    `format` to `"native"` when unset, and the 2026-07-31 spike leaned on
 *    exactly that. But `native` is the single most consequential property of
 *    the whole arrangement — it is what lifts the build-time throw on
 *    `adminEntry` and what makes full runtime access the declared contract —
 *    and a descriptor that carries no `format` key is indistinguishable from
 *    one that lost it in a refactor. `site-config.test.ts` fails a descriptor
 *    that omits it, spike fixture included.
 *  - **`capabilities: []` and `allowedHosts: []` are declared, not omitted.**
 *    `undefined` is not `[]`: "we asked for nothing" has to be written down.
 *    These two empty arrays are the only declared controls this descriptor has
 *    (ADR-0014 Decision 3), which is why the test pins them deep-equal.
 *  - **Both module specifiers name `@otta-sh/admin-react`.** An `adminEntry` of
 *    `"@otta-sh/plugin/admin"` would satisfy every other pin here while making
 *    `@otta-sh/plugin` the module EmDash statically imports React from — ADR-0014
 *    Decision 1 inverted, arriving through the site config instead of through an
 *    import a depcruise rule could see.
 *
 * NO hooks, NO routes, NO storage, NO settingsSchema, NO fieldWidgets. The
 * console is a browser page. Its data comes from `otta`'s existing
 * authenticated admin route, called with the operator's own session.
 *
 * Pure module (no IO), like its sibling, so the site-config test can pin every
 * field.
 */
import {
	OTTA_CONSOLE_ADMIN_ENTRY,
	OTTA_CONSOLE_ADMIN_PAGES,
	OTTA_CONSOLE_ENTRYPOINT,
	OTTA_CONSOLE_PLUGIN_ID,
	OTTA_CONSOLE_PLUGIN_VERSION,
} from "@otta-sh/admin-react";
import type { PluginDescriptor } from "emdash";

/**
 * Takes no service URL — and that asymmetry with `ottaPluginDescriptor` is the
 * point. `otta` needs one to compute its `allowedHosts` egress entry; the
 * console has no egress to allow, because it never fetches from a Worker at
 * all.
 */
export function ottaConsoleDescriptor(): PluginDescriptor {
	return {
		id: OTTA_CONSOLE_PLUGIN_ID,
		version: OTTA_CONSOLE_PLUGIN_VERSION,
		// Declared literally — see the module doc. The default would be the same
		// value and would still fail the gate.
		format: "native",
		// EmDash generates `import { createPlugin } from "<entrypoint>"` and calls
		// it; the returned ResolvedPlugin is what the runtime holds.
		entrypoint: OTTA_CONSOLE_ENTRYPOINT,
		// ...and `import * as adminN from "<adminEntry>"` into the generated admin
		// registry, keyed by this descriptor's id.
		adminEntry: OTTA_CONSOLE_ADMIN_ENTRY,
		// Zero of each, declared. ADR-0014 lists "otta-console acquiring a
		// capability, an allowedHost, a route, or a hook" among the things that
		// REOPEN the decision.
		capabilities: [],
		allowedHosts: [],
		// INERT FOR NATIVE FORMAT, and kept deliberately. The runtime manifest
		// reads `plugin.admin.pages` off the ResolvedPlugin that `createPlugin()`
		// returns, not off this array — only the standard-format branch of
		// EmDash's virtual-module generator forwards `descriptor.adminPages`. It
		// is declared anyway so both descriptors describe their nav in the same
		// place, and `site-config.test.ts` pins it equal to what `createPlugin()`
		// reports so the redundancy can never become a disagreement.
		adminPages: [...OTTA_CONSOLE_ADMIN_PAGES],
	};
}
