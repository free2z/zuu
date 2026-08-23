export interface SensitiveSeedAuthority {
  begin(): Promise<string>;
  end(token: string): Promise<void>;
}

type ReleaseScheduler = (release: () => void) => void;

const releaseAfterRendererPaint: ReleaseScheduler = (release) => {
  if (typeof requestAnimationFrame !== "function") {
    queueMicrotask(release);
    return;
  }
  // A React state update is not a paint acknowledgement. Keep native capture
  // protection for two frames after clearing. A backgrounded WebView suspends
  // RAF, intentionally retaining protection until it can paint again.
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
      // Release errors remain fail closed in native code. Never republish a
      // mnemonic to compensate for protection that could not be removed.
    }
  }
}

/**
 * Owns the exact create -> backup-read -> acknowledgement transaction.
 *
 * The wallet identity is kept outside React routing state so a Welcome ->
 * Create transition cannot detach the phrase from the native manifest entry it
 * belongs to. Only an explicit acknowledgement for that same identity may
 * clear the phrase and release capture protection.
 */
export class CreatedSeedSession {
  private generation = 0;
  private walletId: string | null = null;
  private confirmationInFlight = false;

  constructor(private readonly display: SensitiveSeedSession) {}

  get currentWalletId(): string | null {
    return this.walletId;
  }

  get confirmationPending(): boolean {
    return this.confirmationInFlight;
  }

  prepare(walletId: string): void {
    if (!walletId) throw new Error("Created wallet identity is missing.");
    this.cancel();
    ++this.generation;
    this.walletId = walletId;
  }

  async reveal(
    walletId: string,
    readPhrase: (walletId: string, token: string) => Promise<string>,
  ): Promise<boolean> {
    if (!walletId) throw new Error("Created wallet identity is missing.");
    if (this.confirmationInFlight) {
      throw new Error("Backup acknowledgement is still in progress.");
    }
    this.cancel();
    const generation = ++this.generation;
    this.walletId = walletId;
    try {
      const revealed = await this.display.reveal((token) =>
        readPhrase(walletId, token),
      );
      if (
        !revealed ||
        generation !== this.generation ||
        this.walletId !== walletId
      ) {
        return false;
      }
      return true;
    } catch (error) {
      if (generation === this.generation && this.walletId === walletId) {
        this.display.clear();
      }
      throw error;
    }
  }

  async confirm(
    walletId: string,
    confirmBackup: (walletId: string) => Promise<void>,
  ): Promise<boolean> {
    if (!walletId || walletId !== this.walletId) {
      throw new Error("Created wallet backup session is missing or stale.");
    }
    if (this.confirmationInFlight) return false;
    this.confirmationInFlight = true;
    const generation = this.generation;
    try {
      await confirmBackup(walletId);
      if (generation !== this.generation || this.walletId !== walletId) {
        return false;
      }
      this.walletId = null;
      ++this.generation;
      this.display.clear();
      return true;
    } finally {
      // This is a process-wide native side-effect lock, not renderer state.
      // Background/cancel/replacement may invalidate the result, but must not
      // permit a second acknowledgement until the first promise settles.
      this.confirmationInFlight = false;
    }
  }

  cancel(): boolean {
    const hadSession = this.walletId !== null;
    if (!hadSession) return false;
    this.walletId = null;
    ++this.generation;
    this.display.clear();
    return true;
  }

  hide(): boolean {
    if (this.walletId === null) return false;
    this.display.clear();
    return true;
  }
}
