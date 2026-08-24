-- Канонизация серийников в учётных таблицах (волна П2 поглощения mydon-stock).
--
-- Уникальные ключи sale и machine_stock включают machine_serial, а источники
-- пишут РАЗНЫЕ формы одного автомата: stock-дорожка — «c2508160376» (форма
-- реестра донора), собственный снапшот — «2508160376» (форма API OurVend).
-- Без приведения переключение источника (OURVEND_ACCOUNTING_SOURCE=own)
-- создавало бы строки-двойники под одним upsert-ключом. Код теперь пишет
-- канон (normalizeMachineSerial: lower + срез «c» ТОЛЬКО у «c»+10 цифр —
-- коды кофемашин вида «c7a6181f0000» не трогаются); здесь приводится история.
--
-- До этой волны в обе таблицы писала только stock-дорожка (одна форма),
-- поэтому пар-двойников быть не должно. Страховочные шаги слияния всё равно
-- выполняются первыми: если двойник вдруг есть, UPDATE ниже упал бы по
-- уникальному индексу — молча испортить данные нельзя, а страховка делает
-- миграцию безусловно проходимой.

-- 1а. sale: если для (source, dt, product) есть И «c…», И голая форма —
--     слить суммированием в голую (продажи аддитивны).
UPDATE sale b
SET qty = b.qty + c.qty,
    amount = b.amount + c.amount,
    fetched_at = greatest(b.fetched_at, c.fetched_at)
FROM sale c
WHERE c.machine_serial ~ '^[cC][0-9]{10}$'
  AND b.machine_serial = regexp_replace(lower(c.machine_serial), '^c', '')
  AND b.source = c.source AND b.dt = c.dt AND b.product = c.product;
--> statement-breakpoint

-- 1б. Удалить слитые «c…»-двойники.
DELETE FROM sale c
USING sale b
WHERE c.machine_serial ~ '^[cC][0-9]{10}$'
  AND b.machine_serial = regexp_replace(lower(c.machine_serial), '^c', '')
  AND b.source = c.source AND b.dt = c.dt AND b.product = c.product;
--> statement-breakpoint

-- 1в. Привести оставшиеся «c…»-строки sale к канону.
UPDATE sale
SET machine_serial = regexp_replace(lower(machine_serial), '^c([0-9]{10})$', '\1')
WHERE machine_serial ~ '^[cC][0-9]{10}$';
--> statement-breakpoint

-- 2а. machine_stock — снимки остатков: суммировать нельзя. При двойнике
--     выживает строка с более поздним fetched_at (при равенстве — голая форма).
DELETE FROM machine_stock a
USING machine_stock b
WHERE a.dt = b.dt AND a.product = b.product
  AND a.id <> b.id
  AND regexp_replace(lower(a.machine_serial), '^c([0-9]{10})$', '\1')
      = regexp_replace(lower(b.machine_serial), '^c([0-9]{10})$', '\1')
  AND a.machine_serial <> b.machine_serial
  AND (a.fetched_at < b.fetched_at
       OR (a.fetched_at = b.fetched_at AND a.machine_serial > b.machine_serial));
--> statement-breakpoint

-- 2б. Привести оставшиеся «c…»-строки machine_stock к канону.
UPDATE machine_stock
SET machine_serial = regexp_replace(lower(machine_serial), '^c([0-9]{10})$', '\1')
WHERE machine_serial ~ '^[cC][0-9]{10}$';
