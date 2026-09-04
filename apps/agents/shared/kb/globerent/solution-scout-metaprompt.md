# Reference — solution-scout (GLOBERENT META-PROMPT v1.0)

> Справочник для агента `solution-scout` / скилла `find-solution`. Источник: Jamshid (META-PROMPT v1.0).
> ⚠️ Внешние факты (цены, версии, ⭐) помечены «сверить» — проверять перед внедрением.

## Модели LLM (цены — late 2025/early 2026, сверить перед закупкой)
| Модель | $/1M вход | $/1M выход | Для чего |
|---|---|---|---|
| Claude Sonnet 4.5 | 3.00 | 15.00 | глубокий ресёрч, агентное, длинный контекст |
| Claude Opus 4.5 | 5.00 | 25.00 | макс. рассуждение, дорого |
| Claude Haiku 4.5 | ~1.00 | ~5.00 | дешёвая массовка, классификация |
| GPT-5/5.1 | ~1.25–2.50 | ~10–15 | общее, Codex |
| GPT-5 mini | 0.25 | 2.00 | дёшево, быстро |
| Gemini 2.5 Pro | 1.25 | 10.00 | 1M контекст, мультимодаль |
| Gemini 2.5 Flash | 0.30 | 2.50 | массовка, быстро |
| DeepSeek V3.2 | 0.27 | 1.10 | дешевле всех при frontier-качестве |
| Qwen3 Max | ~0.86 | ~3.44 | мультиязык вкл. русский |
| YandexGPT Pro 5.1 | ₽0.40/1K | — | RU-native, регуляторика РФ |
| GigaChat 2 Max | ₽0.65/1K | — | RU-native, 152-ФЗ |
| GigaChat 2 Lite | ₽0.065/1K | — | сверхдёшево RU массовка |

**Выбор:** глубокий ресёрч → Sonnet 4.5 / Gemini 2.5 Pro · массовка → DeepSeek V3.2 / Gemini Flash ·
русский/152-ФЗ/КИИ → ТОЛЬКО YandexGPT / GigaChat · кодинг → Sonnet 4.5 / GPT-5.1-Codex.
Проверенные релизы (mid-2026): Sonnet 4.5 (сен’25), Opus 4.5 (нояб’25), YandexGPT 5.1 Pro (авг’25), Qwen3-Max (сен’25).
Версии выше («Sonnet 4.6+», «GPT-5.4+», «Gemini 3.x») — спекуляция, не доверять.

## CIS-ограничения (документировано)
- **КИИ-данные** → западные облака закрыты; легально только **GigaChat / YandexGPT**.
- **Albato.ru** — Skolkovo iPaaS, готовые коннекторы AmoCRM↔YandexGPT/GigaChat, AmoCRM↔МойСклад (152-ФЗ, RU-карта).
- **Bitrix24 Маркет** — дешёвые AI-бандлы (SkyWeb24 «ChatGPT»: 10M токенов ≈ 2 900 ₽).
- **AmoCRM/Kommo** — бесплатный виджет **Emfy GPT Мастер** (ChatGPT/DeepSeek/YandexGPT/GigaChat/Gemini/Qwen).
- **Didox** — официальный npm-SDK (программная интеграция счетов-фактур); **МойСклад** имеет нативную интеграцию Didox.
- **Тендеры UZ**: `augz.uz/tenderzone` — единственный мейнстрим-монитор xarid.uzex/etender.uzex; **OSS-парсера НЕТ** → возможность собрать своё (n8n + Playwright + Claude).

## Источники поиска (awesome-листы и площадки)
- GitHub: `enescingoz/awesome-n8n-templates` (280+), `kyrolabs/awesome-agents`, `Salesably/awesome-ai-agents-for-sales`,
  `Zijian-Ni/awesome-ai-agents-2026`, `ARUNAGIRINATHAN-K/awesome-ai-agents-2026` (300+), `smartmanru/awesome-chatgpt-prompts-ru`.
- Площадки: `n8n.io/workflows` (тысячи), `automationworkflows.io/marketplace`, `bitrix24.ru/apps`, `theresanaiforthat.com`, `futurepedia.io`.
- RU-кейсы: habr.com, vc.ru.

## Дисциплина
Никогда не выдумывать URL · открывать и проверять каждую ссылку · санкционное помечать ⚠️ ·
указывать дату обновления репо/видео · 152-ФЗ-дисклеймер для финансов/налогов.
