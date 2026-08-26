import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parityStreak, PARITY_STREAK_WINDOW, type ParityEventRow } from "./parity-streak";

/** Событие daily() как оно ложится в журнал: ключи русские (ourvend-parity.service.ts). */
const дн = (date: string, over: Record<string, unknown> = {}): ParityEventRow => ({
  occurredAt: new Date(`${date}T08:40:00+05:00`),
  payload: {
    ok: true,
    дней: 7,
    сверено_пар: 14,
    расхождений: 0,
    остатки_сверено: 68,
    остатки_расхождений: 0,
    примечание: null,
    ...over,
  },
});
const красный = (date: string): ParityEventRow => дн(date, { ok: false, расхождений: 2 });
/** Единственное прод-событие 25.08: старая сборка, полей остатков в payload НЕТ вовсе. */
const старая = (date: string): ParityEventRow => ({
  occurredAt: new Date(`${date}T08:40:00+05:00`),
  payload: { ok: true, дней: 7, сверено_пар: 14, расхождений: 0 },
});

describe("Серия зелёных дней паритета (R-P8b-1, R-P8b-2)", () => {
  it("семь подряд, считая сегодняшний, открывают переключение", () => {
    const дни = ["08-20", "08-21", "08-22", "08-23", "08-24", "08-25", "08-26"].map((d) => дн(`2026-${d}`));
    const s = parityStreak(дни, 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.readyForCutover, s.since, s.lastRed], [7, true, "2026-08-20", null]);
    assert.equal(s.threshold, 7);
  });

  it("шесть при пороге семь — ещё нельзя", () => {
    const дни = ["08-21", "08-22", "08-23", "08-24", "08-25", "08-26"].map((d) => дн(`2026-${d}`));
    const s = parityStreak(дни, 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.readyForCutover], [6, false]);
  });

  it("СОБЫТИЕ СТАРОЙ ФОРМЫ НЕ ЗЕЛЁНОЕ: без половины по остаткам вердикт неполный", () => {
    // Прод 25.08: ok=true, но `остатки_*` в payload нет — сверялись только
    // продажи. Считать это зелёным значит открыть флип по половине гейта.
    const s = parityStreak([старая("2026-08-25"), дн("2026-08-26")], 7, "2026-08-26");
    assert.equal(s.greenDays, 1);
    assert.equal(s.lastRed, "2026-08-25");
  });

  it("нулевая сверка остатков зелёной не считается", () => {
    // «Расхождений 0» без единой сравненной пары — те самые нули как «всё
    // хорошо»: снимок остатков есть только за сегодня, а сверка идёт по
    // закрытым суткам (ловушка №1, inventory-prod.md).
    const s = parityStreak([дн("2026-08-26", { остатки_сверено: 0 })], 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.lastRed], [0, "2026-08-26"]);
  });

  it("расхождения по продажам красят день, даже если ok кто-то выставил в true", () => {
    // Вердикт считается по ЧИСЛАМ, а не по одному флагу: `ok` пишет тот же
    // код, что и числа, и если они когда-нибудь разойдутся — верить надо
    // расхождениям, а не флагу, который открывает переключение учёта.
    const s = parityStreak([дн("2026-08-26", { расхождений: 3 })], 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.lastRed], [0, "2026-08-26"]);
    const о = parityStreak([дн("2026-08-26", { остатки_расхождений: 1 })], 7, "2026-08-26");
    assert.equal(о.greenDays, 0);
  });

  it("пропущенный день обнуляет так же, как красный", () => {
    const дни = [дн("2026-08-22"), дн("2026-08-23"), /* 24-го события нет */ дн("2026-08-25"), дн("2026-08-26")];
    assert.equal(parityStreak(дни, 7, "2026-08-26").greenDays, 2);
  });

  it("красный сегодня обнуляет серию немедленно", () => {
    const дни = [дн("2026-08-24"), дн("2026-08-25"), красный("2026-08-26")];
    const s = parityStreak(дни, 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.since, s.lastRed], [0, null, "2026-08-26"]);
  });

  it("сегодня события ЕЩЁ нет — серия не рвётся: паритет считается в 08:40", () => {
    const дни = [дн("2026-08-24"), дн("2026-08-25")];
    const s = parityStreak(дни, 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.since], [2, "2026-08-24"]);
  });

  it("нет ни сегодняшнего, ни вчерашнего события — серия оборвана", () => {
    // Сдвиг курсора — ровно на одни сутки: он покрывает «крон ещё не отработал»,
    // а не «сбор молчит вторые сутки».
    assert.equal(parityStreak([дн("2026-08-24")], 7, "2026-08-26").greenDays, 0);
  });

  it("два события за одни сутки — один день, вердикт по позднейшему", () => {
    const утро = красный("2026-08-26");
    const после = { ...дн("2026-08-26"), occurredAt: new Date("2026-08-26T12:00:00+05:00") };
    assert.equal(parityStreak([утро, после], 7, "2026-08-26").greenDays, 1);
    // И в обратном порядке подачи: сортируем сами, а не полагаемся на `order by`.
    assert.equal(parityStreak([после, утро], 7, "2026-08-26").greenDays, 1);
    assert.equal(parityStreak([после, утро], 7, "2026-08-26").days.length, 1, "сутки — одна строка витрины");
  });

  it("ташкентские сутки, а не UTC: событие 03:00 по Ташкенту — это сегодня", () => {
    // 2026-08-25T22:00Z = 2026-08-26T03:00+05:00. Считай мы дни по UTC —
    // серия рвалась бы на каждом ночном ручном прогоне.
    const ночью: ParityEventRow = { ...дн("2026-08-26"), occurredAt: new Date("2026-08-25T22:00:00Z") };
    const s = parityStreak([дн("2026-08-25"), ночью], 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.days.length], [2, 2]);
  });

  it("окно показа — 14 дней, свежие сверху, с числами обеих половин", () => {
    const дни = Array.from({ length: 20 }, (_, i) => дн(`2026-08-${String(i + 6).padStart(2, "0")}`));
    const s = parityStreak(дни, 7, "2026-08-25");
    assert.equal(PARITY_STREAK_WINDOW, 14);
    assert.equal(s.days.length, 14);
    assert.equal(s.days[0]!.date, "2026-08-25");
    assert.deepEqual([s.days[0]!.salesChecked, s.days[0]!.stockChecked, s.days[0]!.ok], [14, 68, true]);
    assert.equal(s.days[0]!.note, null);
    assert.equal(s.greenDays, 20, "окно ПОКАЗА не режет счёт серии");
  });

  it("записка дня доезжает до витрины: «расхождений 0» без объяснения читается как успех", () => {
    const s = parityStreak([дн("2026-08-26", { остатки_сверено: 0, примечание: "снимков остатков нет" })], 7, "2026-08-26");
    assert.equal(s.days[0]!.note, "снимков остатков нет");
    assert.equal(s.days[0]!.ok, false);
  });

  it("порог 0 не открывает катовер на пустом журнале: пол в один день стоит и здесь", () => {
    // Функция экспортируется наружу, и её числа рисуют «✅ можно переключать» в
    // боте и панели. Без пола `0 >= 0` дало бы разрешение на катовер при
    // ПУСТОМ журнале — гейт, снятый опиской в настройке.
    const пусто = parityStreak([], 0, "2026-08-26");
    assert.deepEqual([пусто.greenDays, пусто.threshold, пусто.readyForCutover], [0, 1, false]);
    // И зажатый порог уезжает В ОТВЕТ: витрина сравнивает поля сама, и «0 из 0»
    // она прочла бы как «можно».
    const один = parityStreak([дн("2026-08-26")], -5, "2026-08-26");
    assert.deepEqual([один.greenDays, один.threshold, один.readyForCutover], [1, 1, true]);
    assert.equal(parityStreak([], Number.NaN, "2026-08-26").threshold, 1);
  });

  it("lastRed может лежать ВНЕ окна показа — витрине это подписано в типе", () => {
    // 20 дней подряд, самый старый — красный: строк показа 14, и красной среди
    // них нет вовсе, а «когда в последний раз рвалось» ответить надо.
    const дни = Array.from({ length: 20 }, (_, i) => дн(`2026-08-${String(i + 6).padStart(2, "0")}`));
    дни[0] = красный("2026-08-06");
    const s = parityStreak(дни, 7, "2026-08-25");
    assert.equal(s.days.length, 14);
    assert.equal(s.lastRed, "2026-08-06");
    assert.equal(
      s.days.some((d) => d.date === s.lastRed),
      false,
      "красный день за пределами окна — искать его в days бессмысленно",
    );
  });

  it("журнал пуст — ноль, а не «готовы»", () => {
    const s = parityStreak([], 7, "2026-08-26");
    assert.deepEqual([s.greenDays, s.readyForCutover, s.days, s.lastRed, s.since], [0, false, [], null, null]);
  });

  it("порог из настроек, а не своя семёрка: три зелёных при пороге 3 — уже можно", () => {
    const дни = [дн("2026-08-24"), дн("2026-08-25"), дн("2026-08-26")];
    const s = parityStreak(дни, 3, "2026-08-26");
    assert.deepEqual([s.greenDays, s.threshold, s.readyForCutover], [3, 3, true]);
  });
});
