import { Inject, Injectable } from "@nestjs/common";
import { note } from "@mydon/db";
import { desc, ilike, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type NoteRow = typeof note.$inferSelect;

export interface CreateNoteInput {
  title?: string;
  body: string;
  tags?: string[];
}

/**
 * Заметки — хранилище знаний MYDON (ТЗ §7 note).
 *
 * Сюда переносится память из Cowork и выжимки из прошлых разговоров: без них
 * помощник не знает контекста и предлагает то, что владелец уже решил.
 * Поиск — по тексту: знание бесполезно, если его нельзя найти в нужный момент.
 */
@Injectable()
export class NotesService {
  constructor(@Inject(DB) private readonly db: Db) {}

  list(limit = 100): Promise<NoteRow[]> {
    return this.db.select().from(note).orderBy(desc(note.createdAt)).limit(limit);
  }

  /** Поиск по заголовку и тексту — помощник ищет здесь ответ на вопрос. */
  search(q: string, limit = 20): Promise<NoteRow[]> {
    const like = `%${q}%`;
    return this.db
      .select()
      .from(note)
      .where(or(ilike(note.title, like), ilike(note.body, like)))
      .orderBy(desc(note.createdAt))
      .limit(limit);
  }

  /**
   * Создание с защитой от дублей: импорт памяти запускается повторно, и
   * одинаковые записи копились бы при каждом прогоне.
   */
  async create(input: CreateNoteInput): Promise<NoteRow> {
    if (input.title) {
      const [existing] = await this.db
        .select()
        .from(note)
        .where(sql`${note.title} = ${input.title}`)
        .limit(1);
      if (existing) {
        const [updated] = await this.db
          .update(note)
          .set({ body: input.body, tags: input.tags ?? [] })
          .where(sql`${note.id} = ${existing.id}`)
          .returning();
        return updated;
      }
    }

    const [created] = await this.db
      .insert(note)
      .values({
        title: input.title ?? null,
        body: input.body,
        tags: input.tags ?? [],
      })
      .returning();
    return created;
  }
}
