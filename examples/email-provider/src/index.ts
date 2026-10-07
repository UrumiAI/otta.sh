/**
 * The descriptor your site's EmDash config registers: `plugins: [httpEmailProvider()]`.
 * See docs/email-providers.md.
 */
import type { PluginDescriptor } from "emdash";
import { EMAIL_API_URL } from "./plugin.js";

/** The exact hostname of an https URL. Throws on any other scheme, so the key never travels in cleartext. */
export function httpsHost(url: string): string {
	const parsed = new URL(url);
	if (parsed.protocol !== "https:") throw new Error("email provider: the API URL must use https");
	return parsed.hostname;
}

export function httpEmailProvider(): PluginDescriptor {
	return {
		id: "http-email",
		version: "0.0.0",
		format: "standard",
		// The module that default-exports ./plugin.ts. Rename to your package.
		entrypoint: "@otta-sh/example-email-provider/plugin",
		capabilities: ["hooks.email-transport:register", "network:request"],
		// One exact host, never a wildcard.
		allowedHosts: [httpsHost(EMAIL_API_URL)],
		settingsSchema: {
			apiKey: { type: "secret", label: "API key" },
			from: { type: "email", label: "From address", description: "Verified with your email API" },
		},
	};
}
