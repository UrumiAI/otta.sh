/**
 * `scripts/pack-build.mjs` builds the template against the PACKED Otta packages.
 * On a branch that moves the host train (EmDash, Astro, React), the template
 * still pins the last release's versions, which the packed `@urumi.ai/otta-store`
 * no longer accepts as peers, and npm refuses the install (ERESOLVE). So the
 * script aligns the scratch site's pins to the packed store's peers first, and
 * says so. These cases pin that alignment.
 */
import { describe, expect, test } from "vitest";
import { alignPeerPins, satisfiesPeer } from "../../../scripts/pack-build-peers.mjs";

const PEERS = {
	"@astrojs/cloudflare": "~14.1.2",
	"@astrojs/react": "~6.0.1",
	"@emdash-cms/cloudflare": "1.5.0",
	"@urumi.ai/otta-plugin": "0.2.0",
	astro: "~7.3.6",
	emdash: "1.5.0",
	react: "~19.2.7",
	"react-dom": "~19.2.7",
};

function template(): {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
} {
	return {
		dependencies: {
			"@astrojs/cloudflare": "14.1.2",
			"@astrojs/react": "6.0.1",
			"@emdash-cms/cloudflare": "1.3.1",
			"@urumi.ai/otta-plugin": "file:/tmp/otta-plugin-0.2.0.tgz",
			astro: "7.3.6",
			emdash: "1.3.1",
			react: "19.2.7",
			"react-dom": "19.2.7",
		},
		devDependencies: { wrangler: "4.159.0" },
	};
}

describe("satisfiesPeer", () => {
	test("an exact peer takes only that version", () => {
		expect(satisfiesPeer("1.5.0", "1.5.0")).toBe(true);
		expect(satisfiesPeer("1.3.1", "1.5.0")).toBe(false);
	});

	test("~ takes patches of the same minor, ^ the same major (0.y stays in 0.y)", () => {
		expect(satisfiesPeer("7.3.9", "~7.3.6")).toBe(true);
		expect(satisfiesPeer("7.3.5", "~7.3.6")).toBe(false);
		expect(satisfiesPeer("7.4.0", "~7.3.6")).toBe(false);
		expect(satisfiesPeer("7.9.0", "^7.3.6")).toBe(true);
		expect(satisfiesPeer("8.0.0", "^7.3.6")).toBe(false);
		expect(satisfiesPeer("0.3.0", "^0.2.3")).toBe(false);
	});

	test("an unrecognised range is not claimed as satisfied", () => {
		expect(satisfiesPeer("1.0.0", ">=1.0.0 <2")).toBe(false);
	});
});

describe("alignPeerPins", () => {
	test("moves a pin the peer refuses to the exact peer version, and reports it", () => {
		const pkg = template();
		const changes = alignPeerPins(pkg, PEERS);
		expect(pkg.dependencies.emdash).toBe("1.5.0");
		expect(pkg.dependencies["@emdash-cms/cloudflare"]).toBe("1.5.0");
		expect(changes).toEqual([
			{
				name: "@emdash-cms/cloudflare",
				section: "dependencies",
				from: "1.3.1",
				to: "1.5.0",
				peer: "1.5.0",
			},
			{ name: "emdash", section: "dependencies", from: "1.3.1", to: "1.5.0", peer: "1.5.0" },
		]);
	});

	test("keeps a pin a range peer accepts", () => {
		const pkg = template();
		alignPeerPins(pkg, PEERS);
		expect(pkg.dependencies.astro).toBe("7.3.6");
		expect(pkg.dependencies.react).toBe("19.2.7");
	});

	test("moves a pin a range peer refuses to the range's floor", () => {
		const pkg = template();
		pkg.dependencies.astro = "7.2.0";
		const changes = alignPeerPins(pkg, { astro: "~7.3.6" });
		expect(pkg.dependencies.astro).toBe("7.3.6");
		expect(changes).toEqual([
			{ name: "astro", section: "dependencies", from: "7.2.0", to: "7.3.6", peer: "~7.3.6" },
		]);
	});

	test("never touches @urumi.ai/* (they are the tarballs) or a peer the site does not pin", () => {
		const pkg = template();
		alignPeerPins(pkg, { ...PEERS, "@cloudflare/kumo": "2.15.0" });
		expect(pkg.dependencies["@urumi.ai/otta-plugin"]).toBe("file:/tmp/otta-plugin-0.2.0.tgz");
		expect(pkg.dependencies).not.toHaveProperty("@cloudflare/kumo");
	});

	test("a template that already matches changes nothing", () => {
		const pkg = template();
		pkg.dependencies.emdash = "1.5.0";
		pkg.dependencies["@emdash-cms/cloudflare"] = "1.5.0";
		expect(alignPeerPins(pkg, PEERS)).toEqual([]);
	});

	test("a peer range it cannot read is an error, not a guess", () => {
		expect(() => alignPeerPins(template(), { emdash: ">=1.5.0 <2" })).toThrow(/emdash/);
	});
});
