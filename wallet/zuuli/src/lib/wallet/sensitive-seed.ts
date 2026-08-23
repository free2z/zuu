import { wallet } from "./bridge";

export interface SensitiveSeedAuthority {
  begin(): Promise<string>;
  end(token: string): Promise<void>;
}

type ReleaseScheduler = (release: () => void) => void;

// Native display acquisition and custody are separate IPC commands. Keep the
// entire renderer ceremony process-wide single-flight so a second session
// cannot replace the first lease after custody returns but before its result is
// delivered and published. This is deliberately module state rather than React
// state: every SensitiveSeedSession in this renderer shares the native lease.
let revealInFlight = false;

const releaseAfterRendererPaint: ReleaseScheduler = (release) => {
  if (typeof requestAnimationFrame !== "function") {
    queueMicrotask(release);
    return;
  }
  // React state updates are not paint acknowledgements. Keep native capture
  // protection through two animation frames so the cleared view is actually
  // presented before releasing it. Backgrounded WebViews suspend RAF, which
  // intentionally keeps native protection fail closed until foreground.
  requestAnimationFrame(() => requestAnimationFrame(release));
};

export class SensitiveSeedSession {
  private generation = 0;
  private token: string | null = null;
  private active = false;

  constructor(
    private readonly authority: SensitiveSeedAuthority,
    private readonly publish: (phrase: string | null) => void,
    private readonly scheduleRelease: ReleaseScheduler = releaseAfterRendererPaint,
  ) {}

  async reveal(
    readPhrase: (token: string) => Promise<string>,
  ): Promise<boolean> {
    if (revealInFlight) return false;
    revealInFlight = true;
    try {
      this.clear();
      this.active = true;
      const generation = ++this.generation;
      this.publish(null);
      let token: string;
      try {
        token = await this.authority.begin();
      } catch (error) {
        if (generation === this.generation) {
          this.active = false;
          this.publish(null);
        }
        throw error;
      }
      if (generation !== this.generation) {
        await this.release(token);
        return false;
      }
      this.token = token;
      try {
        // Native capture protection is active before this biometric/user-
        // presence-bound custody read can put a mnemonic in the renderer.
        const phrase = await readPhrase(token);
        if (generation !== this.generation || this.token !== token) {
          await this.release(token);
          return false;
        }
        this.publish(phrase);
        return true;
      } catch (error) {
        if (generation === this.generation && this.token === token) {
          this.token = null;
          this.active = false;
          this.publish(null);
          await this.release(token);
        }
        throw error;
      }
    } finally {
      revealInFlight = false;
    }
  }

  clear(): boolean {
    if (!this.active) return false;
    this.active = false;
    ++this.generation;
    this.publish(null);
    const token = this.token;
    this.token = null;
    if (token) this.scheduleRelease(() => void this.release(token));
    return true;
  }

  private async release(token: string): Promise<void> {
    try {
      await this.authority.end(token);
    } catch {
      // Native protection is fail closed: a failed release retains the secure
      // flag/cover. Never restore renderer material to compensate.
    }
  }
}

export const walletSensitiveSeedAuthority: SensitiveSeedAuthority = {
  begin: () => wallet.beginSensitiveDisplay().then(({ token }) => token),
  end: (token) => wallet.endSensitiveDisplay(token),
};
