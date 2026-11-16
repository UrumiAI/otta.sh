/**
 * The peer alignment `pack-build.mjs` applies to the scratch site.
 *
 * The template pins the host train (emdash, @emdash-cms/cloudflare, astro, react,
 * ...) at the versions the LAST published Otta release supports. On a branch that
 * moves that train, the packed `@urumi.ai/otta-store` declares the new versions as
 * peers and npm refuses the template's pins (ERESOLVE), although the template can
 * only move after this release is published. So, before installing, each pin of
 * the site's that the packed store's peer range refuses is moved to the version
 * the peer names: the version itself for an exact peer, the range's floor for a
 * `~` or `^` range. Pins the peer accepts, `@urumi.ai/*` (the tarballs) and peers
 * the site does not pin are left alone.
 */

const VERSION = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/;
const RANGE = /^([~^]?)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** @param {string} version */
function parts(version) {
	const m = VERSION.exec(version);
	if (!m) return undefined;
	return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ?? "" };
}

/**
 * Whether `version` (exact) satisfies `peer` (exact, `~x.y.z` or `^x.y.z`). A
 * prerelease satisfies only an equal exact peer. Anything else is `false`.
 * @param {string} version
 * @param {string} peer
 * @returns {boolean}
 */
export function satisfiesPeer(version, peer) {
	const range = RANGE.exec(peer);
	const v = parts(version);
	if (!range || !v) return false;
	const [, op, floorText] = range;
	if (op === "") return version === floorText;
	const floor = parts(floorText);
	if (!floor || v.pre !== "") return false;
	const atLeast =
		v.major !== floor.major
			? v.major > floor.major
			: v.minor !== floor.minor
				? v.minor > floor.minor
				: v.patch >= floor.patch;
	if (!atLeast) return false;
	if (op === "~") return v.major === floor.major && v.minor === floor.minor;
	if (floor.major > 0) return v.major === floor.major;
	if (floor.minor > 0) return v.major === 0 && v.minor === floor.minor;
	return v.major === 0 && v.minor === 0 && v.patch === floor.patch;
}

/**
 * Move each of `pkg`'s pins that `peers` refuses to the peer's version, in place.
 * Returns what changed, sorted by name.
 * @param {{ dependencies?: Record<string, string>, devDependencies?: Record<string, string> }} pkg
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
			const range = RANGE.exec(peer);
			if (!range) {
				throw new Error(
					`pack-build: cannot read the packed store's peer range for ${name} ("${peer}")`,
				);
			}
			// The template pins exactly; a range pin is judged by its floor.
			const pinned = pin.replace(/^[~^=]/, "");
			if (satisfiesPeer(pinned, peer)) continue;
			const to = range[2];
			deps[name] = to;
			changes.push({ name, section, from: pin, to, peer });
		}
	}
	return changes;
}
