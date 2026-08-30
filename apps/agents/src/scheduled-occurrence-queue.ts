import { jobKey, type ScheduledJob } from "./schedule";

export interface PendingScheduledOccurrence {
  job: ScheduledJob;
  scheduledAt: Date;
}

export interface ScheduledOccurrenceFlushResult {
  completed: PendingScheduledOccurrence[];
  failed: { occurrence: PendingScheduledOccurrence; error: unknown }[];
}

/**
 * Process-local retry buffer for a cron tick that has fired but Core has not
 * materialized yet. Provider durability starts in Core; this closes the
 * smaller live-process network gap before that boundary without inventing
 * missed ticks while the whole Agents service was offline.
 */
export class ScheduledOccurrenceRetryQueue {
  private readonly pending = new Map<string, PendingScheduledOccurrence>();

  enqueue(job: ScheduledJob, scheduledAt: Date): void {
    const occurrence = { job: { ...job }, scheduledAt: new Date(scheduledAt) };
    this.pending.set(this.key(occurrence), occurrence);
  }

  get size(): number {
    return this.pending.size;
  }

  async flush(
    deliver: (occurrence: PendingScheduledOccurrence) => Promise<void>,
  ): Promise<ScheduledOccurrenceFlushResult> {
    const completed: PendingScheduledOccurrence[] = [];
    const failed: { occurrence: PendingScheduledOccurrence; error: unknown }[] = [];
    for (const [key, occurrence] of [...this.pending]) {
      try {
        await deliver(occurrence);
        if (this.pending.get(key) === occurrence) this.pending.delete(key);
        completed.push(occurrence);
      } catch (error) {
        failed.push({ occurrence, error });
      }
    }
    return { completed, failed };
  }

  private key(occurrence: PendingScheduledOccurrence): string {
    return `${jobKey(occurrence.job)}\u0000${occurrence.scheduledAt.toISOString()}`;
  }
}
