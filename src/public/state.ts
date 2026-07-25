/**
 * Curated public surface of the state layer.
 *
 * The key-derivation helpers (`keyDigest`, `sanitizeSegment`, `namespaceSegments`)
 * and the in-process async lock are deliberately absent: they are how a store is
 * built, not part of the contract a host programs against, and pinning them
 * publicly would freeze the on-disk layout.
 */
export type { StoreNamespace } from "../state/keys.js";
export {
  isLockingStateStore,
  withOptionalSessionLock,
  type LockingStateStore,
  type StateStoreDependencies,
} from "../state/store.js";
export {
  createBoundedMemoryStateStore,
  type BoundedMemoryStateStore,
  type BoundedMemoryStateStoreOptions,
} from "../state/memory-store.js";
export {
  createFilesystemStateStore,
  type FilesystemStateStore,
  type FilesystemStateStoreOptions,
} from "../state/filesystem-store.js";
