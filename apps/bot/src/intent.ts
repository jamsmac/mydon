// Единый разбор вопросов живёт в @mydon/assistant — бот и панель понимают
// вопрос ОДИНАКОВО. Реэкспорт, чтобы существующие импорты «./intent» не ломать.
export { parseIntent, DOMAIN_HINT, type Intent } from "@mydon/assistant";
