# Живые расхождения OurVend и задачи по направлениям

Дата: 2026-08-31
Статус: implemented design

## Цель

После cutover `mydon-stock → own` расхождение становится видимой работой, а не
одноразовым сообщением:

- одно расхождение sales или stock на автомат/день даёт одну задачу VendHub;
- все расходящиеся SKU автомата/дня сохранены в payload одной stock-задачи;
  в её описании показаны первые 20 и счётчик оставшихся;
- повторный прогон обновляет значения без дублей;
- исправленная проблема закрывается автоматически;
- отказ донора, пустая или неполная сверка ничего не закрывают;
- повторное расхождение в контролируемом окне переоткрывает ту же задачу;
- immediate Telegram-alerts показывают `opened` (включая счётчик reopened), `resolved` и
  daily-deduped `failed`, а ежедневный
  `ourvend.parity` остаётся общей сводкой;
- доска сначала группирует все задачи по направлению, затем по срочности.

## Почему не `notification_delivery`

`notification_delivery` означает только, что Telegram принял сообщение. После ACK
событие исчезает из `/rules/pending`, даже если причина не устранена. Поэтому
Telegram — канал переходов, а постоянное состояние живёт в `operational_issue` и задаче.

```text
authoritative parity scan
  → operational_issue (open/resolved, episode, stable identity)
  → task(domain=vendhub, stable clientKey)
  → transition/failure event
  → RulesService → Telegram → delivery ACK
```

## Идентичность и модель

`operational_issue` хранит `kind + fingerprint`, `scope_date`, `scope_key`,
`status=open|resolved`, `episode`, безопасный payload, времена наблюдения и связанную
задачу. Fingerprints:

- sales: `(dt, canonical machine serial)`;
- stock: `(dt, canonical machine serial)`;
- детали stock-позиций: `(dt, serial, normalized product)` в `payload.items`.

Дата остаётся частью issue: исправление одного дня не закрывает другой. Группировка
SKU не теряет детали, но не создаёт десятки задач на один автомат. Публичное создание
задач не может занять зарезервированные source или prefix `clientKey`.

`operational_projection_state` хранит watermark проекции. Он не позволяет медленному старому
прогону перезаписать результат более свежей сверки.

## Reconciliation

Один прогон под PostgreSQL advisory lock:

1. Преобразует полный отчёт, а не обрезанные примеры из `ourvend.parity`.
2. Новое наблюдение создаёт issue и task; повтор обновляет текст без дубля.
3. Resolved issue, снова попавший в красную сверку, переоткрывает ту же task и
   увеличивает `episode`.
4. Open issue закрывается только когда mismatch исчез и его machine/day есть в
   authoritative coverage. Task сразу получает `done`, system confirmation и accepted quality.
5. Opened и reopened дают общее `opened` event со счётчиком `reopened`; resolved даёт отдельное
   `resolved` event. Неизменённое красное
   состояние нового transition-alert не создаёт.
6. Watermark отбрасывает stale scan до любого изменения issue/task/event.

Ручное `done/cancelled/redo` и назначение LLM-агенту для managed parity-task запрещены:
иначе UI-статус мог бы разойтись с authoritative issue или оставить LLM-reserve.

## Coverage и окно повтора

Stock snapshot записывается полной заменой `(machine, day)`. Поэтому наличие scope с обеих
сторон доказывает полную сверку: удалённый/переименованный SKU может честно исчезнуть из
задачи. Если целый scope пропал хотя бы с одной стороны, issue остаётся open. `retired`, ноль
сверенных пар и пустое coverage также ничего не закрывают.

Внутренний recheck всегда берёт 30 дней: это честное окно автоповтора resolved issue без
ежедневного full-history scan. Более старый open issue расширяет окно от своей даты. Публичный
endpoint остаётся ограничен 30 днями; защитный потолок open recheck — 3650 дней.
Ещё более старая запись остаётся открытой и требует явного разбора.

## Доска задач

Внешний порядок использует канон `DOMAINS`, внутри — существующие urgency-группы:

```text
GLOBERENT
  Просрочено / Сегодня / На этой неделе / Позже / Без срока
VendHub
  ...
Личный контур
  ...
MYDON
  ...
Без направления
  ...
```

Пустые группы не рисуются, legacy `null/unknown` видны в конце. Так же группируются задачи,
ожидающие приёмки. Quick Add требует направление; Edit позволяет разобрать legacy-задачи.
Доска забирает страницы API по 300 строк и явно отклоняет обнаруженные межстраничные
дубли. При стабильном наборе задач это убирает прежний жёсткий UI-лимит 300; snapshot/keyset-гарантия
для одновременно меняющейся доски остаётся следующим hardening.

## Ошибки и восстановление

- Issue, task, audit, transition event и watermark меняются в одной транзакции.
- Reconcile читает/блокирует только open issues и resolved fingerprints, реально повторившиеся
  в текущем отчёте, а не всю resolved-историю.
- Ошибка проекции не переписывает уже сохранённый честный `ourvend.parity`; старые задачи
  остаются open, а `ourvend.parity_issues.failed` даёт immediate Telegram-alert.
- Автозакрытая task сразу system-confirmed и не попадает в ручную приёмку.
- NaN/±Infinity в sales и stock дают явный mismatch с конечными числами в payload, а не
  ложный resolve или невалидный JSON.

## Проверка

- N одинаковых прогонов → одна task и одно open-event;
- частичное исправление SKU → та же stock-task с уменьшенным списком;
- полное исправление при coverage → done + confirmed + resolved-event;
- пустое/неполное coverage → task остаётся open с прежними деталями;
- ручные terminal/redo и agent-assignment отклоняются;
- recurrence в 30-дневном окне → та же task и новый episode;
- newer clean scan → older late red scan пропускается watermark-гейтом;
- NaN/±Infinity на любой стороне не могут автозакрыть issue;
- канонический порядок направлений, вложенная срочность и видимая группа
  «Без направления»;
- Quick Add/Edit сохраняют валидный domain, а paginated board при стабильном наборе читает
  задачи после 300-й строки и обнаруживает дубли.
