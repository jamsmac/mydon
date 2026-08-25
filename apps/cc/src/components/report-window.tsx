import Link from "next/link";

/**
 * Переключатель окна расчёта у листов-отчётов: ссылки `?days=`, текущее — жирным.
 *
 * Один на три листа П5b («Маржа», «Мёртвый сток», «Цены»): у них различается
 * только набор окон и ключ вкладки. Список окон закрыт не ради защиты прода —
 * ядро само зажимает своё окно (`@Min/@Max` в DTO) независимо от панели, — а
 * потому, что на листе ровно столько кнопок, сколько в списке.
 *
 * Лист «Усушка» (П4) держит свой такой же переключатель: переписывать рабочий
 * лист ради общей строки не стали, диффа было бы больше, чем пользы.
 */
export function ReportWindow({
  domain,
  tab,
  days,
  windows,
}: {
  domain: string;
  tab: string;
  days: number;
  windows: readonly number[];
}) {
  const base = `/domain/${domain}?tab=${encodeURIComponent(tab)}`;
  return (
    <p className="hint">
      Окно расчёта:{" "}
      {windows.map((d, idx) => (
        <span key={d}>
          {idx > 0 ? " · " : ""}
          {d === days ? <b>{`${d} дн`}</b> : <Link href={`${base}&days=${d}`}>{`${d} дн`}</Link>}
        </span>
      ))}
    </p>
  );
}
