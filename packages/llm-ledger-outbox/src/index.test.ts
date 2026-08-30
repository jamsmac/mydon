import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import {
  LlmBudgetDeniedError,
  LlmLedgerCloseError,
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  type LlmBudgetSnapshot,
  type LlmLedger,
  type LlmLedgerReserveRecovery,
  type LlmReservation,
  type LlmReserveRequest,
  type LlmSettlementRequest,
} from "@mydon/shared";

import {
  drainLlmSettlementOutbox,
  DurableLlmLedger,
  FileLlmSettlementOutbox,
  LlmSettlementConflictError,
  LlmSettlementOutboxError,
  readLlmSettlementOutboxMonitoring,
  type LlmSettlementHandle,
} from "./index";

const INITIAL_TIME = new Date("2026-08-30T12:00:00.000Z");

class FakeLedger implements LlmLedger, LlmLedgerReserveRecovery {
  reserveCalls = 0;
  settleCalls = 0;
  failCalls = 0;
  releaseCalls = 0;
  recoveryCalls: string[] = [];
  reserveImpl: (request: LlmReserveRequest) => Promise<LlmReservation> = async (request) =>
    reservation(request.requestKey);
  settleImpl: (reservationId: string, request: LlmSettlementRequest) => Promise<void> = async () =>
    undefined;
  failImpl: (
    reservationId: string,
    request: Omit<LlmSettlementRequest, "outcome"> & {
      outcome?: "provider_error" | "unknown";
    },
  ) => Promise<void> = async () => undefined;
  releaseImpl: (reservationId: string, reason: string) => Promise<void> = async () => undefined;
  recoveryImpl: (requestKey: string) => Promise<void> = async () => undefined;

  async reserve(request: LlmReserveRequest): Promise<LlmReservation> {
    this.reserveCalls += 1;
    return this.reserveImpl(request);
  }

  async settle(reservationId: string, request: LlmSettlementRequest): Promise<void> {
    this.settleCalls += 1;
    await this.settleImpl(reservationId, request);
  }

  async fail(
    reservationId: string,
    request: Omit<LlmSettlementRequest, "outcome"> & {
      outcome?: "provider_error" | "unknown";
    },
  ): Promise<void> {
    this.failCalls += 1;
    await this.failImpl(reservationId, request);
  }

  async release(reservationId: string, reason: string): Promise<void> {
    this.releaseCalls += 1;
    await this.releaseImpl(reservationId, reason);
  }

  async recoverPreDispatch(requestKey: string): Promise<void> {
    this.recoveryCalls.push(requestKey);
    await this.recoveryImpl(requestKey);
  }
}

test("reserve persists before dispatch and arms fallback before returning", async (t) => {
  const rootDir = await temporaryRoot(t);
  const events: string[] = [];
  const clock = fixedClock(INITIAL_TIME);
  const store = new FileLlmSettlementOutbox({
    rootDir,
    producer: "bot",
    clock,
    testHooks: {
      fsyncFile: async () => {
        events.push("file-fsync");
      },
      fsyncDirectory: async () => {
        events.push("dir-fsync");
      },
    },
  });
  const delegate = new FakeLedger();
  delegate.reserveImpl = async (request) => {
    events.push("delegate-reserve");
    const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
    assert.equal(monitoring.pendingCount, 1);
    assert.equal(monitoring.fallbackCount, 0);
    return reservation(request.requestKey);
  };

  const result = await new DurableLlmLedger(delegate, store).reserve(reserveRequest("request-1"));

  assert.equal(result.id, "reservation-request-1");
  const delegateIndex = events.indexOf("delegate-reserve");
  assert.ok(delegateIndex > 0);
  assert.ok(events.slice(0, delegateIndex).includes("file-fsync"));
  assert.ok(events.slice(delegateIndex + 1).includes("file-fsync"));
  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.pendingCount, 1);
  assert.equal(monitoring.fallbackCount, 1);
  assert.equal(monitoring.exactCount, 0);

  const pendingDir = join(rootDir, "bot", "pending");
  const [filename] = await readdir(pendingDir);
  assert.ok(filename);
  assert.equal((await stat(pendingDir)).mode & 0o777, 0o700);
  assert.equal((await stat(join(pendingDir, filename))).mode & 0o777, 0o600);
});

test("file fsync failure prevents reserve dispatch", async (t) => {
  const rootDir = await temporaryRoot(t);
  const delegate = new FakeLedger();
  const store = new FileLlmSettlementOutbox({
    rootDir,
    producer: "cc",
    testHooks: {
      fsyncFile: async () => {
        throw new Error("raw filesystem details must not escape");
      },
    },
  });

  await assert.rejects(
    new DurableLlmLedger(delegate, store).reserve(reserveRequest("request-fsync")),
    (error: unknown) =>
      error instanceof LlmSettlementOutboxError &&
      !error.message.includes("raw filesystem details"),
  );
  assert.equal(delegate.reserveCalls, 0);
  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir });
  assert.equal(monitoring.pendingCount, 0);
});

test("definitive budget denial cancels pre-reserve recovery", async (t) => {
  const rootDir = await temporaryRoot(t);
  const delegate = new FakeLedger();
  delegate.reserveImpl = async () => {
    throw new LlmBudgetDeniedError("pause", "budget exhausted", budget());
  };
  const ledger = new DurableLlmLedger(
    delegate,
    new FileLlmSettlementOutbox({ rootDir, producer: "agents" }),
  );

  await assert.rejects(ledger.reserve(reserveRequest("request-denied")), LlmBudgetDeniedError);
  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir });
  assert.equal(monitoring.pendingCount, 0);
  assert.equal(monitoring.fallbackCount, 0);
});

test("replay-blocked reserve keeps the sole recovery marker", async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = new Date(INITIAL_TIME);
  const clock = () => new Date(now);
  const delegate = new FakeLedger();
  delegate.reserveImpl = async (request) => {
    throw new LlmReplayBlockedError(request.requestKey);
  };
  const ledger = new DurableLlmLedger(
    delegate,
    new FileLlmSettlementOutbox({
      rootDir,
      producer: "agents",
      fallbackDelayMs: 1_000,
      clock,
    }),
  );

  await assert.rejects(ledger.reserve(reserveRequest("request-replay")), LlmReplayBlockedError);
  let monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.pendingCount, 1);

  now = new Date(INITIAL_TIME.getTime() + 1_001);
  const result = await drainLlmSettlementOutbox({ rootDir, ledger: delegate, clock });
  assert.equal(result.completedCount, 1);
  assert.deepEqual(delegate.recoveryCalls, ["request-replay"]);
  monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.pendingCount, 0);
});

test("exact close is durable before delegate call and acknowledged only after success", async (t) => {
  const rootDir = await temporaryRoot(t);
  const events: string[] = [];
  const store = new FileLlmSettlementOutbox({
    rootDir,
    producer: "documents",
    testHooks: {
      fsyncFile: async () => {
        events.push("file-fsync");
      },
      fsyncDirectory: async () => {
        events.push("dir-fsync");
      },
    },
  });
  const delegate = new FakeLedger();
  delegate.settleImpl = async () => {
    events.push("delegate-settle");
    const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir });
    assert.equal(monitoring.exactCount, 1);
  };
  const ledger = new DurableLlmLedger(delegate, store);

  await ledger.settle("reservation-exact", settlement("secret-result"));

  const delegateIndex = events.indexOf("delegate-settle");
  assert.ok(delegateIndex >= 2);
  const eventsBeforeDelegate = events.slice(0, delegateIndex);
  const fileFsyncIndex = eventsBeforeDelegate.lastIndexOf("file-fsync");
  assert.ok(fileFsyncIndex >= 0);
  assert.ok(eventsBeforeDelegate.slice(fileFsyncIndex + 1).includes("dir-fsync"));
  assert.equal(delegate.settleCalls, 1);
  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir });
  assert.equal(monitoring.pendingCount, 0);
  assert.equal(monitoring.exactCount, 0);
});

test("transient close survives decorator restart and is drained with identical intent", async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = new Date(INITIAL_TIME);
  const clock = () => new Date(now);
  const firstDelegate = new FakeLedger();
  firstDelegate.settleImpl = async () => {
    throw new LlmLedgerCloseError("temporary", true, 503);
  };
  const firstLedger = new DurableLlmLedger(
    firstDelegate,
    new FileLlmSettlementOutbox({
      rootDir,
      producer: "bot",
      clock,
      retryBaseDelayMs: 1_000,
    }),
  );
  const request = settlement("restart-secret");

  await assert.rejects(firstLedger.settle("reservation-restart", request), LlmLedgerCloseError);
  let monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.retryingCount, 1);
  assert.equal(monitoring.exactCount, 1);

  now = new Date(INITIAL_TIME.getTime() + 1_001);
  const restartedDelegate = new FakeLedger();
  restartedDelegate.settleImpl = async (reservationId, retriedRequest) => {
    assert.equal(reservationId, "reservation-restart");
    assert.deepEqual(retriedRequest, request);
  };
  const result = await drainLlmSettlementOutbox({
    rootDir,
    ledger: restartedDelegate,
    clock,
  });

  assert.equal(result.claimedCount, 1);
  assert.equal(result.completedCount, 1);
  assert.equal(result.retryScheduledCount, 0);
  assert.equal(restartedDelegate.settleCalls, 1);
  monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.pendingCount, 0);
  assert.equal(monitoring.retryingCount, 0);
  assert.equal(monitoring.processingCount, 0);
});

test("terminal typed close preserves bounded intent but never raw error", async (t) => {
  const rootDir = await temporaryRoot(t);
  const delegate = new FakeLedger();
  delegate.settleImpl = async () => {
    throw new LlmLedgerCloseError("terminal response body must not be stored", false, 409);
  };
  const ledger = new DurableLlmLedger(
    delegate,
    new FileLlmSettlementOutbox({ rootDir, producer: "cc" }),
  );

  await assert.rejects(
    ledger.settle("reservation-dead-secret", settlement("payload-dead-secret")),
    LlmLedgerCloseError,
  );

  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir });
  assert.equal(monitoring.deadCount, 1);
  assert.equal(monitoring.pendingCount, 0);
  const deadDir = join(rootDir, "cc", "dead");
  const [filename] = await readdir(deadDir);
  assert.ok(filename);
  const deadContents = await readFile(join(deadDir, filename), "utf8");
  assert.ok(deadContents.includes("payload-dead-secret"));
  assert.ok(deadContents.includes("reservation-dead-secret"));
  assert.ok(!deadContents.includes("terminal response body"));
  assert.match(deadContents, /"httpStatus":409/);
});

test("ambiguous reserve is recovered before any provider dispatch", async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = new Date(INITIAL_TIME);
  const clock = () => new Date(now);
  const delegate = new FakeLedger();
  delegate.reserveImpl = async () => {
    throw new LlmLedgerUnavailableError("ambiguous reserve");
  };
  const ledger = new DurableLlmLedger(
    delegate,
    new FileLlmSettlementOutbox({
      rootDir,
      producer: "agents",
      fallbackDelayMs: 1_000,
      clock,
    }),
  );

  await assert.rejects(
    ledger.reserve(reserveRequest("request-ambiguous")),
    LlmLedgerUnavailableError,
  );
  let drainResult = await drainLlmSettlementOutbox({ rootDir, ledger: delegate, clock });
  assert.equal(drainResult.claimedCount, 0);
  assert.deepEqual(delegate.recoveryCalls, []);

  now = new Date(INITIAL_TIME.getTime() + 1_001);
  drainResult = await drainLlmSettlementOutbox({ rootDir, ledger: delegate, clock });
  assert.equal(drainResult.completedCount, 1);
  assert.deepEqual(delegate.recoveryCalls, ["request-ambiguous"]);
  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.pendingCount, 0);
});

test("successful reserve fallback waits for grace period then only fails unknown", async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = new Date(INITIAL_TIME);
  const clock = () => new Date(now);
  const delegate = new FakeLedger();
  const ledger = new DurableLlmLedger(
    delegate,
    new FileLlmSettlementOutbox({
      rootDir,
      producer: "bot",
      fallbackDelayMs: 1_000,
      clock,
    }),
  );
  await ledger.reserve(reserveRequest("request-fallback"));

  let result = await drainLlmSettlementOutbox({ rootDir, ledger: delegate, clock });
  assert.equal(result.claimedCount, 0);
  assert.equal(delegate.failCalls, 0);
  assert.equal(delegate.reserveCalls, 1);

  now = new Date(INITIAL_TIME.getTime() + 1_001);
  delegate.failImpl = async (reservationId, request) => {
    assert.equal(reservationId, "reservation-request-fallback");
    assert.deepEqual(request, {
      outcome: "unknown",
      reason: "settlement_outbox_fallback",
    });
  };
  result = await drainLlmSettlementOutbox({ rootDir, ledger: delegate, clock });
  assert.equal(result.completedCount, 1);
  assert.equal(delegate.failCalls, 1);
  // The drainer has no code path to reserve or dispatch a provider request.
  assert.equal(delegate.reserveCalls, 1);
});

test("max-attempt fallback dead keeps intent and blocks a second exact record", async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = new Date(INITIAL_TIME);
  const clock = () => new Date(now);
  const delegate = new FakeLedger();
  delegate.failImpl = async () => {
    throw new LlmLedgerCloseError("transient body must not enter dead", true, 503);
  };
  const store = new FileLlmSettlementOutbox({
    rootDir,
    producer: "bot",
    fallbackDelayMs: 1_000,
    maxAttempts: 1,
    clock,
  });
  await new DurableLlmLedger(delegate, store).reserve(reserveRequest("request-fallback-dead"));
  now = new Date(INITIAL_TIME.getTime() + 1_001);

  const result = await drainLlmSettlementOutbox({
    rootDir,
    ledger: delegate,
    maxAttempts: 1,
    clock,
  });

  assert.equal(result.deadLetteredCount, 1);
  const deadDir = join(rootDir, "bot", "dead");
  const [filename] = await readdir(deadDir);
  assert.ok(filename);
  const deadContents = await readFile(join(deadDir, filename), "utf8");
  assert.ok(deadContents.includes("reservation-request-fallback-dead"));
  assert.ok(deadContents.includes("settlement_outbox_fallback"));
  assert.ok(!deadContents.includes("transient body"));

  await assert.rejects(
    store.persistExact("reservation-request-fallback-dead", "settle", settlement("late-exact")),
    LlmSettlementOutboxError,
  );
  assert.equal((await readdir(deadDir)).length, 1);
  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.deadCount, 1);
  assert.equal(monitoring.exactCount, 0);
});

test("checksum mismatch is dead-lettered without recovery call", async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = new Date(INITIAL_TIME);
  const clock = () => new Date(now);
  const store = new FileLlmSettlementOutbox({
    rootDir,
    producer: "bot",
    fallbackDelayMs: 1_000,
    clock,
  });
  const handle = await store.persistPreReserve("request-corrupt");
  const valid = await readFile(handle.path, "utf8");
  await writeFile(handle.path, valid.replace("request-corrupt", "request-tampered"), "utf8");
  now = new Date(INITIAL_TIME.getTime() + 1_001);
  const delegate = new FakeLedger();

  const result = await drainLlmSettlementOutbox({ rootDir, ledger: delegate, clock });

  assert.equal(result.deadLetteredCount, 1);
  assert.equal(result.claimedCount, 0);
  assert.deepEqual(delegate.recoveryCalls, []);
  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.deadCount, 1);
  assert.equal(monitoring.pendingCount, 0);
  const [deadFilename] = await readdir(join(rootDir, "bot", "dead"));
  assert.ok(deadFilename);
  const deadContents = await readFile(join(rootDir, "bot", "dead", deadFilename), "utf8");
  assert.ok(!deadContents.includes("request-corrupt"));
  assert.ok(!deadContents.includes("request-tampered"));
});

test("first exact intent is immutable on conflict", async (t) => {
  const rootDir = await temporaryRoot(t);
  const store = new FileLlmSettlementOutbox({ rootDir, producer: "documents" });
  const first = await store.persistExact(
    "reservation-conflict",
    "settle",
    settlement("first-payload"),
  );
  const before = await readFile(first.path, "utf8");

  await assert.rejects(
    store.persistExact("reservation-conflict", "release", { reason: "different-payload" }),
    LlmSettlementConflictError,
  );

  assert.equal(await readFile(first.path, "utf8"), before);
  const same = await store.persistExact(
    "reservation-conflict",
    "settle",
    settlement("first-payload"),
  );
  assert.equal(same.path, first.path);
});

test("drainer re-reads exact under lock instead of dispatching a stale fallback", async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = new Date(INITIAL_TIME);
  const clock = () => new Date(now);
  const store = new FileLlmSettlementOutbox({
    rootDir,
    producer: "bot",
    fallbackDelayMs: 1_000,
    clock,
  });
  const reserveDelegate = new FakeLedger();
  await new DurableLlmLedger(reserveDelegate, store).reserve(reserveRequest("request-stale-read"));
  now = new Date(INITIAL_TIME.getTime() + 1_001);

  const candidateRead = deferred<void>();
  const continueDrain = deferred<void>();
  const drainDelegate = new FakeLedger();
  const drainPromise = drainLlmSettlementOutbox({
    rootDir,
    ledger: drainDelegate,
    clock,
    testHooks: {
      afterPendingRead: async () => {
        candidateRead.resolve();
        await continueDrain.promise;
      },
    },
  });

  await candidateRead.promise;
  await store.persistExact("reservation-request-stale-read", "settle", settlement("fresh-exact"));
  continueDrain.resolve();
  const result = await drainPromise;

  assert.equal(result.completedCount, 1);
  assert.equal(drainDelegate.failCalls, 0);
  assert.equal(drainDelegate.settleCalls, 1);
  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.pendingCount, 0);
  assert.equal(monitoring.exactCount, 0);
});

test("persistExact holds the reservation lock across active-read and atomic replace", async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = new Date(INITIAL_TIME);
  const clock = () => new Date(now);
  const exactRead = deferred<void>();
  const continueExact = deferred<void>();
  const store = new FileLlmSettlementOutbox({
    rootDir,
    producer: "bot",
    fallbackDelayMs: 1_000,
    clock,
    testHooks: {
      afterExactActiveRead: async () => {
        exactRead.resolve();
        await continueExact.promise;
      },
    },
  });
  await new DurableLlmLedger(new FakeLedger(), store).reserve(reserveRequest("request-write-race"));
  now = new Date(INITIAL_TIME.getTime() + 1_001);

  const exactPromise = store.persistExact(
    "reservation-request-write-race",
    "settle",
    settlement("locked-exact"),
  );
  await exactRead.promise;
  const drainDelegate = new FakeLedger();
  const blockedDrain = await drainLlmSettlementOutbox({
    rootDir,
    ledger: drainDelegate,
    clock,
  });

  assert.equal(blockedDrain.claimedCount, 0);
  assert.equal(blockedDrain.skippedCount, 1);
  assert.equal(drainDelegate.failCalls, 0);
  assert.equal(drainDelegate.settleCalls, 0);

  continueExact.resolve();
  await exactPromise;
  const completedDrain = await drainLlmSettlementOutbox({
    rootDir,
    ledger: drainDelegate,
    clock,
  });
  assert.equal(completedDrain.completedCount, 1);
  assert.equal(drainDelegate.failCalls, 0);
  assert.equal(drainDelegate.settleCalls, 1);
});

test("stale reservation lock is reclaimed after its lease", async (t) => {
  const rootDir = await temporaryRoot(t);
  const clock = fixedClock(INITIAL_TIME);
  const store = new FileLlmSettlementOutbox({ rootDir, producer: "bot", clock });
  await store.persistExact("reservation-stale-lock", "settle", settlement("stale-lock"));
  const locksDir = join(rootDir, "bot", "locks");
  const lockId = sha256("lock:reservation:reservation-stale-lock");
  const lockPath = join(locksDir, `${lockId}.lock`);
  const ownerPath = join(lockPath, "abandoned.owner");
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(ownerPath, "abandoned", { mode: 0o600 });
  const staleAt = new Date(INITIAL_TIME.getTime() - 2_000);
  await utimes(ownerPath, staleAt, staleAt);

  const delegate = new FakeLedger();
  const result = await drainLlmSettlementOutbox({
    rootDir,
    ledger: delegate,
    processingLeaseMs: 1_000,
    clock,
  });

  assert.equal(result.completedCount, 1);
  assert.equal(delegate.settleCalls, 1);
  assert.deepEqual(await readdir(locksDir), []);
});

test("drainer removes only expired atomic-write temporary files", async (t) => {
  const rootDir = await temporaryRoot(t);
  const clock = fixedClock(INITIAL_TIME);
  const store = new FileLlmSettlementOutbox({ rootDir, producer: "bot", clock });
  await store.persistPreReserve("request-temp-cleanup");
  const pendingDir = join(rootDir, "bot", "pending");
  const stalePath = join(pendingDir, ".tmp-stale-test");
  const freshPath = join(pendingDir, ".tmp-fresh-test");
  await writeFile(stalePath, "stale", { mode: 0o600 });
  await writeFile(freshPath, "fresh", { mode: 0o600 });
  const staleAt = new Date(INITIAL_TIME.getTime() - 2_000);
  const freshAt = new Date(INITIAL_TIME.getTime() - 500);
  await utimes(stalePath, staleAt, staleAt);
  await utimes(freshPath, freshAt, freshAt);

  await drainLlmSettlementOutbox({
    rootDir,
    ledger: new FakeLedger(),
    processingLeaseMs: 1_000,
    clock,
  });

  await assert.rejects(stat(stalePath), isMissingPath);
  assert.equal(await readFile(freshPath, "utf8"), "fresh");
});

test("expired processing claim is reclaimed and completed", async (t) => {
  const rootDir = await temporaryRoot(t);
  let now = new Date(INITIAL_TIME);
  const clock = () => new Date(now);
  const store = new FileLlmSettlementOutbox({ rootDir, producer: "bot", clock });
  const handle = await store.persistExact("reservation-reclaim", "settle", settlement("reclaim"));
  const processingDir = join(rootDir, "bot", "processing");
  const oldClaimTimestamp = INITIAL_TIME.getTime().toString(36);
  const processingPath = join(
    processingDir,
    `${handle.recordId}--claim-${oldClaimTimestamp}-abcdef.json`,
  );
  await rename(handle.path, processingPath);
  now = new Date(INITIAL_TIME.getTime() + 2_000);
  const delegate = new FakeLedger();

  const result = await drainLlmSettlementOutbox({
    rootDir,
    ledger: delegate,
    clock,
    processingLeaseMs: 1_000,
  });

  assert.equal(result.reclaimedCount, 1);
  assert.equal(result.claimedCount, 1);
  assert.equal(result.completedCount, 1);
  assert.equal(delegate.settleCalls, 1);
  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir, clock });
  assert.equal(monitoring.processingCount, 0);
  assert.equal(monitoring.pendingCount, 0);
});

test("global summary separates pending fallback and retrying exact across producers", async (t) => {
  const rootDir = await temporaryRoot(t);
  const clock = fixedClock(INITIAL_TIME);
  const fallbackStore = new FileLlmSettlementOutbox({
    rootDir,
    producer: "bot",
    clock,
  });
  const fallbackDelegate = new FakeLedger();
  await new DurableLlmLedger(fallbackDelegate, fallbackStore).reserve(
    reserveRequest("request-summary"),
  );
  const exactStore = new FileLlmSettlementOutbox({
    rootDir,
    producer: "cc",
    clock,
  });
  const exactHandle: LlmSettlementHandle = await exactStore.persistExact(
    "reservation-summary",
    "settle",
    settlement("summary"),
  );
  await exactStore.retryLater(exactHandle);

  const monitoring = await readLlmSettlementOutboxMonitoring({
    rootDir,
    maxAttempts: 32,
    clock,
  });

  assert.deepEqual(monitoring, {
    available: true,
    pendingCount: 1,
    retryingCount: 1,
    processingCount: 0,
    deadCount: 0,
    fallbackCount: 1,
    exactCount: 1,
    oldestPendingAt: INITIAL_TIME.toISOString(),
    nextRetryAt: new Date(INITIAL_TIME.getTime() + 1_000).toISOString(),
    maxAttempts: 32,
  });
});

test("monitoring a missing read-only root does not create it", async (t) => {
  const parent = await temporaryRoot(t);
  const missingRoot = join(parent, "read-only-missing");

  const monitoring = await readLlmSettlementOutboxMonitoring({ rootDir: missingRoot });

  assert.equal(monitoring.available, false);
  await assert.rejects(stat(missingRoot), (error: unknown) =>
    Boolean(error instanceof Error && "code" in error && error.code === "ENOENT"),
  );
});

test("oversized exact payload fails before delegate close", async (t) => {
  const rootDir = await temporaryRoot(t);
  const delegate = new FakeLedger();
  const ledger = new DurableLlmLedger(
    delegate,
    new FileLlmSettlementOutbox({ rootDir, producer: "cc" }),
  );

  await assert.rejects(
    ledger.settle("reservation-large", {
      outcome: "success",
      metadata: { value: "x".repeat(70 * 1024) },
    }),
    LlmSettlementOutboxError,
  );
  assert.equal(delegate.settleCalls, 0);
});

async function temporaryRoot(t: TestContext): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), "mydon-llm-outbox-"));
  t.after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });
  return rootDir;
}

function fixedClock(value: Date): () => Date {
  return () => new Date(value);
}

function reserveRequest(requestKey: string): LlmReserveRequest {
  return {
    requestKey,
    consumer: "bot",
    feature: "test",
    provider: "openai",
    model: "gpt-5.6-sol",
    inputTokenCeiling: 100,
    outputTokenCeiling: 100,
  };
}

function reservation(requestKey: string): LlmReservation {
  return {
    id: `reservation-${requestKey}`,
    requestKey,
    day: "2026-08-30",
    reservedUsd: 0.01,
    replay: false,
    budget: budget(),
  };
}

function budget(): LlmBudgetSnapshot {
  return {
    day: "2026-08-30",
    globalCapUsd: 10,
    globalExposureUsd: 0.01,
    remainingUsd: 9.99,
  };
}

function settlement(marker: string): LlmSettlementRequest {
  return {
    outcome: "success",
    usage: { inputTokens: 10, outputTokens: 5 },
    metadata: { marker },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isMissingPath(error: unknown): boolean {
  return Boolean(error instanceof Error && "code" in error && error.code === "ENOENT");
}
