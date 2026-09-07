import { useCallback, useState } from "react";
import {
  type DiagnosticEvent,
  type DiagnosticsStore,
  renderDiagnosticsReport,
} from "@free2z/wallet-shared";
import { Button } from "../../components/ui/button";
import { diagnostics as appDiagnostics } from "../../lib/diagnostics";

/**
 * What the app can tell you about its own failures.
 *
 * ## Why this screen exists
 *
 * `0.1.0 (2)` shipped to TestFlight and hung on a loading skeleton (#973).
 * Nothing was written down, nothing was shown, and the only way to learn
 * anything was to reproduce it on a machine with a debugger attached — which
 * the tester holding the phone does not have. A failure the user can read is
 * the difference between a bug report and "it does not work".
 *
 * ## Why the sharing is manual
 *
 * Because this is an end-to-end encrypted messenger, and a messenger that
 * uploads anything about a session in the background has given away the thing
 * it sells. There is no upload path in this feature or anywhere below it. The
 * buffer is on the device; the report is text; the user copies it if and when
 * they want to, into an issue they can read first.
 */

function shortTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "unknown";
  try {
    return new Date(at).toISOString().replace("T", " ").replace(/\.\d+Z$/u, "");
  } catch {
    return "unknown";
  }
}

function EventRow({ event }: { event: DiagnosticEvent }) {
  return (
    <li className="rounded-md border border-border bg-card p-3">
      <p className="eyebrow text-muted-foreground">
        {event.kind} — {shortTime(event.at)}
      </p>
      <p className="mt-1 text-sm font-medium text-foreground">
        {event.name || "Error"}
      </p>
      {event.message ? (
        <p className="mt-1 break-words text-sm text-muted-foreground">
          {event.message}
        </p>
      ) : null}
      {event.frames.length > 0 ? (
        <pre className="mt-2 overflow-x-auto rounded bg-secondary p-2 text-xs text-muted-foreground">
          {event.frames
            .map((frame) =>
              frame.fn
                ? `at ${frame.fn} (${frame.source}:${frame.line}:${frame.column})`
                : `at ${frame.source}:${frame.line}:${frame.column}`,
            )
            .join("\n")}
        </pre>
      ) : null}
      {event.breadcrumbs.length > 0 ? (
        <p className="mt-2 break-words text-xs text-muted-foreground">
          {event.breadcrumbs
            .map((crumb) => `${crumb.category}/${crumb.code}`)
            .join(" -> ")}
        </p>
      ) : null}
    </li>
  );
}

interface DiagnosticsFeatureProps {
  /** Injectable so a test drives a store it controls. */
  store?: DiagnosticsStore;
}

export default function DiagnosticsFeature({
  store = appDiagnostics,
}: DiagnosticsFeatureProps) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  // The buffer is a mutable ring rather than immutable state, so a render is
  // asked for explicitly after an action that changes it.
  const [, setRevision] = useState(0);
  const events = store.events();
  const environment = store.environment;

  // Rendered when an action asks for it rather than on every render: this panel
  // lives in `App`, so it re-renders with the whole messaging screen, and
  // formatting forty records each time to produce a string nobody read is work
  // the screen it sits under should not pay for.
  const copy = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(renderDiagnosticsReport(store));
        setCopied(true);
      } catch {
        // A WebView can refuse clipboard access. The report is on screen in
        // full below, so a failed copy still leaves the user able to select it.
        setCopied(false);
      }
    })();
  }, [store]);

  const share = useCallback(() => {
    void (async () => {
      const report = renderDiagnosticsReport(store);
      try {
        const shareTo = (
          navigator as Navigator & {
            share?: (data: { title: string; text: string }) => Promise<void>;
          }
        ).share;
        if (shareTo) {
          await shareTo.call(navigator, {
            title: "e2e2z diagnostics",
            text: report,
          });
          return;
        }
      } catch {
        // A dismissed share sheet rejects. That is a choice, not a failure.
        return;
      }
      await navigator.clipboard.writeText(report).catch(() => undefined);
      setCopied(true);
    })();
  }, [store]);

  const clear = useCallback(() => {
    store.clear();
    setCopied(false);
    setRevision((value) => value + 1);
  }, [store]);

  if (!open) {
    return (
      <section className="mt-10 border-t border-border pt-6">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(true)}
          data-diagnostics-open
        >
          Diagnostics{events.length > 0 ? ` (${events.length})` : ""}
        </Button>
      </section>
    );
  }

  return (
    <section
      aria-labelledby="diagnostics-heading"
      className="mt-10 border-t border-border pt-6"
      data-diagnostics-panel
    >
      <h2
        id="diagnostics-heading"
        className="text-lg font-semibold text-foreground"
      >
        Diagnostics
      </h2>
      <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
        Recorded on this device only. Nothing is sent anywhere. Copy the report
        into a GitHub issue if you want us to see it.
      </p>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="eyebrow text-muted-foreground">App</dt>
          <dd className="text-foreground">{environment.app}</dd>
        </div>
        <div>
          <dt className="eyebrow text-muted-foreground">Build</dt>
          <dd className="mono-id text-foreground">
            {environment.version} ({environment.build})
          </dd>
        </div>
        <div>
          <dt className="eyebrow text-muted-foreground">Platform</dt>
          <dd className="text-foreground">
            {environment.platform} {environment.platformVersion}
          </dd>
        </div>
        <div>
          <dt className="eyebrow text-muted-foreground">Engine</dt>
          <dd className="text-foreground">{environment.engine}</dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button type="button" size="sm" onClick={copy}>
          {copied ? "Copied" : "Copy report"}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={share}>
          Share report
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={clear}>
          Clear
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => setOpen(false)}
        >
          Hide
        </Button>
      </div>

      {events.length === 0 ? (
        <p className="mt-4 text-sm text-muted-foreground" data-diagnostics-empty>
          No failures have been recorded on this device.
        </p>
      ) : (
        <ul className="mt-4 space-y-3" data-diagnostics-events>
          {[...events].reverse().map((event, index) => (
            <EventRow key={`${event.at}-${index}`} event={event} />
          ))}
        </ul>
      )}
    </section>
  );
}
