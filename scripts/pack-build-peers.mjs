/**
 * The peer alignment `pack-build.mjs` applies to the scratch site.
 *
 * The template pins the host train (emdash, @emdash-cms/cloudflare, astro, react,
 * ...) at the versions the LAST published Otta release supports. On a branch that
 * moves that train FORWARD, the packed `@urumi.ai/otta-store` declares the new
 * versions as peers and npm refuses the template's pins (ERESOLVE), although the
 * template can only move after this release is published. So, before installing,
 * each template pin BELOW the packed store's peer range is moved up to the version
 * the peer names: the version itself for an exact peer, the range's floor for a
 * `~` or `^` range. Anything else is an error, never rewritten: a pin AHEAD of the
 * range (the branch is behind the template, or the template moved on its own) and
 * a pin that is not a plain version. Pins the peer accepts, `@urumi.ai/*` (the
 * tarballs) and peers the site does not pin are left alone.
 *
 * TWIN: `satisfiesPeerPin` in `sites/store/src/integration.ts` is the same check,
 * run by the published integration at build time. That package cannot import this
 * script, so the rules are kept identical by hand: exact, `~x.y.z` and `^x.y.z`;
 * build metadata (`+…`) ignored; a prerelease satisfies only an equal exact peer;
 * `^0.y.z` stays in `0.y`, `^0.0.z` is exactly `0.0.z`. Change both together.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const RANGE = /^([~^]?)(\d+\.\d+\.\d+)$/;

/**
 * `[major, minor, patch, prerelease]` of a plain version (build metadata ignored).
 * @param {string} version
 * @returns {[number, number, number, string] | undefined}
 */
function parseVersion(version) {
	const m = VERSION.exec(version.trim());
	if (!m) return undefined;
	return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? ""];
}

/**
 * Whether `version` (a plain version) satisfies `peer` (`x.y.z`, `~x.y.z` or
 * `^x.y.z`). Any other peer form is `false` here; callers decide what an
 * unreadable range means.
 * @param {string} version
 * @param {string} peer
 * @returns {boolean}
 */
export function satisfiesPeer(version, peer) {
	const range = RANGE.exec(peer.trim());
	const found = parseVersion(version);
	if (!range || !found) return false;
	const [, op, floorText] = range;
	if (op === "") return version.trim().replace(/\+[0-9A-Za-z.-]+$/, "") === floorText;
	const floor = parseVersion(floorText);
	if (!floor) return false;
	const [major, minor, patch, prerelease] = found;
	const [fMajor, fMinor, fPatch] = floor;
	if (prerelease !== "") return false;
	if ((major - fMajor || minor - fMinor || patch - fPatch) < 0) return false;
	if (op === "~") return major === fMajor && minor === fMinor;
	if (fMajor > 0) return major === fMajor;
	if (fMinor > 0) return major === 0 && minor === fMinor;
	return major === 0 && minor === 0 && patch === fPatch;
}

/**
 * Whether plain version `a` sorts below plain version `b` (a prerelease below its
 * release; two prereleases of one version are not ordered here).
 * @param {[number, number, number, string]} a
 * @param {[number, number, number, string]} b
 */
function below(a, b) {
	const diff = a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
	if (diff !== 0) return diff < 0;
	return a[3] !== "" && b[3] === "";
}

/** @typedef {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} SitePackage */

/**
 * Move each of `pkg`'s pins that sits BELOW `peers`' range up to the peer's
 * version, in place. Throws for a pin ahead of the range, a pin that is not a
 * plain version, or a peer range it cannot read. Returns what changed, by name.
 * @param {SitePackage} pkg
 * @param {Record<string, string>} peers
 * @returns {Array<{ name: string, section: string, from: string, to: string, peer: string }>}
 */
export function alignPeerPins(pkg, peers) {
	/** @type {Array<{ name: string, section: string, from: string, to: string, peer: string }>} */
	const changes = [];
	for (const [name, peer] of Object.entries(peers).toSorted(([a], [b]) => (a < b ? -1 : 1))) {
		if (name.startsWith("@urumi.ai/")) continue;
		for (const section of /** @type {const} */ (["dependencies", "devDependencies"])) {
			const deps = pkg[section];
			const pin = deps?.[name];
			if (deps === undefined || pin === undefined) continue;
			const range = RANGE.exec(peer.trim());
			const floor = range ? parseVersion(range[2]) : undefined;
			if (!range || !floor) {
				throw new Error(
					`pack-build: cannot read the packed store's peer range for ${name} ("${peer}")`,
				);
			}
			const pinned = parseVersion(pin);
			if (!pinned) {
				throw new Error(
					`pack-build: the template pins ${name} ${pin}, which is not a plain version, so it cannot be compared with the packed store's peer ${peer}; pin an exact version in the template`,
				);
			}
			if (satisfiesPeer(pin, peer)) continue;
			if (!below(pinned, floor)) {
				throw new Error(
					`pack-build: the template pins ${name} ${pin}, ahead of the packed store's peer ${peer}; this branch may be behind the template, or the template moved without an Otta release`,
				);
			}
			deps[name] = range[2];
			changes.push({ name, section, from: pin, to: range[2], peer });
		}
	}
	return changes;
}

/**
 * The site's pins that some packed package's peer still refuses (after
 * alignment). Skips `@urumi.ai/*`, peers the site does not pin, and peer ranges
 * other than `x.y.z`, `~x.y.z` and `^x.y.z` (not checked, as in the twin).
 * @param {SitePackage} pkg
 * @param {Array<{ name: string, peerDependencies?: Record<string, string> }>} manifests
 * @returns {Array<{ name: string, pin: string, by: string, peer: string }>}
 */
export function pinsRefusedByPeers(pkg, manifests) {
	/** @type {Array<{ name: string, pin: string, by: string, peer: string }>} */
	const refused = [];
	for (const manifest of manifests) {
		for (const [name, peer] of Object.entries(manifest.peerDependencies ?? {})) {
			if (name.startsWith("@urumi.ai/") || !RANGE.test(peer.trim())) continue;
			const pin = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name];
			if (pin === undefined || satisfiesPeer(pin, peer)) continue;
			refused.push({ name, pin, by: manifest.name, peer });
		}
	}
	return refused;
}
