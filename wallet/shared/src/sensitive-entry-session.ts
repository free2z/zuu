export const SENSITIVE_ENTRY_PURPOSES = [
  "zuuliRestore",
  "zuualletRestore",
  "zuualletRelink",
] as const;

export type SensitiveEntryPurpose = (typeof SENSITIVE_ENTRY_PURPOSES)[number];

export interface SensitiveEntryAuthority {
  begin(purpose: SensitiveEntryPurpose): Promise<string>;
  end(token: string, purpose: SensitiveEntryPurpose): Promise<void>;
}

type ReleaseScheduler = (release: () => void) => void;

interface LifecycleTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export function bindSensitiveEntryLifecycle(
  windowTarget: LifecycleTarget,
  documentTarget: LifecycleTarget,
  isVisible: () => boolean,
  clear: () => Promise<void>,
  acquire: () => Promise<unknown>,
): () => void {
  const onLoss = () => void clear();
  const onResume = () => void clear().then(acquire);
  const onVisibility = () => {
    if (isVisible()) onResume();
    else onLoss();
  };
  windowTarget.addEventListener("blur", onLoss);
  windowTarget.addEventListener("focus", onResume);
  windowTarget.addEventListener("pagehide", onLoss);
  documentTarget.addEventListener("visibilitychange", onVisibility);
  return () => {
    windowTarget.removeEventListener("blur", onLoss);
    windowTarget.removeEventListener("focus", onResume);
    windowTarget.removeEventListener("pagehide", onLoss);
    documentTarget.removeEventListener("visibilitychange", onVisibility);
    onLoss();
  };
}

const releaseAfterRendererPaint: ReleaseScheduler = (release) => {
  if (typeof requestAnimationFrame !== "function") {
    queueMicrotask(release);
    return;
  }
  requestAnimationFrame(() => requestAnimationFrame(release));
};

/**
 * Owns native capture protection for one typed-mnemonic surface.
 *
 * The input stays disabled until native acquisition succeeds. Clearing is
 * synchronous from the renderer's perspective, while native release waits for
 * the cleared view to paint. Tokens are always released with the exact purpose
 * that acquired them.
 */
export class SensitiveEntrySession {
  private generation = 0;
  private token: string | null = null;
  private acquisition: Promise<boolean> | null = null;
  private pendingRelease: Promise<void> | null = null;

  constructor(
    private readonly authority: SensitiveEntryAuthority,
    readonly purpose: SensitiveEntryPurpose,
    private readonly clearRenderer: () => void,
    private readonly setEditable: (editable: boolean) => void,
    private readonly scheduleRelease: ReleaseScheduler = releaseAfterRendererPaint,
  ) {}

  acquire(): Promise<boolean> {
    if (this.token) return Promise.resolve(true);
    if (this.acquisition) {
      return this.acquisition.then((acquired) =>
        acquired ? true : this.acquire(),
      );
    }
    const generation = ++this.generation;
    this.clearRenderer();
    this.setEditable(false);
    const acquisition = this.authority
      .begin(this.purpose)
      .then(async (token) => {
        if (!token) throw new Error("Sensitive-entry lease token is missing.");
        if (generation !== this.generation) {
          await this.release(token);
          return false;
        }
        this.token = token;
        this.setEditable(true);
        return true;
      })
      .catch((error) => {
        if (generation === this.generation) {
          this.clearRenderer();
          this.setEditable(false);
        }
        throw error;
      })
      .finally(() => {
        if (this.acquisition === acquisition) this.acquisition = null;
      });
    this.acquisition = acquisition;
    return acquisition;
  }

  clear(): Promise<void> {
    ++this.generation;
    this.clearRenderer();
    this.setEditable(false);
    const token = this.token;
    this.token = null;
    if (!token) return this.pendingRelease ?? Promise.resolve();

    const pending = new Promise<void>((resolve) => {
      this.scheduleRelease(() => {
        void this.release(token).finally(resolve);
      });
    });
    this.pendingRelease = pending;
    void pending.finally(() => {
      if (this.pendingRelease === pending) this.pendingRelease = null;
    });
    return pending;
  }

  private async release(token: string): Promise<void> {
    try {
      await this.authority.end(token, this.purpose);
    } catch {
      // Native capture remains fail closed if release fails. Renderer material
      // has already been removed and must never be restored as compensation.
    }
  }
}
