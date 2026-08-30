import { createHash, randomUUID } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  utimes,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, resolve } from "node:path";

import {
  LlmBudgetDeniedError,
  LlmLedgerCloseError,
  LlmLedgerUnavailableError,
  type LlmLedger,
  type LlmLedgerReserveRecovery,
  type LlmReservation,
  type LlmReserveRequest,
  type LlmSettlementOutboxMonitoring,
  type LlmSettlementRequest,
} from "@mydon/shared";

const RECORD_VERSION = 1 as const;
const MAX_RECORD_BYTES = 64 * 1024;
const DEAD_METADATA_RESERVE_BYTES = 1_024;
const DEFAULT_FALLBACK_DELAY_MS = 15 * 60_000;
const DEFAULT_MAX_ATTEMPTS = 32;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 15 * 60_000;
const DEFAULT_PROCESSING_LEASE_MS = 5 * 60_000;
const DEFAULT_LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_DELAY_MS = 25;
const DEFAULT_MAX_RECORDS = 50;
const FALLBACK_REASON = "settlement_outbox_fallback";

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type RecordKind = "pre_reserve" | "fallback" | "exact";
type CloseOperation = "settle" | "fail" | "release";
type RecordOperation = "recover_pre_dispatch" | CloseOperation;
type StateDirectory = "pending" | "processing" | "dead";
type DeadCategory = "attempts_exhausted" | "corrupt" | "exact_conflict" | "terminal_close";

interface StoredRecord {
  version: typeof RECORD_VERSION;
  recordId: string;
  kind: RecordKind;
  operation: RecordOperation;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string;
  attempts: number;
  requestKey?: string;
  reservationId?: string;
  payload?: JsonValue;
}

interface ValidDeadRecord {
  version: typeof RECORD_VERSION;
  state: "dead";
  source: StoredRecord;
  deadAt: string;
  category: Exclude<DeadCategory, "corrupt">;
  httpStatus?: number;
}

interface CorruptDeadRecord {
  version: typeof RECORD_VERSION;
  state: "corrupt";
  recordId: string;
  deadAt: string;
  category: "corrupt";
}

type DeadRecord = ValidDeadRecord | CorruptDeadRecord;

interface ValidatedFile {
  path: string;
  record: StoredRecord;
}

interface StateFile {
  path: string;
  state: StateDirectory;
  stats: Stats;
}

interface RetryConfiguration {
  maxAttempts: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}

interface LockConfiguration {
  leaseMs: number;
  waitMs: number;
  clock: () => Date;
}

interface FilesystemLock {
  lockPath: string;
  ownerPath: string;
}

type FilesystemLockResult<T> =
  | { acquired: false }
  | {
      acquired: true;
      value: T;
    };

export interface LlmSettlementOutboxTestHooks {
  /** Test-only seam used to prove fail-closed behavior around file fsync. */
  fsyncFile?: () => Promise<void>;
  /** Test-only seam used to prove directory-fsync failures are surfaced. */
  fsyncDirectory?: () => Promise<void>;
  /** Test-only interleaving seam; invoked while the reservation lock is held. */
  afterExactActiveRead?: () => Promise<void>;
}

export interface DrainLlmSettlementOutboxTestHooks {
  /** Test-only interleaving seam; invoked after the unlocked candidate read. */
  afterPendingRead?: (recordId: string) => Promise<void>;
}

export interface FileLlmSettlementOutboxOptions {
  rootDir: string;
  producer: string;
  fallbackDelayMs?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  lockLeaseMs?: number;
  lockWaitMs?: number;
  clock?: () => Date;
  testHooks?: LlmSettlementOutboxTestHooks;
}

export interface DrainLlmSettlementOutboxOptions {
  rootDir: string;
  ledger: LlmLedger & LlmLedgerReserveRecovery;
  maxRecords?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  processingLeaseMs?: number;
  clock?: () => Date;
  testHooks?: DrainLlmSettlementOutboxTestHooks;
}

export interface ReadLlmSettlementOutboxMonitoringOptions {
  rootDir: string;
  maxAttempts?: number;
  /** Kept as an explicit seam so monitoring tests never depend on wall clock. */
  clock?: () => Date;
}

export interface LlmSettlementOutboxDrainResult {
  claimedCount: number;
  completedCount: number;
  retryScheduledCount: number;
  deadLetteredCount: number;
  skippedCount: number;
  reclaimedCount: number;
}

export interface LlmSettlementHandle {
  readonly recordId: string;
  readonly path: string;
  readonly reservationId?: string;
}

/**
 * A sanitized failure from the durable spool. It deliberately never retains a
 * filesystem error, request body, request key, reservation id, or file path.
 */
export class LlmSettlementOutboxError extends LlmLedgerUnavailableError {
  constructor(message = "LLM settlement outbox недоступен") {
    super(message);
    this.name = "LlmSettlementOutboxError";
  }
}

/** The first exact close payload is immutable for a reservation. */
export class LlmSettlementConflictError extends LlmSettlementOutboxError {
  constructor() {
    super("LLM settlement outbox обнаружил конфликт exact close");
    this.name = "LlmSettlementConflictError";
  }
}

/**
 * Producer-local durable storage. All writes use a temporary file, file fsync,
 * atomic rename, and directory fsync. The public handles contain no payload.
 */
export class FileLlmSettlementOutbox {
  private readonly rootDir: string;
  private readonly producerRoot: string;
  private readonly pendingDir: string;
  private readonly processingDir: string;
  private readonly deadDir: string;
  private readonly locksDir: string;
  private readonly fallbackDelayMs: number;
  private readonly retryConfiguration: RetryConfiguration;
  private readonly clock: () => Date;
  private readonly lockConfiguration: LockConfiguration;
  private readonly testHooks: LlmSettlementOutboxTestHooks;
  private layoutReady = false;
  private mutationChain: Promise<void> = Promise.resolve();

  constructor(options: FileLlmSettlementOutboxOptions) {
    const normalizedRoot = normalizedOutboxRoot(options.rootDir);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(options.producer)) {
      throw new LlmSettlementOutboxError("LLM settlement outbox producer имеет неверный формат");
    }
    this.rootDir = normalizedRoot;
    this.producerRoot = join(normalizedRoot, options.producer);
    this.pendingDir = join(this.producerRoot, "pending");
    this.processingDir = join(this.producerRoot, "processing");
    this.deadDir = join(this.producerRoot, "dead");
    this.locksDir = join(this.producerRoot, "locks");
    this.fallbackDelayMs = boundedInteger(
      options.fallbackDelayMs,
      DEFAULT_FALLBACK_DELAY_MS,
      1_000,
      24 * 60 * 60_000,
    );
    this.retryConfiguration = {
      maxAttempts: boundedInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 1_000),
      retryBaseDelayMs: boundedInteger(
        options.retryBaseDelayMs,
        DEFAULT_RETRY_BASE_DELAY_MS,
        1,
        60 * 60_000,
      ),
      retryMaxDelayMs: boundedInteger(
        options.retryMaxDelayMs,
        DEFAULT_RETRY_MAX_DELAY_MS,
        1,
        24 * 60 * 60_000,
      ),
    };
    this.clock = options.clock ?? (() => new Date());
    this.lockConfiguration = {
      leaseMs: boundedInteger(
        options.lockLeaseMs,
        DEFAULT_PROCESSING_LEASE_MS,
        1_000,
        24 * 60 * 60_000,
      ),
      waitMs: boundedInteger(options.lockWaitMs, DEFAULT_LOCK_WAIT_MS, 0, 5 * 60_000),
      clock: this.clock,
    };
    this.testHooks = options.testHooks ?? {};
  }

  /** @internal Used by DurableLlmLedger before the one-shot reserve call. */
  async persistPreReserve(requestKey: string): Promise<LlmSettlementHandle> {
    if (requestKey.trim() === "") {
      throw new LlmSettlementOutboxError("LLM settlement outbox получил пустой requestKey");
    }
    return this.withMutation(async () => {
      await this.ensureLayout();
      const now = this.clock();
      const recordId = digest(`pre-reserve:${requestKey}`);
      const path = join(this.pendingDir, `${recordId}.json`);
      return this.withRecordLock(recordId, async () => {
        if (await pathExists(join(this.deadDir, `${recordId}.json`))) {
          throw new LlmSettlementOutboxError(
            "LLM settlement outbox уже поместил reserve recovery в dead-letter",
          );
        }
        const existing = await readStoredRecordIfExists(path);
        if (existing !== null) {
          if (
            existing.kind !== "pre_reserve" ||
            existing.operation !== "recover_pre_dispatch" ||
            existing.requestKey !== requestKey
          ) {
            throw new LlmSettlementConflictError();
          }
          const refreshed: StoredRecord = {
            ...existing,
            updatedAt: now.toISOString(),
            nextAttemptAt: addMilliseconds(now, this.fallbackDelayMs).toISOString(),
            attempts: 0,
          };
          await atomicWriteRecord(path, refreshed, this.testHooks);
          return { recordId, path };
        }
        const record: StoredRecord = {
          version: RECORD_VERSION,
          recordId,
          kind: "pre_reserve",
          operation: "recover_pre_dispatch",
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          nextAttemptAt: addMilliseconds(now, this.fallbackDelayMs).toISOString(),
          attempts: 0,
          requestKey,
        };
        await atomicWriteRecord(path, record, this.testHooks);
        return { recordId, path };
      });
    });
  }

  /** @internal Converts the recovery marker to a conservative delayed close. */
  async armFallback(
    handle: LlmSettlementHandle,
    reservation: LlmReservation,
  ): Promise<LlmSettlementHandle> {
    return this.withMutation(async () => {
      return this.withRecordLock(handle.recordId, async () => {
        return this.withReservationLock(reservation.id, async () => {
          const existing = await readStoredRecord(handle.path);
          if (
            existing.recordId !== handle.recordId ||
            existing.kind !== "pre_reserve" ||
            existing.operation !== "recover_pre_dispatch" ||
            existing.requestKey !== reservation.requestKey
          ) {
            throw new LlmSettlementConflictError();
          }
          const now = this.clock();
          const record: StoredRecord = {
            version: RECORD_VERSION,
            recordId: existing.recordId,
            kind: "fallback",
            operation: "fail",
            createdAt: existing.createdAt,
            updatedAt: now.toISOString(),
            nextAttemptAt: addMilliseconds(now, this.fallbackDelayMs).toISOString(),
            attempts: 0,
            reservationId: reservation.id,
            payload: normalizeJson({ outcome: "unknown", reason: FALLBACK_REASON }),
          };
          await atomicWriteRecord(handle.path, record, this.testHooks);
          return { recordId: record.recordId, path: handle.path, reservationId: reservation.id };
        });
      });
    });
  }

  /** @internal Removes a pre-reserve marker only for a definitive denial. */
  async cancel(handle: LlmSettlementHandle): Promise<void> {
    await this.withMutation(async () => {
      await this.withRecordLock(handle.recordId, async () => {
        await unlinkAndSync(handle.path, this.testHooks);
      });
    });
  }

  /** @internal Persists or upgrades to the first immutable exact close. */
  async persistExact(
    reservationId: string,
    operation: CloseOperation,
    body: unknown,
  ): Promise<LlmSettlementHandle> {
    if (reservationId.trim() === "") {
      throw new LlmSettlementOutboxError("LLM settlement outbox получил пустой reservation id");
    }
    const payload = normalizeJson(body);
    return this.withMutation(async () => {
      await this.ensureLayout();
      return this.withReservationLock(reservationId, async () => {
        const dead = await this.findDeadReservation(reservationId);
        if (dead !== null) {
          if (dead.source.kind === "exact" && !sameExactIntent(dead.source, operation, payload)) {
            throw new LlmSettlementConflictError();
          }
          throw new LlmSettlementOutboxError(
            "LLM settlement outbox уже поместил reservation в dead-letter",
          );
        }
        const matching = await this.findActiveReservation(reservationId);
        if (matching !== null) {
          await this.testHooks.afterExactActiveRead?.();
          if (matching.record.kind === "exact") {
            if (!sameExactIntent(matching.record, operation, payload)) {
              throw new LlmSettlementConflictError();
            }
            return {
              recordId: matching.record.recordId,
              path: matching.path,
              reservationId,
            };
          }
          if (matching.path.startsWith(`${this.processingDir}/`)) {
            throw new LlmSettlementOutboxError(
              "LLM settlement outbox уже обрабатывает fallback для reservation",
            );
          }
          const now = this.clock();
          const exact: StoredRecord = {
            ...matching.record,
            kind: "exact",
            operation,
            updatedAt: now.toISOString(),
            nextAttemptAt: now.toISOString(),
            attempts: 0,
            payload,
          };
          await atomicWriteRecord(matching.path, exact, this.testHooks);
          return { recordId: exact.recordId, path: matching.path, reservationId };
        }

        const recordId = digest(`close:${reservationId}`);
        const path = join(this.pendingDir, `${recordId}.json`);
        if (await pathExists(join(this.deadDir, `${recordId}.json`))) {
          throw new LlmSettlementOutboxError(
            "LLM settlement outbox уже поместил reservation в dead-letter",
          );
        }
        const now = this.clock();
        const exact: StoredRecord = {
          version: RECORD_VERSION,
          recordId,
          kind: "exact",
          operation,
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          nextAttemptAt: now.toISOString(),
          attempts: 0,
          reservationId,
          payload,
        };
        await atomicWriteRecord(path, exact, this.testHooks);
        return { recordId, path, reservationId };
      });
    });
  }

  /** @internal Deletes a record only after confirmed Core success. */
  async acknowledge(handle: LlmSettlementHandle): Promise<void> {
    await this.withMutation(async () => {
      await this.withHandleReservationLock(handle, async () => {
        await unlinkAndSync(handle.path, this.testHooks);
        if (handle.reservationId !== undefined) {
          await this.removeDuplicateFallbacks(handle.reservationId, handle.path);
        }
      });
    });
  }

  /** @internal Schedules the identical payload after an ambiguous/transient close. */
  async retryLater(handle: LlmSettlementHandle): Promise<void> {
    await this.withMutation(async () => {
      await this.withHandleReservationLock(handle, async () => {
        const file = await readStoredRecordIfExists(handle.path);
        if (file === null) return;
        const attempts = file.attempts + 1;
        if (attempts >= this.retryConfiguration.maxAttempts) {
          await deadLetter(
            handle.path,
            file,
            "attempts_exhausted",
            this.deadDir,
            this.clock(),
            this.testHooks,
          );
          return;
        }
        const now = this.clock();
        const retry: StoredRecord = {
          ...file,
          attempts,
          updatedAt: now.toISOString(),
          nextAttemptAt: addMilliseconds(
            now,
            retryDelayMs(attempts, this.retryConfiguration),
          ).toISOString(),
        };
        await atomicWriteRecord(handle.path, retry, this.testHooks);
      });
    });
  }

  /** @internal Preserves the bounded exact intent, but never the raw transport error. */
  async rejectTerminal(handle: LlmSettlementHandle, error: LlmLedgerCloseError): Promise<void> {
    await this.withMutation(async () => {
      await this.withHandleReservationLock(handle, async () => {
        const file = await readStoredRecordIfExists(handle.path);
        if (file === null) return;
        await deadLetter(
          handle.path,
          file,
          "terminal_close",
          this.deadDir,
          this.clock(),
          this.testHooks,
          error.httpStatus,
        );
      });
    });
  }

  private async findActiveReservation(reservationId: string): Promise<ValidatedFile | null> {
    for (const directory of [this.pendingDir, this.processingDir]) {
      const entries = await safeReadDirectory(directory);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = join(directory, entry.name);
        const record = await readStoredRecordIfExists(path);
        if (record?.reservationId === reservationId) return { path, record };
      }
    }
    return null;
  }

  private async findDeadReservation(reservationId: string): Promise<ValidDeadRecord | null> {
    const entries = await safeReadDirectory(this.deadDir);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const dead = await readDeadRecordIfExists(join(this.deadDir, entry.name));
      if (dead?.state === "dead" && dead.source.reservationId === reservationId) return dead;
    }
    return null;
  }

  private async removeDuplicateFallbacks(reservationId: string, acknowledgedPath: string) {
    for (const directory of [this.pendingDir, this.processingDir]) {
      const entries = await safeReadDirectory(directory);
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = join(directory, entry.name);
        if (path === acknowledgedPath) continue;
        const record = await readStoredRecordIfExists(path);
        if (record?.reservationId === reservationId && record.kind === "fallback") {
          await unlinkAndSync(path, this.testHooks);
        }
      }
    }
  }

  private async withReservationLock<T>(
    reservationId: string,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const acquired = await withFilesystemLock(
      this.locksDir,
      reservationLockKey(reservationId),
      this.lockConfiguration,
      this.testHooks,
      mutation,
    );
    if (!acquired.acquired) {
      throw new LlmSettlementOutboxError(
        "LLM settlement outbox не смог получить lock для reservation",
      );
    }
    return acquired.value;
  }

  private async withRecordLock<T>(recordId: string, mutation: () => Promise<T>): Promise<T> {
    const acquired = await withFilesystemLock(
      this.locksDir,
      recordLockKey(recordId),
      this.lockConfiguration,
      this.testHooks,
      mutation,
    );
    if (!acquired.acquired) {
      throw new LlmSettlementOutboxError("LLM settlement outbox не смог получить lock для record");
    }
    return acquired.value;
  }

  private async withHandleReservationLock<T>(
    handle: LlmSettlementHandle,
    mutation: () => Promise<T>,
  ): Promise<T> {
    if (handle.reservationId === undefined) return mutation();
    return this.withReservationLock(handle.reservationId, mutation);
  }

  private async ensureLayout(): Promise<void> {
    if (this.layoutReady) return;
    for (const path of [
      this.rootDir,
      this.producerRoot,
      this.pendingDir,
      this.processingDir,
      this.deadDir,
      this.locksDir,
    ]) {
      await ensureDirectory(path, this.testHooks, true);
    }
    this.layoutReady = true;
  }

  private async withMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutationChain;
    let release = (): void => undefined;
    this.mutationChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  }
}

/**
 * Cross-process record/reservation lock. The owner token makes late release
 * unable to delete a successor's lock, while heartbeat + lease allow crash
 * recovery.
 */
async function withFilesystemLock<T>(
  locksDir: string,
  key: string,
  configuration: LockConfiguration,
  hooks: LlmSettlementOutboxTestHooks,
  operation: () => Promise<T>,
): Promise<FilesystemLockResult<T>> {
  const lock = await acquireFilesystemLock(locksDir, key, configuration, hooks);
  if (lock === null) return { acquired: false };

  let heartbeatStopped = false;
  const heartbeatIntervalMs = Math.max(250, Math.floor(configuration.leaseMs / 3));
  const heartbeat = setInterval(() => {
    if (heartbeatStopped) return;
    const timestamp = configuration.clock();
    void utimes(lock.ownerPath, timestamp, timestamp).catch(() => undefined);
  }, heartbeatIntervalMs);
  heartbeat.unref();

  try {
    return { acquired: true, value: await operation() };
  } finally {
    heartbeatStopped = true;
    clearInterval(heartbeat);
    await releaseFilesystemLock(lock, hooks);
  }
}

async function acquireFilesystemLock(
  locksDir: string,
  key: string,
  configuration: LockConfiguration,
  hooks: LlmSettlementOutboxTestHooks,
): Promise<FilesystemLock | null> {
  await ensureDirectory(locksDir, hooks);
  const lockPath = join(locksDir, `${digest(`lock:${key}`)}.lock`);
  const deadline = Date.now() + configuration.waitMs;

  for (;;) {
    const ownerToken = randomUUID().replaceAll("-", "");
    const ownerPath = join(lockPath, `${ownerToken}.owner`);
    let created = false;
    try {
      await mkdir(lockPath, { mode: 0o700 });
      created = true;
      await chmod(lockPath, 0o700);
      await syncDirectory(locksDir, hooks);
      await writeLockOwner(ownerPath, ownerToken, hooks);
      return { lockPath, ownerPath };
    } catch (error) {
      if (created) {
        await removeOwnedLockDirectory(lockPath, hooks).catch(() => undefined);
        throw new LlmSettlementOutboxError();
      }
      if (!isNodeError(error, "EEXIST")) {
        throw new LlmSettlementOutboxError();
      }
    }

    const reclaimed = await reclaimStaleFilesystemLock(
      lockPath,
      locksDir,
      configuration.clock(),
      configuration.leaseMs,
      hooks,
    );
    if (reclaimed) continue;
    if (Date.now() >= deadline) return null;
    await delay(Math.min(LOCK_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())));
  }
}

async function writeLockOwner(
  ownerPath: string,
  ownerToken: string,
  hooks: LlmSettlementOutboxTestHooks,
): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(ownerPath, "wx", 0o600);
    await handle.writeFile(ownerToken, "utf8");
    if (hooks.fsyncFile !== undefined) await hooks.fsyncFile();
    else await handle.sync();
    await handle.close();
    handle = null;
    await chmod(ownerPath, 0o600);
    await syncDirectory(dirname(ownerPath), hooks);
  } catch {
    if (handle !== null) await handle.close().catch(() => undefined);
    await unlink(ownerPath).catch(() => undefined);
    throw new LlmSettlementOutboxError();
  }
}

async function reclaimStaleFilesystemLock(
  lockPath: string,
  locksDir: string,
  now: Date,
  leaseMs: number,
  hooks: LlmSettlementOutboxTestHooks,
): Promise<boolean> {
  let modifiedAt: number;
  try {
    modifiedAt = await lockModifiedAt(lockPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw new LlmSettlementOutboxError();
  }
  if (modifiedAt + leaseMs > now.getTime()) return false;

  const quarantinePath = join(
    locksDir,
    `.stale-${basename(lockPath)}-${randomUUID().replaceAll("-", "")}`,
  );
  try {
    await rename(lockPath, quarantinePath);
    await syncDirectory(locksDir, hooks);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return true;
    throw new LlmSettlementOutboxError();
  }
  await removeOwnedLockDirectory(quarantinePath, hooks);
  return true;
}

async function lockModifiedAt(lockPath: string): Promise<number> {
  const entries = await readdir(lockPath, { withFileTypes: true });
  const owners = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".owner"));
  if (owners.length === 0) return (await stat(lockPath)).mtimeMs;
  let modifiedAt = 0;
  for (const owner of owners) {
    modifiedAt = Math.max(modifiedAt, (await stat(join(lockPath, owner.name))).mtimeMs);
  }
  return modifiedAt;
}

async function releaseFilesystemLock(
  lock: FilesystemLock,
  hooks: LlmSettlementOutboxTestHooks,
): Promise<void> {
  try {
    await unlink(lock.ownerPath);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw new LlmSettlementOutboxError();
  }
  try {
    await rmdir(lock.lockPath);
    await syncDirectory(dirname(lock.lockPath), hooks);
  } catch (error) {
    if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) {
      throw new LlmSettlementOutboxError();
    }
  }
}

async function removeOwnedLockDirectory(
  lockPath: string,
  hooks: LlmSettlementOutboxTestHooks,
): Promise<void> {
  const entries = await safeReadDirectory(lockPath);
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".owner")) {
      await unlink(join(lockPath, entry.name)).catch(() => undefined);
    }
  }
  try {
    await rmdir(lockPath);
    await syncDirectory(dirname(lockPath), hooks);
  } catch (error) {
    if (!isNodeError(error, "ENOENT") && !isNodeError(error, "ENOTEMPTY")) {
      throw new LlmSettlementOutboxError();
    }
  }
}

/**
 * Ledger decorator with a one-shot reserve and durable close intent. Reserve
 * never retries. A successful reserve is not returned until its conservative
 * recovery fallback is fsynced.
 */
export class DurableLlmLedger implements LlmLedger {
  constructor(
    private readonly delegate: LlmLedger,
    private readonly outbox: FileLlmSettlementOutbox,
  ) {}

  async reserve(request: LlmReserveRequest): Promise<LlmReservation> {
    const marker = await this.outbox.persistPreReserve(request.requestKey);
    let reservation: LlmReservation;
    try {
      reservation = await this.delegate.reserve(request);
    } catch (error) {
      if (error instanceof LlmBudgetDeniedError) {
        await this.outbox.cancel(marker);
      }
      throw error;
    }
    await this.outbox.armFallback(marker, reservation);
    return reservation;
  }

  async settle(reservationId: string, request: LlmSettlementRequest): Promise<void> {
    await this.close(reservationId, "settle", request, () =>
      this.delegate.settle(reservationId, request),
    );
  }

  async fail(
    reservationId: string,
    request: Omit<LlmSettlementRequest, "outcome"> & {
      outcome?: "provider_error" | "unknown";
    },
  ): Promise<void> {
    const exactRequest = { ...request, outcome: request.outcome ?? "unknown" } as const;
    await this.close(reservationId, "fail", exactRequest, () =>
      this.delegate.fail(reservationId, request),
    );
  }

  async release(reservationId: string, reason: string): Promise<void> {
    await this.close(reservationId, "release", { reason }, () =>
      this.delegate.release(reservationId, reason),
    );
  }

  private async close(
    reservationId: string,
    operation: CloseOperation,
    body: unknown,
    send: () => Promise<void>,
  ): Promise<void> {
    const handle = await this.outbox.persistExact(reservationId, operation, body);
    try {
      await send();
    } catch (error) {
      if (error instanceof LlmLedgerCloseError && !error.retryable) {
        await this.outbox.rejectTerminal(handle, error);
      } else {
        await this.outbox.retryLater(handle);
      }
      throw error;
    }
    await this.outbox.acknowledge(handle);
  }
}

/**
 * Global drain. It discovers every producer below root, reclaims expired
 * claims, and serializes each reservation across concurrent producer/drainer
 * processes before it calls recovery or idempotent close APIs.
 */
export async function drainLlmSettlementOutbox(
  options: DrainLlmSettlementOutboxOptions,
): Promise<LlmSettlementOutboxDrainResult> {
  const rootDir = normalizedOutboxRoot(options.rootDir);
  const result = emptyDrainResult();
  const clock = options.clock ?? (() => new Date());
  const now = clock();
  const processingLeaseMs = boundedInteger(
    options.processingLeaseMs,
    DEFAULT_PROCESSING_LEASE_MS,
    1_000,
    24 * 60 * 60_000,
  );
  const retryConfiguration: RetryConfiguration = {
    maxAttempts: boundedInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 1_000),
    retryBaseDelayMs: boundedInteger(
      options.retryBaseDelayMs,
      DEFAULT_RETRY_BASE_DELAY_MS,
      1,
      60 * 60_000,
    ),
    retryMaxDelayMs: boundedInteger(
      options.retryMaxDelayMs,
      DEFAULT_RETRY_MAX_DELAY_MS,
      1,
      24 * 60 * 60_000,
    ),
  };
  const maxRecords = boundedInteger(options.maxRecords, DEFAULT_MAX_RECORDS, 1, 10_000);

  if (!(await pathExists(rootDir))) return result;
  await cleanupExpiredTemporaryFiles(rootDir, now, processingLeaseMs);
  result.reclaimedCount = await reclaimExpiredProcessing(rootDir, now, processingLeaseMs);

  const pendingFiles = await collectStateFiles(rootDir, "pending");
  pendingFiles.sort((left, right) => left.path.localeCompare(right.path));
  for (const file of pendingFiles) {
    if (result.claimedCount >= maxRecords) {
      result.skippedCount += 1;
      continue;
    }

    let validated: ValidatedFile;
    try {
      validated = { path: file.path, record: await readStoredRecord(file.path) };
    } catch {
      await deadLetter(file.path, null, "corrupt", join(dirname(file.path), "..", "dead"), now, {});
      result.deadLetteredCount += 1;
      continue;
    }
    await options.testHooks?.afterPendingRead?.(validated.record.recordId);
    if (Date.parse(validated.record.nextAttemptAt) > now.getTime()) {
      result.skippedCount += 1;
      continue;
    }

    const producerRoot = dirname(dirname(validated.path));
    const expectedLockKey = storedRecordLockKey(validated.record);
    const locked = await withFilesystemLock(
      join(producerRoot, "locks"),
      expectedLockKey,
      { leaseMs: processingLeaseMs, waitMs: 0, clock },
      {},
      async () => {
        const current = await readStoredRecordIfExists(validated.path);
        if (
          current === null ||
          storedRecordLockKey(current) !== expectedLockKey ||
          Date.parse(current.nextAttemptAt) > now.getTime()
        ) {
          return false;
        }

        const claimedPath = await claimPending({ path: validated.path, record: current }, now);
        if (claimedPath === null) return false;
        result.claimedCount += 1;
        const deadDir = join(dirname(dirname(claimedPath)), "dead");
        if (current.attempts >= retryConfiguration.maxAttempts) {
          await deadLetter(claimedPath, current, "attempts_exhausted", deadDir, now, {});
          result.deadLetteredCount += 1;
          return true;
        }

        try {
          await dispatchRecord(options.ledger, current);
          await unlinkAndSync(claimedPath, {});
          result.completedCount += 1;
        } catch (error) {
          if (error instanceof LlmLedgerCloseError && !error.retryable) {
            await deadLetter(
              claimedPath,
              current,
              "terminal_close",
              deadDir,
              clock(),
              {},
              error.httpStatus,
            );
            result.deadLetteredCount += 1;
            return true;
          }
          const attempts = current.attempts + 1;
          if (attempts >= retryConfiguration.maxAttempts) {
            await deadLetter(claimedPath, current, "attempts_exhausted", deadDir, clock(), {});
            result.deadLetteredCount += 1;
            return true;
          }
          await returnForRetry(claimedPath, current, attempts, retryConfiguration, clock());
          result.retryScheduledCount += 1;
        }
        return true;
      },
    );
    if (!locked.acquired || !locked.value) {
      result.skippedCount += 1;
    }
  }
  return result;
}

/** Secret-free aggregate; this function never mutates the spool. */
export async function readLlmSettlementOutboxMonitoring(
  options: ReadLlmSettlementOutboxMonitoringOptions,
): Promise<LlmSettlementOutboxMonitoring> {
  const maxAttempts = boundedInteger(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 1, 1_000);
  // Invoke the seam so fake clocks can prove this path is deterministic even
  // though the current aggregate contains only stored timestamps.
  (options.clock ?? (() => new Date()))();
  const unavailable = monitoringSnapshot(false, maxAttempts);
  try {
    const rootDir = normalizedOutboxRoot(options.rootDir);
    const rootStats = await stat(rootDir);
    if (!rootStats.isDirectory()) return unavailable;
    const pending = await collectStateFiles(rootDir, "pending");
    const processing = await collectStateFiles(rootDir, "processing");
    const dead = await collectStateFiles(rootDir, "dead");
    const snapshot = monitoringSnapshot(true, maxAttempts);
    snapshot.processingCount = processing.length;
    snapshot.deadCount = dead.length;

    const active = [...pending, ...processing];
    for (const file of active) {
      let record: StoredRecord | null = null;
      try {
        record = await readStoredRecord(file.path);
      } catch {
        // Keep corrupt pending files visible until the drainer sanitizes them.
      }
      if (file.state === "pending") {
        if ((record?.attempts ?? 0) > 0) snapshot.retryingCount += 1;
        else snapshot.pendingCount += 1;
        const candidate = record?.createdAt ?? file.stats.mtime.toISOString();
        snapshot.oldestPendingAt = earlierIso(snapshot.oldestPendingAt, candidate);
      }
      if (record !== null) {
        snapshot.nextRetryAt = earlierIso(snapshot.nextRetryAt, record.nextAttemptAt);
        if (record.kind === "fallback") snapshot.fallbackCount += 1;
        if (record.kind === "exact") snapshot.exactCount += 1;
      }
    }
    return snapshot;
  } catch {
    return unavailable;
  }
}

async function dispatchRecord(
  ledger: LlmLedger & LlmLedgerReserveRecovery,
  record: StoredRecord,
): Promise<void> {
  if (record.kind === "pre_reserve") {
    if (record.requestKey === undefined) throw new LlmSettlementOutboxError();
    await ledger.recoverPreDispatch(record.requestKey);
    return;
  }
  if (record.reservationId === undefined || record.payload === undefined) {
    throw new LlmSettlementOutboxError();
  }
  if (record.operation === "settle") {
    await ledger.settle(record.reservationId, record.payload as unknown as LlmSettlementRequest);
    return;
  }
  if (record.operation === "fail") {
    await ledger.fail(
      record.reservationId,
      record.payload as unknown as Omit<LlmSettlementRequest, "outcome"> & {
        outcome?: "provider_error" | "unknown";
      },
    );
    return;
  }
  if (record.operation === "release") {
    const reason = isJsonObject(record.payload) ? record.payload.reason : undefined;
    if (typeof reason !== "string") throw new LlmSettlementOutboxError();
    await ledger.release(record.reservationId, reason);
    return;
  }
  throw new LlmSettlementOutboxError();
}

async function claimPending(file: ValidatedFile, now: Date): Promise<string | null> {
  const pendingDir = dirname(file.path);
  const producerRoot = dirname(pendingDir);
  const processingDir = join(producerRoot, "processing");
  await ensureDirectory(processingDir, {});
  const claimToken = `${now.getTime().toString(36)}-${randomUUID().replaceAll("-", "")}`;
  const claimedPath = join(processingDir, `${file.record.recordId}--claim-${claimToken}.json`);
  try {
    await rename(file.path, claimedPath);
    await syncDirectory(pendingDir, {});
    await syncDirectory(processingDir, {});
    return claimedPath;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw new LlmSettlementOutboxError();
  }
}

async function reclaimExpiredProcessing(
  rootDir: string,
  now: Date,
  processingLeaseMs: number,
): Promise<number> {
  let reclaimed = 0;
  const files = await collectStateFiles(rootDir, "processing");
  for (const file of files) {
    const claimTimestamp = parseClaimTimestamp(basename(file.path));
    const startedAt = claimTimestamp ?? file.stats.mtimeMs;
    if (startedAt + processingLeaseMs > now.getTime()) continue;
    let candidate: StoredRecord;
    try {
      candidate = await readStoredRecord(file.path);
    } catch {
      await deadLetter(file.path, null, "corrupt", join(dirname(file.path), "..", "dead"), now, {});
      continue;
    }
    const producerRoot = dirname(dirname(file.path));
    const expectedLockKey = storedRecordLockKey(candidate);
    const locked = await withFilesystemLock(
      join(producerRoot, "locks"),
      expectedLockKey,
      { leaseMs: processingLeaseMs, waitMs: 0, clock: () => new Date(now) },
      {},
      async () => {
        const record = await readStoredRecordIfExists(file.path);
        if (record === null || storedRecordLockKey(record) !== expectedLockKey) return false;
        const currentStats = await stat(file.path);
        const currentClaimTimestamp = parseClaimTimestamp(basename(file.path));
        const currentStartedAt = currentClaimTimestamp ?? currentStats.mtimeMs;
        if (currentStartedAt + processingLeaseMs > now.getTime()) return false;

        const pendingDir = join(producerRoot, "pending");
        await ensureDirectory(pendingDir, {});
        const pendingPath = join(pendingDir, `${record.recordId}.json`);
        if (await pathExists(pendingPath)) {
          const pendingRecord = await readStoredRecordIfExists(pendingPath);
          if (pendingRecord !== null && sameStoredIntent(pendingRecord, record)) {
            await unlinkAndSync(file.path, {});
            return true;
          }
          await deadLetter(
            file.path,
            record,
            "exact_conflict",
            join(producerRoot, "dead"),
            now,
            {},
          );
          return false;
        }
        try {
          await rename(file.path, pendingPath);
          await syncDirectory(dirname(file.path), {});
          await syncDirectory(pendingDir, {});
          return true;
        } catch (error) {
          if (!isNodeError(error, "ENOENT")) throw new LlmSettlementOutboxError();
          return false;
        }
      },
    );
    if (locked.acquired && locked.value) reclaimed += 1;
  }
  return reclaimed;
}

async function returnForRetry(
  claimedPath: string,
  record: StoredRecord,
  attempts: number,
  configuration: RetryConfiguration,
  now: Date,
): Promise<void> {
  const updated: StoredRecord = {
    ...record,
    attempts,
    updatedAt: now.toISOString(),
    nextAttemptAt: addMilliseconds(now, retryDelayMs(attempts, configuration)).toISOString(),
  };
  await atomicWriteRecord(claimedPath, updated, {});
  const processingDir = dirname(claimedPath);
  const pendingDir = join(dirname(processingDir), "pending");
  await ensureDirectory(pendingDir, {});
  const pendingPath = join(pendingDir, `${record.recordId}.json`);
  if (await pathExists(pendingPath)) {
    const pending = await readStoredRecordIfExists(pendingPath);
    if (pending !== null && sameStoredIntent(pending, updated)) {
      await unlinkAndSync(claimedPath, {});
      return;
    }
    await deadLetter(
      claimedPath,
      updated,
      "exact_conflict",
      join(dirname(processingDir), "dead"),
      now,
      {},
    );
    return;
  }
  try {
    await rename(claimedPath, pendingPath);
    await syncDirectory(processingDir, {});
    await syncDirectory(pendingDir, {});
  } catch {
    throw new LlmSettlementOutboxError();
  }
}

async function deadLetter(
  sourcePath: string,
  record: StoredRecord | null,
  category: DeadCategory,
  deadDir: string,
  now: Date,
  hooks: LlmSettlementOutboxTestHooks,
  httpStatus?: number,
): Promise<void> {
  await ensureDirectory(deadDir, hooks);
  const fallbackId = digest(`corrupt:${basename(sourcePath)}`);
  if ((record === null) !== (category === "corrupt")) {
    throw new LlmSettlementOutboxError();
  }
  const deadRecord: DeadRecord =
    record === null
      ? {
          version: RECORD_VERSION,
          state: "corrupt",
          recordId: fallbackId,
          deadAt: now.toISOString(),
          category: "corrupt",
        }
      : {
          version: RECORD_VERSION,
          state: "dead",
          source: record,
          deadAt: now.toISOString(),
          category: category as Exclude<DeadCategory, "corrupt">,
          ...(httpStatus === undefined ? {} : { httpStatus }),
        };
  const deadPath = join(
    deadDir,
    `${deadRecord.state === "dead" ? deadRecord.source.recordId : deadRecord.recordId}.json`,
  );
  await atomicWriteDeadRecord(deadPath, deadRecord, hooks);
  await unlinkAndSync(sourcePath, hooks);
}

async function atomicWriteRecord(
  path: string,
  record: StoredRecord,
  hooks: LlmSettlementOutboxTestHooks,
): Promise<void> {
  const checksum = digest(canonicalJson(record));
  await atomicWrite(
    path,
    canonicalJson({ record, checksum }),
    hooks,
    MAX_RECORD_BYTES - DEAD_METADATA_RESERVE_BYTES,
  );
}

async function atomicWriteDeadRecord(
  path: string,
  record: DeadRecord,
  hooks: LlmSettlementOutboxTestHooks,
): Promise<void> {
  const checksum = digest(canonicalJson(record));
  await atomicWrite(path, canonicalJson({ record, checksum }), hooks, MAX_RECORD_BYTES);
}

async function atomicWrite(
  path: string,
  contents: string,
  hooks: LlmSettlementOutboxTestHooks,
  maxBytes: number,
): Promise<void> {
  const bytes = Buffer.byteLength(contents, "utf8");
  if (bytes > maxBytes) {
    throw new LlmSettlementOutboxError("LLM settlement outbox record превышает 64 KiB");
  }
  const directory = dirname(path);
  await ensureDirectory(directory, hooks);
  const temporaryPath = join(directory, `.tmp-${randomUUID()}`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    if (hooks.fsyncFile !== undefined) await hooks.fsyncFile();
    else await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
    await syncDirectory(directory, hooks);
  } catch {
    if (handle !== null) await handle.close().catch(() => undefined);
    await unlink(temporaryPath).catch(() => undefined);
    throw new LlmSettlementOutboxError();
  }
}

async function syncDirectory(
  directory: string,
  hooks: LlmSettlementOutboxTestHooks,
): Promise<void> {
  if (hooks.fsyncDirectory !== undefined) {
    await hooks.fsyncDirectory();
    return;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function unlinkAndSync(path: string, hooks: LlmSettlementOutboxTestHooks): Promise<void> {
  try {
    await unlink(path);
    await syncDirectory(dirname(path), hooks);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw new LlmSettlementOutboxError();
  }
}

async function ensureDirectory(
  path: string,
  hooks: LlmSettlementOutboxTestHooks,
  syncExistingParent = false,
): Promise<void> {
  const missing: string[] = [];
  let cursor = path;
  try {
    for (;;) {
      try {
        const current = await stat(cursor);
        if (!current.isDirectory()) throw new LlmSettlementOutboxError();
        break;
      } catch (error) {
        if (!isNodeError(error, "ENOENT")) throw error;
        missing.push(cursor);
        const parent = dirname(cursor);
        if (parent === cursor) throw new LlmSettlementOutboxError();
        cursor = parent;
      }
    }

    if (missing.length === 0 && syncExistingParent) {
      await syncDirectory(dirname(path), hooks);
    }
    for (const directory of missing.reverse()) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, "EEXIST")) throw error;
        const current = await stat(directory);
        if (!current.isDirectory()) throw new LlmSettlementOutboxError();
      }
      await chmod(directory, 0o700);
      // A directory entry is not durable until its parent directory is fsynced.
      await syncDirectory(dirname(directory), hooks);
    }
    await chmod(path, 0o700);
  } catch {
    throw new LlmSettlementOutboxError();
  }
}

async function readStoredRecord(path: string): Promise<StoredRecord> {
  const fileStats = await stat(path);
  if (!fileStats.isFile() || fileStats.size > MAX_RECORD_BYTES) {
    throw new LlmSettlementOutboxError("LLM settlement outbox record повреждён");
  }
  const contents = await readFile(path, "utf8");
  return decodeStoredRecord(contents);
}

async function readStoredRecordIfExists(path: string): Promise<StoredRecord | null> {
  try {
    return await readStoredRecord(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function readDeadRecordIfExists(path: string): Promise<DeadRecord | null> {
  try {
    const fileStats = await stat(path);
    if (!fileStats.isFile() || fileStats.size > MAX_RECORD_BYTES) {
      throw new LlmSettlementOutboxError("LLM settlement outbox dead record повреждён");
    }
    return decodeDeadRecord(await readFile(path, "utf8"));
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return null;
    throw error;
  }
}

async function decodeStoredRecord(contents: string): Promise<StoredRecord> {
  if (Buffer.byteLength(contents, "utf8") > MAX_RECORD_BYTES) {
    throw new LlmSettlementOutboxError("LLM settlement outbox record повреждён");
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new LlmSettlementOutboxError("LLM settlement outbox record повреждён");
  }
  if (!isJsonObject(value) || !isStoredRecord(value.record) || typeof value.checksum !== "string") {
    throw new LlmSettlementOutboxError("LLM settlement outbox record повреждён");
  }
  if (!constantTimeTextEqual(value.checksum, digest(canonicalJson(value.record)))) {
    throw new LlmSettlementOutboxError("LLM settlement outbox checksum не совпал");
  }
  return value.record;
}

function decodeDeadRecord(contents: string): DeadRecord {
  if (Buffer.byteLength(contents, "utf8") > MAX_RECORD_BYTES) {
    throw new LlmSettlementOutboxError("LLM settlement outbox dead record повреждён");
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new LlmSettlementOutboxError("LLM settlement outbox dead record повреждён");
  }
  if (!isJsonObject(value) || !isDeadRecord(value.record) || typeof value.checksum !== "string") {
    throw new LlmSettlementOutboxError("LLM settlement outbox dead record повреждён");
  }
  if (!constantTimeTextEqual(value.checksum, digest(canonicalJson(value.record)))) {
    throw new LlmSettlementOutboxError("LLM settlement outbox dead checksum не совпал");
  }
  return value.record;
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isJsonObject(value)) return false;
  if (
    value.version !== RECORD_VERSION ||
    typeof value.recordId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.recordId) ||
    !isRecordKind(value.kind) ||
    !isRecordOperation(value.operation) ||
    typeof value.createdAt !== "string" ||
    !isIsoTimestamp(value.createdAt) ||
    typeof value.updatedAt !== "string" ||
    !isIsoTimestamp(value.updatedAt) ||
    typeof value.nextAttemptAt !== "string" ||
    !isIsoTimestamp(value.nextAttemptAt) ||
    !Number.isInteger(value.attempts) ||
    (value.attempts as number) < 0
  ) {
    return false;
  }
  if (value.kind === "pre_reserve") {
    return (
      value.operation === "recover_pre_dispatch" &&
      typeof value.requestKey === "string" &&
      value.requestKey !== "" &&
      value.reservationId === undefined &&
      value.payload === undefined
    );
  }
  if (
    typeof value.reservationId !== "string" ||
    value.reservationId === "" ||
    value.requestKey !== undefined ||
    value.payload === undefined
  ) {
    return false;
  }
  if (value.kind === "fallback") {
    return value.operation === "fail" && isFallbackPayload(value.payload);
  }
  return value.operation !== "recover_pre_dispatch" && isValidExactPayload(value);
}

function isDeadRecord(value: unknown): value is DeadRecord {
  if (
    !isJsonObject(value) ||
    value.version !== RECORD_VERSION ||
    typeof value.deadAt !== "string" ||
    !isIsoTimestamp(value.deadAt)
  ) {
    return false;
  }
  if (value.state === "corrupt") {
    return (
      value.category === "corrupt" &&
      typeof value.recordId === "string" &&
      /^[a-f0-9]{64}$/.test(value.recordId)
    );
  }
  return (
    value.state === "dead" &&
    value.category !== "corrupt" &&
    isDeadCategory(value.category) &&
    isStoredRecord(value.source) &&
    (value.httpStatus === undefined ||
      (Number.isInteger(value.httpStatus) &&
        (value.httpStatus as number) >= 100 &&
        (value.httpStatus as number) <= 599))
  );
}

function isValidExactPayload(record: Record<string, unknown>): boolean {
  if (record.operation === "release") {
    return isJsonObject(record.payload) && typeof record.payload.reason === "string";
  }
  return isJsonObject(record.payload);
}

function isFallbackPayload(value: unknown): boolean {
  return (
    isJsonObject(value) &&
    value.outcome === "unknown" &&
    value.reason === FALLBACK_REASON &&
    Object.keys(value).length === 2
  );
}

async function collectStateFiles(
  rootDir: string,
  targetState: StateDirectory,
): Promise<StateFile[]> {
  const files: StateFile[] = [];
  await walk(rootDir);
  return files;

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    if (basename(directory) === targetState) {
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const path = join(directory, entry.name);
        files.push({ path, state: targetState, stats: await stat(path) });
      }
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (
        entry.name === "locks" ||
        entry.name.startsWith(".stale-") ||
        (isStateDirectory(entry.name) && entry.name !== targetState)
      ) {
        continue;
      }
      await walk(join(directory, entry.name));
    }
  }
}

async function cleanupExpiredTemporaryFiles(
  rootDir: string,
  now: Date,
  leaseMs: number,
): Promise<void> {
  const temporaryFiles: Array<{ path: string; stats: Stats }> = [];
  await walk(rootDir);
  for (const file of temporaryFiles) {
    if (file.stats.mtimeMs + leaseMs > now.getTime()) continue;
    await unlinkAndSync(file.path, {});
  }

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (entry.name === "locks" || entry.name.startsWith(".stale-")) continue;
        await walk(join(directory, entry.name));
        continue;
      }
      if (!entry.isFile() || !entry.name.startsWith(".tmp-")) continue;
      const path = join(directory, entry.name);
      temporaryFiles.push({ path, stats: await stat(path) });
    }
  }
}

async function safeReadDirectory(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw new LlmSettlementOutboxError();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return false;
    throw new LlmSettlementOutboxError();
  }
}

function sameExactIntent(
  record: StoredRecord,
  operation: CloseOperation,
  payload: JsonValue,
): boolean {
  return record.operation === operation && canonicalJson(record.payload) === canonicalJson(payload);
}

function sameStoredIntent(left: StoredRecord, right: StoredRecord): boolean {
  return (
    left.recordId === right.recordId &&
    left.kind === right.kind &&
    left.operation === right.operation &&
    left.requestKey === right.requestKey &&
    left.reservationId === right.reservationId &&
    canonicalJson(left.payload ?? null) === canonicalJson(right.payload ?? null)
  );
}

function reservationLockKey(reservationId: string): string {
  return `reservation:${reservationId}`;
}

function recordLockKey(recordId: string): string {
  return `record:${recordId}`;
}

function storedRecordLockKey(record: StoredRecord): string {
  return record.reservationId === undefined
    ? recordLockKey(record.recordId)
    : reservationLockKey(record.reservationId);
}

function normalizeJson(value: unknown): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError("undefined");
    return JSON.parse(serialized) as JsonValue;
  } catch {
    throw new LlmSettlementOutboxError("LLM settlement outbox не смог сериализовать payload");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new LlmSettlementOutboxError();
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  throw new LlmSettlementOutboxError();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function retryDelayMs(attempts: number, configuration: RetryConfiguration): number {
  const exponent = Math.min(Math.max(attempts - 1, 0), 30);
  return Math.min(configuration.retryBaseDelayMs * 2 ** exponent, configuration.retryMaxDelayMs);
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || !Number.isInteger(value)) return fallback;
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizedOutboxRoot(value: string): string {
  if (value.trim() === "" || !isAbsolute(value)) {
    throw new LlmSettlementOutboxError("LLM settlement outbox root не настроен");
  }
  const normalized = resolve(value);
  if (parse(normalized).root === normalized) {
    throw new LlmSettlementOutboxError("LLM settlement outbox root слишком широкий");
  }
  return normalized;
}

function monitoringSnapshot(
  available: boolean,
  maxAttempts: number,
): LlmSettlementOutboxMonitoring {
  return {
    available,
    pendingCount: 0,
    retryingCount: 0,
    processingCount: 0,
    deadCount: 0,
    fallbackCount: 0,
    exactCount: 0,
    oldestPendingAt: null,
    nextRetryAt: null,
    maxAttempts,
  };
}

function emptyDrainResult(): LlmSettlementOutboxDrainResult {
  return {
    claimedCount: 0,
    completedCount: 0,
    retryScheduledCount: 0,
    deadLetteredCount: 0,
    skippedCount: 0,
    reclaimedCount: 0,
  };
}

function earlierIso(current: string | null, candidate: string): string {
  if (current === null) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

function addMilliseconds(date: Date, milliseconds: number): Date {
  return new Date(date.getTime() + milliseconds);
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  });
}

function parseClaimTimestamp(filename: string): number | null {
  const match = /--claim-([a-z0-9]+)-[a-f0-9]+\.json$/i.exec(filename);
  if (match?.[1] === undefined) return null;
  const parsed = Number.parseInt(match[1], 36);
  return Number.isFinite(parsed) ? parsed : null;
}

function isIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isRecordKind(value: unknown): value is RecordKind {
  return value === "pre_reserve" || value === "fallback" || value === "exact";
}

function isRecordOperation(value: unknown): value is RecordOperation {
  return (
    value === "recover_pre_dispatch" ||
    value === "settle" ||
    value === "fail" ||
    value === "release"
  );
}

function isStateDirectory(value: string): value is StateDirectory {
  return value === "pending" || value === "processing" || value === "dead";
}

function isDeadCategory(value: unknown): value is DeadCategory {
  return (
    value === "attempts_exhausted" ||
    value === "corrupt" ||
    value === "exact_conflict" ||
    value === "terminal_close"
  );
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
