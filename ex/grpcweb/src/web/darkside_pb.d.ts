import * as jspb from 'google-protobuf'

import * as service_pb from './service_pb';


export class DarksideMetaState extends jspb.Message {
  getSaplingactivation(): number;
  setSaplingactivation(value: number): DarksideMetaState;

  getBranchid(): string;
  setBranchid(value: string): DarksideMetaState;

  getChainname(): string;
  setChainname(value: string): DarksideMetaState;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DarksideMetaState.AsObject;
  static toObject(includeInstance: boolean, msg: DarksideMetaState): DarksideMetaState.AsObject;
  static serializeBinaryToWriter(message: DarksideMetaState, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DarksideMetaState;
  static deserializeBinaryFromReader(message: DarksideMetaState, reader: jspb.BinaryReader): DarksideMetaState;
}

export namespace DarksideMetaState {
  export type AsObject = {
    saplingactivation: number,
    branchid: string,
    chainname: string,
  }
}

export class DarksideBlock extends jspb.Message {
  getBlock(): string;
  setBlock(value: string): DarksideBlock;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DarksideBlock.AsObject;
  static toObject(includeInstance: boolean, msg: DarksideBlock): DarksideBlock.AsObject;
  static serializeBinaryToWriter(message: DarksideBlock, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DarksideBlock;
  static deserializeBinaryFromReader(message: DarksideBlock, reader: jspb.BinaryReader): DarksideBlock;
}

export namespace DarksideBlock {
  export type AsObject = {
    block: string,
  }
}

export class DarksideBlocksURL extends jspb.Message {
  getUrl(): string;
  setUrl(value: string): DarksideBlocksURL;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DarksideBlocksURL.AsObject;
  static toObject(includeInstance: boolean, msg: DarksideBlocksURL): DarksideBlocksURL.AsObject;
  static serializeBinaryToWriter(message: DarksideBlocksURL, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DarksideBlocksURL;
  static deserializeBinaryFromReader(message: DarksideBlocksURL, reader: jspb.BinaryReader): DarksideBlocksURL;
}

export namespace DarksideBlocksURL {
  export type AsObject = {
    url: string,
  }
}

export class DarksideTransactionsURL extends jspb.Message {
  getHeight(): number;
  setHeight(value: number): DarksideTransactionsURL;

  getUrl(): string;
  setUrl(value: string): DarksideTransactionsURL;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DarksideTransactionsURL.AsObject;
  static toObject(includeInstance: boolean, msg: DarksideTransactionsURL): DarksideTransactionsURL.AsObject;
  static serializeBinaryToWriter(message: DarksideTransactionsURL, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DarksideTransactionsURL;
  static deserializeBinaryFromReader(message: DarksideTransactionsURL, reader: jspb.BinaryReader): DarksideTransactionsURL;
}

export namespace DarksideTransactionsURL {
  export type AsObject = {
    height: number,
    url: string,
  }
}

export class DarksideHeight extends jspb.Message {
  getHeight(): number;
  setHeight(value: number): DarksideHeight;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DarksideHeight.AsObject;
  static toObject(includeInstance: boolean, msg: DarksideHeight): DarksideHeight.AsObject;
  static serializeBinaryToWriter(message: DarksideHeight, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DarksideHeight;
  static deserializeBinaryFromReader(message: DarksideHeight, reader: jspb.BinaryReader): DarksideHeight;
}

export namespace DarksideHeight {
  export type AsObject = {
    height: number,
  }
}

export class DarksideEmptyBlocks extends jspb.Message {
  getHeight(): number;
  setHeight(value: number): DarksideEmptyBlocks;

  getNonce(): number;
  setNonce(value: number): DarksideEmptyBlocks;

  getCount(): number;
  setCount(value: number): DarksideEmptyBlocks;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): DarksideEmptyBlocks.AsObject;
  static toObject(includeInstance: boolean, msg: DarksideEmptyBlocks): DarksideEmptyBlocks.AsObject;
  static serializeBinaryToWriter(message: DarksideEmptyBlocks, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): DarksideEmptyBlocks;
  static deserializeBinaryFromReader(message: DarksideEmptyBlocks, reader: jspb.BinaryReader): DarksideEmptyBlocks;
}

export namespace DarksideEmptyBlocks {
  export type AsObject = {
    height: number,
    nonce: number,
    count: number,
  }
}

