import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * dsh-context-manager — minimal cross-process mutex for the on-disk stores.
 *
 * Two Harness processes (or a Harness plus a headless script) can write the
 * same pin or notes file. Without a lock both load the same snapshot and the
 * slower write wins, silently losing the other's update. This is a lockfile:
 * O_CREAT|O_EXCL creation, bounded retries with a small backoff, and reclaim
 * of a lock whose holder died (idle longer than `staleMs`). node:fs only —
 * the plugin adds no npm runtime dependency.
 * @module dsh-context-manager/lock
 */

/** Idle time after which a lock is presumed abandoned by a dead process.
 * 60s, not 10s: slow notes critical sections (large diaries) must never be
 * reclaimed mid-write — a false stale verdict is a cross-process lost update. */
const LOCK_STALE_MS = 60_000;
/** Retry cadence: linear backoff, capped, with a bounded attempt count. */
const LOCK_RETRY_BASE_MS = 20;
const LOCK_RETRY_MAX_MS = 200;
const LOCK_MAX_ATTEMPTS = 60;

/** Thrown when the lock could not be taken within the attempt budget. */
export class LockBusyError extends Error {
  constructor(lockPath) {
    super(`timed out waiting for ${lockPath}`);
    this.name = 'LockBusyError';
    this.code = 'lock-busy';
  }
}

/** Reclaim only a lock that is both present and idle past `staleMs`. */
function reclaimStaleLock(lockPath, staleMs, logger) {
  try {
    const idle = Date.now() - statSync(lockPath).mtimeMs;
    if (idle <= staleMs) return false;
    unlinkSync(lockPath);
    logger?.warn?.(`context-manager: reclaimed stale lock ${lockPath} (idle ${Math.round(idle)}ms)`);
    return true;
  } catch {
    // The lock disappeared between EEXIST and stat — retry immediately.
    return true;
  }
}

/**
 * Run `fn` while holding `${file}.lock`, so one load-modify-save critical
 * section per file runs at a time across processes.
 * @param {string} file - the store file the critical section mutates.
 * @param {() => T | Promise<T>} fn - critical section.
 * @param {{logger?: object, staleMs?: number, attempts?: number}} [options]
 * @returns {Promise<T>} whatever `fn` returns.
 * @template T
 */
export async function withFileLock(file, fn, { logger, staleMs = LOCK_STALE_MS, attempts = LOCK_MAX_ATTEMPTS } = {}) {
  const lockPath = `${file}.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd;
  for (let attempt = 0; fd === undefined && attempt < attempts; attempt += 1) {
    try {
      fd = openSync(lockPath, 'wx');
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (reclaimStaleLock(lockPath, staleMs, logger)) continue;
      await delay(Math.min(LOCK_RETRY_BASE_MS * (attempt + 1), LOCK_RETRY_MAX_MS));
    }
  }
  if (fd === undefined) throw new LockBusyError(lockPath);
  try {
    writeSync(fd, `${process.pid} ${Date.now()}\n`);
  } catch (error) {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // A stale lock is reclaimed by the next waiter.
    }
    throw error;
  }
  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Already closed.
    }
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process reclaimed the lock after a false stale verdict.
    }
  }
}
