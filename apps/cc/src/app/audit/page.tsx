import Link from "next/link";
import { core, CoreUnavailable, type AuditEntry, type Person } from "../../lib/core";
import { CoreDown } from "../../components/core-down";
import { when } from "../../lib/format";

export const dynamic = "force-dynamic";

/**
 * Подпись автора. Раньше ЛЮБОЙ actorKind=human подписывался «ты» — а Core
 * пишет действия сотрудников именно с actorKind=human: работа оператора
 * выглядела работой владельца. Теперь person:<id>/staff:<id> резолвятся в имя.
 */
function actorLabel(e: AuditEntry, people: Map<string, string>): string {
  const id = /(?:person|staff):([0-9a-f-]{36})/.exec(e.actorRef ?? "")?.[1];
  if (id) return people.get(id) ?? "сотрудник";
  if (e.actorKind === "human") return "ты";
  if (e.actorKind === "agent") return "агент";
  return "система";
}

/** Понятное имя действия: в журнале коды, а читать его будет не программист. */
export const ACTION_LABELS: Record<string, string> = {
  "entity.create": "завёл карточку",
  "entity.update": "изменил карточку",
  "entity.approve": "утвердил карточку",
  "entity.delete": "удалил карточку",
  "approval.request": "попросил разрешения",
  "approval.approved": "одобрил",
  "approval.rejected": "отклонил",
  "approval.clarify": "отправил на уточнение",
  "claim.confirmed": "заявленное подтвердилось",
  "claim.refuted": "заявленное НЕ подтвердилось",
  "task.create": "поставил задачу",
  "task.claimed": "взял задачу",
  "task.done": "закрыл задачу",
  "task.edit": "изменил задачу",
  "task.rated": "оценил работу",
  "collection.collected": "снял выручку",
  "collection.received": "принял инкассацию",
  "collection.cancelled": "отменил инкассацию",
  /**
   * Разовая правка среза «правда о пробеле»: 247 перенесённых строк стояли на
   * пять часов раньше реальности. Записей за один момент много — первый экран
   * `/audit` они займут целиком, и это объявлено в чек-листе выкатки (R-I-5);
   * отбор по действию у эндпоинта есть (`?action=`).
   */
  "collection.time_corrected": "поправил время инкассации (перенос VendCash, +5 часов)",
  "maintenance.log_created": "записал работу по обслуживанию",
  "maintenance.log_closed": "закрыл работу по обслуживанию",
  "maintenance.log_removed": "удалил запись обслуживания",
  "maintenance.part_swapped": "заменил узел",
  "vending.stock.recount": "пересчитал склад",
  "coffee.refill.delete": "удалил запись заливки",
  "coffee.return.delete": "удалил запись возврата",
  "coffee.consumable.delete": "удалил запись расходников",
  "person.link_telegram": "привязал Telegram",
};

function describe(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

export default async function Audit() {
  let entries: AuditEntry[];
  let people: Person[];
  try {
    [entries, people] = await Promise.all([core.audit(60), core.people(true).catch(() => [] as Person[])]);
  } catch (err) {
    return <CoreDown detail={err instanceof CoreUnavailable ? err.detail : String(err)} />;
  }
  const names = new Map(people.map((p) => [p.id, p.name]));

  return (
    <>
      <div className="page-head">
        <h1>Журнал</h1>
        <p>
          Технический аудит системных записей. Полевые вводы сотрудников (заливки, возвраты, склад) сюда не
          попадают — их смотри в ленте <Link href="/team/actions">«Действия»</Link>.
        </p>
      </div>

      {entries.length === 0 ? (
        <div className="empty">
          <b>Журнал пуст</b>
          Записи появятся, как только в системе что-то произойдёт.
        </div>
      ) : (
        <div className="rows">
          {entries.map((e) => (
            <div className="row" key={e.id}>
              <span className={`pill ${e.actorKind}`}>{actorLabel(e, names)}</span>
              <div className="t">
                <b>{describe(e.action)}</b>
              </div>
              <span className="when">{when(e.ts)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
