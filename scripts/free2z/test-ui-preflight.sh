#!/usr/bin/env bash
# Free2Z application check: test ui preflight.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PREFLIGHT="$REPO_ROOT/ts/svelte/free2z/scripts/preflight.mjs"

if [[ ! -f "$PREFLIGHT" ]]; then
	echo "FAIL: preflight script not found at $PREFLIGHT" >&2
	exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

failures=0

HOST_OS="$(node -p 'process.platform')"
HOST_CPU="$(node -p 'process.arch')"
# Empty off Linux, where npm attaches no libc constraint at all.
HOST_LIBC="$(node -p 'process.platform !== "linux" ? "" : (process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl")')"

# Build a fixture package directory. $1 = name of the case.
#
# The tree models the three classes that matter:
#   node_modules/dep, node_modules/other  — ordinary required deps
#   node_modules/host-binary              — optional, but os/cpu match THIS host,
#                                           so it is required here (the class
#                                           @resvg/resvg-js-darwin-arm64 is in)
#   node_modules/foreign-binary           — optional for another platform, plus a
#                                           nested child of its own; both must be
#                                           excused
make_fixture() {
	local dir="$TMP/$1"
	mkdir -p "$dir/scripts"
	cp "$PREFLIGHT" "$dir/scripts/preflight.mjs"
	cat >"$dir/package.json" <<'JSON'
{
  "name": "fixture",
  "engines": { "node": ">=24.0.0" },
  "devDependencies": { "dep": "^1.0.0", "other": "^2.0.0" }
}
JSON
	python3 - "$dir" "$HOST_OS" "$HOST_CPU" "$HOST_LIBC" <<'PY'
import json, os, sys

root, host_os, host_cpu, host_libc = sys.argv[1:5]
foreign_os = "aix" if host_os != "aix" else "sunos"

lock = {
    "lockfileVersion": 3,
    "packages": {
        "": {
            "name": "fixture",
            "devDependencies": {"dep": "^1.0.0", "other": "^2.0.0"},
        },
        "node_modules/dep": {"version": "1.0.0"},
        "node_modules/other": {"version": "2.0.0"},
        "node_modules/host-binary": {
            "version": "3.0.0", "optional": True,
            "os": [host_os], "cpu": [host_cpu],
        },
        "node_modules/foreign-binary": {
            "version": "4.0.0", "optional": True, "os": [foreign_os],
        },
        "node_modules/foreign-binary/node_modules/child": {"version": "5.0.0"},
        # An unsatisfied optional peer: recorded in the lockfile, never present.
        "node_modules/peer-only": {"version": "6.0.0", "peer": True},
        # A peer npm DID resolve and install: not excused, and its absence from
        # disk must be reported.
        "node_modules/peer-installed": {"version": "7.0.0", "peer": True},
    },
}
hidden = {
    "lockfileVersion": 3,
    "packages": {
        "node_modules/dep": {"version": "1.0.0"},
        "node_modules/other": {"version": "2.0.0"},
        "node_modules/host-binary": {"version": "3.0.0"},
        "node_modules/peer-installed": {"version": "7.0.0"},
    },
}
on_disk = [("dep", "1.0.0"), ("other", "2.0.0"), ("host-binary", "3.0.0"),
           ("peer-installed", "7.0.0")]

# The glibc/musl pair. Only meaningful on Linux, where npm installs exactly one
# half; off Linux the `os` constraint excuses both and the pair is inert. This
# is the case that would otherwise turn the required `ui` gate red on the
# Ubuntu runner after a perfectly clean `npm ci`.
if host_libc:
    other_libc = "musl" if host_libc == "glibc" else "glibc"
    lock["packages"]["node_modules/libc-host"] = {
        "version": "8.0.0", "optional": True,
        "os": [host_os], "cpu": [host_cpu], "libc": [host_libc],
    }
    lock["packages"]["node_modules/libc-other"] = {
        "version": "9.0.0", "optional": True,
        "os": [host_os], "cpu": [host_cpu], "libc": [other_libc],
    }
    hidden["packages"]["node_modules/libc-host"] = {"version": "8.0.0"}
    on_disk.append(("libc-host", "8.0.0"))

json.dump(lock, open(os.path.join(root, "package-lock.json"), "w"))
os.makedirs(os.path.join(root, "node_modules"), exist_ok=True)
json.dump(hidden, open(os.path.join(root, "node_modules", ".package-lock.json"), "w"))
for name, version in on_disk:
    d = os.path.join(root, "node_modules", name)
    os.makedirs(d, exist_ok=True)
    json.dump({"name": name, "version": version}, open(os.path.join(d, "package.json"), "w"))
PY
	echo "$dir"
}

# Rewrite one JSON file in a fixture with an inline python snippet on stdin.
patch_json() {
	python3 - "$1" "$2"
}

run_case() {
	local name="$1" expect="$2" dir="$3" want="${4:-}"
	local out status
	set +e
	out="$(cd "$dir" && node scripts/preflight.mjs 2>&1)"
	status=$?
	set -e
	if [[ "$expect" == "pass" && $status -ne 0 ]]; then
		echo "FAIL [$name]: expected exit 0, got $status" >&2
		echo "$out" >&2
		failures=$((failures + 1))
		return
	fi
	if [[ "$expect" == "fail" && $status -eq 0 ]]; then
		echo "FAIL [$name]: expected a nonzero exit, got 0" >&2
		failures=$((failures + 1))
		return
	fi
	if [[ -n "$want" ]] && ! grep -qF "$want" <<<"$out"; then
		echo "FAIL [$name]: output did not mention '$want'" >&2
		echo "$out" >&2
		failures=$((failures + 1))
		return
	fi
	echo "ok   [$name]"
}

# 1. Healthy tree. Foreign-platform optional packages, their nested children, and
#    an unsatisfied optional peer are all legitimately absent — none may be
#    reported. This is the case that keeps the guard alive.
dir="$(make_fixture healthy)"
run_case "healthy tree passes (foreign-arch, nested and peer entries excused)" pass "$dir"

dir="$(make_fixture deleted-dir)"
rm -rf "$dir/node_modules/dep"
run_case "a package directory deleted from disk is caught" fail "$dir" "missing from disk"

# 3. An optional package that IS required on this host. `npm ci --omit=optional`
#    leaves the JS wrapper installed and the native binding gone; skipping every
#    `optional: true` entry would wave that through and reproduce the exact
#    misleading failure this guard promises to prevent.
dir="$(make_fixture host-optional-missing)"
rm -rf "$dir/node_modules/host-binary"
patch_json "$dir" host <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "node_modules", ".package-lock.json")
d = json.load(open(p))
d["packages"].pop("node_modules/host-binary", None)
json.dump(d, open(p, "w"))
PY
run_case "an optional package required on THIS host is caught" fail "$dir" "node_modules/host-binary"

# 4. A dependency added to the lockfile that was never installed (stale tree
#    after a `git pull` that changed package-lock.json).
dir="$(make_fixture not-installed)"
patch_json "$dir" lock <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "package-lock.json")
d = json.load(open(p))
d["packages"]["node_modules/marked-footnote"] = {"version": "1.4.0"}
json.dump(d, open(p, "w"))
PY
run_case "a lockfile dep that was never installed is caught" fail "$dir" "marked-footnote"

# 5. Wrong version ON DISK while the hidden lockfile still records the right one.
#    npm's hidden lockfile is a claim, not an observation; a half-finished
#    install or a hand-swapped directory leaves it stale, so the version has to
#    be read from the package's own package.json.
dir="$(make_fixture wrong-version-on-disk)"
patch_json "$dir" disk <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "node_modules", "dep", "package.json")
json.dump({"name": "dep", "version": "0.9.0"}, open(p, "w"))
PY
run_case "a wrong on-disk version behind a stale hidden lockfile is caught" fail "$dir" "wrong version"

# 6. Tree ahead of the lockfile: `npm install <pkg>` without committing the lock.
dir="$(make_fixture tree-ahead)"
mkdir -p "$dir/node_modules/rogue"
patch_json "$dir" ahead <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "node_modules", ".package-lock.json")
d = json.load(open(p))
d["packages"]["node_modules/rogue"] = {"version": "1.0.0"}
json.dump(d, open(p, "w"))
PY
run_case "a tree ahead of the lockfile is caught" fail "$dir" "not in package-lock.json"

# 7. node_modules never installed at all.
dir="$(make_fixture no-install)"
rm -f "$dir/node_modules/.package-lock.json"
run_case "an uninstalled tree is caught" fail "$dir" ".package-lock.json is missing"

# 8. Node older than engines.node, major boundary. The floor is raised above the
#    running major so the case works on whatever Node runs this script.
dir="$(make_fixture old-node-major)"
patch_json "$dir" major <<'PY'
import json, os, subprocess, sys
major = int(subprocess.run(["node", "-p", "process.versions.node.split('.')[0]"],
                           capture_output=True, text=True).stdout.strip())
p = os.path.join(sys.argv[1], "package.json")
d = json.load(open(p))
d["engines"]["node"] = f">={major + 1}.0.0"
json.dump(d, open(p, "w"))
PY
run_case "a Node older than engines.node (major) is caught" fail "$dir" "older than engines.node"

# 9. Same major, higher minor floor. The trap this guard exists for is itself a
#    minor boundary — `.ts` type stripping lands in 22.18, not 22.0 — so a
#    major-only comparison would be blind the day the floor moves to >=24.18.0.
dir="$(make_fixture old-node-minor)"
patch_json "$dir" minor <<'PY'
import json, os, subprocess, sys
major, minor = (int(x) for x in subprocess.run(
    ["node", "-p", "process.versions.node.split('.').slice(0,2).join(' ')"],
    capture_output=True, text=True).stdout.split())
p = os.path.join(sys.argv[1], "package.json")
d = json.load(open(p))
d["engines"]["node"] = f">={major}.{minor + 1}.0"
json.dump(d, open(p, "w"))
PY
run_case "a Node below a same-major engines floor is caught" fail "$dir" "older than engines.node"

# 10. ...and the running Node itself must satisfy an equal floor, or case 9 would
#     pass for the wrong reason (any floor at all going red).
dir="$(make_fixture exact-node)"
patch_json "$dir" exact <<'PY'
import json, os, subprocess, sys
v = subprocess.run(["node", "-p", "process.versions.node"],
                   capture_output=True, text=True).stdout.strip()
p = os.path.join(sys.argv[1], "package.json")
d = json.load(open(p))
d["engines"]["node"] = f">={v}"
json.dump(d, open(p, "w"))
PY
run_case "the running Node satisfies an exactly-equal floor" pass "$dir"

# 11. The glibc/musl pair on Linux. Both halves match on os and cpu, so a rule
#     that looked only at those would demand the half `npm ci` correctly never
#     installs -- turning the required `ui` CI gate red after a clean install and
#     blocking every UI PR. Inert off Linux, where npm sets no libc constraint;
#     the healthy-tree case above already covers this host.
if [[ -n "$HOST_LIBC" ]]; then
	dir="$(make_fixture libc-pair)"
	run_case "the wrong-libc half of a native pair is excused ($HOST_LIBC host)" pass "$dir"

	dir="$(make_fixture libc-host-missing)"
	rm -rf "$dir/node_modules/libc-host"
	run_case "the matching-libc half is still required" fail "$dir" "node_modules/libc-host"
else
	echo "skip [libc pair: no libc constraint applies on $HOST_OS]"
fi

# 12. A peer npm actually resolved and installed, then deleted. Excusing every
#     `peer: true` entry outright would bless that tree; the unsatisfied peer in
#     the healthy fixture proves the excuse is still there when it is warranted.
dir="$(make_fixture resolved-peer-deleted)"
rm -rf "$dir/node_modules/peer-installed"
run_case "an installed peer deleted from disk is caught" fail "$dir" "node_modules/peer-installed"

# 13. A compound or caret engines range still yields a floor. ">=24 <26" and
#     "^24.18.0" are ordinary manifest edits, and a parser that only accepted the
#     exact current shape would silently stop checking Node after either.
for range in ">=99 <101" "^99.0.0" "~99.0.0"; do
	dir="$(make_fixture "engine-range-$(echo "$range" | tr -cd '[:alnum:]')")"
	patch_json "$dir" "$range" <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "package.json")
d = json.load(open(p))
d["engines"]["node"] = sys.argv[2]
json.dump(d, open(p, "w"))
PY
	run_case "engines.node \"$range\" is still enforced" fail "$dir" "older than engines.node"
done

# 14. package.json and package-lock.json describing different graphs. A merge
#     that takes the manifest from one side and the lock from the other leaves a
#     tree that still matches the (stale) lock, so every check below passes while
#     the newly declared import dies -- and the `npm ci` this script prescribes
#     everywhere else refuses to run, which is baffling advice unless the real
#     cause is named.
dir="$(make_fixture manifest-drift)"
patch_json "$dir" drift <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "package.json")
d = json.load(open(p))
d["devDependencies"]["marked-footnote"] = "^1.4.0"
json.dump(d, open(p, "w"))
PY
run_case "package.json ahead of package-lock.json is caught" fail "$dir" "different dependencies"

# 15. Engine floors written as npm's other legal shapes. "24" and "24.x" are
#     ordinary manifest values, and a parser that only accepted a leading
#     >=/^/~ would fail open on them -- warn, exit 0, and let Node 22 run.
for range in "99" "99.x" "99.*"; do
	dir="$(make_fixture "engine-bare-$(echo "$range" | tr -cd '[:alnum:]')")"
	patch_json "$dir" "$range" <<'PY'
import json, os, sys
p = os.path.join(sys.argv[1], "package.json")
d = json.load(open(p))
d["engines"]["node"] = sys.argv[2]
json.dump(d, open(p, "w"))
PY
	run_case "engines.node \"$range\" is still enforced" fail "$dir" "older than engines.node"
done

# Hoisted dependencies of foreign optional binaries have no os/cpu metadata
# themselves. A grandchild must follow the exemption, but a shared dependency
# reached from a host package must remain required even if npm's hidden lock
# omitted it. This models Sharp's foreign wasm wrappers and @emnapi/runtime.
for mode in foreign-only shared-host shared-peer nested-host nested-host-present; do
  dir="$(make_fixture "hoisted-$mode")"
  patch_json "$dir" "$mode" <<'PYFIX'
import json, os, sys
root, mode = sys.argv[1:3]
p = os.path.join(root, "package-lock.json")
lock = json.load(open(p))
entries = lock["packages"]
entries["node_modules/foreign-binary"]["dependencies"] = {"hoisted": "1.0.0"}
entries["node_modules/hoisted"] = {
    "version": "1.0.0", "optional": True,
    "dependencies": {"grandchild": "1.0.0"},
}
entries["node_modules/grandchild"] = {"version": "1.0.0", "optional": True}
if mode == "shared-host":
    entries["node_modules/dep"]["dependencies"] = {"grandchild": "1.0.0"}
if mode == "shared-peer":
    entries["node_modules/dep"]["peerDependencies"] = {"grandchild": "1.0.0"}
if mode.startswith("nested-host"):
    # The host package resolves its own nearer nested copy. It does not need
    # the top-level grandchild, but that nested copy must still be required.
    entries["node_modules/dep"]["dependencies"] = {"grandchild": "2.0.0"}
    entries["node_modules/dep/node_modules/grandchild"] = {
        "version": "2.0.0", "optional": True,
    }
if mode == "nested-host-present":
    nested = os.path.join(root, "node_modules", "dep", "node_modules", "grandchild")
    os.makedirs(nested)
    json.dump({"name": "grandchild", "version": "2.0.0"}, open(os.path.join(nested, "package.json"), "w"))
json.dump(lock, open(p, "w"))
PYFIX
  if [[ "$mode" == nested-host-present ]]; then
    run_case "installed nested host copy does not require foreign hoisted copy" pass "$dir"
  elif [[ "$mode" == foreign-only ]]; then
    run_case "foreign-only hoisted children and grandchildren are excused" pass "$dir"
  elif [[ "$mode" == nested-host ]]; then
    run_case "nearest host dependency is still required" fail "$dir" "node_modules/dep/node_modules/grandchild"
  else
    run_case "hoisted dependency shared with a host $mode remains required" fail "$dir" "node_modules/grandchild"
  fi
done

# 16. The lifecycle wiring itself. Everything above invokes preflight.mjs
#     directly, so a deleted or misspelled `pretest` hook would leave every case
#     green while local `npm test` runs with no preflight at all -- the exact
#     silent-regression shape this guard was built to stop.
wiring_report=""
set +e
wiring_report="$(python3 - "$REPO_ROOT" <<'PY'
import json, os, sys

root = sys.argv[1]
pkg = json.load(open(os.path.join(root, "ts/svelte/free2z/package.json")))
scripts = pkg.get("scripts", {})
gone = [name for name in ("pretest", "pretest:browser")
        if "scripts/preflight.mjs" not in scripts.get(name, "")]
if gone:
    print(", ".join(gone))
    sys.exit(1)
PY
)"
wiring_status=$?
set -e
if [[ $wiring_status -eq 0 ]]; then
	echo "ok   [package.json still runs the preflight as pretest and pretest:browser]"
else
	echo "FAIL [lifecycle wiring]: npm test would run without the preflight ($wiring_report)" >&2
	failures=$((failures + 1))
fi

if ((failures)); then
	echo "$failures preflight positive control(s) FAILED" >&2
	exit 1
fi
echo "All preflight positive controls passed."
