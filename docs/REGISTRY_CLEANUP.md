# Разбор реестра автоматов — разовая процедура

> Нужна один раз, после PR 0 складского ТЗ. Дальше вид автомата задаётся при
> заведении карточки, и разбирать будет нечего.
>
> Всё, что здесь есть, — запросы и правила решения. Ни одна команда не
> склеивает и не удаляет карточки сама: что из двух «American hospital»
> настоящее, знает владелец, а не система.

---

## Зачем

На 06.08.2026 в реестре 29 автоматов. Из них:

- **23** привязаны к кофейным точкам — вид определился сам;
- **6** не привязаны, и среди них видны три разных случая:

| Карточка | Серийник | Похоже на |
|---|---|---|
| `Снек (без точки)` | `c2508160360` | снек — формат серийника другой |
| `Olma Администрация · снек` | `c2508160376` | снек |
| `American Hospital · снек` | `c2508160359` | снек |
| `American hospital` | `3be8c71e0000` | кофе без привязки **либо дубль** |
| `OFFice` | `da0a191f0000` | кофе без привязки |
| `Olma склад` | `039ec91c0000` | не в поле — стоит на складе |

Слово «похоже» здесь не фигура речи: это догадка по формату серийника и
названию. Именно её и надо заменить решением — за тем процедура и написана.

Пока вид не проставлен, автомат считается неразмеченным и получает только
плановое ТО. Кофейные нормативы (мойка миксера, фильтр воды) ему не достанутся.

---

## Шаг 1. Разметить то, что размечается само

```bash
cd /opt/mydon-app
docker compose -f deploy/docker-compose.yml --env-file .env exec -T mydon-core \
  node tools/backfill-machine-kinds.mjs --dry-run
```

Покажет, кому какой вид будет проставлен. Привязанные к точке → `coffee`,
остальные → `other` («не размечен»), **а не** `snack`: угадывать по названию
значит повторить ту же ошибку с другой стороны. Если устраивает:

```bash
docker compose -f deploy/docker-compose.yml --env-file .env exec -T mydon-core \
  node tools/backfill-machine-kinds.mjs
```

Идемпотентно: повторный прогон не трогает уже размеченное, в том числе ваши
ручные решения.

---

## Шаг 2. Собрать улики по неразмеченным

```bash
docker exec -i mydon-db psql -U mydon -d mydon <<'SQL'
select e.name,
       e.external_ref                                                as серийник,
       coalesce(mc.kind::text, '—')                                  as вид,
       (select count(*) from machine_slot s
         where s.machine_serial = e.external_ref)                    as слотов,
       (select count(*) from machine_sale ms
         where ms.machine_serial = e.external_ref)                   as продаж,
       (select count(*) from coffee_refill cr
         where cr.location_id in
           (select id from coffee_location where entity_id = e.id))  as заливок_кофе,
       e.created_at::date                                            as заведён
from entity e
left join machine_card mc on mc.entity_id = e.id
where e.type = 'machine' and coalesce(mc.kind::text, 'other') = 'other'
order by e.name;
SQL
```

Как читать:

| Улика | Что означает |
|---|---|
| **слотов > 0** | Автомат есть в зеркале Ourvend со слотами-пружинами → снек или напитки |
| **продаж > 0** | Автомат работает и деньги приносит — точно не «стоит на складе» |
| **заливок_кофе > 0** | В него заливали бункеры → кофейный, просто привязку сняли или завели заново |
| **слотов = 0, продаж = 0** | Либо не в работе, либо сбор Ourvend был выключен. Разделить эти два случая может только человек |

Последнюю строку стоит держать в голове: пока `OURVEND_SYNC_CRON` не собирал
данные, нули в «слотах» и «продажах» не значат ничего. Сначала убедитесь, что
сбор включён (`docker logs mydon-agents | grep -i вендинг`), дайте ему пройти
хотя бы раз, и только потом делайте выводы.

---

## Шаг 3. Проставить вид руками

```bash
TOKEN=$(grep '^SERVICE_TOKEN=' .env | cut -d= -f2)
docker compose -f deploy/docker-compose.yml --env-file .env exec -T mydon-core \
  node -e '
  const [id, kind] = process.argv.slice(1);
  fetch(`http://127.0.0.1:3001/entities/${id}/machine-kind`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-service-token": process.env.SERVICE_TOKEN },
    body: JSON.stringify({ kind, actor: "owner" }),
  }).then(async (r) => console.log(r.status, (await r.text()).slice(0, 200)));
  ' <id-автомата> <вид>
```

Допустимые виды: `coffee`, `snack`, `drink`, `combo`, `other`.

Каждая правка пишется в аудит с `actor: owner` — именно поэтому она делается
не запросом в базу напрямую. Через полгода будет видно, что этот вид выбрал
человек, а не подставил массовый прогон; догадка и решение имеют разный вес.

После разметки — дозавести нормативы (команда идемпотентна, уже заведённое
не тронет):

```bash
docker compose -f deploy/docker-compose.yml --env-file .env exec -T mydon-core \
  node tools/apply-maintenance-norms.mjs
```

Автоматам, ставшим `coffee`, добавятся мойка миксера и фильтр воды.

---

## Шаг 4. Дубли

```bash
docker exec -i mydon-db psql -U mydon -d mydon <<'SQL'
select lower(trim(name)) as имя, count(*) as карточек,
       array_agg(external_ref order by created_at) as серийники,
       array_agg(id::text  order by created_at)    as ids
from entity where type = 'machine'
group by lower(trim(name)) having count(*) > 1;
SQL
```

Одинаковое имя при **разных** серийниках — это, скорее всего, два разных
автомата на одном объекте, и склеивать их нельзя: у каждого своя история
обслуживания и свои остатки. Правильное действие — переименовать, чтобы люди
их различали («American hospital · кофе» и «American hospital · снек»).

Одинаковое имя при **одинаковом** серийнике — настоящий дубль. Но и его не
удаляют: на карточке могут висеть задачи, журнал работ, узлы и заливки.
Порядок такой:

```bash
docker exec -i mydon-db psql -U mydon -d mydon <<'SQL'
-- что висит на каждой из карточек-кандидатов
select 'task' as где, count(*) from task where entity_id = '<id>'
union all select 'maintenance_log', count(*) from maintenance_log where entity_id = '<id>'
union all select 'machine_part',    count(*) from machine_part    where machine_id = '<id>'
union all select 'vending_refill',  count(*) from vending_refill  where machine_id = '<id>';
SQL
```

Пустую карточку можно выключить, непустую — нет: её история должна переехать
на оставшуюся, а это отдельная задача с миграцией, а не команда в консоли.
Если такой случай найдётся — скажите, сделаю переносом, а не удалением.

---

## Шаг 5. Автоматы не в работе

`Olma склад` по названию похож на автомат, который стоит на складе, а не
на точке. Если это так, ему не нужен график обслуживания вовсе: он будет
краснеть за ТО оборудования, которое никто не эксплуатирует.

Выключить норматив (не удалить — история остаётся видна):

```bash
docker exec -i mydon-db psql -U mydon -d mydon -c \
  "select id, title from maintenance_plan
    where entity_id = '<id>' and is_active"
```

и затем `DELETE /maintenance/plans/<planId>` — эндпоинт выключает норматив,
а не стирает его.

Отдельного статуса «не в работе» у карточки автомата пока нет. Если таких
машин станет больше двух, его стоит завести полем в `machine_card` — тем же
решением, что и вид: состояние, которое влияет на графики, не должно
угадываться по названию.
