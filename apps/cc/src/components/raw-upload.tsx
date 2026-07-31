"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { importFile } from "../app/sources/actions";

/**
 * Загрузка выгрузки файлом.
 *
 * Это и есть недостающее звено «заполнить источник»: роли колонок назначать не
 * по чему, пока нет первой выгрузки, а положить её раньше мог только
 * разработчик — скриптом, с ключом приёма и туннелем до сервера.
 *
 * Время съёма спрашивается отдельно и НЕ подставляется автоматически: именно
 * оно отвечает на вопрос «насколько свежо», и подменять его временем загрузки
 * значило бы врать про свежесть данных.
 */
export function RawUpload({
  source,
  report,
  reportTitle,
  path,
}: {
  source: string;
  report: string;
  reportTitle: string;
  /** Где этот отчёт нажать в чужом интерфейсе. */
  path: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<number | null>(null);

  if (!open) {
    return (
      <button type="button" className="btn sm" onClick={() => setOpen(true)}>
        Загрузить выгрузку
      </button>
    );
  }

  return (
    <form
      className="srcform"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        form.set("source", source);
        form.set("report", report);
        setError(null);
        setDone(null);
        start(async () => {
          const res = await importFile(form);
          if (res.ok) {
            setDone(res.rows ?? 0);
            router.refresh();
          } else setError(res.error ?? "Не получилось");
        });
      }}
    >
      <div className="srcfr">
        <label>
          Файл выгрузки (CSV, TSV)
          <input type="file" name="file" accept=".csv,.tsv,.txt,text/csv,text/plain" required />
        </label>
        <label>
          Когда снято у источника
          <input type="datetime-local" name="fetchedAt" required />
        </label>
      </div>
      <div className="srcfr">
        <label>
          Период с
          <input type="date" name="periodFrom" />
        </label>
        <label>
          Период по
          <input type="date" name="periodTo" />
        </label>
      </div>
      <div className="srcfr">
        <label>
          Учётная запись
          <input name="account" placeholder="под какой снимал" />
        </label>
        <label>
          Разделитель
          <select name="delimiter" className="mapsel" style={{ maxWidth: "none", height: 34 }}>
            <option value="">определить самим</option>
            <option value=";">точка с запятой</option>
            <option value=",">запятая</option>
            <option value="\t">табуляция</option>
            <option value="|">вертикальная черта</option>
          </select>
        </label>
      </div>

      <div className="srcfa">
        <button className="btn sm" type="submit" disabled={pending}>
          {pending ? "Загружаю…" : "Загрузить"}
        </button>
        <button type="button" className="btn sm ghost" onClick={() => setOpen(false)}>
          Закрыть
        </button>
        {error && <span className="err-text">{error}</span>}
        {done !== null && (
          <span className="mapok">
            Загружено строк: {done.toLocaleString("ru-RU")} — теперь назначь роли колонок
          </span>
        )}
      </div>

      <p className="hint">
        Отчёт «{reportTitle}» берётся здесь: {path || "путь в системе не записан"}. Первая
        строка файла считается заголовками. Кодировка определяется сама — Excel в
        русской локали сохраняет CSV в cp1251, и такой файл читается верно.
        Значения не приводятся к типам: «15000.00» останется «15000.00».
        <br />
        Повторная загрузка того же снимка (та же тройка источник + отчёт + время
        съёма) заменяет строки, а не плодит дубли.
      </p>
    </form>
  );
}
