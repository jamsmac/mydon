import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPricePeriods,
  compareColumns,
  csvCell,
  daysBefore,
  findLookalikes,
  interleaved,
  markOverlaps,
  normalizeRowsQuery,
  parseColumnFilters,
  priceAt,
  referencePrice,
  referenceSince,
  tightKey,
  timelineKey,
  toCsv,
} from "./raw.service";
import { fiscalGaps } from "@mydon/shared";

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
      [0, { value: "cash", exact: false }],
      [12, { value: "paid", exact: false }],
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

describe("Товары: без чего не собирается чек", () => {
  const full = { ИКПУ: "02201001001000000", упаковка: "стакан 0.2", НДС: "12%" };
  const of = (attrs: Record<string, unknown>) => fiscalGaps(attrs).map((g) => `${g.field}:${g.flaw}`);

  it("заполненная карточка не требует ничего", () => {
    assert.deepEqual(fiscalGaps(full), []);
  });

  it("пустое поле и пробелы — это «не выяснили», а не значение", () => {
    assert.deepEqual(of({ ИКПУ: "", упаковка: "   ", НДС: null }), [
      "ИКПУ:нет",
      "упаковка:нет",
      "НДС:нет",
    ]);
  });

  it("нулевая ставка НДС записана явно и полем считается", () => {
    // «0%» — законное значение для льготных позиций, а пустое поле значит, что
    // ставку не выясняли. Чек по первому соберётся, по второму нет.
    assert.deepEqual(fiscalGaps({ ...full, НДС: "0%" }), []);
    assert.deepEqual(fiscalGaps({ ...full, НДС: 0 }), []);
  });

  it("огрызок ИКПУ опаснее пустого: карточка выглядит заполненной, чек не пройдёт", () => {
    // Правило перенесено из mydon-stock (validate_fiscal) и VendHub-OS
    // (IKPU_CODE_REGEX): ровно 17 цифр. Своего мы не выдумываем — чек
    // принимает касса.
    const g = fiscalGaps({ ...full, ИКПУ: "0220100" });
    assert.deepEqual(g.map((x) => x.flaw), ["неверно"]);
    assert.match(g[0].why, /17 цифр, а тут 7/);
  });

  it("пробелы и дефисы в ИКПУ разницей не считаются", () => {
    assert.deepEqual(fiscalGaps({ ...full, ИКПУ: "02201-001 001000000" }), []);
  });

  it("буквы в ИКПУ — это неверно, а не «нет»", () => {
    assert.deepEqual(of({ ...full, ИКПУ: "0220100100100000A" }), ["ИКПУ:неверно"]);
  });

  it("ставка, которая не читается процентом, отмечается отдельно", () => {
    assert.deepEqual(of({ ...full, НДС: "как обычно" }), ["НДС:неверно"]);
    assert.deepEqual(of({ ...full, НДС: "180%" }), ["НДС:неверно"]);
  });

  it("дробная ставка через запятую читается", () => {
    assert.deepEqual(fiscalGaps({ ...full, НДС: "12,5" }), []);
  });

  it("карточки нет вовсе — не хватает всего", () => {
    assert.equal(fiscalGaps(null).length, 3);
  });

  it("посторонние поля карточки на фискализацию не влияют", () => {
    assert.deepEqual(fiscalGaps({ ...full, цена: 20000, категория: 10 }), []);
  });
});

describe("Товары: двойники под разными именами", () => {
  const p = (name: string, orders: number, revenue = orders * 20000) => ({ name, orders, revenue });
  const f = (product: string, flavour: string, orders: number) => ({ product, flavour, orders });

  it("«Какао» и Cocoa связываются общим вкусом — названия переводят, вкусы нет", () => {
    const hints = findLookalikes(
      [p("Cocoa", 130), p("Какао", 45)],
      [f("Cocoa", "Какао без сахара", 130), f("Какао", "Какао без сахара", 45)],
    );
    assert.deepEqual(
      hints.get("cocoa")?.map((h) => h.name),
      ["Какао"],
    );
    assert.match(hints.get("какао")?.[0].reason ?? "", /общий вкус «Какао без сахара» — 45 из 45/);
  });

  it("основание всегда с числами: по ним видно двойник это или подмена кнопки", () => {
    // Настоящий Espresso: 414 из 700 заказов пробиты его кнопкой, а приготовлен
    // MacCoffee. Вкус общий, но это не двойник. Числа в основании дают владельцу
    // это различить — за него код решать не имеет права.
    const hints = findLookalikes(
      [p("Espresso", 700), p("MacCoffee 3in1", 2000)],
      [
        f("Espresso", "Эспрессо", 286),
        f("Espresso", "MacCoffee с сахаром", 414),
        f("MacCoffee 3in1", "MacCoffee с сахаром", 2000),
      ],
    );
    assert.match(
      hints.get("espresso")?.[0].reason ?? "",
      /общий вкус «MacCoffee с сахаром» — 414 из 700 заказов/,
    );
  });

  it("одиночный чужой вкус основанием не считается", () => {
    const hints = findLookalikes(
      [p("Americano", 1000), p("Latte", 800)],
      [f("Americano", "Американо", 999), f("Americano", "Латте", 1), f("Latte", "Латте", 800)],
    );
    assert.equal(hints.get("americano"), undefined, "один заказ из тысячи — шум, а не признак");
  });

  it("вкус, встречающийся у половины ассортимента, не связывает ничего", () => {
    const items = ["A", "B", "C", "D", "E", "F"].map((n) => p(n, 100));
    const hints = findLookalikes(
      items,
      items.map((i) => f(i.name, "без сахара", 100)),
    );
    assert.equal(hints.size, 0, "«без сахара» — не признак одного напитка");
  });

  it("разница только в пробелах и знаках — механический двойник", () => {
    const hints = findLookalikes([p("MacCoffee 3in1", 100), p("MacCoffee 3-in-1", 40)], []);
    assert.deepEqual(hints.get("maccoffee 3in1"), [
      { name: "MacCoffee 3-in-1", reason: "то же название без пробелов и знаков" },
    ]);
  });

  it("товар не связывается сам с собой, как бы ни писался в выгрузке", () => {
    const hints = findLookalikes(
      [p("Ice Lemon Tea", 500)],
      [f("Ice Lemon Tea", "Ice tea", 300), f("ice lemon  tea", "Ice tea", 200)],
    );
    assert.equal(hints.size, 0);
  });

  it("подсказок не больше трёх — длинный список никто не читает", () => {
    const items = ["A", "B", "C", "D"].map((n) => p(n, 100));
    const hints = findLookalikes(
      items,
      items.map((i) => f(i.name, "шоколад", 100)),
    );
    assert.equal(hints.get("a")?.length, 3);
  });

  it("название без пробелов и знаков: регистр и «ё» тоже не считаются разницей", () => {
    assert.equal(tightKey("MacCoffee 3-in-1"), "maccoffee3in1");
    assert.equal(tightKey("Тёплый  чай!"), "теплыйчай");
  });
});

describe("Цены: касание хвостами — не примесь", () => {
  const b = (price: number, from: string, to: string, orders: number) => ({
    month: from.slice(0, 7),
    price,
    from,
    to,
    orders,
  });

  it("один поздний заказ по старой цене не выбрасывает отрезок новой", () => {
    // Дефект, найденный разбором: проверка сравнивала только границы вёдер,
    // поэтому единственный поздний заказ по старой цене (та самая подмена
    // кнопки) уничтожал весь отрезок новой цены вместе с сотнями заказов.
    // Дальше автомат, который цену как раз ПОДНЯЛ, попадал в отставшие с
    // выдуманным недобором.
    const { periods, mismatched } = buildPricePeriods([
      b(15000, "2026-06-01 08:00:00", "2026-06-20 12:00:00", 501),
      b(18000, "2026-06-16 09:00:00", "2026-06-30 20:00:00", 400),
    ]);
    assert.deepEqual(periods.map((p) => p.price), [15000, 18000], "цену подняли");
    assert.equal(periods[1].orders, 400, "заказы новой цены не потеряны");
    assert.equal(mismatched, 0);
  });

  it("зеркальный случай: старые заказы тоже не пропадают", () => {
    const { periods } = buildPricePeriods([
      b(15000, "2026-06-01 08:00:00", "2026-06-20 12:00:00", 300),
      b(18000, "2026-06-16 09:00:00", "2026-06-30 20:00:00", 400),
      b(18000, "2026-07-01 08:00:00", "2026-07-31 20:00:00", 800),
    ]);
    assert.deepEqual(periods.map((p) => p.price), [15000, 18000]);
    assert.equal(periods[0].orders, 300, "старая цена сохранила свои заказы");
    assert.equal(periods[0].from, "2026-06-01 08:00:00");
  });

  it("рассыпанная по всему отрезку чужая цена по-прежнему примесь", () => {
    // Espresso: чужие заказы идут вперемешку весь месяц, а не жмутся к краю.
    const { periods, mismatched } = buildPricePeriods([
      b(20000, "2026-06-02 09:00:00", "2026-06-29 21:00:00", 271),
      b(15000, "2026-06-03 10:00:00", "2026-06-28 18:00:00", 180),
    ]);
    assert.equal(periods.length, 1);
    assert.equal(periods[0].price, 20000);
    assert.equal(mismatched, 180);
  });

  it("одиночный заказ внутри чужого отрезка — примесь", () => {
    const { periods, mismatched } = buildPricePeriods([
      b(20000, "2026-06-01 08:00:00", "2026-06-30 20:00:00", 300),
      b(25000, "2026-06-15 12:00:00", "2026-06-15 12:00:00", 1),
    ]);
    assert.equal(periods.length, 1);
    assert.equal(mismatched, 1);
  });

  it("правило перекрытия проверяется отдельно", () => {
    const long = b(1, "2026-06-01 00:00:00", "2026-06-21 00:00:00", 1);
    const tail = b(2, "2026-06-19 00:00:00", "2026-07-01 00:00:00", 1);
    const inside = b(3, "2026-06-02 00:00:00", "2026-06-20 00:00:00", 1);
    const after = b(4, "2026-06-22 00:00:00", "2026-06-30 00:00:00", 1);
    assert.equal(interleaved(long, tail), false, "хвост в два дня — не примесь");
    assert.equal(interleaved(long, inside), true, "почти полное вложение — примесь");
    assert.equal(interleaved(long, after), false, "не пересекаются вовсе");
  });
});

describe("Цены: последняя известная цена держится после последнего заказа", () => {
  const t = [
    { price: 15000, from: "2026-06-01 08:00:00", to: "2026-07-25 20:00:00", orders: 100 },
  ];

  it("после последнего заказа цена не исчезает", () => {
    // Дефект, найденный разбором: цена «кончалась» вместе с последним заказом,
    // и при подсчёте большинства автомат, просто не продавший товар в тот день,
    // выпадал из счёта. Из-за этого недобор обнулялся целиком — ровно в том
    // случае, ради которого экран и сделан.
    assert.equal(priceAt(t, "2026-07-28 09:00:00"), 15000);
  });

  it("до первого заказа цены действительно не было", () => {
    assert.equal(priceAt(t, "2026-05-01 00:00:00"), null);
  });

  it("эталон не теряется из-за того, что часть автоматов молчала в этот день", () => {
    const line = (...steps: [number, string, string][]) =>
      steps.map(([price, from, to]) => ({ price, from, to, orders: 100 }));
    const timelines = [
      line([15000, "2026-06-01 08:00:00", "2026-07-25 20:00:00"]),
      line([15000, "2026-06-01 08:00:00", "2026-07-25 20:00:00"]),
      line(
        [12000, "2026-06-01 08:00:00", "2026-07-10 20:00:00"],
        [11000, "2026-07-28 09:00:00", "2026-07-30 20:00:00"],
      ),
    ];
    assert.equal(referencePrice([15000, 15000, 11000]), 15000);
    assert.equal(
      referenceSince(timelines, 15000),
      "2026-06-01 08:00:00",
      "большинство держится с самого начала, и поздняя смена цены у отставшего его не рушит",
    );
  });
});

describe("Товары: подсказка двойника требует оснований с обеих сторон", () => {
  const p = (name: string, orders: number, revenue = orders * 20000) => ({ name, orders, revenue });
  const f = (product: string, flavour: string, orders: number) => ({ product, flavour, orders });

  it("три чужих заказа не связывают товар на 80 млн с чужой карточкой", () => {
    // Дефект, найденный разбором: порог проверялся только у той стороны, на
    // чьей строке встаёт подсказка. У Latte доля 4000/4000, поэтому подсказка
    // появлялась, хотя всё основание — три заказа Cappuccino. Владелец читал в
    // основании числа Latte и одним кликом вешал его выручку на чужую карточку.
    const hints = findLookalikes(
      [p("Latte", 4000), p("Cappuccino", 5200)],
      [
        f("Latte", "Латте классический", 4000),
        f("Cappuccino", "Капучино", 5197),
        f("Cappuccino", "Латте классический", 3),
      ],
    );
    assert.equal(hints.get("latte"), undefined, "три заказа — не основание");
    assert.equal(hints.get("cappuccino"), undefined);
  });

  it("настоящий двойник связывается по-прежнему и показывает обе стороны", () => {
    const hints = findLookalikes(
      [p("Cocoa", 130), p("Какао", 45)],
      [f("Cocoa", "Какао без сахара", 130), f("Какао", "Какао без сахара", 45)],
    );
    assert.match(hints.get("cocoa")?.[0].reason ?? "", /130 из 130 заказов здесь и 45 из 45 там/);
  });
});

describe("Сырой слой: точный фильтр по колонке", () => {
  it("по умолчанию ищется вхождение — «кардио» находит все точки кардиологии", () => {
    const f = parseColumnFilters({ f5: "кардио" });
    assert.deepEqual(f.get(5), { value: "кардио", exact: false });
  });

  it("«=» перед значением ищет целиком: cash не должен открывать cash0", () => {
    // При сверке с выпиской платёжной системы подмена одного канала другим
    // дорого стоит, поэтому у кодов нужен точный поиск.
    assert.deepEqual(parseColumnFilters({ f6: "=cash" }).get(6), { value: "cash", exact: true });
  });

  it("«=» без значения — мусор в адресе, а не фильтр «пусто»", () => {
    assert.equal(parseColumnFilters({ f6: "=" }).size, 0);
    assert.equal(parseColumnFilters({ f6: "=   " }).size, 0);
  });
});

describe("Цены: ключ пары «автомат + товар»", () => {
  it("разные написания дают один ключ — автомат не считается дважды", () => {
    assert.equal(
      timelineKey("6620191F0000", "Ice Lemon Tea"),
      timelineKey("6620191f0000", "ice lemon  tea"),
    );
  });

  it("серийник с пробелом не склеивается с чужим названием", () => {
    assert.notEqual(timelineKey("aa bb", "Tea"), timelineKey("aa", "bb Tea"));
  });
});

describe("Цены: одна цена в месяце — одно ведро", () => {
  it("два написания товара не спорят между собой за один месяц", () => {
    // «Ice Lemon Tea» и «ice lemon  tea» приходят разными строками, но это одна
    // и та же цена. Без склейки второе ведро уходило в примесь, и треть заказов
    // пропадала из счёта.
    const { periods, mismatched } = buildPricePeriods([
      { month: "2026-06", price: 20000, from: "2026-06-01 08:00:00", to: "2026-06-30 20:00:00", orders: 20 },
      { month: "2026-06", price: 20000, from: "2026-06-01 09:00:00", to: "2026-06-30 21:00:00", orders: 10 },
    ]);
    assert.equal(periods.length, 1);
    assert.equal(periods[0].orders, 30, "заказы обоих написаний в счёте");
    assert.equal(periods[0].from, "2026-06-01 08:00:00", "начало — самое раннее из двух");
    assert.equal(periods[0].to, "2026-06-30 21:00:00");
    assert.equal(mismatched, 0, "одна цена сама себе не примесь");
  });
});
