import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BASELINE,
  can,
  effectiveRoles,
  LEGACY_ROLE_MAP,
  normalizeRoles,
  PERMISSIONS,
  permissionsOf,
  ROLE_LABELS,
  ROLE_PERMISSIONS,
  rolesLabel,
  STAFF_ROLES,
} from "./roles";
import {
  generateInviteCode,
  hashInviteCode,
  inviteExpiry,
  inviteHashEquals,
  inviteLink,
  isInviteExpired,
  normalizeInviteCode,
  parseStartPayload,
} from "./invite";

describe("Матрица прав", () => {
  it("у каждой роли есть русская подпись и набор прав", () => {
    for (const r of STAFF_ROLES) {
      assert.ok(ROLE_LABELS[r], `${r} без подписи`);
      assert.ok(ROLE_PERMISSIONS[r], `${r} без прав`);
    }
  });

  it("в матрице нет выдуманных прав", () => {
    const known = new Set<string>(PERMISSIONS);
    for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
      for (const p of perms) assert.ok(known.has(p), `${role}: неизвестное право ${p}`);
    }
  });

  it("пустые роли не запирают человека", () => {
    // Карточка заведена, Telegram привязан, роли владелец проставить не успел —
    // бот обязан работать, иначе первый новый сотрудник упрётся в молчание.
    assert.equal(can([], "tasks.own"), true);
    assert.equal(can(null, "tasks.own"), true);
    assert.deepEqual(permissionsOf([]), [...BASELINE]);
  });

  it("но лишнего пустые роли не дают", () => {
    assert.equal(can([], "cash.collect"), false);
    assert.equal(can([], "parts.replace"), false);
    assert.equal(can([], "system.admin"), false);
  });

  it("роли складываются, а не вытесняют друг друга", () => {
    // Двое в поле делают всю работу: «оператор ИЛИ техник» описало бы их неверно.
    assert.equal(can(["operator"], "parts.replace"), false);
    assert.equal(can(["operator", "technician"], "parts.replace"), true);
    assert.equal(can(["operator", "technician"], "coffee.refill"), true);
  });

  it("владелец может всё", () => {
    for (const p of PERMISSIONS) assert.equal(can(["owner"], p), true, `владельцу отказано в ${p}`);
  });

  it("инкассатор не лезет в склад и запчасти", () => {
    assert.equal(can(["collector"], "cash.collect"), true);
    assert.equal(can(["collector"], "stock.intake"), false);
    assert.equal(can(["collector"], "parts.replace"), false);
  });

  it("system.admin есть только у владельца", () => {
    for (const r of STAFF_ROLES) {
      if (r === "owner") continue;
      assert.equal(can([r], "system.admin"), false, `${r} не должен настраивать систему`);
    }
  });

  it("мусор в ролях выбрасывается, а не сохраняется «на всякий случай»", () => {
    // Роль, которой нет в матрице, прав не даёт, но создаёт вид,
    // что доступ настроен.
    assert.deepEqual(normalizeRoles(["operator", "царь", "", null, 42]), ["operator"]);
    assert.deepEqual(normalizeRoles("operator"), []);
    assert.deepEqual(normalizeRoles(["operator", "operator"]), ["operator"], "дубли схлопываются");
  });

  it("подпись ролей человеческая", () => {
    assert.equal(rolesLabel(["operator", "technician"]), "Оператор, Техник");
    assert.equal(rolesLabel([]), "роли не заданы");
    assert.equal(rolesLabel(["мусор"]), "роли не заданы");
  });
});

describe("Права на назначение и приёмку задач (П7, R-P7-3)", () => {
  it("менеджер может назначать и подтверждать, оператор — нет", () => {
    assert.equal(can(["manager"], "tasks.assign"), true);
    assert.equal(can(["manager"], "tasks.confirm"), true);
    assert.equal(can(["operator"], "tasks.assign"), false);
    assert.equal(can(["operator"], "tasks.confirm"), false);
    assert.equal(can(["owner"], "tasks.confirm"), true, "владелец получает права списком PERMISSIONS");
  });

  it("`tasks.own` остаётся у сотрудника без ролей — новые права его не заперли", () => {
    assert.equal(can([], "tasks.own"), true);
    assert.equal(can([], "tasks.confirm"), false);
    assert.deepEqual([...BASELINE], ["tasks.own"]);
  });

  it("effectiveRoles: легаси `role='владелец'` даёт owner, мусор — ничего", () => {
    assert.deepEqual(effectiveRoles({ roles: [], role: "владелец" }), ["owner"]);
    assert.deepEqual(effectiveRoles({ roles: null, role: "Менеджер" }), ["manager"]);
    assert.deepEqual(effectiveRoles({ roles: ["operator"], role: "кладовщик" }), ["operator"]);
    assert.deepEqual(effectiveRoles({ roles: ["operator"], role: null }), ["operator"]);
    assert.deepEqual(effectiveRoles({ roles: ["выдумка"], role: "" }), []);
  });

  it("effectiveRoles не задваивает роль, если она есть и в массиве, и в легаси", () => {
    assert.deepEqual(effectiveRoles({ roles: ["owner"], role: "владелец" }), ["owner"]);
  });

  it("LEGACY_ROLE_MAP отдаёт только owner и manager — правами это поле не управляет шире", () => {
    assert.deepEqual([...new Set(LEGACY_ROLE_MAP.values())].sort(), ["manager", "owner"]);
  });
});

describe("Приглашения", () => {
  const PEPPER = "перец-длиннее-шестнадцати";

  it("код только из однозначного алфавита", () => {
    // Код диктуют голосом: «ноль или буква О» — это потерянная попытка.
    // Из каждой похожей пары убран ОДИН символ, а не оба: 8 остаётся, потому
    // что B исключена, и спутать её больше не с чем.
    for (let i = 0; i < 50; i += 1) {
      const code = generateInviteCode();
      assert.equal(code.length, 10);
      assert.ok(!/[01BILOSZ5]/.test(code), `${code} содержит спутываемый символ`);
      assert.match(code, /^[ACDEFGHJKMNPQRTUVWXY2346789]+$/);
    }
  });

  it("коды не повторяются", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateInviteCode()));
    assert.equal(seen.size, 200);
  });

  it("ввод прощает пробелы, дефисы и регистр", () => {
    assert.equal(normalizeInviteCode(" ac-de fg "), "ACDEFG");
    assert.equal(normalizeInviteCode("acde_fg"), "ACDEFG");
  });

  it("хеш зависит от перца — утечка дампа не даёт рабочих кодов", () => {
    const a = hashInviteCode("ACDEFG", PEPPER);
    const b = hashInviteCode("ACDEFG", "другой-перец");
    assert.notEqual(a, b);
    assert.equal(hashInviteCode("ac-de fg", PEPPER), a, "нормализация до хеширования");
  });

  it("сравнение хешей за постоянное время", () => {
    const h = hashInviteCode("ACDEFG", PEPPER);
    assert.equal(inviteHashEquals(h, h), true);
    assert.equal(inviteHashEquals(h, hashInviteCode("QRTUVW", PEPPER)), false);
    assert.equal(inviteHashEquals(h, "коротко"), false, "разная длина не должна падать");
  });

  it("ссылка ведёт в бота с полезной нагрузкой", () => {
    assert.equal(inviteLink("mydon_bot", "ACDEFG"), "https://t.me/mydon_bot?start=inv_ACDEFG");
  });

  it("разбор /start принимает только свой формат", () => {
    assert.equal(parseStartPayload("/start inv_ACDEFG"), "ACDEFG");
    assert.equal(parseStartPayload("  /start inv_acdefg  "), "ACDEFG");
    assert.equal(parseStartPayload("/start"), null);
    assert.equal(parseStartPayload("/start hello"), null);
    assert.equal(parseStartPayload("/start inv_"), null);
    assert.equal(parseStartPayload("inv_ACDEFG"), null);
  });

  it("срок жизни — сутки", () => {
    const now = new Date("2026-08-06T10:00:00.000Z");
    const exp = inviteExpiry(now);
    assert.equal(exp.toISOString(), "2026-08-07T10:00:00.000Z");
    assert.equal(isInviteExpired(exp, now), false);
    assert.equal(isInviteExpired(exp, new Date("2026-08-07T10:00:01.000Z")), true);
  });

  it("истёкшее ровно в срок считается истёкшим", () => {
    const exp = new Date("2026-08-07T10:00:00.000Z");
    assert.equal(isInviteExpired(exp, exp), true, "граница не должна давать лишнюю секунду доступа");
  });
});
