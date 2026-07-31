import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPricePeriods,
  compareColumns,
  csvCell,
  daysBefore,
  markOverlaps,
  normalizeRowsQuery,
  parseColumnFilters,
  priceAt,
  referencePrice,
  referenceSince,
  toCsv,
} from "./raw.service";

describe("Сырой слой: разбор параметров страницы", () => {
  it("номера колонок и страниц берутся только целыми и положительными", () => {
    const q = normalizeRowsQuery({ page: "3", size: "50", sort: "4", dir: "desc" });
    assert.equal(q.page, 3);
    assert.equal(q.size, 50);
    assert.equal(q.offset, 100);
    assert.equal(q.sort, 4);
    assert.equal(q.dir, "desc");
  });

  it("мусор в адресе не роняет страницу, а откатывается к умолчаниям", () => {
    const q = normalizeRowsQuery({ page: "-2", size: "abc", sort: "1.5", dir: "вниз" });
    assert.equal(q.page, 1);
    assert.equal(q.size, 100);
    assert.equal(q.sort, null, "дробный номер колонки — не колонка");
    assert.equal(q.dir, "asc");
  });

  it("размер страницы ограничен сверху: одним запросом всю выгрузку не вытянуть", () => {
    assert.equal(normalizeRowsQuery({ size: "999999" }).size, 1000);
  });

  it("попытка подставить в номер колонки не-число отбрасывается", () => {
    // Номер колонки — единственное, что уходит в текст SQL-запроса,
    // поэтому проверяем его отдельно и придирчиво.
    for (const bad of ["0; drop table raw_row", "1e3", "-1", "99999", ""]) {
      assert.equal(normalizeRowsQuery({ sort: bad }).sort, null, `пропущено: ${bad}`);
    }
    assert.equal(normalizeRowsQuery({ sort: "0" }).sort, 0, "нулевая колонка допустима");
  });
});

describe("Сырой слой: фильтры по колонкам", () => {
  it("читаются только ключи вида f<число>, остальное игнорируется", () => {
    const f = parseColumnFilters({ f0: "cash", f12: "paid", q: "поиск", foo: "bar", fx: "1" });
    assert.deepEqual([...f.entries()], [
      [0, "cash"],
      [12, "paid"],
    ]);
  });

  it("пустой фильтр не считается фильтром", () => {
    assert.equal(parseColumnFilters({ f0: "   ", f1: "" }).size, 0);
  });

  it("номер колонки за пределами разумного отбрасывается", () => {
    assert.equal(parseColumnFilters({ f9999: "x" }).size, 0);
  });
});

describe("Сырой слой: выгрузка в CSV", () => {
  it("разделитель — точка с запятой, значения со спецсимволами в кавычках", () => {
    assert.equal(csvCell("Americano"), "Americano");
    assert.equal(csvCell("цена; со скидкой"), '"цена; со скидкой"');
    assert.equal(csvCell('он сказал "да"'), '"он сказал ""да"""');
    assert.equal(csvCell("две\nстроки"), '"две\nстроки"');
  });

  it("шапка повторяет колонки источника, порядок сохраняется", () => {
    const csv = toCsv(
      ["Order number", "Goods name", "Order price"],
      [
        { idx: 1, cells: ["ff0001", "Ice Lemon Tea", "15000"] },
        { idx: 2, cells: ["ud1782", "MacCoffee 3in1", "15000.00"] },
      ],
    );
    const lines = csv.split("\r\n");
    assert.equal(lines[0], "﻿#;Order number;Goods name;Order price");
    assert.equal(lines[1], "1;ff0001;Ice Lemon Tea;15000");
    assert.equal(lines[2], "2;ud1782;MacCoffee 3in1;15000.00");
  });

  it("цифры не приводятся к числу: «15000.00» остаётся как в источнике", () => {
    const csv = toCsv(["Order price"], [{ idx: 1, cells: ["15000.00"] }]);
    assert.ok(csv.includes("15000.00"), "приведение типов на сыром слое запрещено");
  });
});

describe("Сырой слой: дрейф состава колонок", () => {
  const base = ["Order number", "Goods name", "Machine Code"];

  it("одинаковый состав — дрейфа нет", () => {
    const d = compareColumns(base, [...base]);
    assert.deepEqual(d, { added: [], removed: [], reordered: false });
  });

  it("появилась и пропала колонка — обе названы", () => {
    const d = compareColumns(base, ["Order number", "Machine Code", "Cup type"]);
    assert.deepEqual(d.added, ["Cup type"]);
    assert.deepEqual(d.removed, ["Goods name"]);
  });

  it("перестановка при том же составе замечается", () => {
    const d = compareColumns(base, ["Machine Code", "Order number", "Goods name"]);
    assert.equal(d.reordered, true);
    assert.deepEqual(d.added, []);
    assert.deepEqual(d.removed, []);
  });

  it("о перестановке не сообщаем, когда состав и так изменился", () => {
    // Владельцу важнее пропажа колонки: «ещё и переставлены» только шумит.
    const d = compareColumns(base, ["Machine Code", "Order number"]);
    assert.equal(d.reordered, false);
    assert.deepEqual(d.removed, ["Goods name"]);
  });

  it("регистр и лишние пробелы не считаются изменением", () => {
    const d = compareColumns(base, ["order number", "  Goods   name", "MACHINE CODE"]);
    assert.deepEqual(d, { added: [], removed: [], reordered: false });
  });
});

describe("История стоянок: переезд или путаница", () => {
  const stay = (point: string, from: string, to: string, orders = 1) => ({ point, from, to, orders });

  it("отрезки упорядочиваются по времени, а не по тому, как легли в базу", () => {
    const r = markOverlaps([
      stay("4 корпус", "2025-05-21 20:05:10", "2026-04-26 15:40:07"),
      stay("宁波乐仝", "2024-05-21 15:05:51", "2024-10-11 14:06:17"),
      stay("hamid alimjan", "2024-10-11 16:13:29", "2025-05-21 17:31:29"),
    ]);
    assert.deepEqual(r.map((x) => x.point), ["宁波乐仝", "hamid alimjan", "4 корпус"]);
  });

  it("переезд в тот же день пересечением не считается", () => {
    // Настоящий случай 039ec91c0000: последний заказ на старой точке в 14:06,
    // первый на новой в 16:13 того же дня. Это переезд, а не путаница.
    const r = markOverlaps([
      stay("宁波乐仝", "2024-05-21 15:05:51", "2024-10-11 14:06:17"),
      stay("hamid alimjan", "2024-10-11 16:13:29", "2025-05-21 17:31:29"),
    ]);
    assert.deepEqual(r.map((x) => x.overlaps), [false, false]);
  });

  it("пересечение помечается у обоих отрезков", () => {
    const r = markOverlaps([
      stay("A", "2025-01-01 10:00:00", "2025-06-01 10:00:00"),
      stay("B", "2025-03-01 10:00:00", "2025-09-01 10:00:00"),
    ]);
    assert.deepEqual(r.map((x) => x.overlaps), [true, true]);
  });

  it("единственная точка — переездов не было", () => {
    const r = markOverlaps([stay("Logistics", "2025-01-01 10:00:00", "2026-07-31 10:00:00", 900)]);
    assert.equal(r.length, 1);
    assert.equal(r[0].overlaps, false);
  });

  it("время сравнивается как строки — формат источника это позволяет", () => {
    // «2024-10-11 14:06:17» < «2024-10-11 16:13:29» и как строки, и как даты.
    // Приводить к датам на сыром слое незачем, и тест это закрепляет.
    const r = markOverlaps([
      stay("B", "2024-10-11 16:13:29", "2024-12-01 10:00:00"),
      stay("A", "2024-10-11 09:00:00", "2024-10-11 14:06:17"),
    ]);
    assert.deepEqual(r.map((x) => x.point), ["A", "B"]);
    assert.deepEqual(r.map((x) => x.overlaps), [false, false]);
  });
});

describe("Цены: отрезок, а не поле", () => {
  const bucket = (month: string, price: number, from: string, to: string, orders: number) => ({
    month,
    price,
    from: `${month}-${from}`,
    to: `${month}-${to}`,
    orders,
  });

  it("одна цена весь период — отрезок один, смен нет", () => {
    const { periods, mismatched } = buildPricePeriods([
      bucket("2026-05", 15000, "01 08:00:00", "31 20:00:00", 210),
      bucket("2026-06", 15000, "01 08:00:00", "30 20:00:00", 190),
    ]);
    assert.equal(periods.length, 1);
    assert.deepEqual(periods[0], {
      price: 15000,
      from: "2026-05-01 08:00:00",
      to: "2026-06-30 20:00:00",
      orders: 400,
    });
    assert.equal(mismatched, 0);
  });

  it("цену подняли между месяцами — два отрезка", () => {
    const { periods } = buildPricePeriods([
      bucket("2026-05", 15000, "01 08:00:00", "31 20:00:00", 210),
      bucket("2026-06", 20000, "01 08:00:00", "30 20:00:00", 190),
    ]);
    assert.deepEqual(periods.map((p) => p.price), [15000, 20000]);
    assert.equal(periods[1].from, "2026-06-01 08:00:00");
  });

  it("цену подняли внутри месяца — граница по первому заказу новой цены", () => {
    // Старая цена кончается раньше, чем начинается новая: это смена, и не важно,
    // что обе попали в один месяц.
    const { periods, mismatched } = buildPricePeriods([
      bucket("2026-06", 15000, "01 08:00:00", "14 19:00:00", 120),
      bucket("2026-06", 20000, "15 09:12:00", "30 20:00:00", 140),
    ]);
    assert.deepEqual(periods.map((p) => p.price), [15000, 20000]);
    assert.equal(periods[1].from, "2026-06-15 09:12:00");
    assert.equal(mismatched, 0);
  });

  it("две цены вперемешку сменой не считаются — это подмена кнопки", () => {
    // Настоящий случай Espresso: из 700 наличных продаж 271 — настоящий
    // эспрессо, остальные пробиты этой кнопкой, а приготовлен другой напиток.
    // Деньги там правильные, но принадлежат не этому товару.
    const { periods, mismatched } = buildPricePeriods([
      bucket("2026-06", 20000, "02 09:00:00", "29 21:00:00", 271),
      bucket("2026-06", 15000, "03 10:00:00", "28 18:00:00", 180),
      bucket("2026-06", 25000, "07 11:00:00", "21 12:00:00", 90),
    ]);
    assert.equal(periods.length, 1, "цена одна: остальное — примесь");
    assert.equal(periods[0].price, 20000);
    assert.equal(periods[0].orders, 271, "чужие заказы в цену товара не идут");
    assert.equal(mismatched, 270);
  });

  it("одиночный заказ между двумя отрезками одной цены — сбой, а не смена", () => {
    const { periods, mismatched } = buildPricePeriods([
      bucket("2026-04", 20000, "01 08:00:00", "30 20:00:00", 300),
      bucket("2026-05", 5000, "10 12:00:00", "10 12:00:00", 1),
      bucket("2026-06", 20000, "01 08:00:00", "30 20:00:00", 280),
    ]);
    assert.equal(periods.length, 1, "цена не менялась");
    assert.equal(periods[0].orders, 580, "заказ по сбойной цене в неё не засчитан");
    assert.equal(mismatched, 1);
  });

  it("короткий отрезок остаётся, когда соседи не сходятся между собой", () => {
    // Слева 15 000, справа 25 000 — промежуточные 20 000 из двух заказов могут
    // быть настоящим шагом. Выбрасывать их значило бы стереть смену цены.
    const { periods } = buildPricePeriods([
      bucket("2026-04", 15000, "01 08:00:00", "30 20:00:00", 300),
      bucket("2026-05", 20000, "10 12:00:00", "11 12:00:00", 2),
      bucket("2026-06", 25000, "01 08:00:00", "30 20:00:00", 280),
    ]);
    assert.deepEqual(periods.map((p) => p.price), [15000, 20000, 25000]);
  });

  it("цена вернулась к прежней — это два отрезка, а не один", () => {
    const { periods } = buildPricePeriods([
      bucket("2026-04", 15000, "01 08:00:00", "30 20:00:00", 100),
      bucket("2026-05", 20000, "01 08:00:00", "31 20:00:00", 100),
      bucket("2026-06", 15000, "01 08:00:00", "30 20:00:00", 100),
    ]);
    assert.deepEqual(periods.map((p) => p.price), [15000, 20000, 15000]);
    assert.equal(periods[2].from, "2026-06-01 08:00:00");
  });

  it("вёдра приходят в любом порядке — отрезки всё равно по времени", () => {
    const { periods } = buildPricePeriods([
      bucket("2026-06", 20000, "01 08:00:00", "30 20:00:00", 190),
      bucket("2026-05", 15000, "01 08:00:00", "31 20:00:00", 210),
    ]);
    assert.deepEqual(periods.map((p) => p.price), [15000, 20000]);
  });

  it("пусто — не ноль, а отсутствие отрезков", () => {
    assert.deepEqual(buildPricePeriods([]), { periods: [], mismatched: 0 });
  });
});

describe("Цены: чему верить в разнобое", () => {
  it("цена большинства — эталон", () => {
    assert.equal(referencePrice([20000, 20000, 20000, 15000]), 20000);
  });

  it("поровну — большинства нет, эталон выдумывать нельзя", () => {
    assert.equal(referencePrice([20000, 20000, 15000, 15000]), null);
  });

  it("один автомат — он и есть большинство", () => {
    assert.equal(referencePrice([15000]), 15000);
  });

  it("считать не с чего — null, а не ноль", () => {
    assert.equal(referencePrice([]), null);
  });
});

describe("Цены: с какого момента считать недобор", () => {
  /** Отрезки идут встык, но не внахлёст: новая цена начинается после старой. */
  const line = (...steps: [number, string, string][]) =>
    steps.map(([price, from, to]) => ({ price, from, to, orders: 100 }));
  const END = "2026-07-31 23:59:59";

  it("цена в момент времени берётся из отрезка, который его накрывает", () => {
    const t = line(
      [15000, "2026-01-01 08:00:00", "2026-03-31 20:00:00"],
      [20000, "2026-04-01 09:00:00", END],
    );
    assert.equal(priceAt(t, "2026-02-01 00:00:00"), 15000);
    assert.equal(priceAt(t, "2026-05-01 00:00:00"), 20000);
    assert.equal(priceAt(t, "2025-12-01 00:00:00"), null, "до первого заказа цены не было");
  });

  it("недобор считается не с первого поднявшего, а с момента большинства", () => {
    // Первый автомат поднял цену в марте, второй — в апреле, третий не поднял.
    // В марте большинства ещё нет: один против двух. Оно складывается только в
    // апреле, и лишь с этого момента третий автомат становится отставшим.
    const timelines = [
      line([15000, "2026-01-01 08:00:00", "2026-02-28 20:00:00"], [20000, "2026-03-01 09:00:00", END]),
      line([15000, "2026-01-01 08:00:00", "2026-03-31 20:00:00"], [20000, "2026-04-01 09:00:00", END]),
      line([15000, "2026-01-01 08:00:00", END]),
    ];
    assert.equal(referenceSince(timelines, 20000), "2026-04-01 09:00:00");
  });

  it("большинство не сложилось — требовать недобор не за что", () => {
    const timelines = [
      line([15000, "2026-01-01 08:00:00", "2026-02-28 20:00:00"], [20000, "2026-03-01 09:00:00", END]),
      line([15000, "2026-01-01 08:00:00", END]),
    ];
    assert.equal(referenceSince(timelines, 20000), null, "один против одного — не большинство");
  });

  it("большинство потерялось и сложилось заново — берётся последний отрезок", () => {
    // Автомат откатил цену назад, большинство рассыпалось, потом собралось
    // снова. Считать недобор с первого раза значило бы приписать чужие месяцы.
    const timelines = [
      line(
        [20000, "2026-01-01 08:00:00", "2026-02-28 20:00:00"],
        [15000, "2026-03-01 09:00:00", "2026-05-31 20:00:00"],
        [20000, "2026-06-01 09:00:00", END],
      ),
      line([20000, "2026-01-01 08:00:00", END]),
      line([15000, "2026-01-01 08:00:00", END]),
    ];
    assert.equal(referenceSince(timelines, 20000), "2026-06-01 09:00:00");
  });
});

describe("Цены: молчащий автомат — не отставший", () => {
  it("отсчёт ведётся от последнего заказа в выгрузке, а не от сегодня", () => {
    assert.equal(daysBefore("2026-07-30 21:15:00", 14), "2026-07-16");
    assert.equal(daysBefore("2026-03-05 10:00:00", 14), "2026-02-19", "через границу месяца");
  });

  it("нечитаемое время не роняет расчёт", () => {
    assert.equal(daysBefore("", 14), "");
  });
});
