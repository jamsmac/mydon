import { statfs } from "node:fs/promises";
import { Controller, Get, HttpStatus, Inject, Res } from "@nestjs/common";
import { sql } from "drizzle-orm";
import type { Response } from "express";
import { TZ } from "@mydon/shared";
import { appConfig } from "./config";
import { DB, type Db } from "./db/db.module";

export interface HealthReport {
  status: "ok" | "degraded";
  service: string;
  commit: string;
  tz: string;
  tzExpected: string;
  tzOk: boolean;
  dbOk: boolean;
  dbLatencyMs: number;
  storageOk: boolean;
  storageFreeMb: number;
  storageMinMb: number;
  uptimeSec: number;
  memoryMb: number;
}

export function storageIsHealthy(freeMb: number, minMb: number): boolean {
  return Number.isFinite(freeMb) && freeMb >= minMb;
}

@Controller("health")
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  @Get()
  async check(@Res({ passthrough: true }) response: Response): Promise<HealthReport> {
    const tz = appConfig.tz;
    const start = performance.now();
    let dbOk = false;
    let dbLatencyMs = -1;
    let storageFreeMb = -1;

    await Promise.all([
      this.db
        .execute(sql`SELECT 1`)
        .then(() => {
          dbOk = true;
          dbLatencyMs = Math.round(performance.now() - start);
        })
        .catch(() => undefined),
      statfs(appConfig.healthStoragePath, { bigint: true })
        .then((stats) => {
          storageFreeMb = Number((stats.bavail * stats.bsize) / (1024n * 1024n));
        })
        .catch(() => undefined),
    ]);

    const storageOk = storageIsHealthy(storageFreeMb, appConfig.healthMinStorageMb);

    const report: HealthReport = {
      status: dbOk && tz === TZ && storageOk ? "ok" : "degraded",
      service: "mydon-core",
      commit: process.env.GIT_SHA ?? "unknown",
      tz,
      tzExpected: TZ,
      tzOk: tz === TZ,
      dbOk,
      dbLatencyMs,
      storageOk,
      storageFreeMb,
      storageMinMb: appConfig.healthMinStorageMb,
      uptimeSec: Math.floor(process.uptime()),
      memoryMb: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    };

    if (report.status === "degraded") response.status(HttpStatus.SERVICE_UNAVAILABLE);
    return report;
  }
}
