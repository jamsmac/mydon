import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Приглашение сотрудника в бота.
 *
 * Зачем вообще. Сейчас привязка идёт по @username: бот берёт ник из первого
 * сообщения и находит по нему карточку. Это дыра — ник в Telegram
 * освобождается после смены, и любой, кто его займёт, получит доступ
 * к карточке сотрудника со всеми его задачами.
 *
 * Приглашение решает это тем, что секрет знает только тот, кому его дали:
 * владелец выпускает одноразовую ссылку и передаёт лично.
 *
 * В БД хранится ХЕШ кода, а не сам код. Утечка дампа не должна давать
 * работающих приглашений; поэтому же в хеш подмешивается «перец» из
 * окружения — без него подбор по радужной таблице для 10 символов
 * тривиален.
 */

/**
 * Алфавит без похожих символов: 0/O, 1/I/l, 5/S, 8/B. Код диктуют голосом
 * и вводят с телефона, и «ноль или буква О» — это потерянная попытка.
 */
const ALPHABET = "ACDEFGHJKMNPQRTUVWXY2346789";

/** Длина кода. 10 символов из 27 — это ~47 бит, перебор не окупается. */
const CODE_LENGTH = 10;

/** Сколько живёт приглашение. Сутки: не успел — попросит новое. */
export const INVITE_TTL_HOURS = 24;

/**
 * Сгенерировать код.
 *
 * randomBytes, а не Math.random: последний предсказуем, и предсказуемое
 * приглашение — это приглашение для постороннего.
 */
export function generateInviteCode(length = CODE_LENGTH): string {
  const out: string[] = [];
  // Отбрасываем байты, не укладывающиеся в целое число алфавитов, — иначе
  // первые символы алфавита выпадали бы чаще остальных.
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length;
  while (out.length < length) {
    for (const b of randomBytes(length)) {
      if (b >= limit) continue;
      out.push(ALPHABET[b % ALPHABET.length]);
      if (out.length === length) break;
    }
  }
  return out.join("");
}

/**
 * Привести введённый код к каноническому виду.
 *
 * Человек диктует код по телефону, а другой набирает его в спешке: пробелы,
 * дефисы и регистр не должны стоить попытки.
 */
export function normalizeInviteCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s\-_]/g, "");
}

/** Хеш кода для хранения. Перец — из окружения, в БД его нет. */
export function hashInviteCode(code: string, pepper: string): string {
  return createHash("sha256").update(`${pepper}:${normalizeInviteCode(code)}`).digest("hex");
}

/**
 * Сравнение хешей за постоянное время.
 *
 * Обычное === выходит на первом различии, и по времени ответа можно
 * подбирать хеш посимвольно. Для 10-символьного кода это реально.
 */
export function inviteHashEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Ссылка-приглашение: сотрудник жмёт её и сразу подключается. */
export function inviteLink(botUsername: string, code: string): string {
  return `https://t.me/${botUsername}?start=inv_${code}`;
}

/** Код из полезной нагрузки `/start inv_XXXX`. Не наш формат — null. */
export function parseStartPayload(text: string): string | null {
  const m = /^\/start\s+inv_([A-Za-z0-9]{4,32})$/.exec(text.trim());
  return m ? normalizeInviteCode(m[1]) : null;
}

/** Истекло ли приглашение. */
export function isInviteExpired(expiresAt: Date, now = new Date()): boolean {
  return expiresAt.getTime() <= now.getTime();
}

/** Когда истечёт приглашение, выпущенное сейчас. */
export function inviteExpiry(now = new Date(), hours = INVITE_TTL_HOURS): Date {
  return new Date(now.getTime() + hours * 3600_000);
}
