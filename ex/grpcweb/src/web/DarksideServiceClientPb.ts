/**
 * @fileoverview gRPC-Web generated client stub for cash.z.wallet.sdk.rpc
 * @enhanceable
 * @public
 */

// GENERATED CODE -- DO NOT EDIT!


/* eslint-disable */
// @ts-nocheck


import * as grpcWeb from 'grpc-web';

import * as darkside_pb from './darkside_pb';
import * as service_pb from './service_pb';


export class DarksideStreamerClient {
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

  methodDescriptorReset = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.DarksideStreamer/Reset',
    grpcWeb.MethodType.UNARY,
    darkside_pb.DarksideMetaState,
    service_pb.Empty,
    (request: darkside_pb.DarksideMetaState) => {
      return request.serializeBinary();
    },
    service_pb.Empty.deserializeBinary
  );

  reset(
    request: darkside_pb.DarksideMetaState,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.Empty>;

  reset(
    request: darkside_pb.DarksideMetaState,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void): grpcWeb.ClientReadableStream<service_pb.Empty>;

  reset(
    request: darkside_pb.DarksideMetaState,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.DarksideStreamer/Reset',
        request,
        metadata || {},
        this.methodDescriptorReset,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.DarksideStreamer/Reset',
    request,
    metadata || {},
    this.methodDescriptorReset);
  }

  methodDescriptorStageBlocks = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.DarksideStreamer/StageBlocks',
    grpcWeb.MethodType.UNARY,
    darkside_pb.DarksideBlocksURL,
    service_pb.Empty,
    (request: darkside_pb.DarksideBlocksURL) => {
      return request.serializeBinary();
    },
    service_pb.Empty.deserializeBinary
  );

  stageBlocks(
    request: darkside_pb.DarksideBlocksURL,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.Empty>;

  stageBlocks(
    request: darkside_pb.DarksideBlocksURL,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void): grpcWeb.ClientReadableStream<service_pb.Empty>;

  stageBlocks(
    request: darkside_pb.DarksideBlocksURL,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.DarksideStreamer/StageBlocks',
        request,
        metadata || {},
        this.methodDescriptorStageBlocks,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.DarksideStreamer/StageBlocks',
    request,
    metadata || {},
    this.methodDescriptorStageBlocks);
  }

  methodDescriptorStageBlocksCreate = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.DarksideStreamer/StageBlocksCreate',
    grpcWeb.MethodType.UNARY,
    darkside_pb.DarksideEmptyBlocks,
    service_pb.Empty,
    (request: darkside_pb.DarksideEmptyBlocks) => {
      return request.serializeBinary();
    },
    service_pb.Empty.deserializeBinary
  );

  stageBlocksCreate(
    request: darkside_pb.DarksideEmptyBlocks,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.Empty>;

  stageBlocksCreate(
    request: darkside_pb.DarksideEmptyBlocks,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void): grpcWeb.ClientReadableStream<service_pb.Empty>;

  stageBlocksCreate(
    request: darkside_pb.DarksideEmptyBlocks,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.DarksideStreamer/StageBlocksCreate',
        request,
        metadata || {},
        this.methodDescriptorStageBlocksCreate,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.DarksideStreamer/StageBlocksCreate',
    request,
    metadata || {},
    this.methodDescriptorStageBlocksCreate);
  }

  methodDescriptorStageTransactions = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.DarksideStreamer/StageTransactions',
    grpcWeb.MethodType.UNARY,
    darkside_pb.DarksideTransactionsURL,
    service_pb.Empty,
    (request: darkside_pb.DarksideTransactionsURL) => {
      return request.serializeBinary();
    },
    service_pb.Empty.deserializeBinary
  );

  stageTransactions(
    request: darkside_pb.DarksideTransactionsURL,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.Empty>;

  stageTransactions(
    request: darkside_pb.DarksideTransactionsURL,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void): grpcWeb.ClientReadableStream<service_pb.Empty>;

  stageTransactions(
    request: darkside_pb.DarksideTransactionsURL,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.DarksideStreamer/StageTransactions',
        request,
        metadata || {},
        this.methodDescriptorStageTransactions,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.DarksideStreamer/StageTransactions',
    request,
    metadata || {},
    this.methodDescriptorStageTransactions);
  }

  methodDescriptorApplyStaged = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.DarksideStreamer/ApplyStaged',
    grpcWeb.MethodType.UNARY,
    darkside_pb.DarksideHeight,
    service_pb.Empty,
    (request: darkside_pb.DarksideHeight) => {
      return request.serializeBinary();
    },
    service_pb.Empty.deserializeBinary
  );

  applyStaged(
    request: darkside_pb.DarksideHeight,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.Empty>;

  applyStaged(
    request: darkside_pb.DarksideHeight,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void): grpcWeb.ClientReadableStream<service_pb.Empty>;

  applyStaged(
    request: darkside_pb.DarksideHeight,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.DarksideStreamer/ApplyStaged',
        request,
        metadata || {},
        this.methodDescriptorApplyStaged,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.DarksideStreamer/ApplyStaged',
    request,
    metadata || {},
    this.methodDescriptorApplyStaged);
  }

  methodDescriptorGetIncomingTransactions = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.DarksideStreamer/GetIncomingTransactions',
    grpcWeb.MethodType.SERVER_STREAMING,
    service_pb.Empty,
    service_pb.RawTransaction,
    (request: service_pb.Empty) => {
      return request.serializeBinary();
    },
    service_pb.RawTransaction.deserializeBinary
  );

  getIncomingTransactions(
    request: service_pb.Empty,
    metadata?: grpcWeb.Metadata): grpcWeb.ClientReadableStream<service_pb.RawTransaction> {
    return this.client_.serverStreaming(
      this.hostname_ +
        '/cash.z.wallet.sdk.rpc.DarksideStreamer/GetIncomingTransactions',
      request,
      metadata || {},
      this.methodDescriptorGetIncomingTransactions);
  }

  methodDescriptorClearIncomingTransactions = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.DarksideStreamer/ClearIncomingTransactions',
    grpcWeb.MethodType.UNARY,
    service_pb.Empty,
    service_pb.Empty,
    (request: service_pb.Empty) => {
      return request.serializeBinary();
    },
    service_pb.Empty.deserializeBinary
  );

  clearIncomingTransactions(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.Empty>;

  clearIncomingTransactions(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void): grpcWeb.ClientReadableStream<service_pb.Empty>;

  clearIncomingTransactions(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.DarksideStreamer/ClearIncomingTransactions',
        request,
        metadata || {},
        this.methodDescriptorClearIncomingTransactions,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.DarksideStreamer/ClearIncomingTransactions',
    request,
    metadata || {},
    this.methodDescriptorClearIncomingTransactions);
  }

  methodDescriptorAddAddressUtxo = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.DarksideStreamer/AddAddressUtxo',
    grpcWeb.MethodType.UNARY,
    service_pb.GetAddressUtxosReply,
    service_pb.Empty,
    (request: service_pb.GetAddressUtxosReply) => {
      return request.serializeBinary();
    },
    service_pb.Empty.deserializeBinary
  );

  addAddressUtxo(
    request: service_pb.GetAddressUtxosReply,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.Empty>;

  addAddressUtxo(
    request: service_pb.GetAddressUtxosReply,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void): grpcWeb.ClientReadableStream<service_pb.Empty>;

  addAddressUtxo(
    request: service_pb.GetAddressUtxosReply,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.DarksideStreamer/AddAddressUtxo',
        request,
        metadata || {},
        this.methodDescriptorAddAddressUtxo,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.DarksideStreamer/AddAddressUtxo',
    request,
    metadata || {},
    this.methodDescriptorAddAddressUtxo);
  }

  methodDescriptorClearAddressUtxo = new grpcWeb.MethodDescriptor(
    '/cash.z.wallet.sdk.rpc.DarksideStreamer/ClearAddressUtxo',
    grpcWeb.MethodType.UNARY,
    service_pb.Empty,
    service_pb.Empty,
    (request: service_pb.Empty) => {
      return request.serializeBinary();
    },
    service_pb.Empty.deserializeBinary
  );

  clearAddressUtxo(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null): Promise<service_pb.Empty>;

  clearAddressUtxo(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null,
    callback: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void): grpcWeb.ClientReadableStream<service_pb.Empty>;

  clearAddressUtxo(
    request: service_pb.Empty,
    metadata: grpcWeb.Metadata | null,
    callback?: (err: grpcWeb.RpcError,
               response: service_pb.Empty) => void) {
    if (callback !== undefined) {
      return this.client_.rpcCall(
        this.hostname_ +
          '/cash.z.wallet.sdk.rpc.DarksideStreamer/ClearAddressUtxo',
        request,
        metadata || {},
        this.methodDescriptorClearAddressUtxo,
        callback);
    }
    return this.client_.unaryCall(
    this.hostname_ +
      '/cash.z.wallet.sdk.rpc.DarksideStreamer/ClearAddressUtxo',
    request,
    metadata || {},
    this.methodDescriptorClearAddressUtxo);
  }

}

