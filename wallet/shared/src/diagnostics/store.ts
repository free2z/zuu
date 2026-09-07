import {
  type DiagnosticsEnvironment,
  reviveEnvironment,
} from "./environment";
import {
  type DiagnosticBreadcrumb,
  type DiagnosticEvent,
  createBreadcrumb,
  createDiagnosticEvent,
  reviveDiagnosticEvent,
} from "./record";
import type {
  BreadcrumbCategory,
  BreadcrumbCode,
  DiagnosticKind,
} from "./vocabulary";

/** Bumped when the persisted shape changes; older payloads are discarded. */
export const DIAGNOSTICS_SCHEMA_VERSION = 1;

/** The storage key all three surfaces use. Each has its own origin. */
export const DIAGNOSTICS_STORAGE_KEY = "free2z.diagnostics.v1";

/** Events kept before the oldest is dropped. */
export const DEFAULT_EVENT_CAPACITY = 40;

/** Breadcrumbs kept before the oldest is dropped. */
export const DEFAULT_BREADCRUMB_CAPACITY = 24;

/** Breadcrumbs attached to each event. */
export const BREADCRUMBS_PER_EVENT = 12;

/**
 * Ceiling on the serialized buffer.
 *
 * A diagnostics buffer that can grow is a diagnostics buffer that can fill a
 * user's storage quota and take the app down with it — which would be a worse
 * bug than the one it exists to report. Events are dropped oldest-first until
 * the payload fits.
 */
export const MAX_PERSISTED_CHARACTERS = 48_000;

/**
 * Where the buffer survives a restart.
 *
 * An injectable port rather than a direct `localStorage` reference: the store
 * is constructed in `main.tsx` before anything else runs, and it must work in a
 * private window, under a storage-blocking setting, and in a Node test — all
 * three of which make `window.localStorage` throw on access rather than return
 * null.
 */
export interface DiagnosticsPersistence {
  read(): string | null;
  write(serialized: string): void;
  clear(): void;
}

type MinimalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/**
 * A persistence port over `localStorage` that never throws.
 *
 * Every method is wrapped: a store that cannot persist still captures in
 * memory, and losing the buffer is always better than the diagnostics
 * subsystem becoming the crash.
 */
export function localStoragePersistence(
  storage: MinimalStorage,
  key: string = DIAGNOSTICS_STORAGE_KEY,
): DiagnosticsPersistence {
  return {
    read() {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    write(serialized: string) {
      try {
        storage.setItem(key, serialized);
      } catch {
        // Quota, private mode, or a blocked origin. Nothing to do and nothing
        // worth reporting: reporting it here would recurse into this store.
      }
    },
    clear() {
      try {
        storage.removeItem(key);
      } catch {
        // As above.
      }
    },
  };
}

/** How a {@link DiagnosticsStore} is configured. */
export interface DiagnosticsStoreOptions {
  readonly environment: DiagnosticsEnvironment;
  readonly persistence?: DiagnosticsPersistence | null;
  readonly eventCapacity?: number;
  readonly breadcrumbCapacity?: number;
  readonly now?: () => number;
}

interface PersistedShape {
  readonly v: number;
  readonly environment: unknown;
  readonly events: unknown;
}

function positiveCapacity(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : fallback;
}

/**
 * A bounded, local, restart-surviving record of what went wrong.
 *
 * Three properties, in the order they matter:
 *
 * 1. **It is local.** There is no upload, no endpoint, no queue and no retry.
 *    Nothing in this file knows how to make a network request. The user reads
 *    the buffer on the diagnostics screen and decides, by hand, whether to
 *    share it.
 * 2. **It is redacted on the way in.** `record()` builds the event through
 *    `createDiagnosticEvent`, which redacts before returning, so no unredacted
 *    value is ever held. There is nothing for an export path to forget.
 * 3. **It is bounded.** Events, breadcrumbs and serialized size all have
 *    ceilings, so a crash loop degrades to a full ring rather than to a filled
 *    storage quota.
 */
export class DiagnosticsStore {
  readonly environment: DiagnosticsEnvironment;

  private readonly persistence: DiagnosticsPersistence | null;
  private readonly eventCapacity: number;
  private readonly breadcrumbCapacity: number;
  private readonly clock: () => number;
  private storedEvents: DiagnosticEvent[] = [];
  private trail: DiagnosticBreadcrumb[] = [];

  constructor(options: DiagnosticsStoreOptions) {
    this.environment = options.environment;
    this.persistence = options.persistence ?? null;
    this.eventCapacity = positiveCapacity(
      options.eventCapacity,
      DEFAULT_EVENT_CAPACITY,
    );
    this.breadcrumbCapacity = positiveCapacity(
      options.breadcrumbCapacity,
      DEFAULT_BREADCRUMB_CAPACITY,
    );
    this.clock = options.now ?? (() => Date.now());
    this.storedEvents = this.load();
  }

  /**
   * Note what the app is doing.
   *
   * Takes no free-form argument by design — see `vocabulary.ts`. A call site
   * cannot attach a handle, an address or a body to a breadcrumb, because
   * there is nowhere to put one.
   */
  breadcrumb(category: BreadcrumbCategory, code: BreadcrumbCode): void {
    const crumb = createBreadcrumb(this.clock(), category, code);
    if (!crumb) return;
    this.trail.push(crumb);
    if (this.trail.length > this.breadcrumbCapacity) {
      this.trail = this.trail.slice(-this.breadcrumbCapacity);
    }
  }

  /** Capture a failure. Returns the redacted record that was stored. */
  record(kind: DiagnosticKind, error: unknown): DiagnosticEvent {
    const event = createDiagnosticEvent({
      at: this.clock(),
      kind,
      error,
      breadcrumbs: this.trail.slice(-BREADCRUMBS_PER_EVENT),
    });
    this.storedEvents.push(event);
    if (this.storedEvents.length > this.eventCapacity) {
      this.storedEvents = this.storedEvents.slice(-this.eventCapacity);
    }
    this.persist();
    return event;
  }

  /** The buffer, oldest first. */
  events(): readonly DiagnosticEvent[] {
    return this.storedEvents;
  }

  /** The live breadcrumb trail, oldest first. */
  breadcrumbs(): readonly DiagnosticBreadcrumb[] {
    return this.trail;
  }

  /** Forget everything, on disk as well as in memory. */
  clear(): void {
    this.storedEvents = [];
    this.trail = [];
    this.persistence?.clear();
  }

  private load(): DiagnosticEvent[] {
    const raw = this.persistence?.read();
    if (!raw) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return [];
    }
    if (typeof parsed !== "object" || parsed === null) return [];
    const payload = parsed as Partial<PersistedShape>;
    if (payload.v !== DIAGNOSTICS_SCHEMA_VERSION) return [];
    // A buffer written by a different install of a different surface is not
    // this app's history. Revive it only if it says it is ours.
    const environment = reviveEnvironment(payload.environment);
    if (!environment || environment.app !== this.environment.app) return [];
    if (!Array.isArray(payload.events)) return [];
    const events = payload.events
      .map(reviveDiagnosticEvent)
      .filter((event): event is DiagnosticEvent => event !== null);
    return events.slice(-this.eventCapacity);
  }

  private persist(): void {
    if (!this.persistence) return;
    let events = this.storedEvents;
    let serialized = this.serialize(events);
    while (serialized.length > MAX_PERSISTED_CHARACTERS && events.length > 1) {
      events = events.slice(1);
      serialized = this.serialize(events);
    }
    if (serialized.length > MAX_PERSISTED_CHARACTERS) {
      // A single event over the ceiling cannot happen — every field is capped
      // — but if it somehow did, an empty buffer beats a rejected write.
      this.persistence.write(this.serialize([]));
      return;
    }
    this.storedEvents = events;
    this.persistence.write(serialized);
  }

  private serialize(events: readonly DiagnosticEvent[]): string {
    const payload: PersistedShape = {
      v: DIAGNOSTICS_SCHEMA_VERSION,
      environment: this.environment,
      events,
    };
    return JSON.stringify(payload);
  }
}
