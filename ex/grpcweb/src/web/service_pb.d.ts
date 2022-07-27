import * as jspb from 'google-protobuf'

import * as compact_formats_pb from './compact_formats_pb';


export class BlockID extends jspb.Message {
  getHeight(): number;
  setHeight(value: number): BlockID;

  getHash(): Uint8Array | string;
  getHash_asU8(): Uint8Array;
  getHash_asB64(): string;
  setHash(value: Uint8Array | string): BlockID;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): BlockID.AsObject;
  static toObject(includeInstance: boolean, msg: BlockID): BlockID.AsObject;
  static serializeBinaryToWriter(message: BlockID, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): BlockID;
  static deserializeBinaryFromReader(message: BlockID, reader: jspb.BinaryReader): BlockID;
}

export namespace BlockID {
  export type AsObject = {
    height: number,
    hash: Uint8Array | string,
  }
}

export class BlockRange extends jspb.Message {
  getStart(): BlockID | undefined;
  setStart(value?: BlockID): BlockRange;
  hasStart(): boolean;
  clearStart(): BlockRange;

  getEnd(): BlockID | undefined;
  setEnd(value?: BlockID): BlockRange;
  hasEnd(): boolean;
  clearEnd(): BlockRange;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): BlockRange.AsObject;
  static toObject(includeInstance: boolean, msg: BlockRange): BlockRange.AsObject;
  static serializeBinaryToWriter(message: BlockRange, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): BlockRange;
  static deserializeBinaryFromReader(message: BlockRange, reader: jspb.BinaryReader): BlockRange;
}

export namespace BlockRange {
  export type AsObject = {
    start?: BlockID.AsObject,
    end?: BlockID.AsObject,
  }
}

export class TxFilter extends jspb.Message {
  getBlock(): BlockID | undefined;
  setBlock(value?: BlockID): TxFilter;
  hasBlock(): boolean;
  clearBlock(): TxFilter;

  getIndex(): number;
  setIndex(value: number): TxFilter;

  getHash(): Uint8Array | string;
  getHash_asU8(): Uint8Array;
  getHash_asB64(): string;
  setHash(value: Uint8Array | string): TxFilter;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): TxFilter.AsObject;
  static toObject(includeInstance: boolean, msg: TxFilter): TxFilter.AsObject;
  static serializeBinaryToWriter(message: TxFilter, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): TxFilter;
  static deserializeBinaryFromReader(message: TxFilter, reader: jspb.BinaryReader): TxFilter;
}

export namespace TxFilter {
  export type AsObject = {
    block?: BlockID.AsObject,
    index: number,
    hash: Uint8Array | string,
  }
}

export class RawTransaction extends jspb.Message {
  getData(): Uint8Array | string;
  getData_asU8(): Uint8Array;
  getData_asB64(): string;
  setData(value: Uint8Array | string): RawTransaction;

  getHeight(): number;
  setHeight(value: number): RawTransaction;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): RawTransaction.AsObject;
  static toObject(includeInstance: boolean, msg: RawTransaction): RawTransaction.AsObject;
  static serializeBinaryToWriter(message: RawTransaction, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): RawTransaction;
  static deserializeBinaryFromReader(message: RawTransaction, reader: jspb.BinaryReader): RawTransaction;
}

export namespace RawTransaction {
  export type AsObject = {
    data: Uint8Array | string,
    height: number,
  }
}

export class SendResponse extends jspb.Message {
  getErrorcode(): number;
  setErrorcode(value: number): SendResponse;

  getErrormessage(): string;
  setErrormessage(value: string): SendResponse;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): SendResponse.AsObject;
  static toObject(includeInstance: boolean, msg: SendResponse): SendResponse.AsObject;
  static serializeBinaryToWriter(message: SendResponse, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): SendResponse;
  static deserializeBinaryFromReader(message: SendResponse, reader: jspb.BinaryReader): SendResponse;
}

export namespace SendResponse {
  export type AsObject = {
    errorcode: number,
    errormessage: string,
  }
}

export class ChainSpec extends jspb.Message {
  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): ChainSpec.AsObject;
  static toObject(includeInstance: boolean, msg: ChainSpec): ChainSpec.AsObject;
  static serializeBinaryToWriter(message: ChainSpec, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): ChainSpec;
  static deserializeBinaryFromReader(message: ChainSpec, reader: jspb.BinaryReader): ChainSpec;
}

export namespace ChainSpec {
  export type AsObject = {
  }
}

export class Empty extends jspb.Message {
  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Empty.AsObject;
  static toObject(includeInstance: boolean, msg: Empty): Empty.AsObject;
  static serializeBinaryToWriter(message: Empty, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Empty;
  static deserializeBinaryFromReader(message: Empty, reader: jspb.BinaryReader): Empty;
}

export namespace Empty {
  export type AsObject = {
  }
}

export class LightdInfo extends jspb.Message {
  getVersion(): string;
  setVersion(value: string): LightdInfo;

  getVendor(): string;
  setVendor(value: string): LightdInfo;

  getTaddrsupport(): boolean;
  setTaddrsupport(value: boolean): LightdInfo;

  getChainname(): string;
  setChainname(value: string): LightdInfo;

  getSaplingactivationheight(): number;
  setSaplingactivationheight(value: number): LightdInfo;

  getConsensusbranchid(): string;
  setConsensusbranchid(value: string): LightdInfo;

  getBlockheight(): number;
  setBlockheight(value: number): LightdInfo;

  getGitcommit(): string;
  setGitcommit(value: string): LightdInfo;

  getBranch(): string;
  setBranch(value: string): LightdInfo;

  getBuilddate(): string;
  setBuilddate(value: string): LightdInfo;

  getBuilduser(): string;
  setBuilduser(value: string): LightdInfo;

  getEstimatedheight(): number;
  setEstimatedheight(value: number): LightdInfo;

  getZcashdbuild(): string;
  setZcashdbuild(value: string): LightdInfo;

  getZcashdsubversion(): string;
  setZcashdsubversion(value: string): LightdInfo;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): LightdInfo.AsObject;
  static toObject(includeInstance: boolean, msg: LightdInfo): LightdInfo.AsObject;
  static serializeBinaryToWriter(message: LightdInfo, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): LightdInfo;
  static deserializeBinaryFromReader(message: LightdInfo, reader: jspb.BinaryReader): LightdInfo;
}

export namespace LightdInfo {
  export type AsObject = {
    version: string,
    vendor: string,
    taddrsupport: boolean,
    chainname: string,
    saplingactivationheight: number,
    consensusbranchid: string,
    blockheight: number,
    gitcommit: string,
    branch: string,
    builddate: string,
    builduser: string,
    estimatedheight: number,
    zcashdbuild: string,
    zcashdsubversion: string,
  }
}

export class TransparentAddressBlockFilter extends jspb.Message {
  getAddress(): string;
  setAddress(value: string): TransparentAddressBlockFilter;

  getRange(): BlockRange | undefined;
  setRange(value?: BlockRange): TransparentAddressBlockFilter;
  hasRange(): boolean;
  clearRange(): TransparentAddressBlockFilter;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): TransparentAddressBlockFilter.AsObject;
  static toObject(includeInstance: boolean, msg: TransparentAddressBlockFilter): TransparentAddressBlockFilter.AsObject;
  static serializeBinaryToWriter(message: TransparentAddressBlockFilter, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): TransparentAddressBlockFilter;
  static deserializeBinaryFromReader(message: TransparentAddressBlockFilter, reader: jspb.BinaryReader): TransparentAddressBlockFilter;
}

export namespace TransparentAddressBlockFilter {
  export type AsObject = {
    address: string,
    range?: BlockRange.AsObject,
  }
}

export class Duration extends jspb.Message {
  getIntervalus(): number;
  setIntervalus(value: number): Duration;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Duration.AsObject;
  static toObject(includeInstance: boolean, msg: Duration): Duration.AsObject;
  static serializeBinaryToWriter(message: Duration, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Duration;
  static deserializeBinaryFromReader(message: Duration, reader: jspb.BinaryReader): Duration;
}

export namespace Duration {
  export type AsObject = {
    intervalus: number,
  }
}

export class PingResponse extends jspb.Message {
  getEntry(): number;
  setEntry(value: number): PingResponse;

  getExit(): number;
  setExit(value: number): PingResponse;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): PingResponse.AsObject;
  static toObject(includeInstance: boolean, msg: PingResponse): PingResponse.AsObject;
  static serializeBinaryToWriter(message: PingResponse, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): PingResponse;
  static deserializeBinaryFromReader(message: PingResponse, reader: jspb.BinaryReader): PingResponse;
}

export namespace PingResponse {
  export type AsObject = {
    entry: number,
    exit: number,
  }
}

export class Address extends jspb.Message {
  getAddress(): string;
  setAddress(value: string): Address;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Address.AsObject;
  static toObject(includeInstance: boolean, msg: Address): Address.AsObject;
  static serializeBinaryToWriter(message: Address, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Address;
  static deserializeBinaryFromReader(message: Address, reader: jspb.BinaryReader): Address;
}

export namespace Address {
  export type AsObject = {
    address: string,
  }
}

export class AddressList extends jspb.Message {
  getAddressesList(): Array<string>;
  setAddressesList(value: Array<string>): AddressList;
  clearAddressesList(): AddressList;
  addAddresses(value: string, index?: number): AddressList;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): AddressList.AsObject;
  static toObject(includeInstance: boolean, msg: AddressList): AddressList.AsObject;
  static serializeBinaryToWriter(message: AddressList, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): AddressList;
  static deserializeBinaryFromReader(message: AddressList, reader: jspb.BinaryReader): AddressList;
}

export namespace AddressList {
  export type AsObject = {
    addressesList: Array<string>,
  }
}

export class Balance extends jspb.Message {
  getValuezat(): number;
  setValuezat(value: number): Balance;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Balance.AsObject;
  static toObject(includeInstance: boolean, msg: Balance): Balance.AsObject;
  static serializeBinaryToWriter(message: Balance, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Balance;
  static deserializeBinaryFromReader(message: Balance, reader: jspb.BinaryReader): Balance;
}

export namespace Balance {
  export type AsObject = {
    valuezat: number,
  }
}

export class Exclude extends jspb.Message {
  getTxidList(): Array<Uint8Array | string>;
  setTxidList(value: Array<Uint8Array | string>): Exclude;
  clearTxidList(): Exclude;
  addTxid(value: Uint8Array | string, index?: number): Exclude;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): Exclude.AsObject;
  static toObject(includeInstance: boolean, msg: Exclude): Exclude.AsObject;
  static serializeBinaryToWriter(message: Exclude, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): Exclude;
  static deserializeBinaryFromReader(message: Exclude, reader: jspb.BinaryReader): Exclude;
}

export namespace Exclude {
  export type AsObject = {
    txidList: Array<Uint8Array | string>,
  }
}

export class TreeState extends jspb.Message {
  getNetwork(): string;
  setNetwork(value: string): TreeState;

  getHeight(): number;
  setHeight(value: number): TreeState;

  getHash(): string;
  setHash(value: string): TreeState;

  getTime(): number;
  setTime(value: number): TreeState;

  getSaplingtree(): string;
  setSaplingtree(value: string): TreeState;

  getOrchardtree(): string;
  setOrchardtree(value: string): TreeState;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): TreeState.AsObject;
  static toObject(includeInstance: boolean, msg: TreeState): TreeState.AsObject;
  static serializeBinaryToWriter(message: TreeState, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): TreeState;
  static deserializeBinaryFromReader(message: TreeState, reader: jspb.BinaryReader): TreeState;
}

export namespace TreeState {
  export type AsObject = {
    network: string,
    height: number,
    hash: string,
    time: number,
    saplingtree: string,
    orchardtree: string,
  }
}

export class GetAddressUtxosArg extends jspb.Message {
  getAddressesList(): Array<string>;
  setAddressesList(value: Array<string>): GetAddressUtxosArg;
  clearAddressesList(): GetAddressUtxosArg;
  addAddresses(value: string, index?: number): GetAddressUtxosArg;

  getStartheight(): number;
  setStartheight(value: number): GetAddressUtxosArg;

  getMaxentries(): number;
  setMaxentries(value: number): GetAddressUtxosArg;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): GetAddressUtxosArg.AsObject;
  static toObject(includeInstance: boolean, msg: GetAddressUtxosArg): GetAddressUtxosArg.AsObject;
  static serializeBinaryToWriter(message: GetAddressUtxosArg, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): GetAddressUtxosArg;
  static deserializeBinaryFromReader(message: GetAddressUtxosArg, reader: jspb.BinaryReader): GetAddressUtxosArg;
}

export namespace GetAddressUtxosArg {
  export type AsObject = {
    addressesList: Array<string>,
    startheight: number,
    maxentries: number,
  }
}

export class GetAddressUtxosReply extends jspb.Message {
  getAddress(): string;
  setAddress(value: string): GetAddressUtxosReply;

  getTxid(): Uint8Array | string;
  getTxid_asU8(): Uint8Array;
  getTxid_asB64(): string;
  setTxid(value: Uint8Array | string): GetAddressUtxosReply;

  getIndex(): number;
  setIndex(value: number): GetAddressUtxosReply;

  getScript(): Uint8Array | string;
  getScript_asU8(): Uint8Array;
  getScript_asB64(): string;
  setScript(value: Uint8Array | string): GetAddressUtxosReply;

  getValuezat(): number;
  setValuezat(value: number): GetAddressUtxosReply;

  getHeight(): number;
  setHeight(value: number): GetAddressUtxosReply;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): GetAddressUtxosReply.AsObject;
  static toObject(includeInstance: boolean, msg: GetAddressUtxosReply): GetAddressUtxosReply.AsObject;
  static serializeBinaryToWriter(message: GetAddressUtxosReply, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): GetAddressUtxosReply;
  static deserializeBinaryFromReader(message: GetAddressUtxosReply, reader: jspb.BinaryReader): GetAddressUtxosReply;
}

export namespace GetAddressUtxosReply {
  export type AsObject = {
    address: string,
    txid: Uint8Array | string,
    index: number,
    script: Uint8Array | string,
    valuezat: number,
    height: number,
  }
}

export class GetAddressUtxosReplyList extends jspb.Message {
  getAddressutxosList(): Array<GetAddressUtxosReply>;
  setAddressutxosList(value: Array<GetAddressUtxosReply>): GetAddressUtxosReplyList;
  clearAddressutxosList(): GetAddressUtxosReplyList;
  addAddressutxos(value?: GetAddressUtxosReply, index?: number): GetAddressUtxosReply;

  serializeBinary(): Uint8Array;
  toObject(includeInstance?: boolean): GetAddressUtxosReplyList.AsObject;
  static toObject(includeInstance: boolean, msg: GetAddressUtxosReplyList): GetAddressUtxosReplyList.AsObject;
  static serializeBinaryToWriter(message: GetAddressUtxosReplyList, writer: jspb.BinaryWriter): void;
  static deserializeBinary(bytes: Uint8Array): GetAddressUtxosReplyList;
  static deserializeBinaryFromReader(message: GetAddressUtxosReplyList, reader: jspb.BinaryReader): GetAddressUtxosReplyList;
}

export namespace GetAddressUtxosReplyList {
  export type AsObject = {
    addressutxosList: Array<GetAddressUtxosReply.AsObject>,
  }
}

