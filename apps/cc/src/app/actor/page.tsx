import { cookies } from "next/headers";
import { ActorDeclare } from "../../components/actor-declare";
import { ACTOR_COOKIE, declaredAgentRef, resolveActor } from "../../lib/actor";

export const dynamic = "force-dynamic";

/** Ссылка актора словами — так же, как её подпишет журнал. */
function actorWords(ref: string): string {
  if (ref === "owner") return "владелец";
  if (ref.startsWith("agent:")) return `агент ${ref.slice("agent:".length)}`;
  return ref;
}

/**
 * «Кто действует» (R-H-9). Сюда агент приходит в начале работы в браузере
 * владельца и объявляет себя — иначе его правки лягут в журнал правками
 * владельца: по заголовку Tailscale их не отличить.
 */
export default async function ActorPage() {
  const declared = declaredAgentRef((await cookies()).get(ACTOR_COOKIE)?.value);
  const actor = await resolveActor();
  // Без логина владельца панель не отличает людей друг от друга — и это надо
  // сказать, а не молча подписывать всех владельцем (решение 2026-09-11).
  const ownerLoginConfigured = (process.env.OWNER_TAILSCALE_LOGIN ?? "").trim() !== "";

  return (
    <>
      <div className="page-head">
        <h1>Кто действует</h1>
        <p>
          Каждая запись панели ложится в журнал с автором. Агент, работающий в этом браузере, должен
          объявить себя здесь — иначе его правки будут числиться за владельцем.
        </p>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        Записи из этого браузера сейчас подписываются: <b>{actorWords(actor)}</b>
        {!ownerLoginConfigured && (
          <p className="hint" style={{ marginTop: 8 }}>
            Логин владельца (OWNER_TAILSCALE_LOGIN) не задан, поэтому людей панель не различает:
            всё, что сделано без объявления агента, подписывается владельцем. Это допущение, а не
            знание — задайте логин, и правки других людей в tailnet лягут их логином.
          </p>
        )}
      </div>

      <ActorDeclare declared={declared} />
    </>
  );
}
