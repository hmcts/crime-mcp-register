/**
 * Single-use, TTL-bounded payload store.
 *
 * Used by setup_workspace and update_knowledge to hold a generated bundle
 * (tarball/zip + apply script) in memory under a random ID, returning the
 * download URL to Claude. When Claude fetches the bundle from
 * GET /payload/:id, the entry is deleted immediately -- it cannot be
 * replayed, cannot be downloaded twice, cannot leak into a long-lived
 * cache.
 *
 * TTL exists as a backstop in case Claude never fetches: the entry is GC'd
 * after 5 minutes. This prevents a slow leak if a tool call runs but
 * Claude crashes / disconnects before fetching.
 *
 * Thread-safety: Node is single-threaded; no locks needed.
 *
 * SOLID:
 *   - Single responsibility: opaque-token -> bundle, single read.
 *   - No transitive dependencies; pure in-memory map + setInterval.
 */

import { randomBytes } from 'node:crypto';

export interface PayloadEntry {
  /** The actual bundle bytes (tar.gz or zip). */
  bundle: Buffer;
  /** Filename hint for Content-Disposition. */
  filename: string;
  /** MIME type. */
  contentType: string;
  /** When this entry expires and gets GC'd if not fetched. Unix ms. */
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const ID_BYTES = 24;          // 32-char base64url -- enough entropy for non-guessable IDs

const store = new Map<string, PayloadEntry>();
let gcTimer: NodeJS.Timeout | null = null;

/**
 * Store a bundle. Returns the random ID Claude must use to fetch it.
 * The ID is a 32-character base64url string -- non-guessable, single-use.
 */
export function storePayload(bundle: Buffer, filename: string, contentType: string): string {
  const id = randomBytes(ID_BYTES).toString('base64url');
  store.set(id, {
    bundle,
    filename,
    contentType,
    expiresAt: Date.now() + TTL_MS,
  });
  ensureGc();
  return id;
}

/**
 * Take (read AND delete) a payload by ID. Returns undefined if not found
 * or already expired. Single-use semantics.
 */
export function takePayload(id: string): PayloadEntry | undefined {
  const entry = store.get(id);
  if (!entry) return undefined;
  store.delete(id);
  if (entry.expiresAt < Date.now()) {
    return undefined;
  }
  return entry;
}

/** Force-clear the entire store. Used by tests. */
export function clearAllPayloads(): void {
  store.clear();
}

/** Number of entries currently live (for /health-style introspection). */
export function payloadStoreSize(): number {
  return store.size;
}

function ensureGc(): void {
  if (gcTimer) return;
  gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of store) {
      if (entry.expiresAt < now) {
        store.delete(id);
      }
    }
    if (store.size === 0 && gcTimer) {
      clearInterval(gcTimer);
      gcTimer = null;
    }
  }, 60 * 1000); // sweep every minute while there are entries

  // Don't keep the process alive on this timer alone.
  gcTimer.unref?.();
}
