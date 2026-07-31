"use server";

import { revalidatePath } from "next/cache";
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
