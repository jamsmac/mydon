import "reflect-metadata";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { EnsureForDayDto } from "./tasks.controller";

/**
 * `dayKey` — ЧАСТЬ КЛЮЧА ИДЕМПОТЕНТНОСТИ, а не просто дата (R-G-2).
 *
 * `source` собирается как `<ключ>:<dayKey>` и обязан попасть под предикат
 * частичного индекса `:[0-9]{4}-[0-9]{2}-[0-9]{2}$`. Полная дата-время проходит
 * `@IsISO8601({strict:true})`, но под предикат НЕ попадает — и дедуп
 * выключается молча: дубли пойдут без единой ошибки.
 */
const тело = (dayKey: string) => plainToInstance(EnsureForDayDto, { title: "Мойка миксера", ownerKind: "human", dayKey });

describe("EnsureForDayDto: dayKey — только голые сутки", () => {
  it("YYYY-MM-DD принимается", async () => {
    assert.deepEqual(await validate(тело("2026-08-26")), []);
  });

  for (const плохой of ["2026-08-26T06:00:00.000Z", "2026-08-26 06:00", "26.08.2026", "2026-8-26"]) {
    it(`«${плохой}» отбивается: такой source уходит из-под предиката индекса`, async () => {
      const ошибки = await validate(тело(плохой));
      assert.ok(ошибки.length > 0, "иначе дедуп молча перестаёт работать");
    });
  }
});
