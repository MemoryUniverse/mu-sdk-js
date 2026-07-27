/**
 * mu-sdk — the Memory Universe JavaScript/TypeScript developer SDK.
 *
 * A THIN async wire client (`MemoryClient`): add / search / recall / context, talking to
 * `mu-server`'s public surface ONLY over the versioned wire contract. No engine, no stores, no
 * strategies, no embedder — faithful mirror of `mu-sdk-python`'s public surface
 * (`mu-sdk-python/src/mu_sdk/__init__.py`).
 */

export { ApiKeyAuth, BearerAuth, DemoHeaderAuth, type SdkAuth, resolveAuth } from "./auth.js";
export type { RequestFunc, RetryOptions } from "./decorators.js";
export { withRetry, withTimeout, withTrace } from "./decorators.js";
export { mapWireError } from "./errorMapping.js";
export {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  PrivateDataRejectedError,
  RateLimitedError,
  SdkError,
  SdkTimeoutError,
  ServerError,
  ServiceUnavailableError,
  TransientSdkError,
  TransportError,
  UnexpectedResponseError,
  ValidationError,
} from "./errors.js";
export {
  type AddOptions,
  type ContextApi,
  MemoryClient,
  type MemoryClientOptions,
  type RecallOptions,
  type RequestSignalOption,
  type SearchOptions,
} from "./client.js";
export {
  type ContextIndexListView,
  type ContextIndexView,
  contextIndexListViewSchema,
  contextIndexViewSchema,
} from "./models/context.js";
export {
  type ContentType,
  type MemoryCreateRequest,
  type MemoryListResponse,
  type MemoryResponse,
  type MemoryTier,
  type Polarity,
  type Visibility,
  contentTypeSchema,
  memoryCreateRequestSchema,
  memoryListResponseSchema,
  memoryResponseSchema,
  memoryTierSchema,
  polaritySchema,
  visibilitySchema,
} from "./models/memory.js";
export {
  DEFAULT_RECALL_CHANNELS,
  type DegradeReason,
  type Namespace,
  type RecallChannels,
  type RecallItemView,
  type RecallMode,
  type RecallRequest,
  type RecallResult,
  degradeReasonSchema,
  namespaceSchema,
  recallChannelsSchema,
  recallItemViewSchema,
  recallMemoryIds,
  recallModeSchema,
  recallRequestSchema,
  recallResultSchema,
} from "./models/recall.js";
export {
  type SdkIdentity,
  type SdkSettings,
  type SdkSettingsInput,
  isIdentityComplete,
  resolveSdkSettings,
} from "./settings.js";
export {
  FetchTransport,
  type FetchLike,
  type QueryParams,
  type Transport,
  type TransportRequestOptions,
  TransportResponse,
} from "./transport.js";

export const SDK_VERSION = "0.1.0";
