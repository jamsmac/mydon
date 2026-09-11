// Волна 2б: слияние карточек одного места и контрагент места — на настоящем SQL.
// Сервис слияния — сырой SQL по двум десяткам таблиц; заглушки его не проверят.
import assert from "node:assert/strict";
import path from "node:path";
import { coreDb, reqCore, ENGINE } from "./svc-harness.mjs";
const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const { PlaceMergeService } = reqCore(path.join(REPO, "apps/core/dist/entities/place-merge.service.js"));
const { PlaceCardService } = reqCore(path.join(REPO, "apps/core/dist/entities/place-card.service.js"));
const { db, run, close } = await coreDb();
const n = async (sql) => Number((await run(sql))[0].n);
try {
  // «4 корпус кардиология» (S, вся история) и «кардиология 4 корпус» (T, автомат сейчас)
  const S = "00000000-0000-0000-0000-0000000005a1", T = "00000000-0000-0000-0000-0000000007a1";
  const M = "00000000-0000-0000-0000-00000000aa01", C = "00000000-0000-0000-0000-00000000cc01";
  const O = "00000000-0000-0000-0000-00000000dd01", P = "00000000-0000-0000-0000-0000000009a1";
  await run(`insert into entity (id, type, name, attrs) values
    ('${S}','location','4 корпус кардиология','{}'), ('${T}','location','кардиология 4 корпус','{}'),
    ('${M}','machine','4 корпус кардиология','{}'), ('${C}','contractor','Центр кардиологии','{}'),
    ('${O}','product','Эспрессо','{}'), ('${P}','location','4 Корпус  Кардиология','{}')`);
  await run(`insert into machine_placement (location_id, entity_id, start_date, end_date) values
    ('${S}','${M}','2026-08-01','2026-08-19'), ('${T}','${M}','2026-08-20', null)`);
  await run(`insert into coffee_refill (location_id, position, filled_weight, entered_date) values
    ('${S}',1,600,'2026-08-10'), ('${S}',2,500,'2026-08-11'), ('${T}',1,590,'2026-09-01')`);
  await run(`insert into coffee_consumable (location_id, logged_date, water, cups) values
    ('${S}','2026-08-10',5,40), ('${T}','2026-09-01',4,30)`);
  await run(`insert into geo_point (entity_id, lat, lng) values ('${S}',41.32362,69.2999), ('${T}',41.3237,69.3)`);
  await run(`insert into attachment (owner_type, owner_id, storage_key) values ('entity','${S}','photos/s.jpg')`);

  const merge = new PlaceMergeService(db);
  const cards = new PlaceCardService(db);

  // 1. контрагент: назначить; владелец — только контрагент/наша компания
  await cards.setContractor(S, C, "agent:claude-code");
  await assert.rejects(cards.setContractor(T, O, "agent:claude-code"), /контрагент или наша компания/);
  // имя уникально В ПРЕДЕЛАХ контрагента: «4 Корпус  Кардиология» — тот же ключ имени
  await assert.rejects(cards.setContractor(P, C, "agent:claude-code"), /уже есть место «4 корпус кардиология»/);

  // 2. предпросмотр T → S: что переедет, без записи
  const pv = await merge.preview(T, S);
  assert.deepEqual(pv.blockers, []);
  assert.deepEqual({ ...pv.moves }, {
    "machine_placement.location_id": 1,
    "coffee_refill.location_id": 1,
    "coffee_consumable.location_id": 1,
  });
  assert.equal(pv.geo, "target_keeps");
  assert.equal(await n(`select count(*)::int as n from coffee_refill where location_id='${T}'`), 1, "предпросмотр ничего не пишет");

  // 3. коллизия дня расходников — отказ со списком, ничего не перенесено
  await run(`insert into coffee_consumable (location_id, logged_date, water) values ('${S}','2026-09-01',1)`);
  const blocked = await merge.preview(T, S);
  assert.match(blocked.blockers.join(";"), /расходники кофе за один и тот же день \(coffee_consumable\): 1/);
  await assert.rejects(merge.merge(T, S, { basis: "owner_word", reason: "одно место, слово владельца 10.09" }, "agent:claude-code"), /Слить нельзя/);
  assert.equal(await n(`select count(*)::int as n from machine_placement where location_id='${T}'`), 1, "отказ ничего не перенёс");
  await run(`delete from coffee_consumable where location_id='${S}' and logged_date='2026-09-01'`);

  // 4. без основания и по адресу — отказ ещё до базы
  await assert.rejects(merge.merge(T, S, { basis: "address", reason: "один адрес у обоих" }), /адреса основанием не является/);

  // 5. слияние: всё переехало, исходная закрыта, одна запись в журнале
  const done = await merge.merge(T, S, { basis: "owner_word", reason: "одно место, слово владельца 10.09" }, "agent:claude-code");
  assert.equal(done.moves["coffee_refill.location_id"], 1);
  assert.equal(await n(`select count(*)::int as n from coffee_refill where location_id='${S}'`), 3);
  assert.equal(await n(`select count(*)::int as n from coffee_consumable where location_id='${S}'`), 2);
  assert.equal(await n(`select count(*)::int as n from machine_placement where location_id='${S}' and end_date is null`), 1,
    "открытый период автомата — теперь на целевой карточке");
  assert.equal(await n(`select count(*)::int as n from geo_point where entity_id='${T}'`), 0, "координаты исходной отброшены");
  assert.equal(await n(`select count(*)::int as n from geo_point where entity_id='${S}'`), 1, "у целевой — свои");
  const [t] = await run(`select attrs from entity where id='${T}'`);
  const attrs = typeof t.attrs === "string" ? JSON.parse(t.attrs) : t.attrs;
  assert.equal(attrs["слита в"], S); assert.equal(attrs["выключена"], true);
  const audit = await run(`select actor_kind, actor_ref, target from audit_log where action='entity.merge'`);
  assert.deepEqual(audit.map((a) => [a.actor_kind, a.actor_ref, a.target]), [["agent", "agent:claude-code", S]], "одна запись, автор — агент");

  // 6. слитую карточку второй раз не сольёшь
  const again = await merge.preview(T, S);
  assert.match(again.blockers.join(";"), /исходная карточка уже слита/);

  // 7. контрагент целевой не потерян, исходной карточки места больше нет
  assert.equal(await n(`select count(*)::int as n from place_card where entity_id='${S}' and contractor_id='${C}'`), 1);
  assert.equal(await n(`select count(*)::int as n from place_card where entity_id='${T}'`), 0);
  const owners = await cards.owners();
  assert.deepEqual(owners.map((o) => [o.entityId, o.contractorName]), [[S, "Центр кардиологии"]]);

  console.log(`Слияние мест (${ENGINE}): перенос, отказ на коллизии, пометки, журнал, контрагент ✔`,
    Object.entries(done.moves).map(([k, v]) => `${k}=${v}`).join(" "));
} finally { await close(); }
