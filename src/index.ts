/**
 * mu-sdk — the Memory Universe JavaScript/TypeScript developer SDK.
 *
 * A THIN async wire client (`MemoryClient`): add / search / recall (tier-scoped) / consolidate /
 * ask / context, talking to `mu-server`'s public surface ONLY over the versioned wire contract.
 * No engine, no stores, no strategies, no embedder — faithful mirror of `mu-sdk-python`'s public
 * surface (`mu-sdk-python/src/mu_sdk/__init__.py`).
 */

export { ApiKeyAuth, BearerAuth, DemoHeaderAuth, type SdkAuth, resolveAuth } from "./auth.js";
export {
  DEFAULT_TOKEN_PATH,
  type LifecycleSettings,
  loadEngineServerAuth,
  type ManagerMode,
  PRIVATE_PLANE_FIELDS,
  planeConfigFor,
  resolveTokenPath,
  type SdkConfig,
  type SdkMode,
  SHARED_PLANE_FIELDS,
  type SharedPlaneConfig,
  TOKEN_PATH_ENV_VAR,
  validatePlaneFields,
} from "./config.js";
export type { RequestFunc, RetryOptions } from "./decorators.js";
export { withRetry, withTimeout, withTrace } from "./decorators.js";
export { mapWireError } from "./errorMapping.js";
export {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  EngineServerTokenNotFoundError,
  NotFoundError,
  PlaneFieldRejectedError,
  PrivateDataRejectedError,
  RateLimitedError,
  SdkConfigError,
  SdkError,
  SdkTimeoutError,
  ServerError,
  ServiceUnavailableError,
  SurfaceVerbNotImplementedError,
  TransientSdkError,
  TransportError,
  UnexpectedResponseError,
  UnsupportedModeError,
  ValidationError,
} from "./errors.js";
export {
  type AddOptions,
  type AskOptions,
  type BuildContextOptions,
  type ConsolidateOptions,
  type ContextApi,
  type GetOptions,
  MemoryClient,
  type MemoryClientOptions,
  type PromoteOptions,
  type RecallOptions,
  type RequestSignalOption,
  type SearchOptions,
  type ShareOptions,
} from "./client.js";
export {
  type AskRequest,
  type AskResult,
  type ConsolidateRequest,
  type ConsolidateResult,
  askRequestSchema,
  askResultSchema,
  consolidateRequestSchema,
  consolidateResultSchema,
} from "./models/consolidate.js";
export {
  type ContextIndexListView,
  type ContextIndexView,
  type ContextView,
  contextIndexListViewSchema,
  contextIndexViewSchema,
  contextViewSchema,
} from "./models/context.js";
export {
  type ContentType,
  type MemoryCreateRequest,
  type MemoryListResponse,
  type MemoryResponse,
  type MemoryTier,
  type MemoryWriteResult,
  type Polarity,
  type Visibility,
  contentTypeSchema,
  memoryCreateRequestSchema,
  memoryListResponseSchema,
  memoryResponseSchema,
  memoryTierSchema,
  memoryWriteResultSchema,
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
