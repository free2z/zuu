declare module "snarkjs" {
  export const plonk: {
    fullProve(
      input: Record<string, string>,
      wasm: string | Uint8Array,
      key: string | Uint8Array,
      logger?: unknown,
      witnessOptions?: unknown,
      proverOptions?: unknown,
    ): Promise<{ proof: Record<string, unknown>; publicSignals: string[] }>;
    verify(
      key: unknown,
      signals: string[],
      proof: Record<string, unknown>,
    ): Promise<boolean>;
  };
}
