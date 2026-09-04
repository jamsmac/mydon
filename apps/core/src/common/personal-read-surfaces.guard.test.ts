import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * ГАРД ПОЛНОТЫ личного контура (R-P5-7b) — systematic, а не поэндпоинтно.
 *
 * Личный контур живёт в трёх таблицах: `entity`/`money_flow` (org.code='personal')
 * и `task` (domain='personal'). ЛЮБОЕ чтение этих таблиц потенциально несёт
 * personal-строки. Поэтому тест ЭНУМЕРИРУЕТ каждое место в Core, читающее их
 * (`.from(...)` / `.<x>Join(...)`), и требует, чтобы КАЖДЫЙ такой файл был явно
 * классифицирован в реестре ниже — либо гейтится owner-видимостью, либо стоит в
 * осознанном allowlist с причиной «personal тут не всплывает».
 *
 * ПОЧЕМУ ЭТО ЛОВИТ РЕГРЕСС (а не косметика):
 *  1. Новый эндпоинт/сервис, читающий entity/task/money_flow, которого нет в
 *     реестре, РОНЯЕТ тест (assert на нераспознанные файлы) — автор обязан
 *     сознательно решить, гейтить его или занести в allowlist с обоснованием.
 *     Забыть гейт «молча» больше нельзя: молчание = красный тест.
 *  2. Файлы категории OWNER_TOKEN_GATE дополнительно проходят ДЕШЁВУЮ дым-проверку
 *     на НАЛИЧИЕ токена гейта (`excludePersonal`): полное удаление фильтра из
 *     tasks/entities/registry роняет тест. Это НЕ доказывает, что предикат вшит в
 *     конкретный `.where(...)` — частичный регресс (снят гейт с одного метода,
 *     где рядом у других он остаётся; или из `and(...)` выкинут taskGate, а
 *     параметр `excludePersonal` цел) подстроку в файле сохраняет. Фактическую
 *     ПРОВОДКУ гейта в SQL держат per-surface тесты захвата WHERE рядом с самими
 *     сервисами: tasks.test.ts, entities.test.ts, registry.service.test.ts,
 *     actions.service.test.ts — снятие проводки там роняет тест на уровне SQL.
 *  3. Реестр держится в синхроне с кодом: устаревшая запись (файл больше не
 *     читает эти таблицы) тоже краснит тест — allowlist не гниёт.
 *
 * ГРАНИЦА ЧЕСТНОСТИ: тест гарантирует ПОЛНОТУ классификации и защищает
 * гейт-файлы. Он НЕ доказывает во время выполнения безопасность каждой
 * allowlist-записи — это ревью-обоснование автора (категория + причина). Три
 * не-гейт категории:
 *   • DOMAIN_SELECTOR — personal достижим ТОЛЬКО с явным domain-селектором
 *     (param/query/body), а его глобально режет PersonalDomainGuard (R-P5-4/6).
 *   • NON_PERSONAL_TABLES — запрос привязан к vendhub/coffee/globerent-таблицам
 *     или к entity.type, которых у личного контура (недвижимость/транспорт/
 *     накопления) нет; personal-org строк в этих путях не бывает.
 *   • WRITE_OR_DEDUP — чтение task ради идемпотентной записи/связки или фонового
 *     разбора, а не owner-facing выдача личных заголовков.
 */

type Category = "OWNER_TOKEN_GATE" | "DOMAIN_SELECTOR" | "NON_PERSONAL_TABLES" | "WRITE_OR_DEDUP";

/** Реестр: relPath (от apps/core/src) → категория + причина классификации. */
const REGISTRY: Record<string, { category: Category; reason: string }> = {
  // — Гейт owner-видимости (единый источник personalVisible). Тест ниже
  //   дополнительно требует наличия токена гейта в этих файлах.
  "entities/entities.service.ts": {
    category: "OWNER_TOKEN_GATE",
    reason: "domain-less find/byId/pending гейтятся excludePersonal → notPersonalOrg",
  },
  "tasks/tasks.service.ts": {
    category: "OWNER_TOKEN_GATE",
    reason: "list/byId/overdue/… гейтятся excludePersonal → domain is distinct from 'personal'",
  },
  "registry/registry.service.ts": {
    category: "OWNER_TOKEN_GATE",
    reason: "overview/briefing гейтятся excludePersonal по org/domain (R-P5-7b)",
  },
  "registry/actions.service.ts": {
    category: "OWNER_TOKEN_GATE",
    reason: "лента task/entity-подзапросов гейтится excludePersonal (R-P5-7a)",
  },

  // — Personal достижим только через явный domain-селектор → PersonalDomainGuard.
  "finance/finance.service.ts": {
    category: "DOMAIN_SELECTOR",
    reason: "flows/summary/counterpartyCandidates скоупятся orgId(domain из запроса); domain=personal режет глобальный guard",
  },
  "contracts/contracts.service.ts": {
    category: "DOMAIN_SELECTOR",
    reason: "договоры/деньги через grContract (globerent) и domain-param; personal — только с селектором (guard)",
  },
  "units/units.service.ts": {
    category: "DOMAIN_SELECTOR",
    reason: "globerentUnit (globerent) + domain-param; personal только с селектором (guard)",
  },
  "imports/imports.service.ts": {
    category: "DOMAIN_SELECTOR",
    reason: "grImportContract (globerent) + domain-param; personal только с селектором (guard)",
  },
  "registry-import/registry-import.service.ts": {
    category: "DOMAIN_SELECTOR",
    reason: "импортёр реестра GLOBERENT, читает по фиксированному направлению/селектору",
  },
  "preorders/preorders.service.ts": {
    category: "DOMAIN_SELECTOR",
    reason: "grPreorder (globerent) + domain-param; personal только с селектором (guard)",
  },
  "verification/verification.service.ts": {
    category: "DOMAIN_SELECTOR",
    reason: "сверка по карточке/направлению; personal-строки достижимы только с domain-селектором (guard)",
  },

  // — Запрос привязан к vendhub/coffee-таблицам или entity.type, которых у
  //   личного контура нет; personal-org строк в этих путях не бывает.
  "coffee/coffee.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "join entity через coffeeIngredient/machinePlacement — обогащение имён кофе-контура",
  },
  "stock/vending-ledger.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "проекция vending_stock → леджер (У6): entity читается как склады и карточки товаров vendhub",
  },
  "coffee/coffee-ledger.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "возврат бункера → склад (У5): entity читается как имя точки заливки, карточки ингредиента и склада vendhub",
  },
  "coffee/coffee-orders.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "join entity по coffeeOrder.machineId — имена автоматов кофе-контура",
  },
  "coffee/norm-fact.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "справочник entity для норма/факт кофе-контура (type product/location)",
  },
  "collections/collections.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "инкассации: entity как справочник автоматов (machineId), не личные карточки",
  },
  "sales/sales.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "продажи: join entity по sale.machineId/product (vendhub), не личный контур",
  },
  "stock/stock.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "склад: entity по type warehouse/ingredient/product (vendhub), не личные карточки",
  },
  "supply/supply.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "снабжение: entity как справочник автоматов/складов vendhub",
  },
  "maintenance/maintenance.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "обслуживание: entity — автоматы/техника vendhub, не личный контур",
  },
  "maintenance/parts.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "узлы автоматов: entity читается только как имя автомата по machine_id периода (vendhub), не личный контур",
  },
  "vending/vending.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "снек-контур: entity как справочник автоматов/товаров vendhub",
  },
  "approvals/approvals.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "апрувы читают конкретную карточку по id для решения; не листинг личного контура",
  },
  "raw/raw.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "raw-импорт ourvend/vendhub: entity как справочник автоматов/товаров, не личные карточки",
  },
  "gaps/gaps.service.ts": {
    category: "NON_PERSONAL_TABLES",
    reason: "кросс-доменное чтение money_flow, но потребитель (bankFlowsWithoutDomainGap) оставляет только source='bank' и domain IS NULL — personal (domain='personal') отфильтрован",
  },

  // — Чтение task ради записи/связки/фона, а не owner-facing выдача.
  "tasks/task-bridge.service.ts": {
    category: "WRITE_OR_DEDUP",
    reason: "мост событие→задача: чтение task по id/clientKey для идемпотентной записи",
  },
  "tasks/task-llm-jobs.service.ts": {
    category: "WRITE_OR_DEDUP",
    reason: "фоновая LLM-очередь по task; не HTTP-выдача личных заголовков не-владельцу",
  },
  "ourvend/parity-issue.service.ts": {
    category: "WRITE_OR_DEDUP",
    reason: "заведение vendhub-задачи о расхождении: чтение task по clientKey для дедупа",
  },
  "vending/low-stock-issue.service.ts": {
    category: "WRITE_OR_DEDUP",
    reason: "заведение vendhub-задачи о низком остатке: чтение task по clientKey для дедупа",
  },
};

/** Личные таблицы: чтение по имени ИЛИ по локальному alias(...) из них. */
const PERSONAL_TABLES = ["task", "entity", "moneyFlow"] as const;
const READ_VERBS = "from|innerJoin|leftJoin|rightJoin|fullJoin";

/**
 * Локальные alias личных таблиц в файле: `const place = alias(entity, "place")`.
 * Такой alias — полноценное чтение личной таблицы (actions/coffee/registry-import
 * читают entity ИМЕННО через него: `.from(place)`/`.innerJoin(place, …)`), но по
 * имени таблицы он не виден. Собираем имена переменных, чтобы матчить .from/.join
 * и по ним. Иначе сервис, читающий личные таблицы ТОЛЬКО через alias, ускользал
 * бы из discoverReadSites — и негейтнутая personal-поверхность уехала бы молча.
 */
function aliasNames(text: string): string[] {
  const re = new RegExp(`(\\w+)\\s*=\\s*alias\\(\\s*(?:${PERSONAL_TABLES.join("|")})\\b`, "g");
  const names = new Set<string>();
  for (const m of text.matchAll(re)) names.add(m[1]!);
  return [...names];
}

/**
 * Читает ли файл личные таблицы. Матч идёт по ВСЕМУ тексту (а не построчно):
 * `.from(` с переносом до имени таблицы иначе ускользал бы (`\s*` покрывает
 * переносы строк). Имена = сами таблицы + их локальные alias в этом файле.
 */
function readsPersonalTables(text: string): boolean {
  const names = [...PERSONAL_TABLES, ...aliasNames(text)];
  return new RegExp(`\\.(?:${READ_VERBS})\\(\\s*(?:${names.join("|")})\\b`).test(text);
}

// Тест компилируется в dist, но ЧИТАТЬ обязан ИСХОДНИКИ (src): в dist лежат
// .js, а мы матчим .ts-поверхности. Находим apps/core по сегменту пути (работает
// и из dist/common, и из src/common), затем целимся в src.
const PARTS = __dirname.split(path.sep);
const CORE_ROOT = PARTS.slice(0, PARTS.lastIndexOf("core") + 1).join(path.sep);
const SRC_ROOT = path.join(CORE_ROOT, "src");

function listServiceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listServiceFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** Файлы Core, реально читающие entity/task/money_flow (rel-путь от src). */
function discoverReadSites(): string[] {
  const found: string[] = [];
  for (const file of listServiceFiles(SRC_ROOT)) {
    if (readsPersonalTables(readFileSync(file, "utf8"))) {
      found.push(path.relative(SRC_ROOT, file).split(path.sep).join("/"));
    }
  }
  return found.sort();
}

describe("гард полноты personal-фильтра (systematic)", () => {
  const discovered = discoverReadSites();

  it("КАЖДОЕ чтение entity/task/money_flow классифицировано (новый — роняет тест)", () => {
    const unclassified = discovered.filter((f) => !(f in REGISTRY));
    assert.deepEqual(
      unclassified,
      [],
      `Новые чтения личных таблиц без классификации: ${unclassified.join(", ")}. ` +
        "Занеси файл в REGISTRY (гейт excludePersonal) или в allowlist с причиной.",
    );
  });

  it("реестр не гниёт: нет записей про файлы, которые больше не читают эти таблицы", () => {
    const stale = Object.keys(REGISTRY).filter((f) => !discovered.includes(f));
    assert.deepEqual(stale, [], `Устаревшие записи REGISTRY: ${stale.join(", ")}`);
  });

  it("гейт-файлы всё ещё несут owner-видимость (удаление фильтра роняет тест)", () => {
    const gated = Object.entries(REGISTRY).filter(([, v]) => v.category === "OWNER_TOKEN_GATE");
    for (const [file] of gated) {
      const text = readFileSync(path.join(SRC_ROOT, file), "utf8");
      assert.ok(
        text.includes("excludePersonal"),
        `${file} помечен OWNER_TOKEN_GATE, но токена гейта excludePersonal в нём нет — фильтр личного контура потерян`,
      );
    }
  });

  it("каждая запись реестра несёт непустую причину классификации", () => {
    for (const [file, v] of Object.entries(REGISTRY)) {
      assert.ok(v.reason.trim().length > 0, `${file}: пустая причина классификации`);
    }
  });
});
