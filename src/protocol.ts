// Compatibility facade. Provider quirks and schemas live in the Codex adapter.
export {
  CODEX_WORKER_OUTPUT_SCHEMA,
  ExternalResponseSchema,
  parseResponse,
  WorkerProtocolError,
  type ParseOptions,
} from './providers/codex/protocol.js';
