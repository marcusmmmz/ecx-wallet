/** EIP-1193 / JSON-RPC error codes the Provider returns. */
export const ErrorCode = {
  UserRejected: 4001,
  Unauthorized: 4100,
  UnsupportedMethod: 4200,
  Disconnected: 4900,
  ChainDisconnected: 4901,
  /** The origin already has a request of this kind waiting for the user. */
  RequestPending: -32002,
  InvalidParams: -32602,
  Internal: -32603,
} as const;

export class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRpcError";
  }
}
