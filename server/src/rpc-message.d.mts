export type RequestId = string | number;
export type RpcError = { code: number; message: string };

export type RpcMessage<Params = Record<string, unknown>> = {
  id?: RequestId;
  params?: Params;
  error?: RpcError;
  result?: unknown;
} & ({ method: string } | { method?: never });
