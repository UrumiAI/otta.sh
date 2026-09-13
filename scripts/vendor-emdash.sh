#!/usr/bin/env bash
#
# Rebuild the vendored EmDash host tarballs in `vendor/`.
#
# The host Otta builds against is upstream EmDash `main` with the open
# conditional-write pull request merged onto it, packed as four tarballs and
# committed under `vendor/`. See `vendor/README.md` for what is in them and why.
#
# This script is the reproduction recipe. It is idempotent: re-running it with
# the same two commits reproduces the same merge branch and the same tarballs.
#
# Usage:
#   scripts/vendor-emdash.sh <base-main-sha> <cas-pr-head-sha> [clone-dir]
#
# Environment:
#   EMDASH_UPSTREAM_URL   upstream repository to fetch from (read-only)
#   EMDASH_FORK_REMOTE    remote name to push the merge branch to; the push is
#                         refused unless its URL is the project's own fork
#   EMDASH_CAS_PR         pull-request number whose head is merged (default 2980)
#   EMDASH_RECORDED_MERGE the merge commit recorded in vendor/README.md
#   EMDASH_RECORDED_HEAD  the branch head recorded in vendor/README.md (the
#                         merge plus the post-merge fix-ups it needed)
#   SKIP_PUSH=1           build and pack without pushing the branch
#
set -euo pipefail

BASE_SHA="${1:?base upstream main SHA required}"
CAS_SHA="${2:?conditional-write PR head SHA required}"
CLONE_DIR="${3:-${EMDASH_CLONE_DIR:-}}"
CAS_PR="${EMDASH_CAS_PR:-2980}"
UPSTREAM_URL="${EMDASH_UPSTREAM_URL:-https://github.com/emdash-cms/emdash.git}"
FORK_REMOTE="${EMDASH_FORK_REMOTE:-origin}"
BRANCH="otta/emdash-cas"
FORK_OWNER="vedanshujain"
RECORDED_MERGE="${EMDASH_RECORDED_MERGE:-39ff8569c914853fa7fde1720632caa6ba4ac91c}"
RECORDED_HEAD="${EMDASH_RECORDED_HEAD:-2dc708318d358631ab0620aded3d2afc0bac6de9}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="$REPO_ROOT/vendor"
CONFLICT_DIFF="$VENDOR_DIR/otta-emdash-cas.diff"

if [[ -z "$CLONE_DIR" ]]; then
	echo "error: pass the EmDash clone directory as the third argument, or set EMDASH_CLONE_DIR." >&2
	exit 2
fi
CLONE_DIR="$(cd "$CLONE_DIR" && pwd)"

log() { printf '\n==> %s\n' "$*"; }
die() { printf '\nerror: %s\n' "$*" >&2; exit 1; }

# ── 1. Fetch the base and the PR head ───────────────────────────────────────
log "Fetching upstream main and PR #$CAS_PR head"
git -C "$CLONE_DIR" fetch "$UPSTREAM_URL" main
git -C "$CLONE_DIR" fetch "$UPSTREAM_URL" "refs/pull/$CAS_PR/head"
git -C "$CLONE_DIR" cat-file -e "$BASE_SHA^{commit}"
git -C "$CLONE_DIR" cat-file -e "$CAS_SHA^{commit}"

# ── 2. Reproduce the merge ──────────────────────────────────────────────────
# What is vendored is not the raw merge: it is the merge plus the fix-ups the
# merge itself needed (the keep-both import lists leave an unused type import
# behind, and the host lints with `--deny-warnings`). Both SHAs are recorded in
# `vendor/README.md`, and the recorded HEAD is reused verbatim when it is
# reachable, its first-parent chain contains the recorded merge, and that merge
# has exactly the two requested commits as parents. Otherwise the merge is
# attempted fresh and the resolutions have to be re-applied —
# `vendor/otta-emdash-cas.diff` is the machine-readable record of them.
WORKTREE="${EMDASH_BUILD_WORKTREE:-$CLONE_DIR/../emdash-build-otta-cas}"

log "Preparing build worktree"
git -C "$CLONE_DIR" fetch "$FORK_REMOTE" "$BRANCH" 2>/dev/null || true

reusable_head() { # prints the recorded head when it can be reused
	git -C "$CLONE_DIR" cat-file -e "$RECORDED_HEAD^{commit}" 2>/dev/null || return 1
	git -C "$CLONE_DIR" cat-file -e "$RECORDED_MERGE^{commit}" 2>/dev/null || return 1
	# the recorded merge must be on the recorded head's first-parent chain
	# (no pipe into `grep -q`: its early exit would trip `pipefail`)
	local chain
	chain="$(git -C "$CLONE_DIR" rev-list --first-parent "$RECORDED_HEAD")"
	grep -qx "$RECORDED_MERGE" <<<"$chain" || return 1
	local parents
	parents="$(git -C "$CLONE_DIR" rev-list --parents -n 1 "$RECORDED_MERGE" | cut -d" " -f2-)"
	[[ "$parents" == "$BASE_SHA $CAS_SHA" ]] || return 1
	printf '%s' "$RECORDED_HEAD"
}

RECORDED=""
if RECORDED="$(reusable_head)"; then
	log "Reusing the recorded branch head $RECORDED (merge $RECORDED_MERGE on its first-parent chain)"
else
	RECORDED=""
	log "The recorded head is unreachable or does not match the requested commits; re-merging"
fi

if [[ -d "$WORKTREE" ]]; then
	git -C "$WORKTREE" merge --abort 2>/dev/null || true
	git -C "$WORKTREE" reset --hard -q "$BASE_SHA"
	git -C "$WORKTREE" clean -qfdx -e node_modules
else
	git -C "$CLONE_DIR" worktree add -q -B "$BRANCH" "$WORKTREE" "$BASE_SHA"
fi

if [[ -n "$RECORDED" ]]; then
	git -C "$WORKTREE" checkout -q -B "$BRANCH" "$RECORDED"
else
	git -C "$WORKTREE" checkout -q -B "$BRANCH" "$BASE_SHA"
	log "Checking whether the recorded resolutions still apply to this base"
	if git -C "$WORKTREE" apply --check "$CONFLICT_DIFF"; then
		echo "    vendor/otta-emdash-cas.diff applies cleanly — the recorded resolutions are still valid."
	else
		echo "    vendor/otta-emdash-cas.diff no longer applies — the resolutions need redoing by hand." >&2
	fi
	log "Merging PR #$CAS_PR"
	if ! git -C "$WORKTREE" merge --no-edit "$CAS_SHA"; then
		cat >&2 <<-'MSG'

			The merge stopped on conflicts, and no recorded resolution matches these
			two commits. vendor/README.md lists the resolutions this build expects
			and vendor/otta-emdash-cas.diff is the same thing as a patch. Apply them,
			commit the merge on the branch, run the host's own
			`oxlint --type-aware --deny-warnings` and commit any fix-ups it demands,
			then re-run this script with the new SHAs recorded.

			The load-bearing one is the migration-number collision: the PR's
			plugin-storage-revisions migration must be renumbered to the next free
			number -- the file, its .ts importers, and the runner's map key.
		MSG
		exit 1
	fi
fi

# The migration-number collision is a SEMANTIC conflict, not a textual one: an
# auto-merge can succeed and leave two migrations sharing a numeric prefix, and
# the runner keys its map by name, so nothing downstream complains. Assert it.
MIGRATIONS_DIR="$WORKTREE/packages/core/src/database/migrations"
[[ -d "$MIGRATIONS_DIR" ]] || die "no migrations directory at $MIGRATIONS_DIR — the host has moved it, and every check below would pass vacuously."
DUPES="$(ls "$MIGRATIONS_DIR" | grep -E '^[0-9]+_' | sed 's/_.*//' | sort | uniq -d || true)"
[[ -z "$DUPES" ]] || die "duplicate migration number(s) in the merged tree: $DUPES
       renumber the pull request's migration to the next free number."
MIGRATION_TAIL="$(ls "$MIGRATIONS_DIR" | grep -E '^[0-9]+_' | sort | tail -1 | sed 's/\.ts$//')"
[[ -n "$MIGRATION_TAIL" ]] || die "no numbered migrations found in $MIGRATIONS_DIR — the post-pack assertion would have nothing to check."
log "Migrations: $(ls "$MIGRATIONS_DIR" | grep -cE '^[0-9]+_') with unique numbers, tail $MIGRATION_TAIL"

# ── 3. Install ──────────────────────────────────────────────────────────────
# Frozen only, deliberately: an unpinned fallback would let the dependency
# closure bundled into the tarballs drift between runs of a script whose whole
# point is reproducing one build.
log "Installing"
(cd "$WORKTREE" && pnpm install --frozen-lockfile)

# ── 4. Build the packages Otta consumes ─────────────────────────────────────
# `admin` and `registry-client` are here because the core build links against
# their WORKSPACE source, which is newer than the release their version names.
# See vendor/README.md.
log "Building"
for filter in emdash @emdash-cms/admin @emdash-cms/cloudflare @emdash-cms/registry-client; do
	(cd "$WORKTREE" && pnpm --filter "$filter" build)
done

# ── 5. Version the packed build so it cannot be confused with a release ─────
# Each package's own version, patch-bumped and suffixed. The suffix is what
# keeps a vendored build from ever being mistaken for a published release.
PACKAGES=(core admin cloudflare registry-client)

bump_version() { # <package-dir> -> prints "<from> <to>"
	node -e "
		const fs = require('fs');
		const f = '$WORKTREE/packages/' + process.argv[1] + '/package.json';
		const s = fs.readFileSync(f, 'utf8');
		const from = JSON.parse(s).version;
		const [maj, min, patch] = from.split('-')[0].split('.');
		const to = maj + '.' + min + '.' + (Number(patch) + 1) + '-otta.1';
		fs.writeFileSync(f, s.replace('\"version\": \"' + from + '\"', '\"version\": \"' + to + '\"'));
		process.stdout.write(from + ' ' + to);
	" "$1"
}

restore_versions() {
	for pkg in "${PACKAGES[@]}"; do
		git -C "$WORKTREE" checkout -- "packages/$pkg/package.json" 2>/dev/null || true
	done
}
trap restore_versions EXIT

for pkg in "${PACKAGES[@]}"; do
	log "Versioning $pkg: $(bump_version "$pkg")"
done

# ── 6. Pack into vendor/ ────────────────────────────────────────────────────
mkdir -p "$VENDOR_DIR"
rm -f "$VENDOR_DIR"/emdash-*.tgz
for pkg in "${PACKAGES[@]}"; do
	(cd "$WORKTREE/packages/$pkg" && pnpm pack --pack-destination "$VENDOR_DIR" >/dev/null)
done
restore_versions
trap - EXIT
ls -l "$VENDOR_DIR"

# ── 6b. Assert the packed core actually carries what it is vendored for ──────
# A build that silently loses a primitive, or a pack that picks up a stale
# `dist`, would otherwise only surface increments later.
CORE_TGZ="$(ls "$VENDOR_DIR"/emdash-[0-9]*.tgz)"
CHECK_DIR="$(mktemp -d)"
trap 'rm -rf "$CHECK_DIR"' EXIT
tar -xzf "$CORE_TGZ" -C "$CHECK_DIR" package/dist
for symbol in updateIf getVersioned compareAndSet compareAndDelete "$MIGRATION_TAIL"; do
	grep -rqlF "$symbol" "$CHECK_DIR/package/dist" ||
		die "the packed core's dist does not mention '$symbol' — the build is not the CAS build."
done
rm -rf "$CHECK_DIR"
trap - EXIT
log "Packed core carries updateIf, getVersioned, compareAndSet, compareAndDelete and $MIGRATION_TAIL"

# ── 7. Push the merge branch to the project's own fork, never upstream ──────
if [[ "${SKIP_PUSH:-}" == "1" ]]; then
	log "SKIP_PUSH=1 — not pushing $BRANCH"
	exit 0
fi
FORK_URL="$(git -C "$CLONE_DIR" remote get-url "$FORK_REMOTE")"
case "$FORK_URL" in
	*"$FORK_OWNER"*) ;;
	*)
		echo "error: refusing to push — remote '$FORK_REMOTE' is not the project's own fork." >&2
		echo "       This script never pushes to the upstream repository." >&2
		exit 3
		;;
esac
# A plain push, never forced: the recorded head is what the vendored tarballs
# were built from, so rewriting it would orphan the record.
log "Pushing $BRANCH to '$FORK_REMOTE'"
git -C "$WORKTREE" push "$FORK_REMOTE" "$BRANCH"

log "Done. Update the SHAs and figures in vendor/README.md if either commit moved."
