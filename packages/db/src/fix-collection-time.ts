/**
 * Разовый сдвиг +5 часов у 247 перенесённых инкассаций (срез «правда о
 * пробеле», R-I-4/R-I-5).
 *
 * ЧТО ПРАВИТСЯ. 247 строк `collection` с `source='import'` и `client_key`,
 * который начинается с `vendcash:collection:` — доказанное происхождение от
 * донора VendCash. У донора `collected_at` — настоящий UTC (см. шапку
 * донорской миграции `FixOrderDateTimezone`), но прошлый импорт прочитал его
 * как ташкентские НАСТЕННЫЕ ЧАСЫ и увёл момент на пять часов НАЗАД: «06:40 по
 * Ташкенту» на самом деле означает 11:40. Ручная история (`manual_history`,
 * 139 строк) прошлый импорт прочитал ПРАВИЛЬНО — она этим скриптом не
 * трогается вовсе, множество ограничено `source='import'`.
 *
 * ПОЧЕМУ ОПЕРАЦИЯ НЕ ИДЕМПОТЕНТНА ПО ПРИРОДЕ. Сдвиг — это `+5 часов`, а не
 * «привести к правде»: повторный прогон дал бы ещё +5, то есть +10 часов
 * суммарно, и отличить «сдвинуто один раз правильно» от «сдвинуто дважды»
 * можно только ПО СЛЕДУ (событие/аудит), а не по самим данным. Поэтому три
 * независимые заставы стоят на трёх разных путях защиты, а не на одном:
 *   1. происхождение (`source='import' AND client_key IS NULL`) — пока оно не
 *      доказано, чинить время НЕЛЬЗЯ вовсе (обычно застава срабатывает там,
 *      где T2 backfill-collection-keys упёрся в R-I-8 — расходящиеся коды
 *      автомата и не сшил пару);
 *   2. отметка события `cash.collection_time_corrected` в `event`;
 *   3. запись `action='collection.time_corrected'` в `audit_log`;
 *   4. распределение ташкентского часа множества: максимум > 19 — данные
 *      выглядят уже сдвинутыми ЧУЖОЙ рукой (после верной правки максимум
 *      РОВНО 19, повтор эта застава не поймает — повтор ловят 2 и 3).
 *
 * ПОЧЕМУ ДОНОР ЗДЕСЬ НЕ НУЖЕН ВОВСЕ. Множество, которое правится, доказано
 * ключом, уже лежащим в MYDON (`backfill-collection-keys.ts`, T2) — открывать
 * ещё одно подключение к чужой базе ради операции, которая её не читает,
 * незачем.
 *
 * ОДНА ТРАНЗАКЦИЯ. `UPDATE` каждой строки + построчный `audit_log` + одно
 * событие — 247 строк это доли секунды, а половинчатый сдвиг (часть строк
 * сдвинута, часть нет) не должен существовать в принципе: он неотличим от
 * данных, которые сдвигали дважды по кускам.
 *
 * СУММЫ И СТАТУСЫ НЕ МЕНЯЮТСЯ НИГДЕ. Правится время, не деньги: `суммыПоСтатусам`
 * считается до и после, расхождение — ошибка реализации, а не предупреждение.
 *
 * Запуск (шаг выкатки, ДВА прогона — сначала пробный, донор НЕ подключается):
 *   node packages/db/dist/fix-collection-time.js --dry-run </dev/null
 *   node packages/db/dist/fix-collection-time.js --apply   </dev/null
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { and, eq, isNull, like, sql } from "drizzle-orm";
import { TASHKENT_OFFSET_MS, tashkentDay, tashkentMinute } from "@mydon/shared";
import { ПРЕФИКС_КЛЮЧА } from "./backfill-collection-keys";
import { createDb, type Database } from "./index";
import { разобратьФлаги } from "./script-flags";
import { auditLog, collection, event } from "./schema";

export const EVENT_TYPE = "cash.collection_time_corrected";
export const AUDIT_ACTION = "collection.time_corrected";
/** Ожидание прода. Меняется флагом `--expect=<N>` — им пользуется только дымовой прогон. */
export const ОЖИДАНИЕ_ПРОДА = 247;

export class FixTimeRefusal extends Error {}

export interface ЧасыНабора {
  мин: number;
  макс: number;
  сред: number;
}

export interface FixTimeReport {
  найдено: number;
  кПравке: number;
  правлено: number;
  часыДо: ЧасыНабора;
  часыПосле: ЧасыНабора;
  суткиДо: { from: string; to: string };
  суткиПосле: { from: string; to: string };
  суммыДо: Record<string, number>;
  суммыПосле: Record<string, number>;
  сдвигЧасов: number;
}

interface Строка {
  id: string;
  source: string;
  clientKey: string | null;
  collectedAt: Date;
  receivedAt: Date | null;
  amount: string | null;
  status: string;
}

/** Через ту же минуту, что режет ключ бота: вторая формула зоны запрещена. */
export function ташкентскийЧас(at: Date): number {
  return Number(tashkentMinute(at).slice(11, 13));
}

export function часыНабора(rows: readonly { collectedAt: Date }[]): ЧасыНабора {
  const часы = rows.map((r) => ташкентскийЧас(r.collectedAt));
  return {
    мин: Math.min(...часы),
    макс: Math.max(...часы),
    сред: Math.round(часы.reduce((s, h) => s + h, 0) / часы.length),
  };
}

export function суммыПоСтатусам(rows: readonly { status: string; amount: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    out[r.status] = (out[r.status] ?? 0) + (r.amount == null ? 0 : Math.round(Number(r.amount) * 100));
  }
  return out;
}

function сутки(rows: readonly { collectedAt: Date }[]): { from: string; to: string } {
  const дни = rows.map((r) => tashkentDay(r.collectedAt)).sort();
  return { from: дни[0]!, to: дни[дни.length - 1]! };
}

export async function fixCollectionTime(
  db: Database,
  opts: { apply: boolean; expect?: number; now?: Date },
): Promise<FixTimeReport> {
  const now = opts.now ?? new Date();
  const ожидание = opts.expect ?? ОЖИДАНИЕ_ПРОДА;

  // ЗАСТАВА 1 — происхождение. Пока хоть одна строка `import` без ключа,
  // остальные вопросы преждевременны: чинить время у строк, происхождение
  // которых не доказано, нельзя (обычно это T2, упершийся в R-I-8).
  const [{ n: безКлюча }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(collection)
    .where(and(eq(collection.source, "import"), isNull(collection.clientKey)));
  if (Number(безКлюча) > 0) {
    throw new FixTimeRefusal(
      `строк source='import' без client_key: ${безКлюча}. Происхождение не доказано — сначала ` +
        `backfill-collection-keys, и, если они остались без пары, решение владельца по коду автомата (R-I-8).`,
    );
  }

  // ЗАСТАВА 2 — отметка события: повторный прогон дал бы ещё +5 часов.
  const [{ n: событий }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(event)
    .where(eq(event.type, EVENT_TYPE));
  if (Number(событий) > 0) {
    throw new FixTimeRefusal(
      `в event уже есть отметка ${EVENT_TYPE} — время уже правили, повторный сдвиг дал бы +10 часов.`,
    );
  }

  // ЗАСТАВА 3 — построчный аудит: тот же повтор, другой путь проверки.
  const [{ n: аудита }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLog)
    .where(eq(auditLog.action, AUDIT_ACTION));
  if (Number(аудита) > 0) {
    throw new FixTimeRefusal(
      `в audit_log уже есть запись ${AUDIT_ACTION} — время уже правили, повторный сдвиг дал бы +10 часов.`,
    );
  }

  const множество = (await db
    .select({
      id: collection.id,
      source: collection.source,
      clientKey: collection.clientKey,
      collectedAt: collection.collectedAt,
      receivedAt: collection.receivedAt,
      amount: collection.amount,
      status: collection.status,
    })
    .from(collection)
    .where(and(eq(collection.source, "import"), like(collection.clientKey, `${ПРЕФИКС_КЛЮЧА}%`)))) as unknown as Строка[];

  // ЗАСТАВА 4 — третий ремень, для правки ЧУЖОЙ рукой: после НАШЕЙ верной
  // правки максимум ташкентского часа равен ровно 19, повтор эта застава не
  // поймает — повтор ловят 2 и 3 выше.
  const часыДо = множество.length > 0 ? часыНабора(множество) : { мин: 0, макс: 0, сред: 0 };
  if (часыДо.макс > 19) {
    throw new FixTimeRefusal(
      `максимум ташкентского часа в множестве — ${часыДо.макс} (> 19): данные выглядят уже сдвинутыми чужой рукой.`,
    );
  }

  const найдено = множество.length;
  if (найдено !== ожидание) {
    throw new FixTimeRefusal(`найдено ${найдено}, ожидалось ${ожидание} — остановка.`);
  }

  const суммыДо = суммыПоСтатусам(множество);
  const суткиДо = найдено > 0 ? сутки(множество) : { from: "", to: "" };
  const сдвигЧасов = TASHKENT_OFFSET_MS / 3_600_000;

  const после = множество.map((r) => ({
    ...r,
    collectedAt: new Date(r.collectedAt.getTime() + TASHKENT_OFFSET_MS),
    receivedAt: r.receivedAt ? new Date(r.receivedAt.getTime() + TASHKENT_OFFSET_MS) : null,
  }));
  const часыПосле = после.length > 0 ? часыНабора(после) : { мин: 0, макс: 0, сред: 0 };
  const суткиПосле = найдено > 0 ? сутки(после) : { from: "", to: "" };
  const суммыПосле = суммыПоСтатусам(после);

  let правлено = 0;
  if (opts.apply) {
    await db.transaction(async (tx) => {
      for (const r of множество) {
        const collectedAt = new Date(r.collectedAt.getTime() + TASHKENT_OFFSET_MS);
        const receivedAt = r.receivedAt ? new Date(r.receivedAt.getTime() + TASHKENT_OFFSET_MS) : null;
        // Новые значения считаются в TS и пишутся ЯВНЫМИ моментами: так
        // `before`/`after` в аудите честны построчно, а второй копии «пяти
        // часов» в SQL не появляется.
        const [updated] = await tx
          .update(collection)
          .set({ collectedAt, receivedAt })
          .where(eq(collection.id, r.id))
          .returning();
        await tx.insert(auditLog).values({
          actorKind: "system",
          actorRef: "script:fix-collection-time",
          action: AUDIT_ACTION,
          target: r.id,
          before: r,
          after: updated,
        });
        правлено += 1;
      }
      await tx.insert(event).values({
        source: "vendcash",
        type: EVENT_TYPE,
        payload: { rows: правлено, from: суткиПосле.from, to: суткиПосле.to, hours: сдвигЧасов },
        occurredAt: now,
      });
    });
  }

  return {
    найдено,
    кПравке: найдено,
    правлено,
    часыДо,
    часыПосле,
    суткиДо,
    суткиПосле,
    суммыДо,
    суммыПосле,
    сдвигЧасов,
  };
}

export function formatReport(r: FixTimeReport): string {
  const lines = [
    `найдено: ${r.найдено}`,
    `к правке: ${r.кПравке}`,
    `правлено: ${r.правлено}`,
    `часы до: мин ${r.часыДо.мин}, макс ${r.часыДо.макс}, сред ${r.часыДо.сред}`,
    `часы после: мин ${r.часыПосле.мин}, макс ${r.часыПосле.макс}, сред ${r.часыПосле.сред}`,
    `сутки до: ${r.суткиДо.from} … ${r.суткиДо.to}`,
    `сутки после: ${r.суткиПосле.from} … ${r.суткиПосле.to}`,
    `суммы по статусам до: ${JSON.stringify(r.суммыДо)}`,
    `суммы по статусам после: ${JSON.stringify(r.суммыПосле)}`,
    `сдвиг: ${r.сдвигЧасов} ч`,
  ];
  lines.push(
    `ИТОГИ(json): ${JSON.stringify({
      найдено: r.найдено,
      кПравке: r.кПравке,
      правлено: r.правлено,
      часыДо: r.часыДо,
      часыПосле: r.часыПосле,
      суткиДо: r.суткиДо,
      суткиПосле: r.суткиПосле,
      суммыДо: r.суммыДо,
      суммыПосле: r.суммыПосле,
      сдвигЧасов: r.сдвигЧасов,
    })}`,
  );
  return lines.join("\n");
}

// ── Точка входа ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  loadEnv({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

  const флаги = разобратьФлаги(process.argv.slice(2), { безФлагов: "отказ", числа: { "--expect": ОЖИДАНИЕ_ПРОДА } });
  if (!флаги.ok) {
    console.error(флаги.error);
    process.exit(1);
  }
  console.log(флаги.режим);

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL не задан — править нечего.");
    process.exit(1);
  }

  try {
    const report = await fixCollectionTime(createDb(url), {
      apply: флаги.dryRun === false,
      expect: флаги.числа["--expect"],
    });
    console.log(formatReport(report));
  } catch (err) {
    if (err instanceof FixTimeRefusal) {
      console.error(err.message);
      process.exit(3);
    }
    throw err;
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error("Правка времени инкассаций упала:", err instanceof Error ? err.message : err);
    // process.exitCode = 1 здесь НЕ хватило бы: postgres.js держит соединение
    // открытым, и без явного выхода ручной шаг выкатки висел бы после уже
    // напечатанной ошибки — не отличить от «ещё считает».
    process.exit(1);
  });
}
