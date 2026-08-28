/**
 * Разовый бэкфилл `collection.client_key` от донора VendCash (срез «правда о
 * пробеле», R-I-2/R-I-3).
 *
 * ЗАЧЕМ. Журнал инкассаций растёт без ключа идемпотентности: 386 перенесённых
 * строк ничем не защищены от повторного переноса, а ретрай кнопки в боте
 * после таймаута 10 с уже сегодня даёт вторую инкассацию. Ключ заполняет
 * идентичность строки В ИСТОЧНИКЕ — `vendcash:collection:<uuid донора>`; без
 * ключа от клиента строка остаётся `NULL`, и это законное состояние, а не
 * пробел (R-I-2).
 *
 * ПОЧЕМУ СОПОСТАВЛЕНИЕ ПО (код автомата, момент, сумма). Статус в ключ
 * СОЗНАТЕЛЬНО не входит: единственная известная строка расхождения (30.06.2026
 * — `collected` у донора, `cancelled` у нас) — та же самая инкассация, и
 * включи статус в ключ, пара распалась бы на «нет пары» с обеих сторон.
 * Момент донора читается ташкентскими настенными часами (`tashkentInstant`) —
 * той же формулой, что применил прошлый импорт ко всем 386 строкам (§3.2
 * описи); сумма сравнивается в копейках, а не строкой, иначе `"1250000.00"` и
 * `"1250000.000"` разошлись бы по разным ключам.
 *
 * ПОЧЕМУ НЕОДНОЗНАЧНОСТЬ ПЕЧАТАЕТСЯ, А НЕ ПИШЕТСЯ. Тройной дубль на
 * `fa86d006…` 30.01.2026 12:46 внесён владельцем НАМЕРЕННО (Р-4 описи):
 * схлопнуть его по первому совпадению значило бы стереть след тройной ошибки
 * ввода. Два и более кандидата с любой стороны — строка уезжает в отчёт
 * «неоднозначно» и ключ не пишется НИ ОДНОЙ из них.
 *
 * ПОЧЕМУ `3be8c71f0000` / `3be8c71e0000` НЕ СШИВАЮТСЯ (R-I-8). Коды после
 * нормализации различаются символом, и какой из них настоящий — из данных не
 * видно. Хардкод соответствия запечёк бы угадывание в ключ навсегда; 12 строк
 * этого автомата уезжают в отчёт «без пары» — это ожидаемый результат
 * примерки, а не провал скрипта.
 *
 * ДОНОР ЧИТАЕТСЯ ТОЛЬКО НА ЧТЕНИЕ. `VENDCASH_DATABASE_URL` — чужая база со
 * своим владельцем и своим ботом; подключение открывается с `max: 1` и
 * исполняет исключительно SELECT. Переменная в `.env` прода НЕ хранится —
 * передаётся окружением ровно на время команды (см. `.env.example`).
 *
 * БЕЗ ФЛАГОВ — ОТКАЗ. В отличие от `backfill-product-ids.js` (его зовёт
 * `ci.yml` без аргументов и это проверенный прогон): этот скрипт запускают
 * только руками по живой базе, денежному журналу владельца, и «умолчание —
 * запись» здесь читалось бы как ловушка, а не удобство.
 *
 * Запуск (шаг выкатки, ДВА прогона — сначала пробный):
 *   VENDCASH_DATABASE_URL=... node packages/db/dist/backfill-collection-keys.js --dry-run </dev/null
 *   VENDCASH_DATABASE_URL=... node packages/db/dist/backfill-collection-keys.js --apply   </dev/null
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { and, eq, isNull } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import postgres from "postgres";
import { tashkentInstant } from "@mydon/shared";
import { createDb, type Database } from "./index";
import { разобратьФлаги } from "./script-flags";
import { collection, entity } from "./schema";

export const ПРЕФИКС_КЛЮЧА = "vendcash:collection:";

export interface DonorCollectionRow {
  id: string;
  machineCode: string | null;
  collectedAt: string;
  amount: string | null;
  status: string;
}

export interface DonorReader {
  collections(): Promise<DonorCollectionRow[]>;
}

interface НашаСтрока {
  id: string;
  machineCode: string | null;
  collectedAt: Date;
  amount: string | null;
  status: string;
  clientKey: string | null;
}

/** Донор пишет код короче на символ и один — в верхнем регистре (§3.1 описи). */
export function нормализоватьКод(code: string | null): string | null {
  const s = (code ?? "").trim().toLowerCase();
  if (s === "") return null;
  return s.length >= 12 ? s : s.padEnd(12, "0");
}

/** Ключ сопоставления: код + момент (мс) + сумма в копейках. Статус НЕ входит (R-I-3). */
export function ключСопоставления(code: string | null, at: Date, amount: string | null): string | null {
  const код = нормализоватьКод(code);
  if (код === null) return null;
  // Копейки, а не строка: `"1250000.00"` и `"1250000.000"` — одна сумма, а
  // побайтовое сравнение развело бы их по разным ключам.
  const сумма = amount == null ? "null" : String(Math.round(Number(amount) * 100));
  return `${код}|${at.getTime()}|${сумма}`;
}

export interface BackfillKeysReport {
  уДонора: number;
  уНас: number;
  сопоставлено: number;
  кЗаписи: number;
  записано: number;
  безПарыДонор: { id: string; code: string | null; at: string }[];
  безПарыНаши: { id: string; code: string | null; at: string }[];
  неоднозначно: { ключ: string; донор: string[]; наши: string[] }[];
  расхождениеСтатуса: { ourId: string; donorId: string; уНас: string; уДонора: string }[];
}

/**
 * Предикат записи ключа: `id` СТРОГО этой строки, и `client_key IS NULL`.
 *
 * Без `isNull` повторный `--apply` перезаписал бы уже стоящий ключ — тот
 * самый случай, ради которого этот скрипт вообще запускают руками, а не
 * гоняют по расписанию. Вынесена отдельной чистой функцией (образец —
 * `бэкфиллWhere` в `backfill-product-ids.ts`), чтобы предикат проверялся
 * юнит-тестом без стаба drizzle-цепочки целиком.
 */
export function бэкфиллWhere(id: string): SQL | undefined {
  return and(eq(collection.id, id), isNull(collection.clientKey));
}

export async function backfillCollectionKeys(
  db: Database,
  donor: DonorReader,
  opts: { apply: boolean },
): Promise<BackfillKeysReport> {
  const [donorRows, ourRows] = await Promise.all([
    donor.collections(),
    db
      .select({
        id: collection.id,
        machineCode: entity.externalRef,
        collectedAt: collection.collectedAt,
        amount: collection.amount,
        status: collection.status,
        clientKey: collection.clientKey,
      })
      .from(collection)
      .leftJoin(entity, eq(entity.id, collection.machineId))
      .orderBy(collection.id) as unknown as Promise<НашаСтрока[]>,
  ]);

  const поКлючуДонор = new Map<string, string[]>();
  const donorById = new Map<string, DonorCollectionRow>();
  const безПарыДонор: BackfillKeysReport["безПарыДонор"] = [];
  for (const d of donorRows) {
    donorById.set(d.id, d);
    const момент = tashkentInstant(d.collectedAt);
    const код = нормализоватьКод(d.machineCode);
    if (момент === null || код === null) {
      безПарыДонор.push({ id: d.id, code: d.machineCode, at: d.collectedAt });
      continue;
    }
    const ключ = ключСопоставления(d.machineCode, момент, d.amount);
    if (ключ === null) {
      безПарыДонор.push({ id: d.id, code: d.machineCode, at: d.collectedAt });
      continue;
    }
    const список = поКлючуДонор.get(ключ) ?? [];
    список.push(d.id);
    поКлючуДонор.set(ключ, список);
  }

  const поКлючуНаши = new Map<string, string[]>();
  const ourById = new Map<string, НашаСтрока>();
  const безПарыНаши: BackfillKeysReport["безПарыНаши"] = [];
  for (const r of ourRows) {
    ourById.set(r.id, r);
    const ключ = ключСопоставления(r.machineCode, r.collectedAt, r.amount);
    if (ключ === null) {
      безПарыНаши.push({ id: r.id, code: r.machineCode, at: r.collectedAt.toISOString() });
      continue;
    }
    const список = поКлючуНаши.get(ключ) ?? [];
    список.push(r.id);
    поКлючуНаши.set(ключ, список);
  }

  const неоднозначно: BackfillKeysReport["неоднозначно"] = [];
  const расхождениеСтатуса: BackfillKeysReport["расхождениеСтатуса"] = [];
  const кЗаписи: { id: string; clientKey: string }[] = [];

  let сопоставлено = 0;
  for (const [ключ, donorIds] of поКлючуДонор) {
    const ourIds = поКлючуНаши.get(ключ);
    if (!ourIds) {
      for (const id of donorIds) {
        const d = donorById.get(id)!;
        безПарыДонор.push({ id: d.id, code: d.machineCode, at: d.collectedAt });
      }
      continue;
    }
    if (donorIds.length > 1 || ourIds.length > 1) {
      неоднозначно.push({ ключ, донор: [...donorIds], наши: [...ourIds] });
      continue;
    }
    // Пара найдена — это "сопоставлено" НЕЗАВИСИМО от того, нужно ли ей
    // писать ключ: повторный `--apply` находит ту же пару и печатает
    // «сопоставлено 1», а «к записи 0», потому что ключ уже стоит.
    сопоставлено += 1;
    const donorId = donorIds[0]!;
    const ourId = ourIds[0]!;
    const наша = ourById.get(ourId)!;
    const донорская = donorById.get(donorId)!;
    if (наша.status !== донорская.status) {
      расхождениеСтатуса.push({ ourId, donorId, уНас: наша.status, уДонора: донорская.status });
    }
    if (наша.clientKey === null) {
      кЗаписи.push({ id: ourId, clientKey: ПРЕФИКС_КЛЮЧА + donorId });
    }
  }

  for (const [ключ, ourIds] of поКлючуНаши) {
    if (!поКлючуДонор.has(ключ)) {
      for (const id of ourIds) {
        const r = ourById.get(id)!;
        безПарыНаши.push({ id: r.id, code: r.machineCode, at: r.collectedAt.toISOString() });
      }
    }
  }

  let записано = 0;
  if (opts.apply) {
    for (const { id, clientKey } of кЗаписи) {
      const строки = await db.update(collection).set({ clientKey }).where(бэкфиллWhere(id)).returning();
      записано += строки.length;
    }
  }

  return {
    уДонора: donorRows.length,
    уНас: ourRows.length,
    сопоставлено,
    кЗаписи: кЗаписи.length,
    записано,
    безПарыДонор,
    безПарыНаши,
    неоднозначно,
    расхождениеСтатуса,
  };
}

export function formatReport(r: BackfillKeysReport): string {
  const lines = [
    `у донора: ${r.уДонора}`,
    `у нас: ${r.уНас}`,
    `сопоставлено: ${r.сопоставлено}`,
    `к записи: ${r.кЗаписи}`,
    `записано: ${r.записано}`,
    `без пары (донор): ${r.безПарыДонор.length}`,
    `без пары (MYDON): ${r.безПарыНаши.length}`,
    `неоднозначно: ${r.неоднозначно.length}`,
    `расхождение статуса: ${r.расхождениеСтатуса.length}`,
  ];
  if (r.кЗаписи === 0) {
    lines.push(r.уДонора === 0 ? "нечего писать: донор пуст" : "нечего писать: у всех сопоставленных строк ключ уже стоит");
  }
  for (const n of r.неоднозначно) {
    lines.push(`  неоднозначно ${n.ключ}: донор [${n.донор.join(", ")}], наши [${n.наши.join(", ")}]`);
  }
  for (const s of r.расхождениеСтатуса) {
    lines.push(`  расхождение статуса ${s.ourId}/${s.donorId}: у нас «${s.уНас}», у донора «${s.уДонора}»`);
  }
  lines.push(
    `ИТОГИ(json): ${JSON.stringify({
      уДонора: r.уДонора,
      уНас: r.уНас,
      сопоставлено: r.сопоставлено,
      кЗаписи: r.кЗаписи,
      записано: r.записано,
      безПарыДонор: r.безПарыДонор.length,
      безПарыНаши: r.безПарыНаши.length,
      неоднозначно: r.неоднозначно.length,
      расхождениеСтатуса: r.расхождениеСтатуса.length,
    })}`,
  );
  return lines.join("\n");
}

// ── Донор через postgres.js — ТОЛЬКО SELECT ─────────────────────────────────

export function sqlDonor(url: string, schema = "public"): { reader: DonorReader; close(): Promise<void> } {
  const client = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });
  const reader: DonorReader = {
    collections: async () =>
      (await client`
        select c.id::text as id, m.code as "machineCode", c.collected_at::text as "collectedAt",
               c.amount::text as amount, c.status::text as status
          from ${client(schema)}.collections c
          left join ${client(schema)}.machines m on m.id = c.machine_id
         order by c.id`) as unknown as DonorCollectionRow[],
  };
  return { reader, close: async () => client.end({ timeout: 5 }) };
}

// ── Точка входа ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

  const флаги = разобратьФлаги(process.argv.slice(2), { безФлагов: "отказ" });
  if (!флаги.ok) {
    console.error(флаги.error);
    process.exit(1);
  }
  console.log(флаги.режим);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL не задан — писать ключи некуда.");
    process.exit(1);
  }
  const donorUrl = process.env.VENDCASH_DATABASE_URL;
  if (!donorUrl) {
    console.error("VENDCASH_DATABASE_URL не задан — донор VendCash не подключён, читать нечего.");
    process.exit(2);
  }

  const { reader, close } = sqlDonor(donorUrl, process.env.VENDCASH_SCHEMA || "public");
  try {
    console.log(formatReport(await backfillCollectionKeys(createDb(url), reader, { apply: флаги.dryRun === false })));
  } finally {
    await close();
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Бэкфилл ключей инкассации упал:", err instanceof Error ? err.message : err);
    // process.exitCode = 1 здесь НЕ хватило бы: postgres.js держит соединение
    // MYDON открытым (finally выше закрывает только донора), и без явного
    // выхода ручной шаг выкатки висел бы после уже напечатанной ошибки.
    process.exit(1);
  });
}
