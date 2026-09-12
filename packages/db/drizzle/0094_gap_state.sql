-- Переходы пробелов: «стало известно» (Н-2, волна 6).
--
-- ЗАЧЕМ. Реестр «Пробелы» вычисляется на чтении (R-K4) и обязан оставаться
-- таким: хранимый список протух бы на следующий день. Но у вычисляемого
-- списка нет «вчера» — закрывшийся пробел просто исчезает между двумя
-- чтениями, и сигнала «данных стало достаточно» взять неоткуда. `gap_state` —
-- НЕ копия реестра, а журнал его переходов: одна строка на устойчивый ключ
-- пробела, с днями «впервые увиден», «видели последний раз», «пропал» и
-- «вернулся».
--
-- Закрытые строки НЕ удаляются: иначе ответ на вопрос «что стало известно за
-- сутки» снова неоткуда взять. Вернувшийся пробел не выдаётся за новый:
-- «снова не считается» читается иначе, чем «впервые не считается».
--
-- Пробелы без устойчивого ключа (кластеры по окну дат) сюда не попадают
-- вовсе: отличить их закрытие от переразбиения окна нечем, а ложный сигнал
-- «стало известно» хуже молчания.
--
-- `gap_reconcile_run` отвечает на другой вопрос: прошла ли сверка в этот день
-- вообще. Без него «сегодня ничего не закрылось» неотличимо от «сервис стоял»,
-- а это разные новости.
--
-- ЗАМЕР ПРОДА (12.09.2026, до выката): обеих таблиц нет, строк 0 — миграция
-- создаёт пустые таблицы, ни одной существующей строки не трогает и блокировок
-- на живых таблицах не берёт.
--
-- ОТКАТ: DROP TABLE "gap_state"; DROP TABLE "gap_reconcile_run"; — данные
-- теряются полностью, но реестр от них не зависит и его выдача не изменится
-- ни на строку.

CREATE TABLE "gap_reconcile_run" (
	"day" date PRIMARY KEY NOT NULL,
	"gaps_seen" integer NOT NULL,
	"closed" integer NOT NULL,
	"appeared" integer NOT NULL,
	"returned" integer DEFAULT 0 NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "gap_state" (
	"key" text PRIMARY KEY NOT NULL,
	"topic" text NOT NULL,
	"missing" text NOT NULL,
	"first_seen_on" date NOT NULL,
	"last_seen_on" date NOT NULL,
	"closed_on" date,
	"reopened_on" date,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gap_state_closed_on_idx" ON "gap_state" USING btree ("closed_on");--> statement-breakpoint
CREATE INDEX "gap_state_first_seen_on_idx" ON "gap_state" USING btree ("first_seen_on");
