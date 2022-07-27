import * as jspb from 'google-protobuf'



export class CompactBlock extends jspb.Message {
  getProtoversion(): number;
  setProtoversion(value: number): CompactBlock;

  getHeight(): number;
  setHeight(value: number): CompactBlock;

  getHash(): Uint8Array | string;
  getHash_asU8(): Uint8Array;
  getHash_asB64(): string;
  setHash(value: Uint8Array | string): CompactBlock;

  getPrevhash(): Uint8Array | string;
  getPrevhash_asU8(): Uint8Array;
  getPrevhash_asB64(): string;
  setPrevhash(value: Uint8Array | string): CompactBlock;

  getTime(): number;
  setTime(value: number): CompactBlock;

  getHeader(): Uint8Array | string;
  getHeader_asU8(): Uint8Array;
  getHeader_asB64(): string;
  setHeader(value: Uint8Array | string): CompactBlock;

  getVtxList(): Array<CompactTx>;
  setVtxList(value: Array<CompactTx>): CompactBlock;
  clearVtxList(): CompactBlock;
  addVtx(value?: CompactTx, index?: number): CompactTx;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): CompactBlock.AsObject;
  static toObject(includeInstance: boolean, msg: CompactBlock): CompactBlock.AsObject;
  static serializeBinaryToWriter(message: CompactBlock, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): CompactBlock;
  static deserializeBinaryFromReader(message: CompactBlock, reader: jspb.BinaryReader): CompactBlock;
}

export namespace CompactBlock {
  export type AsObject = {
    protoversion: number,
    height: number,
    hash: Uint8Array | string,
    prevhash: Uint8Array | string,
    time: number,
    header: Uint8Array | string,
    vtxList: Array<CompactTx.AsObject>,
  }
}

export class CompactTx extends jspb.Message {
  getIndex(): number;
  setIndex(value: number): CompactTx;

  getHash(): Uint8Array | string;
  getHash_asU8(): Uint8Array;
  getHash_asB64(): string;
  setHash(value: Uint8Array | string): CompactTx;

  getFee(): number;
  setFee(value: number): CompactTx;

  getSpendsList(): Array<CompactSaplingSpend>;
  setSpendsList(value: Array<CompactSaplingSpend>): CompactTx;
  clearSpendsList(): CompactTx;
  addSpends(value?: CompactSaplingSpend, index?: number): CompactSaplingSpend;

  getOutputsList(): Array<CompactSaplingOutput>;
  setOutputsList(value: Array<CompactSaplingOutput>): CompactTx;
  clearOutputsList(): CompactTx;
  addOutputs(value?: CompactSaplingOutput, index?: number): CompactSaplingOutput;

  getActionsList(): Array<CompactOrchardAction>;
  setActionsList(value: Array<CompactOrchardAction>): CompactTx;
  clearActionsList(): CompactTx;
  addActions(value?: CompactOrchardAction, index?: number): CompactOrchardAction;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): CompactTx.AsObject;
  static toObject(includeInstance: boolean, msg: CompactTx): CompactTx.AsObject;
  static serializeBinaryToWriter(message: CompactTx, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): CompactTx;
  static deserializeBinaryFromReader(message: CompactTx, reader: jspb.BinaryReader): CompactTx;
}

export namespace CompactTx {
  export type AsObject = {
    index: number,
    hash: Uint8Array | string,
    fee: number,
    spendsList: Array<CompactSaplingSpend.AsObject>,
    outputsList: Array<CompactSaplingOutput.AsObject>,
    actionsList: Array<CompactOrchardAction.AsObject>,
  }
}

export class CompactSaplingSpend extends jspb.Message {
  getNf(): Uint8Array | string;
  getNf_asU8(): Uint8Array;
  getNf_asB64(): string;
  setNf(value: Uint8Array | string): CompactSaplingSpend;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): CompactSaplingSpend.AsObject;
  static toObject(includeInstance: boolean, msg: CompactSaplingSpend): CompactSaplingSpend.AsObject;
  static serializeBinaryToWriter(message: CompactSaplingSpend, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): CompactSaplingSpend;
  static deserializeBinaryFromReader(message: CompactSaplingSpend, reader: jspb.BinaryReader): CompactSaplingSpend;
}

export namespace CompactSaplingSpend {
  export type AsObject = {
    nf: Uint8Array | string,
  }
}

export class CompactSaplingOutput extends jspb.Message {
  getCmu(): Uint8Array | string;
  getCmu_asU8(): Uint8Array;
  getCmu_asB64(): string;
  setCmu(value: Uint8Array | string): CompactSaplingOutput;

  getEpk(): Uint8Array | string;
  getEpk_asU8(): Uint8Array;
  getEpk_asB64(): string;
  setEpk(value: Uint8Array | string): CompactSaplingOutput;

  getCiphertext(): Uint8Array | string;
  getCiphertext_asU8(): Uint8Array;
  getCiphertext_asB64(): string;
  setCiphertext(value: Uint8Array | string): CompactSaplingOutput;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): CompactSaplingOutput.AsObject;
  static toObject(includeInstance: boolean, msg: CompactSaplingOutput): CompactSaplingOutput.AsObject;
  static serializeBinaryToWriter(message: CompactSaplingOutput, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): CompactSaplingOutput;
  static deserializeBinaryFromReader(message: CompactSaplingOutput, reader: jspb.BinaryReader): CompactSaplingOutput;
}

export namespace CompactSaplingOutput {
  export type AsObject = {
    cmu: Uint8Array | string,
    epk: Uint8Array | string,
    ciphertext: Uint8Array | string,
  }
}

export class CompactOrchardAction extends jspb.Message {
  getNullifier(): Uint8Array | string;
  getNullifier_asU8(): Uint8Array;
  getNullifier_asB64(): string;
  setNullifier(value: Uint8Array | string): CompactOrchardAction;

  getCmx(): Uint8Array | string;
  getCmx_asU8(): Uint8Array;
  getCmx_asB64(): string;
  setCmx(value: Uint8Array | string): CompactOrchardAction;

  getEphemeralkey(): Uint8Array | string;
  getEphemeralkey_asU8(): Uint8Array;
  getEphemeralkey_asB64(): string;
  setEphemeralkey(value: Uint8Array | string): CompactOrchardAction;

  getCiphertext(): Uint8Array | string;
  getCiphertext_asU8(): Uint8Array;
  getCiphertext_asB64(): string;
  setCiphertext(value: Uint8Array | string): CompactOrchardAction;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): CompactOrchardAction.AsObject;
  static toObject(includeInstance: boolean, msg: CompactOrchardAction): CompactOrchardAction.AsObject;
  static serializeBinaryToWriter(message: CompactOrchardAction, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): CompactOrchardAction;
  static deserializeBinaryFromReader(message: CompactOrchardAction, reader: jspb.BinaryReader): CompactOrchardAction;
}

export namespace CompactOrchardAction {
  export type AsObject = {
    nullifier: Uint8Array | string,
    cmx: Uint8Array | string,
    ephemeralkey: Uint8Array | string,
    ciphertext: Uint8Array | string,
  }
}

