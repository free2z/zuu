/**
 * @fileoverview gRPC-Web generated client stub for cash.z.wallet.sdk.rpc
 * @enhanceable
 * @public
 */

// GENERATED CODE -- DO NOT EDIT!


/* eslint-disable */
// @ts-nocheck


import * as grpcWeb from 'grpc-web';

import * as service_pb from './service_pb';
import * as compact_formats_pb from './compact_formats_pb';


export class CompactTxStreamerClient {
  client_: grpcWeb.AbstractClientBase;
  hostname_: string;
  credentials_: null | { [index: string]: string; };
  options_: null | { [index: string]: any; };

  constructor (hostname: string,
               credentials?: null | { [index: string]: string; },
               options?: null | { [index: string]: any; }) {
    if (!options) options = {};
    if (!credentials) credentials = {};
    options['format'] = 'text';

    this.client_ = new grpcWeb.GrpcWebClientBase(options);
    this.hostname_ = hostname;
    this.credentials_ = credentials;
    this.options_ = options;
  }

  methodDescriptorGetLatestBlock = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock',
    grpcWeb.MethodType.UNARY,
    service_pb.ChainSpec,
    service_pb.BlockID,
    (request: service_pb.ChainSpec) => {
      return request.serializeBinary();
    },
    service_pb.BlockID.deserializeBinary
  );

  getLatestBlock(
    request: service_pb.ChainSpec,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.BlockID>;

  getLatestBlock(
    request: service_pb.ChainSpec,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.BlockID) => void): grpcWeb.ClientReadableStream<service_pb.BlockID>;

  getLatestBlock(
    request: service_pb.ChainSpec,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.BlockID) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock',
        request,
        metadata || {},
        this.methodDescriptorGetLatestBlock,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestBlock',
    request,
    metadata || {},
    this.methodDescriptorGetLatestBlock);
  }

  methodDescriptorGetBlock = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlock',
    grpcWeb.MethodType.UNARY,
    service_pb.BlockID,
    compact_formats_pb.CompactBlock,
    (request: service_pb.BlockID) => {
      return request.serializeBinary();
    },
    compact_formats_pb.CompactBlock.deserializeBinary
  );

  getBlock(
    request: service_pb.BlockID,
    metadata: grpcWeb.Metadata | null): Promise<compact_formats_pb.CompactBlock>;

  getBlock(
    request: service_pb.BlockID,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: compact_formats_pb.CompactBlock) => void): grpcWeb.ClientReadableStream<compact_formats_pb.CompactBlock>;

  getBlock(
    request: service_pb.BlockID,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: compact_formats_pb.CompactBlock) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlock',
        request,
        metadata || {},
        this.methodDescriptorGetBlock,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlock',
    request,
    metadata || {},
    this.methodDescriptorGetBlock);
  }

  methodDescriptorGetBlockRange = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlockRange',
    grpcWeb.MethodType.SERVER_STREAMING,
    service_pb.BlockRange,
    compact_formats_pb.CompactBlock,
    (request: service_pb.BlockRange) => {
      return request.serializeBinary();
    },
    compact_formats_pb.CompactBlock.deserializeBinary
  );

  getBlockRange(
    request: service_pb.BlockRange,
    metadata?: grpcWeb.Metadata): grpcWeb.ClientReadableStream<compact_formats_pb.CompactBlock> {
    return this.client_.serverStreaming(
      this.hostname_ +
        '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetBlockRange',
      request,
      metadata || {},
      this.methodDescriptorGetBlockRange);
  }

  methodDescriptorGetTransaction = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction',
    grpcWeb.MethodType.UNARY,
    service_pb.TxFilter,
    service_pb.RawTransaction,
    (request: service_pb.TxFilter) => {
      return request.serializeBinary();
    },
    service_pb.RawTransaction.deserializeBinary
  );

  getTransaction(
    request: service_pb.TxFilter,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.RawTransaction>;

  getTransaction(
    request: service_pb.TxFilter,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.RawTransaction) => void): grpcWeb.ClientReadableStream<service_pb.RawTransaction>;

  getTransaction(
    request: service_pb.TxFilter,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.RawTransaction) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction',
        request,
        metadata || {},
        this.methodDescriptorGetTransaction,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTransaction',
    request,
    metadata || {},
    this.methodDescriptorGetTransaction);
  }

  methodDescriptorSendTransaction = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/SendTransaction',
    grpcWeb.MethodType.UNARY,
    service_pb.RawTransaction,
    service_pb.SendResponse,
    (request: service_pb.RawTransaction) => {
      return request.serializeBinary();
    },
    service_pb.SendResponse.deserializeBinary
  );

  sendTransaction(
    request: service_pb.RawTransaction,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.SendResponse>;

  sendTransaction(
    request: service_pb.RawTransaction,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.SendResponse) => void): grpcWeb.ClientReadableStream<service_pb.SendResponse>;

  sendTransaction(
    request: service_pb.RawTransaction,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.SendResponse) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/SendTransaction',
        request,
        metadata || {},
        this.methodDescriptorSendTransaction,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/SendTransaction',
    request,
    metadata || {},
    this.methodDescriptorSendTransaction);
  }

  methodDescriptorGetTaddressTxids = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTaddressTxids',
    grpcWeb.MethodType.SERVER_STREAMING,
    service_pb.TransparentAddressBlockFilter,
    service_pb.RawTransaction,
    (request: service_pb.TransparentAddressBlockFilter) => {
      return request.serializeBinary();
    },
    service_pb.RawTransaction.deserializeBinary
  );

  getTaddressTxids(
    request: service_pb.TransparentAddressBlockFilter,
    metadata?: grpcWeb.Metadata): grpcWeb.ClientReadableStream<service_pb.RawTransaction> {
    return this.client_.serverStreaming(
      this.hostname_ +
        '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTaddressTxids',
      request,
      metadata || {},
      this.methodDescriptorGetTaddressTxids);
  }

  methodDescriptorGetTaddressBalance = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTaddressBalance',
    grpcWeb.MethodType.UNARY,
    service_pb.AddressList,
    service_pb.Balance,
    (request: service_pb.AddressList) => {
      return request.serializeBinary();
    },
    service_pb.Balance.deserializeBinary
  );

  getTaddressBalance(
    request: service_pb.AddressList,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.Balance>;

  getTaddressBalance(
    request: service_pb.AddressList,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.Balance) => void): grpcWeb.ClientReadableStream<service_pb.Balance>;

  getTaddressBalance(
    request: service_pb.AddressList,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.Balance) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTaddressBalance',
        request,
        metadata || {},
        this.methodDescriptorGetTaddressBalance,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTaddressBalance',
    request,
    metadata || {},
    this.methodDescriptorGetTaddressBalance);
  }

  methodDescriptorGetMempoolTx = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetMempoolTx',
    grpcWeb.MethodType.SERVER_STREAMING,
    service_pb.Exclude,
    compact_formats_pb.CompactTx,
    (request: service_pb.Exclude) => {
      return request.serializeBinary();
    },
    compact_formats_pb.CompactTx.deserializeBinary
  );

  getMempoolTx(
    request: service_pb.Exclude,
    metadata?: grpcWeb.Metadata): grpcWeb.ClientReadableStream<compact_formats_pb.CompactTx> {
    return this.client_.serverStreaming(
      this.hostname_ +
        '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetMempoolTx',
      request,
      metadata || {},
      this.methodDescriptorGetMempoolTx);
  }

  methodDescriptorGetMempoolStream = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetMempoolStream',
    grpcWeb.MethodType.SERVER_STREAMING,
    service_pb.Empty,
    service_pb.RawTransaction,
    (request: service_pb.Empty) => {
      return request.serializeBinary();
    },
    service_pb.RawTransaction.deserializeBinary
  );

  getMempoolStream(
    request: service_pb.Empty,
    metadata?: grpcWeb.Metadata): grpcWeb.ClientReadableStream<service_pb.RawTransaction> {
    return this.client_.serverStreaming(
      this.hostname_ +
        '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetMempoolStream',
      request,
      metadata || {},
      this.methodDescriptorGetMempoolStream);
  }

  methodDescriptorGetTreeState = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTreeState',
    grpcWeb.MethodType.UNARY,
    service_pb.BlockID,
    service_pb.TreeState,
    (request: service_pb.BlockID) => {
      return request.serializeBinary();
    },
    service_pb.TreeState.deserializeBinary
  );

  getTreeState(
    request: service_pb.BlockID,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.TreeState>;

  getTreeState(
    request: service_pb.BlockID,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.TreeState) => void): grpcWeb.ClientReadableStream<service_pb.TreeState>;

  getTreeState(
    request: service_pb.BlockID,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.TreeState) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTreeState',
        request,
        metadata || {},
        this.methodDescriptorGetTreeState,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetTreeState',
    request,
    metadata || {},
    this.methodDescriptorGetTreeState);
  }

  methodDescriptorGetLatestTreeState = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestTreeState',
    grpcWeb.MethodType.UNARY,
    service_pb.Empty,
    service_pb.TreeState,
    (request: service_pb.Empty) => {
      return request.serializeBinary();
    },
    service_pb.TreeState.deserializeBinary
  );

  getLatestTreeState(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.TreeState>;

  getLatestTreeState(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.TreeState) => void): grpcWeb.ClientReadableStream<service_pb.TreeState>;

  getLatestTreeState(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.TreeState) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestTreeState',
        request,
        metadata || {},
        this.methodDescriptorGetLatestTreeState,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLatestTreeState',
    request,
    metadata || {},
    this.methodDescriptorGetLatestTreeState);
  }

  methodDescriptorGetAddressUtxos = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetAddressUtxos',
    grpcWeb.MethodType.UNARY,
    service_pb.GetAddressUtxosArg,
    service_pb.GetAddressUtxosReplyList,
    (request: service_pb.GetAddressUtxosArg) => {
      return request.serializeBinary();
    },
    service_pb.GetAddressUtxosReplyList.deserializeBinary
  );

  getAddressUtxos(
    request: service_pb.GetAddressUtxosArg,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.GetAddressUtxosReplyList>;

  getAddressUtxos(
    request: service_pb.GetAddressUtxosArg,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.GetAddressUtxosReplyList) => void): grpcWeb.ClientReadableStream<service_pb.GetAddressUtxosReplyList>;

  getAddressUtxos(
    request: service_pb.GetAddressUtxosArg,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.GetAddressUtxosReplyList) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetAddressUtxos',
        request,
        metadata || {},
        this.methodDescriptorGetAddressUtxos,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetAddressUtxos',
    request,
    metadata || {},
    this.methodDescriptorGetAddressUtxos);
  }

  methodDescriptorGetAddressUtxosStream = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetAddressUtxosStream',
    grpcWeb.MethodType.SERVER_STREAMING,
    service_pb.GetAddressUtxosArg,
    service_pb.GetAddressUtxosReply,
    (request: service_pb.GetAddressUtxosArg) => {
      return request.serializeBinary();
    },
    service_pb.GetAddressUtxosReply.deserializeBinary
  );

  getAddressUtxosStream(
    request: service_pb.GetAddressUtxosArg,
    metadata?: grpcWeb.Metadata): grpcWeb.ClientReadableStream<service_pb.GetAddressUtxosReply> {
    return this.client_.serverStreaming(
      this.hostname_ +
        '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetAddressUtxosStream',
      request,
      metadata || {},
      this.methodDescriptorGetAddressUtxosStream);
  }

  methodDescriptorGetLightdInfo = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo',
    grpcWeb.MethodType.UNARY,
    service_pb.Empty,
    service_pb.LightdInfo,
    (request: service_pb.Empty) => {
      return request.serializeBinary();
    },
    service_pb.LightdInfo.deserializeBinary
  );

  getLightdInfo(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.LightdInfo>;

  getLightdInfo(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.LightdInfo) => void): grpcWeb.ClientReadableStream<service_pb.LightdInfo>;

  getLightdInfo(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.LightdInfo) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo',
        request,
        metadata || {},
        this.methodDescriptorGetLightdInfo,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/GetLightdInfo',
    request,
    metadata || {},
    this.methodDescriptorGetLightdInfo);
  }

  methodDescriptorPing = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.CompactTxStreamer/Ping',
    grpcWeb.MethodType.UNARY,
    service_pb.Duration,
    service_pb.PingResponse,
    (request: service_pb.Duration) => {
      return request.serializeBinary();
    },
    service_pb.PingResponse.deserializeBinary
  );

  ping(
    request: service_pb.Duration,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.PingResponse>;

  ping(
    request: service_pb.Duration,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.PingResponse) => void): grpcWeb.ClientReadableStream<service_pb.PingResponse>;

  ping(
    request: service_pb.Duration,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.PingResponse) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.CompactTxStreamer/Ping',
        request,
        metadata || {},
        this.methodDescriptorPing,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.CompactTxStreamer/Ping',
    request,
    metadata || {},
    this.methodDescriptorPing);
  }

}

