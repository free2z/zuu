import initializeWasm from "../../wasm-spike/generated/zuu_wasm_spike.wasm?init&no-inline";

type SpikeExports = WebAssembly.Exports & {
  zuu_wasm_spike_add(left: number, right: number): number;
};

let instance: Promise<WebAssembly.Instance> | undefined;

function loadSpike(): Promise<WebAssembly.Instance> {
  return instance ?? (instance = initializeWasm());
}

/**
 * Exercise the first-party Rust/WASM boundary. The operation is intentionally
 * not product functionality; browser coverage proves the integration stays
 * executable while a future shared Rust core is designed.
 */
export async function runWasmSpike(): Promise<number> {
  const wasm = await loadSpike();
  const exports = wasm.exports as SpikeExports;
  if (typeof exports.zuu_wasm_spike_add !== "function") {
    throw new Error("The ZUU WASM spike export is missing");
  }
  return exports.zuu_wasm_spike_add(19, 23);
}
