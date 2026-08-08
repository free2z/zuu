export interface ZecTopUpDemoRuntime {
  explicitMock: boolean;
  development: boolean;
  tauri: boolean;
}

/**
 * The local-only ZEC top-up simulation is a browser development aid, never a
 * payment path. Requiring every condition keeps it out of production bundles'
 * behavior and out of Tauri even when somebody accidentally sets VITE_MOCK=1.
 */
export function canRunZecTopUpDemo(runtime: ZecTopUpDemoRuntime): boolean {
  return runtime.explicitMock && runtime.development && !runtime.tauri;
}

export async function settleZecTopUpDemo(
  runtime: ZecTopUpDemoRuntime,
  amount: number,
  adjustTuzis: (delta: number) => void,
  wait: () => Promise<void> = () =>
    new Promise((resolve) => setTimeout(resolve, 650)),
): Promise<void> {
  if (!canRunZecTopUpDemo(runtime)) {
    throw new Error("Mock ZEC top-up settlement is unavailable in this runtime.");
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error("Mock ZEC top-up amount must be a positive integer.");
  }

  await wait();
  adjustTuzis(amount);
}
