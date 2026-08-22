/**
 * Норма расхода сырья из состава карточки товара (срез F «норма-факт»,
 * задача 1).
 *
 * ЗАЧЕМ РЯДОМ ЖИВУТ ДВЕ ПОХОЖИЕ ФУНКЦИИ. В `./recipe` есть `parseRecipe` —
 * он разбирает состав для карточек и склада (себестоимость по текущим ценам,
 * планограмма и т.п.): поля `ingredientId`/`quantity`, вход — целиком `attrs`
 * карточки, а пустой/битый состав там ОСОЗНАННО тихо превращается в `[]`
 * (для тех задач отсутствующая строка просто не даёт вклада в сумму — это
 * корректно). `parseNormRecipe` здесь — для другой задачи: норма расхода,
 * которую потом сравнивают с фактом залитого сырья. На пустом входе она
 * отдаёт ОШИБКУ, а не `[]`, потому что «рецепт неизвестен» и «норма ноль
 * граммов» — противоположные вещи: ноль означал бы, что всё залитое сырьё —
 * перерасход, и витрина обвинила бы точку в недостаче на пустом месте. Из-за
 * этого нельзя переиспользовать `./recipe::parseRecipe` напрямую и нельзя
 * называть здешние функции так же — один и тот же общий пакет не должен
 * скрывать под одинаковым именем два разных ответа на вопрос «состава нет».
 * Поэтому имена разведены уже ВНУТРИ файла (`NormRecipeLine`/
 * `parseNormRecipe`), не только в барреле `index.ts` — если кто-то однажды
 * «упростит» экспорт обратно в `RecipeLine`/`parseRecipe`, то хотя бы не
 * ambiguous-коллизией в барреле, а явным переименованием на виду.
 *
 * ГДЕ ЛЕЖИТ РЕЦЕПТ. `entity.attrs['состав']` — JSON-массив строк. На проде
 * (проверено вживую) строка выглядит так:
 * `{"ingredientId": "43b93a5b-...", "quantity": 20.2, "unit": "г"}`
 * (UUID карточки ингредиента, число, единица). Разбор здесь принимает и эту
 * форму, и уже-читаемую (`ingredient`/`qty`) — вторая используется в
 * фикстурах тестов и как формат, в который эта функция приводит результат:
 * `ingredient` — тот же идентификатор, что был во входной строке
 * (`ingredient`, если он есть, иначе `ingredientId`); разрешение UUID в имя
 * ингредиента — забота вызывающего кода (там есть доступ к реестру карточек),
 * не этого чистого разбора.
 *
 * ЛОВУШКА ЕДИНИЦ. Стакан считается в штуках (`unit: "шт"`), а не в граммах.
 * Прежний код зашивал `unit: "г"` и терял стакан как статью себестоимости
 * (25 252 шт за окно). `normFor` единицу не трогает и не переводит —
 * она остаётся такой же, как в строке состава.
 */

/** Строка состава карточки: сколько ингредиента на одну порцию. */
export interface NormRecipeLine {
  ingredient: string;
  qty: number;
  unit: string;
}

/**
 * Число из значения строки состава. Карточки заводились руками: чистим
 * пробелы всех видов (включая неразрывный U+00A0 и узкий неразрывный U+202F)
 * и запятую как десятичный разделитель — тот же приём, что в
 * `ingredient-price.ts`/`combine.ts`/`reconcile.ts`/`unify.ts`. Не число —
 * `null`, а не 0.
 */
function toNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const s = v.replace(/[\s\u00A0\u202F]/g, "").replace(",", ".");
  if (s.length === 0 || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Разбор `entity.attrs['состав']` в строки рецепта для нормы расхода.
 *
 * Пустой или отсутствующий состав — это «рецепт неизвестен», а не «норма
 * ноль граммов»: разница принципиальна для сверки норма/факт (ноль означал
 * бы, что всё залитое сырьё — перерасход). Поэтому на пустом/отсутствующем
 * входе и на любой битой строке — `{ error }` с конкретикой (позиция,
 * поле, значение), а не молчаливый `[]` (в отличие от `./recipe::parseRecipe`,
 * см. шапку файла).
 */
export function parseNormRecipe(raw: unknown): NormRecipeLine[] | { error: string } {
  if (raw === null || raw === undefined) {
    return { error: "состав не задан: атрибут «состав» отсутствует — рецепт неизвестен" };
  }
  if (!Array.isArray(raw)) {
    return { error: `состав должен быть списком строк рецепта, получено значение типа "${typeof raw}": ${JSON.stringify(raw)}` };
  }
  if (raw.length === 0) {
    return { error: "состав пуст: ни одной строки рецепта — рецепт неизвестен, это не «ноль граммов»" };
  }

  const lines: NormRecipeLine[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== "object" || item === null) {
      return { error: `состав[${i}]: строка рецепта должна быть объектом, получено ${JSON.stringify(item)}` };
    }
    const rec = item as Record<string, unknown>;

    const ingredientRaw = typeof rec.ingredient === "string" ? rec.ingredient : rec.ingredientId;
    if (typeof ingredientRaw !== "string" || ingredientRaw.trim().length === 0) {
      return {
        error: `состав[${i}]: не задан ингредиент (поле "ingredient" или "ingredientId"), получено ${JSON.stringify(
          rec.ingredient ?? rec.ingredientId,
        )}`,
      };
    }

    const qtyRaw = rec.qty ?? rec.quantity;
    const qty = toNumber(qtyRaw);
    if (qty === null) {
      return {
        error: `состав[${i}] (${ingredientRaw}): поле "qty"/"quantity" не число, получено ${JSON.stringify(qtyRaw)}`,
      };
    }
    if (qty < 0) {
      return { error: `состав[${i}] (${ingredientRaw}): отрицательное количество ${qty} — ошибка ввода` };
    }

    const unitRaw = rec.unit;
    if (typeof unitRaw !== "string" || unitRaw.trim().length === 0) {
      return { error: `состав[${i}] (${ingredientRaw}): не задана единица измерения (поле "unit"), получено ${JSON.stringify(unitRaw)}` };
    }

    lines.push({ ingredient: ingredientRaw, qty, unit: unitRaw });
  }
  return lines;
}

/**
 * Норма на N порций: по каждому ингредиенту — количество на партию и его
 * единица как в составе (штуки в граммы не переводятся, см. ловушку в
 * шапке файла). Один ингредиент в рецепте встречается один раз — если вдруг
 * повторился с той же единицей, количества складываются; с другой единицей —
 * запись строки состава побеждает (перевод единиц — не задача этой функции).
 */
export function normFor(lines: NormRecipeLine[], cups: number): Map<string, { qty: number; unit: string }> {
  const out = new Map<string, { qty: number; unit: string }>();
  for (const line of lines) {
    const qty = line.qty * cups;
    const existing = out.get(line.ingredient);
    if (existing && existing.unit === line.unit) {
      out.set(line.ingredient, { qty: existing.qty + qty, unit: line.unit });
    } else {
      out.set(line.ingredient, { qty, unit: line.unit });
    }
  }
  return out;
}
