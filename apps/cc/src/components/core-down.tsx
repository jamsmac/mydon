/**
 * Экран «Core недоступен».
 *
 * Панель без данных должна честно сказать, что связи нет, а не показать нули:
 * «0 просрочек» при упавшем Core — это ложь, на которую можно положиться.
 */
export function CoreDown({ detail }: { detail: string }) {
  return (
    <div className="warn">
      <b>Нет связи с ядром MYDON</b>
      Панель не может показать данные — это не значит, что тревог нет. Проверьте контейнер
      <span className="mono"> mydon-core</span>.
      <p style={{ margin: "9px 0 0", color: "var(--steel)", fontSize: 13 }}>{detail}</p>
    </div>
  );
}
