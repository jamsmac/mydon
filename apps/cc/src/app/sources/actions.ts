"use server";

import { revalidatePath } from "next/cache";
import {
  DELIMITERS,
  FISCAL_FIELDS,
  decodeUpload,
  fiscalGaps,
  looksLikeXlsx,
  parseDelimited,
  parseXlsx,
} from "@mydon/shared";
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
    // Карточка заведена ИЗ ИСТОЧНИКА, а не владельцем, поэтому ждёт его слова:
    // название взято из чужой панели, и фактом реестра оно станет, когда он
    // подтвердит. Видна она при этом сразу — иначе связывать было бы не с чем.
    const created = await core.createEntity({
      domain: "vendhub",
      type: "product",
      name,
      attrs: { источник: source },
      createdFrom: source,
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
 * Предложить точку в карточку автомата.
 *
 * Раньше значение писалось прямо в карточку. По правилу владельца данные по
 * автоматам и товарам, вписанные не им, фактом не считаются: адрес приходит из
 * чужой панели, поэтому он ЛОЖИТСЯ РЯДОМ и ждёт утверждения, а не подменяет
 * собой поле карточки.
 *
 * Совпадающее значение не предлагается — это шум, а не решение.
 */
export async function fillMachinePoint(machineId: string, point: string): Promise<ActionResult> {
  const value = point.trim();
  if (value.length === 0) return { ok: false, error: "Пустую точку записывать нечего" };
  try {
    await core.proposeField(machineId, {
      field: "точка",
      value,
      origin: "выгрузка источника",
      setBy: "source:gjvending",
      note: "адрес взят из заказов этого автомата",
    });
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true };
}

/** Слово владельца: утвердить карточку вместе со всем, что ей предложено. */
export async function approveEntity(id: string): Promise<ActionResult> {
  try {
    await core.approveEntity(id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  revalidatePath("/queue");
  return { ok: true };
}

/**
 * Утвердить все переданные карточки разом — «утвердить все новые» из очереди.
 *
 * Пустой список — не ошибка, а «нечего утверждать»: молча ничего не делаем.
 */
export async function approveAllCards(ids: string[]): Promise<ActionResult> {
  if (ids.length === 0) return { ok: true };
  try {
    await core.approveEntities(ids);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  revalidatePath("/queue");
  return { ok: true };
}

/** Утвердить одно предложенное значение. */
export async function approveField(id: string, field: string): Promise<ActionResult> {
  try {
    await core.approveField(id, field);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  revalidatePath("/queue");
  return { ok: true };
}

/** Отклонить предложенное значение: уходит без следа в карточке. */
export async function rejectField(id: string, field: string): Promise<ActionResult> {
  try {
    await core.rejectField(id, field);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  revalidatePath("/queue");
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
/** Совпадают ли заголовки листов (для объединения книги «лист 1/3, 2/3…»). */
function sameHeaders(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((h, i) => h === b[i]);
}

export async function importFile(
  form: FormData,
): Promise<ActionResult & { rows?: number; needsSheet?: boolean; sheets?: string[] }> {
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

  // Excel-файл (.xlsx) — это zip, а не текст: читаем его своим разбором. CSV/TSV
  // идут прежним путём. Что именно прочитали, попадёт в примечание снимка.
  const bytes = new Uint8Array(await file.arrayBuffer());
  let columns: string[];
  let rows: string[][];
  let readAs: string;
  if (looksLikeXlsx(bytes)) {
    const chosenSheet = str("sheet"); // выбранный владельцем лист (если уже выбрал)
    const mergeAll = String(form.get("mergeSheets") ?? "") === "1";
    try {
      const probe = await parseXlsx(bytes, chosenSheet);
      const sheetNames = probe.sheetNames;

      // Много листов, а владелец ещё не выбрал — НЕ глотаем первый молча:
      // возвращаем список, пусть выберет лист или отметит «объединить все».
      if (sheetNames.length > 1 && chosenSheet === undefined && !mergeAll) {
        return {
          ok: false,
          needsSheet: true,
          sheets: sheetNames,
          error:
            `В книге ${sheetNames.length} листа(ов): ${sheetNames.join(", ")}. ` +
            `Выбери, какой импортировать, или отметь «объединить все листы».`,
        };
      }

      if (mergeAll && sheetNames.length > 1) {
        // Объединяем листы с ТЕМИ ЖЕ заголовками (книга «лист 1/3, 2/3, 3/3»).
        // Иная структура — пропускаем с предупреждением, а не смешиваем молча.
        const first = await parseXlsx(bytes, sheetNames[0]);
        columns = first.columns;
        rows = [...first.rows];
        const skipped: string[] = [];
        for (const nm of sheetNames.slice(1)) {
          const s = await parseXlsx(bytes, nm);
          if (sameHeaders(s.columns, columns)) rows.push(...s.rows);
          else skipped.push(nm);
        }
        readAs =
          `Excel, объединено листов ${sheetNames.length - skipped.length}/${sheetNames.length}` +
          (skipped.length ? `; пропущены (другие заголовки): ${skipped.join(", ")}` : "");
      } else {
        columns = probe.columns;
        rows = probe.rows;
        const more = sheetNames.length > 1 ? ` (в книге ${sheetNames.length} листов)` : "";
        readAs =
          `Excel, лист «${probe.sheet}»${more}` +
          (probe.ragged > 0 ? `, строк с неровным числом ячеек: ${probe.ragged}` : "");
      }
    } catch (err) {
      return { ok: false, error: `Excel-файл не прочитался: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (columns.length === 0) return { ok: false, error: "В Excel-файле нет заголовков" };
    if (rows.length === 0) return { ok: false, error: "В Excel-файле одни заголовки, ни одной строки" };
  } else {
    const { text, encoding } = decodeUpload(bytes);
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
    columns = parsed.columns;
    rows = parsed.rows;
    readAs =
      `прочитано как ${encoding}, разделитель «${parsed.delimiter === "\t" ? "таб" : parsed.delimiter}»` +
      (parsed.ragged > 0 ? `, строк с неровным числом ячеек: ${parsed.ragged}` : "");
  }

  // Время съёма: владелец называет его сам — это НЕ время загрузки. Именно оно
  // отвечает на вопрос «насколько свежо», и подменять его «сейчас» нельзя.
  const fetchedAt = str("fetchedAt") ?? new Date().toISOString();

  // Тело запроса ограничено, поэтому большая выгрузка идёт пачками. Каждая
  // несёт свою позицию: повтор после обрыва ляжет на место, а не хвостом.
  const CHUNK = 500;
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await core.importRaw(key, {
        source,
        report,
        fetchedAt,
        columns,
        rows: rows.slice(i, i + CHUNK),
        offset: i,
        append: i > 0,
        periodFrom: str("periodFrom"),
        periodTo: str("periodTo"),
        account: str("account"),
        note: str("note") ?? `Загружено файлом «${file.name}», ${readAs}`,
        importedBy: "owner",
      });
    }
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/domain/vendhub");
  return { ok: true, rows: rows.length };
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
