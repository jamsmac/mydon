"use server";

import { revalidatePath } from "next/cache";
import { DELIMITERS, FISCAL_FIELDS, decodeUpload, fiscalGaps, parseDelimited } from "@mydon/shared";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult {
  ok: boolean;
  error?: string;
}

function fail(err: unknown): ActionResult {
  if (err instanceof CoreUnavailable) return { ok: false, error: err.detail };
  return { ok: false, error: err instanceof Error ? err.message : "Не получилось" };
}

/**
 * Решение владельца по значению источника.
 *
 * Пустой `entityId` — осознанное «карточка не нужна»: значение перестаёт
 * числиться неразобранным, но в реестр не попадает. Это не то же самое, что
 * «ещё не смотрел», и хранится отдельно именно поэтому.
 */
export async function linkRawValue(
  source: string,
  kind: "machine" | "product" | "point",
  label: string,
  entityId: string,
): Promise<ActionResult> {
  try {
    await core.rawLink({
      source,
      kind,
      label,
      ...(entityId ? { entityId } : {}),
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}

/**
 * Завести карточку товара прямо из выгрузки.
 *
 * Название берётся ровно таким, как его пишет источник: тогда правило точного
 * совпадения найдёт его и в следующей выгрузке. Фискальные поля (ИКПУ,
 * упаковка, НДС) остаются пустыми — их заполняет владелец в карточке, и
 * выдумывать их здесь нельзя: без них чек всё равно не соберётся.
 */
export async function createProductFromSource(
  source: string,
  label: string,
): Promise<ActionResult> {
  const name = label.trim();
  if (name.length === 0) return { ok: false, error: "Пустое название заводить нельзя" };
  try {
    const created = await core.createEntity({
      domain: "vendhub",
      type: "product",
      name,
      attrs: { источник: source },
    });
    // Связь пишем решением владельца: карточку завёл он, а не правило совпало.
    await core.rawLink({ source, kind: "product", label: name, entityId: created.id });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}

/**
 * Записать точку в карточку автомата.
 *
 * Заполняется ТОЛЬКО пустое поле. Если владелец уже написал там своё — его
 * значение важнее любого источника (то же правило, что в синке снабжения), и
 * вместо тихой перезаписи он получает ответ словами.
 */
export async function fillMachinePoint(machineId: string, point: string): Promise<ActionResult> {
  const value = point.trim();
  if (value.length === 0) return { ok: false, error: "Пустую точку записывать нечего" };
  try {
    const card = await core.entity(machineId);
    const attrs = { ...(card.attrs ?? {}) };
    const current = attrs["точка"];
    if (typeof current === "string" && current.trim().length > 0) {
      if (current.trim() === value) return { ok: true };
      return {
        ok: false,
        error: `В карточке уже указано «${current}» — поменять можно в самой карточке.`,
      };
    }
    // attrs при правке заменяются целиком, поэтому сливаем, а не подставляем.
    await core.updateEntity(machineId, { attrs: { ...attrs, точка: value } });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}

/**
 * Завести или поправить систему-источник.
 *
 * Справочник в коде остаётся основой; отсюда идут только правки владельца.
 * Пустой адрес кабинета — законное состояние: «ещё не записан» честнее
 * выдуманного адреса.
 */
export async function saveSource(input: {
  code: string;
  title: string;
  subtitle?: string;
  url?: string;
  archived?: boolean;
}): Promise<ActionResult> {
  try {
    await core.saveRawSource(input);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}

/** Завести или поправить отчёт системы. Роли назначаются отдельно. */
export async function saveReport(input: {
  source: string;
  code: string;
  title: string;
  ru?: string;
  path?: string;
  archived?: boolean;
}): Promise<ActionResult> {
  try {
    await core.saveRawReport(input);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}

/**
 * Назначить роли колонок отчёта.
 *
 * Выбор идёт из настоящих заголовков последней выгрузки: роль, указывающая на
 * колонку, которой в отчёте нет, — это молчаливо сломанный срез.
 */
export async function setRoles(
  source: string,
  report: string,
  roles: Record<string, string>,
): Promise<ActionResult> {
  try {
    await core.setRawRoles(source, report, roles);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}

/**
 * Загрузка выгрузки файлом.
 *
 * До сих пор положить выгрузку мог только разработчик — скриптом, с ключом
 * приёма и туннелем до сервера. Пока это так, «заполнить источник» означало
 * «продиктовать разработчику»: роли колонок назначать не по чему, пока нет
 * первой выгрузки, а выгрузку не положить без чужих рук.
 *
 * Файл разбирается ЗДЕСЬ, на сервере оболочки, и уходит в Core тем же приёмом,
 * что и скрипт: сырой слой не знает, кто принёс строки, и правила у всех одни.
 */
export async function importFile(form: FormData): Promise<ActionResult & { rows?: number }> {
  const key = process.env.INGEST_KEY ?? "";
  if (key.length === 0) {
    return {
      ok: false,
      error: "Приём выгрузок выключен: INGEST_KEY не задан в окружении оболочки",
    };
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Файл не выбран" };

  const source = String(form.get("source") ?? "");
  const report = String(form.get("report") ?? "");
  const str = (name: string) => {
    const v = String(form.get(name) ?? "").trim();
    return v.length > 0 ? v : undefined;
  };

  const { text, encoding } = decodeUpload(new Uint8Array(await file.arrayBuffer()));
  const chosen = String(form.get("delimiter") ?? "");
  const parsed = parseDelimited(
    text,
    (DELIMITERS as readonly string[]).includes(chosen) ? (chosen as (typeof DELIMITERS)[number]) : undefined,
  );
  if (parsed.columns.length === 0) {
    return { ok: false, error: `Файл прочитан как ${encoding}, но заголовков в нём нет` };
  }
  if (parsed.rows.length === 0) {
    return { ok: false, error: `Файл прочитан как ${encoding}: одни заголовки, ни одной строки` };
  }

  // Время съёма: владелец называет его сам — это НЕ время загрузки. Именно оно
  // отвечает на вопрос «насколько свежо», и подменять его «сейчас» нельзя.
  const fetchedAt = str("fetchedAt") ?? new Date().toISOString();

  // Тело запроса ограничено, поэтому большая выгрузка идёт пачками. Каждая
  // несёт свою позицию: повтор после обрыва ляжет на место, а не хвостом.
  const CHUNK = 500;
  try {
    for (let i = 0; i < parsed.rows.length; i += CHUNK) {
      await core.importRaw(key, {
        source,
        report,
        fetchedAt,
        columns: parsed.columns,
        rows: parsed.rows.slice(i, i + CHUNK),
        offset: i,
        append: i > 0,
        periodFrom: str("periodFrom"),
        periodTo: str("periodTo"),
        account: str("account"),
        note:
          str("note") ??
          `Загружено файлом «${file.name}», прочитано как ${encoding}, разделитель «${
            parsed.delimiter === "\t" ? "таб" : parsed.delimiter
          }»${parsed.ragged > 0 ? `, строк с неровным числом ячеек: ${parsed.ragged}` : ""}`,
        importedBy: "owner",
      });
    }
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true, rows: parsed.rows.length };
}

/**
 * Заполнить фискальные поля карточки товара.
 *
 * Заполняется прямо из строки ассортимента: открывать каждую из четырнадцати
 * карточек по отдельности — час работы там, где нужна минута.
 *
 * Пустое поле разрешено: владелец может знать ИКПУ и ещё не знать ставку, и
 * это честное «не выяснили». А вот заполненное НЕВЕРНО не принимается —
 * карточка с огрызком ИКПУ выглядит готовой, а чек по ней не пройдёт.
 */
export async function saveFiscal(
  entityId: string,
  fields: Record<string, string>,
): Promise<ActionResult> {
  const patch: Record<string, string> = {};
  for (const f of FISCAL_FIELDS) {
    const v = (fields[f] ?? "").trim();
    if (v.length > 0) patch[f] = v;
  }
  // Проверяем ровно то, что вписали: незаполненное поле — не ошибка, а неверно
  // заполненное — ошибка, и о ней надо сказать до сохранения.
  const bad = fiscalGaps(patch).filter((g) => g.flaw === "неверно");
  if (bad.length > 0) {
    return { ok: false, error: bad.map((g) => `${g.field}: ${g.why}`).join("; ") };
  }
  try {
    const card = await core.entity(entityId);
    const attrs = { ...(card.attrs ?? {}) };
    for (const f of FISCAL_FIELDS) {
      const v = (fields[f] ?? "").trim();
      // Пустое значение стирает поле: владелец мог вписать не то и захотеть убрать.
      if (v.length > 0) attrs[f] = v;
      else delete attrs[f];
    }
    // attrs при правке заменяются целиком, поэтому сливаем, а не подставляем.
    await core.updateEntity(entityId, { attrs });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}

/**
 * Завести карточку товара сразу с фискальными полями.
 *
 * Один шаг вместо двух: заводить пустую карточку, чтобы потом её открыть и
 * дозаполнить, — лишняя работа там, где владелец уже знает значения.
 */
export async function createProductWithFiscal(
  source: string,
  label: string,
  fields: Record<string, string>,
): Promise<ActionResult> {
  const created = await createProductFromSource(source, label);
  if (!created.ok) return created;
  if (!FISCAL_FIELDS.some((f) => (fields[f] ?? "").trim().length > 0)) return created;
  try {
    const cards = await core.entitiesOfType("vendhub", "product");
    const card = cards.find((c) => c.name === label.trim());
    if (!card) return { ok: false, error: "Карточка заведена, но не нашлась для заполнения" };
    return await saveFiscal(card.id, fields);
  } catch (err) {
    return fail(err);
  }
}
