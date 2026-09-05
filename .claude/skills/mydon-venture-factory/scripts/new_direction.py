#!/usr/bin/env python3
"""Создаёт скелет направления MYDON по references/direction-package.md.

Пример:
  python scripts/new_direction.py --slug tz-generator --title "Генератор ТЗ" \
      --market uzbekistan --source "https://example.com/case" [--root ventures]
"""
import argparse
import datetime as dt
import pathlib
import re
import sys


def slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    return value.strip("-")


def write(path: pathlib.Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        print(f"  пропущен (уже есть): {path}")
        return
    path.write_text(content.rstrip() + "\n", encoding="utf-8")
    print(f"  создан: {path}")


def main() -> int:
    p = argparse.ArgumentParser(description="Скелет направления MYDON")
    p.add_argument("--slug", required=True, help="латиница, например tz-generator")
    p.add_argument("--title", required=True, help="название направления")
    p.add_argument("--market", default="uzbekistan", help="профиль рынка из references/markets/")
    p.add_argument("--source", default="", help="ссылка на оригинал")
    p.add_argument("--root", default="ventures", help="корневая папка направлений")
    a = p.parse_args()

    slug = slugify(a.slug)
    if not slug:
        print("slug пустой после нормализации", file=sys.stderr)
        return 1
    today = dt.date.today().isoformat()
    root = pathlib.Path(a.root) / slug
    print(f"Направление {slug} → {root}")

    write(root / "DIRECTION.md", f"""# {a.title}

- **Slug:** {slug}
- **Создано:** {today}
- **Оригинал:** {a.source or '[ссылка]'} — [что и как зарабатывает, доказательство дохода H1]
- **Модель дохода клона:** [кто платит, за что, сколько, как часто]
- **Рынок:** {a.market} — [ключевые адаптации]
- **Вердикт и баллы:** [из фазы 2]
- **Гейт T3:** [что одобрено: деньги / юрлицо / риск; дата]
- **KPI:** первый доход — [дата] · доход/нед — [ ] · CAC — [ ] · маржа — [ ] · часы владельца/нед — 0
- **Kill-критерии:** [переопределить или «по умолчанию»]
- **Статус:** scouted
- **Ответственный агент:** {slug}-operator
""")

    write(root / "clone-spec.md", f"""# Clone spec — {a.title}

| Копируем 1:1 | Адаптируем (почему) | Убираем (почему) |
|--------------|---------------------|------------------|
| | | |
""")

    for role, task in (
        ("operator", "ежедневная эксплуатация, KPI, отчёты, kill-критерии"),
        ("growth", "продвижение по каналам профиля рынка до первого дохода и далее"),
    ):
        write(root / "agents" / f"{slug}-{role}.md", f"""# {slug}-{role}
**Задача (одна):** {task}
**Входы:**
**Выходы:**
**Инструменты:**
**Автономия:** T2; T3-действия: [перечислить]
**Триггеры:**
**Метрики:**
**Эскалация:** chief-of-staff → владелец
**Регламент:**
1.
""")

    write(root / "workflows" / f"{slug}-daily-ops.yaml", f"""name: {slug}-daily-ops
schedule: "0 9,15,21 * * *"   # Asia/Tashkent
agent: {slug}-operator
steps:
  - read: reports/latest
  - run: check-kpi
  - if: kill-criteria-hit
    escalate: T3
outputs: reports/YYYY-WW.md
""")

    write(root / "launch" / "plan.md", f"""# План запуска — {a.title}

| # | Шаг | Агент | T3 | Дата | Готово |
|---|-----|-------|----|------|--------|
| 1 | Продукт готов | {slug}-operator | | | |
| 2 | Оплата принимается (тест на минимальную сумму) | {slug}-operator | T3 | | |
| 3 | Оферта размещена | {slug}-operator | T3 | | |
| 4 | Каналы запущены | {slug}-growth | T3 | | |
| 5 | Первые 10 контактов | {slug}-growth | | | |
| 6 | Первый доход | — | | | |
""")
    write(root / "launch" / "product.md", f"# Продукт — {a.title}\n\n[лендинг / поток бота / подписка]\n")
    write(root / "launch" / "channels.md", f"# Каналы — {a.title}\n\n| Канал | Креатив | Бюджет (T3) | Замер |\n|-------|---------|-------------|-------|\n| | | | |\n")
    (root / "skills").mkdir(parents=True, exist_ok=True)
    (root / "reports").mkdir(parents=True, exist_ok=True)
    write(root / "reports" / ".gitkeep", "")
    write(root / "skills" / ".gitkeep", "")
    print("Готово. Следующий шаг: заполнить DIRECTION.md и clone-spec.md (фаза 4).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
