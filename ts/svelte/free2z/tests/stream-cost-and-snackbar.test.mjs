// Regression guards for  (stream-mode cost transparency + 2Z iconography)
// and  (classic-UI snackbar). These are source assertions in the style of
// profile-actions.test.mjs: the behaviours they protect are Tailwind classes,
// timer lifecycle and a CSS custom property, none of which a headless run can
// check without standing up an authenticated dashboard or spoofing the
// free2z.cash hostname the banner gates on.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ppvJoinThreshold } from "../src/lib/ppv-join-threshold.js";

const root = new URL("../", import.meta.url);
const read = (relative) =>
  readFileSync(fileURLToPath(new URL(relative, root)), "utf8");

// These guards assert on what the component *does*, so prose that merely names
// a forbidden token (an explanatory comment saying "not DollarSign") must not
// trip them.
const stripComments = (source) =>
  source
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");

const STREAM_PAGE = "src/routes/[username]/dashboard/stream/+page.svelte";
const BANNER = "src/lib/components/layout/ClassicUiBanner.svelte";
const PAGE_ACTIONS = "src/lib/components/zpageActions/PageActions.svelte";
const TOASTER = "src/lib/components/ui/sonner/sonner.svelte";
const LOCALES = ["en", "es", "fr", "pt-BR"];
const MODES = ["broadcast", "subscribers", "ppv", "private"];

function walk(relativeDir, out = []) {
  for (const entry of readdirSync(fileURLToPath(new URL(relativeDir, root)), {
    withFileTypes: true,
  })) {
    const child = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) walk(child, out);
    else if (/\.(svelte|ts|js)$/.test(entry.name)) out.push(child);
  }
  return out;
}

test("#534: every stream-mode card states its cost", () => {
  const source = read(STREAM_PAGE);
  const grid = source.slice(
    source.indexOf("<!-- Stream Type Selection -->"),
    source.indexOf('data-testid="stream-audience-detail"'),
  );
  const selection = source.slice(
    source.indexOf("<!-- Stream Type Selection -->"),
    source.indexOf("<!-- PPV Settings -->"),
  );
  assert.ok(grid.length > 0, "stream type grid markers moved");
  assert.match(
    grid,
    /\{#each audienceModes as [A-Za-z_$][\w$]* \([A-Za-z_$][\w$]*\.value\)\}/,
    "audience cards must be generated from the shared modes collection",
  );
  assert.equal(
    (grid.match(/<label\b/g) || []).length,
    1,
    "the four audience modes must share one native radio card anatomy",
  );
  assert.match(
    grid,
    /type=["']radio["']/,
    "audience cards must use native radio inputs",
  );
  assert.match(
    grid,
    /name=["']stream-audience["']/,
    "audience cards must share one radio group",
  );
  assert.match(
    grid,
    /bind:group=\{streamType\}/,
    "audience cards must bind the radio group to streamType",
  );
  assert.doesNotMatch(
    grid,
    /aria-pressed/,
    "audience cards must expose radio semantics, not toggle-button semantics",
  );
  assert.match(
    selection,
    /data-audience-cost-detail[\s\S]*selectedAudience\.costKey/,
    "the selected card mode must drive the persistent full cost detail",
  );

  for (const mode of MODES) {
    assert.match(
      source,
      new RegExp(`"dashboard\\.stream\\.types\\.${mode}\\.summary"`),
      `${mode} card has no concise cost summary`,
    );
    assert.match(
      source,
      new RegExp(`"dashboard\\.stream\\.types\\.${mode}\\.cost"`),
      `${mode} has no authoritative cost copy — #534 is about all four`,
    );
  }

  // Warning styling is reserved for the one mode where the creator actually
  // spends 2Z (py/free2z/dj/apps/dyte/views.py bills only broadcast and PPV, and PPV
  // bills the viewer). Free/viewer-pays modes stay muted.
  // Only cost lines are inspected: the Private card legitimately uses orange
  // for its own accent (border/icon), which is not a spend warning.
  const warned = grid
    .split("\n")
    .filter((line) => line.includes("text-xs") && line.includes("text-orange"));
  assert.equal(
    warned.length,
    1,
    "only the broadcast card may carry the orange spend warning",
  );
});

test("#534: cost copy wraps instead of running off the card", () => {
  const source = read(STREAM_PAGE);
  const grid = source.slice(
    source.indexOf("<!-- Stream Type Selection -->"),
    source.indexOf('data-testid="stream-audience-detail"'),
  );
  const detail = source.slice(
    source.indexOf('data-testid="stream-audience-detail"'),
    source.indexOf("<!-- PPV Settings -->"),
  );

  // The card labels use the same button-like styling and every text node inside
  // has to opt back out of whitespace-nowrap or it overflows at 320px. The
  // full billing sentence lives below the cards now, but it has the same rule.
  const summary = grid.slice(
    grid.indexOf("data-audience-summary"),
    grid.indexOf("</p>", grid.indexOf("data-audience-summary")),
  );
  const costDetail = detail.slice(
    detail.indexOf("data-audience-cost-detail"),
    detail.indexOf("</p>", detail.indexOf("data-audience-cost-detail")),
  );
  for (const [block, name] of [
    [summary, "shared card summary"],
    [costDetail, "persistent full cost detail"],
  ]) {
    assert.ok(block.length > 0, `${name} marker moved`);
    assert.match(block, /break-words/, `${name} must break long words`);
    assert.match(block, /whitespace-normal/, `${name} must allow wrapping`);
  }
});

test("#534: money UI uses the 2Z mark, never a dollar sign", () => {
  const offenders = walk("src")
    .filter((file) => /DollarSign/.test(stripComments(read(file))))
    .sort();
  assert.deepEqual(
    offenders,
    [],
    "2Z-denominated UI must use TuziMark, not lucide DollarSign",
  );

  assert.match(read(STREAM_PAGE), /<TuziMark/);
  assert.match(
    read("src/lib/components/stream/StreamSelectionModal.svelte"),
    /<TuziMark/,
  );
});

test("#534: the new cost strings exist in every shipped locale", () => {
  for (const locale of LOCALES) {
    const catalog = JSON.parse(read(`src/lib/locales/${locale}.json`));
    const types = catalog.dashboard.stream.types;
    assert.equal(
      typeof catalog.dashboard.stream.ppvJoinThreshold,
      "string",
      `${locale}.json is missing dashboard.stream.ppvJoinThreshold`,
    );
    for (const mode of MODES) {
      assert.equal(
        typeof types[mode]?.cost,
        "string",
        `${locale}.json is missing dashboard.stream.types.${mode}.cost`,
      );
      assert.ok(types[mode].cost.length > 0);
      assert.equal(
        typeof types[mode]?.summary,
        "string",
        `${locale}.json is missing dashboard.stream.types.${mode}.summary`,
      );
      assert.ok(types[mode].summary.length > 0);
    }
  }
});

test("#852: the creator sees the exact PPV admission reserve", () => {
  const source = read(STREAM_PAGE);
  const settings = source.slice(
    source.indexOf("<!-- PPV Settings -->"),
    source.indexOf("{#if error}"),
  );

  assert.match(source, /ppvJoinThreshold\(ppvPrice\)/);
  assert.match(settings, /max="9999\.99"/);
  assert.match(settings, /dashboard\.stream\.ppvJoinThreshold/);
  assert.match(
    settings,
    /formatLocalizedNumber\(joinThreshold\)/,
    "the displayed threshold must use localized number formatting",
  );
  assert.doesNotMatch(
    source,
    /capped by their balance|limitado por su saldo|limité par leur solde|limitado pelo saldo/,
    "PPV copy must not imply that viewers can join below the admission gate",
  );
});

test("#852: PPV threshold arithmetic is exact at decimal boundaries", () => {
  assert.equal(ppvJoinThreshold("100"), 3015);
  assert.equal(ppvJoinThreshold("0.29"), 24);
  assert.equal(ppvJoinThreshold(0.01), 16);
  assert.equal(ppvJoinThreshold("1.20"), 51);
  assert.equal(ppvJoinThreshold("9999.99"), 300015);

  for (const invalid of [
    0,
    -1,
    "",
    "1.234",
    "10000",
    Infinity,
    undefined,
    null,
  ]) {
    assert.equal(
      ppvJoinThreshold(invalid),
      null,
      `${invalid} must be rejected`,
    );
  }
});

test("#534: the billing formula the cost copy describes has not moved", () => {
  // A tripwire, not a calculation: the cards make a real-money promise, so if
  // anyone changes the settlement math the next UI change has to stop and
  // re-read the copy. Caveat: the `ui` CI job only runs on UI diffs, so a
  // backend-only change lands green and this fires on the following UI PR.
  const views = read("../../../py/free2z/dj/apps/dyte/views.py");

  const expectations = [
    [
      /PPV_JOIN_RESERVE_MINUTES = 30[\s\S]*?PPV_JOIN_PLATFORM_RESERVE = 15[\s\S]*?math\.ceil\([\s\S]*?PPV_JOIN_RESERVE_MINUTES[\s\S]*?PPV_JOIN_PLATFORM_RESERVE/,
      "ppv admission reserve formula",
    ],
    // Session duration rounds UP to whole minutes...
    [
      /duration_minutes = math\.ceil\(\(left_at - joined_at\)\.total_seconds\(\) \/ 60\)/,
      "session duration rounding",
    ],
    //...then 2-minute blocks round DOWN, with NO floor ( removed the
    // `max(..., 1)`). This ceil-then-floor pair is why the cards say "about
    // 1 2Z every 2 minutes" rather than promising an exact rate, and the
    // missing floor is why they say a session of a minute or less is free.
    [/return duration_minutes \/\/ 2$/m, "platform fee formula"],
    // The PPV creator cut rounds the session TOTAL up, not the rate.
    [
      /creator_fee = math\.ceil\(price_per_minute \* duration_minutes\)/,
      "ppv creator fee formula",
    ],
  ];

  for (const [pattern, what] of expectations) {
    assert.match(
      views,
      pattern,
      `${what} changed in py/free2z/dj/apps/dyte/views.py — re-check dashboard.stream.types.*.cost in every locale before updating this test`,
    );
  }

  //the floor stays gone. Restoring it would make a one-second session
  // cost a creator the same as a two-minute one, which is the balance-drain
  // lever the issue closed — and it would make every cost line above wrong.
  assert.doesNotMatch(
    views,
    /max\(\s*duration_minutes/,
    "the platform fee floor is back (#987) — the cost copy in every locale promises that a session of a minute or less is free",
  );
});

test("#987: no cost line misquotes the free window", () => {
  // Two ways to get this wrong, both of which quote a number the backend never
  // charges:
  //
  //  1. "minimum 1 2Z" — the floor is gone, a short session costs nothing.
  //  2. "under 2 minutes is free" — WRONG at the boundary. duration_minutes is
  //     ceil(seconds / 60), so a 1:30 session rounds to 2 and bills 1 2Z. The
  //     free window is a minute or less; 0:60 is the last free session.
  const MINIMUM_CLAIM =
    /minimum 1 2Z|mínimo 1 2Z|mínimo de 1 2Z|minimum de 1 2Z/i;
  const TWO_MINUTE_FREE_CLAIM =
    /(under|less than|menos de|moins de|com menos de|de menos de)\s*2\s*(minutes|minutos)/i;
  const check = (text, where) => {
    assert.doesNotMatch(
      text,
      MINIMUM_CLAIM,
      `${where} still promises a per-session minimum`,
    );
    assert.doesNotMatch(
      text,
      TWO_MINUTE_FREE_CLAIM,
      `${where} quotes a 2-minute free window; the real one is a minute or less`,
    );
  };

  for (const locale of LOCALES) {
    const types = JSON.parse(read(`src/lib/locales/${locale}.json`)).dashboard
      .stream.types;
    for (const mode of MODES) {
      check(types[mode].cost, `${locale}.json ${mode}.cost`);
    }
  }
  check(stripComments(read(STREAM_PAGE)), STREAM_PAGE);
});

test("#506: the classic-UI snackbar auto-dismisses and cleans up its timer", () => {
  const source = read(BANNER);

  assert.match(source, /AUTO_DISMISS_MS = \d+/, "no auto-dismiss timeout");
  const ms = Number(source.match(/AUTO_DISMISS_MS = (\d+)/)[1]);
  assert.ok(
    ms >= 5000 && ms <= 12000,
    `auto-dismiss of ${ms}ms is outside the ~8s the issue asks for`,
  );

  // The timer must be owned by an effect that returns a teardown, otherwise a
  // pending dismissal can fire after the component is gone.
  assert.match(
    source,
    /const timer = setTimeout\([\s\S]*?return \(\) => clearTimeout\(timer\);/,
    "the auto-dismiss timer is not cleared on unmount",
  );

  // Timing out must not persist: only the explicit close writes the key.
  const persistCount = (source.match(/localStorage\.setItem/g) || []).length;
  assert.equal(persistCount, 1, "only the ✕ may persist the dismissal");

  // Announcing a message that disappears on a timer fights screen readers.
  const markup = stripComments(source);
  assert.doesNotMatch(markup, /aria-live/);
  assert.doesNotMatch(markup, /role="(status|alert)"/);

  // Hover/focus suspends the countdown so it cannot vanish mid-read, and the
  // two are tracked separately so releasing one does not clear the other.
  assert.match(source, /onpointerenter=\{\(\) => \(hovered = true\)\}/);
  assert.match(source, /onpointerleave=\{\(\) => \(hovered = false\)\}/);
  assert.match(source, /onfocusin=\{\(\) => \(focusWithin = true\)\}/);
  assert.match(source, /onfocusout=\{\(\) => \(focusWithin = false\)\}/);
  assert.match(source, /held = \$derived\(hovered \|\| focusWithin\)/);
  assert.match(source, /if \(!visible \|\| held\) return;/);
});

test("#506: the snackbar wraps for locales with long labels", () => {
  const source = read(BANNER);
  const markup = stripComments(source.slice(source.indexOf("{#if visible}")));

  // "Switch back" is "Volver a la versión anterior" in Spanish — wider on its
  // own than the room left beside a 44px close button at 320px. Nothing here
  // may be nowrap, and the notice must be able to claim its own row.
  assert.doesNotMatch(markup, /whitespace-nowrap/);
  assert.match(markup, /flex-wrap/);
  assert.match(markup, /class="w-full min-w-0 [^"]*sm:w-auto"/);
});

test("#506: the dismiss target meets the 44px touch minimum", () => {
  const source = read(BANNER);
  const button = source.slice(
    source.indexOf("<button"),
    source.indexOf("</button>"),
  );
  // size-11 === 2.75rem === 44px.
  assert.match(button, /\bsize-11\b/, "dismiss target is under 44px");
  assert.match(button, /navigation\.dismiss/);
});

test("#506: bottom-docked chrome clears the snackbar", () => {
  const banner = read(BANNER);
  const actions = read(PAGE_ACTIONS);

  // The banner publishes its measured height...
  assert.match(banner, /bind:clientHeight=\{dockHeight\}/);
  assert.match(banner, /"--f2z-bottom-dock-height"/);
  assert.match(banner, /removeProperty\("--f2z-bottom-dock-height"\)/);
  //...and zeroes it while hidden so the FAB does not stay lifted.
  assert.match(banner, /const height = visible \? dockHeight : 0;/);

  //...and the article FAB consumes it instead of a hardcoded inline offset.
  assert.match(actions, /var\(--f2z-bottom-dock-height, 0px\)/);
  // Unconditionally: a "wide viewports are safe" breakpoint is a bet on
  // translation length, and the Spanish/Portuguese notice already loses it
  // at 640px.
  const dockRule = actions.slice(
    actions.indexOf(".page-action-dock {"),
    actions.indexOf("/* Entrance:"),
  );
  assert.doesNotMatch(dockRule, /@media/);
  assert.doesNotMatch(
    actions,
    /style="bottom:/,
    "inline bottom would win over the dock-aware rule",
  );
});

test("#853: Sonner clears the bottom dock at both responsive offsets", () => {
  const toaster = read(TOASTER);

  // Sonner replaces `offset` with `mobileOffset` at 600px. Both paths must
  // consume the measured dock height or the reported narrow viewport regresses.
  const occurrences = toaster.match(/var\(--f2z-bottom-dock-height, 0px\)/g);
  assert.equal(occurrences?.length, 2);
  assert.match(toaster, /const offset: SonnerProps\["offset"\]/);
  assert.match(toaster, /const mobileOffset: SonnerProps\["mobileOffset"\]/);
  assert.match(toaster, /env\(safe-area-inset-bottom\)/);
});

test("#853: persistent page actions deliberately paint above toasts", () => {
  const toaster = read(TOASTER);
  const actions = read(PAGE_ACTIONS);

  assert.match(toaster, /z-index: 60/);
  assert.match(actions, /z-index: 70/);
  assert.match(actions, /portaled menus sit at z-80/);
  assert.match(
    read("src/lib/components/zpageActions/ShareButton.svelte"),
    /DropdownMenuContent class="z-\[80\] w-56"/,
  );
  // Modal payment/error feedback reverses the rail/toast ordering so the
  // overlay covers page actions without covering the toast.
  assert.match(actions, /data-slot\$="-overlay"/);
  assert.match(actions, /Array\.from\(document\.body\.children\)/);
  assert.doesNotMatch(actions, /document\.body\.querySelector/);
  assert.match(actions, /new MutationObserver\(updateModalState\)/);
  assert.match(actions, /class:is-modal-active=\{modalActive\}/);
  assert.match(actions, /max-height:\s*calc\(/);
  assert.match(actions, /z-index: 40/);
});
