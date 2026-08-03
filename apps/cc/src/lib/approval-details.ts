import { core, type Approval } from "./core";
import { summarizeCoffeeImport, type CoffeeImportPart } from "./coffee-import-summary";

/**
 * Сводки «что внутри» для карточек согласований (сейчас — импорт кофе).
 *
 * Считается на сервере: payload импорта — тысячи строк, в браузер он не едет.
 * Справочник точек нужен только когда среди согласований есть импорт —
 * лишний запрос на каждый рендер входящих не делаем.
 */
/**
 * Убрать payload перед передачей в клиентский компонент: Next сериализует
 * пропсы целиком, и импорт на тысячи строк уехал бы в HTML каждой страницы.
 * Карточке payload не нужен — что внутри, говорит сводка.
 */
export function stripPayload(a: Approval): Approval {
  const { payload: _payload, ...rest } = a;
  return rest;
}

export async function coffeeImportDetails(
  approvals: Approval[],
): Promise<Map<string, CoffeeImportPart[]>> {
  const out = new Map<string, CoffeeImportPart[]>();
  const hasImport = approvals.some(
    (a) => a.payload !== null && typeof a.payload === "object" && "coffeeImport" in (a.payload ?? {}),
  );
  if (!hasImport) return out;

  let nameById = new Map<string, string>();
  try {
    nameById = new Map((await core.coffeeLocations()).map((l) => [l.id, l.name]));
  } catch {
    // Сводка без имён точек полезнее, чем упавший экран входящих.
  }
  const locationName = (id: string) => nameById.get(id) ?? null;

  for (const a of approvals) {
    const parts = summarizeCoffeeImport(a.payload, locationName);
    if (parts) out.set(a.id, parts);
  }
  return out;
}
