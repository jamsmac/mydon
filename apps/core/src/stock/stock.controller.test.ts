import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { ImportBatchesDto } from "./stock.controller";

/**
 * Проверки на уровне DTO — отдельный слой, и он опаснее, чем кажется.
 *
 * `ValidationPipe` в `main.ts` отбивает запрос ЦЕЛИКОМ до входа в контроллер.
 * Пока у строки импорта стояли `@IsPositive()` и `@Min(0)`, одна плохая строка
 * реестра (нулевое количество, отрицательная цена — обычное дело в живой
 * таблице на 135 строк) отвергала ВЕСЬ импорт и возвращала невнятный объект
 * ошибок вместо построчного отчёта. Сервисные тесты этого не ловили: они зовут
 * `importBatches` напрямую, минуя слой DTO.
 */
describe("ImportBatchesDto: одна плохая строка не должна ронять пачку", () => {
  const годная = {
    fileRow: 14,
    ingredientId: "efc7d1d1-708d-436d-8d9a-36e80c594f6b", // Кофе, живой id
    warehouseId: "21b3966c-c33e-44b2-9257-55ac3440bf9f", // Основной склад
    qtyReceived: 50,
    unit: "кг",
    receivedOn: "2025-05-13",
    unitPriceGross: 239000,
  };

  it("смешанная пачка проходит слой DTO целиком", async () => {
    const dto = plainToInstance(ImportBatchesDto, {
      source: "excel",
      dryRun: true,
      items: [
        годная,
        { ...годная, fileRow: 15, qtyReceived: 0 },
        { ...годная, fileRow: 16, unitPriceGross: -100 },
      ],
    });
    const errors = await validate(dto);
    assert.deepEqual(
      errors,
      [],
      "плохие строки обязаны дойти до сервиса и попасть в отчёт с причиной, а не отбить весь запрос",
    );
  });

  it("тип по-прежнему проверяется: строка вместо числа — ошибка", async () => {
    const dto = plainToInstance(ImportBatchesDto, {
      source: "excel",
      items: [{ ...годная, qtyReceived: "пятьдесят" }],
    });
    const errors = await validate(dto);
    assert.ok(errors.length > 0, "нечисло в количестве — это ошибка формата, а не данных");
  });
});
