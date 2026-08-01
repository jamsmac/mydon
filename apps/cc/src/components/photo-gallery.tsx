import type { Attachment } from "../lib/core";

/**
 * Ссылка на файл вложения для браузера.
 *
 * Абсолютную (presigned S3) отдаём как есть — браузер идёт прямо в хранилище.
 * Относительный путь Core проксируем через маршрут панели: Core наружу закрыт.
 */
function srcOf(a: Attachment): string {
  return /^https?:\/\//.test(a.url) ? a.url : `/api/attachments/${a.id}/raw`;
}

/**
 * Галерея фото карточки: снимки, которые сотрудник приложил при заведении.
 *
 * Владелец видит их прямо в карточке — в том числе решая, утверждать ли
 * черновик: «что за ингредиент завели» отвечает фотография, а не только имя.
 * Только фото (kind=photo): чеки и документы — отдельным разделом позже.
 */
export function PhotoGallery({ attachments }: { attachments: Attachment[] }) {
  const photos = attachments.filter((a) => a.kind === "photo");
  if (photos.length === 0) return null;

  return (
    <div className="sect">
      <div className="sect-h">
        <h3 className="h2">Фото</h3>
        <span className="chip">
          {photos.length} {photos.length === 1 ? "снимок" : "снимков"}
        </span>
      </div>
      <div className="photo-grid">
        {photos.map((a) => {
          const src = srcOf(a);
          return (
            <a key={a.id} href={src} target="_blank" rel="noreferrer" className="photo-thumb">
              {/* Обычный <img>: файлы приватны и идут через прокси панели, а не
                  через оптимизатор Next, которому нужен внешний доступ. */}
              <img src={src} alt="Фото номенклатуры" loading="lazy" />
            </a>
          );
        })}
      </div>
    </div>
  );
}
