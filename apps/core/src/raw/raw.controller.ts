import { timingSafeEqual } from "node:crypto";
import {
  Body,
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
  Post,
  Query,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsISO8601,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";
import { RAW_LINK_KINDS, roleColumnIndex, type RawLinkKind } from "@mydon/shared";
import { MAX_EXPORT, RawService, normalizeRowsQuery, toCsv } from "./raw.service";

export class RawImportDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  source!: string;

  @IsString() @IsNotEmpty() @MaxLength(64)
  report!: string;

  @IsISO8601()
  fetchedAt!: string;

  @IsOptional() @IsISO8601()
  periodFrom?: string;

  @IsOptional() @IsISO8601()
  periodTo?: string;

  @IsOptional() @IsString() @MaxLength(128)
  account?: string;

  @IsOptional() @IsInt() @Min(0)
  rowsTotal?: number;

  @IsOptional() @IsArray() @ArrayMaxSize(512) @IsString({ each: true })
  columns?: string[];

  /** Строки как пришли: массив массивов строк. Порядок — порядок источника. */
  @IsArray() @ArrayMaxSize(5000)
  rows!: string[][];

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;

  @IsOptional() @IsString() @MaxLength(128)
  importedBy?: string;

  @IsOptional() @IsBoolean()
  append?: boolean;

  /** Номер первой строки пачки в исходной выгрузке — чтобы повтор лёг на место. */
  @IsOptional() @IsInt() @Min(0)
  offset?: number;
}

export class RawLinkDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  source!: string;

  @IsIn(RAW_LINK_KINDS)
  kind!: RawLinkKind;

  /** Значение так, как оно написано в источнике. */
  @IsString() @IsNotEmpty() @MaxLength(512)
  label!: string;

  /** Карточка реестра. Пусто — осознанное «карточка не нужна». */
  @IsOptional() @IsUUID()
  entityId?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}


export class RawSourceDefDto {
  /** Код системы: латиница, цифры, подчёркивание. Попадает в адрес и в базу. */
  @IsString() @IsNotEmpty() @MaxLength(64)
  code!: string;

  @IsString() @IsNotEmpty() @MaxLength(128)
  title!: string;

  @IsOptional() @IsString() @MaxLength(256)
  subtitle?: string;

  /** Адрес кабинета. Пусто — честное «ещё не записан». */
  @IsOptional() @IsString() @MaxLength(512)
  url?: string;

  @IsOptional() @IsBoolean()
  archived?: boolean;
}

export class RawReportDefDto {
  @IsString() @IsNotEmpty() @MaxLength(64)
  source!: string;

  @IsString() @IsNotEmpty() @MaxLength(64)
  code!: string;

  @IsString() @IsNotEmpty() @MaxLength(128)
  title!: string;

  @IsOptional() @IsString() @MaxLength(256)
  ru?: string;

  @IsOptional() @IsString() @MaxLength(256)
  path?: string;

  @IsOptional() @IsBoolean()
  archived?: boolean;
}

export class RawRolesDto {
  /**
   * Роль → название колонки этой выгрузки. Пустое значение — осознанное
   * «этой роли в отчёте нет», и это законное состояние.
   */
  @IsObject()
  roles!: Record<string, string>;
}

/** Сравнение в постоянное время: иначе ключ подбирается по времени ответа. */
function secretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Сырой слой источников VendHub.
 *
 * Чтение открыто внутрь docker-сети (наружу Core не смотрит), а приём выгрузок
 * закрыт тем же ключом, что и шлюз событий: писать в базу с улицы нельзя.
 */
@Controller("raw")
export class RawController {
  constructor(private readonly raw: RawService) {}

  /** Список источников и состояние каждого отчёта. */
  @Get("sources")
  sources() {
    return this.raw.overview();
  }

  /**
   * Завести или поправить систему-источник.
   *
   * Справочник в коде остаётся основой: здесь только правки владельца, и
   * пустое поле ничего в коде не затирает.
   */
  @Post("source")
  saveSource(@Body() dto: RawSourceDefDto) {
    return this.raw.saveSource(dto);
  }

  /** Завести или поправить отчёт системы. Роли назначаются отдельно. */
  @Post("report")
  saveReport(@Body() dto: RawReportDefDto) {
    return this.raw.saveReport(dto);
  }

  /**
   * Назначить роли колонок по настоящим заголовкам выгрузки.
   *
   * Отдельно от заведения отчёта: роль указывает на колонку, а колонки видно
   * только после первой выгрузки. Угадывать их по памяти нельзя.
   */
  @Post("roles/:source/:report")
  setRoles(
    @Param("source") source: string,
    @Param("report") report: string,
    @Body() dto: RawRolesDto,
  ) {
    return this.raw.setRoles(source, report, dto.roles);
  }

  /** Последний снимок отчёта: чем именно мы располагаем. */
  @Get("report/:source/:report")
  async report(@Param("source") source: string, @Param("report") report: string) {
    // Проверка существования: отчёта нет — дальше идти незачем.
    await this.raw.report(source, report);
    return {
      snapshot: await this.raw.latestSnapshot(source, report),
      drift: await this.raw.columnDrift(source, report),
    };
  }

  /** Изменился ли состав колонок между двумя последними выгрузками. */
  @Get("report/:source/:report/drift")
  drift(@Param("source") source: string, @Param("report") report: string) {
    return this.raw.columnDrift(source, report).then((drift) => ({ drift }));
  }

  /** Страница строк последнего снимка. Фильтры по колонкам — параметрами f0, f1… */
  @Get("report/:source/:report/rows")
  async rows(
    @Param("source") source: string,
    @Param("report") report: string,
    @Query() query: Record<string, string>,
  ) {
    const def = await this.raw.report(source, report);
    const snapshot = await this.raw.latestSnapshot(source, report);
    if (!snapshot) return { snapshot: null, total: 0, rows: [], decoders: [] };
    const q = normalizeRowsQuery(query);
    const [{ total, rows }, drift] = await Promise.all([
      this.raw.rows(snapshot.id, q),
      this.raw.columnDrift(source, report),
    ]);
    // Расшифровки привязываем к НОМЕРУ колонки в этой конкретной выгрузке:
    // панель отдаёт один отчёт двумя словарями, и номер — единственное общее.
    const decoders = (def.dicts ?? [])
      .map((dict) => ({
        column: roleColumnIndex(snapshot.columns, def.roles, dict.role),
        values: dict.values,
        unconfirmed: dict.unconfirmed ?? [],
      }))
      .filter((d) => d.column >= 0);
    return { snapshot, total, rows, page: q.page, size: q.size, decoders, drift };
  }

  /** Выгрузка того, что сейчас на экране, — в CSV (Excel открывает его напрямую). */
  @Get("report/:source/:report/export.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  async exportCsv(
    @Param("source") source: string,
    @Param("report") report: string,
    @Query() query: Record<string, string>,
  ): Promise<string> {
    const snapshot = await this.raw.latestSnapshot(source, report);
    if (!snapshot) throw new NotFoundException("Этот отчёт ещё ни разу не выгружался");
    const rows = await this.raw.exportRows(snapshot.id, normalizeRowsQuery(query, MAX_EXPORT));
    return toCsv(snapshot.columns, rows);
  }

  /** Где стоял каждый автомат и когда переезжал — по заказам источника. */
  @Get("stays/:source/:report")
  stays(@Param("source") source: string, @Param("report") report: string) {
    return this.raw.machineStays(source, report).then((machines) => ({ machines }));
  }

  /** Где какой товар почём и кто отстал с ценой — по заказам источника. */
  @Get("prices/:source/:report")
  prices(@Param("source") source: string, @Param("report") report: string) {
    return this.raw.prices(source, report);
  }

  /**
   * Журнал продаж: каждая продажа с её родословной.
   *
   * Отдельным эндпоинтом, а не расширением строк: строки сырого слоя обязаны
   * оставаться строками сырого слоя, без наших выводов рядом.
   */
  @Get("journal/:source/:report")
  journal(
    @Param("source") source: string,
    @Param("report") report: string,
    @Query() query: Record<string, string>,
  ) {
    return this.raw.journal(source, report, normalizeRowsQuery(query));
  }

  /**
   * Построчная сверка двух источников по номеру операции.
   *
   * Пути: /raw/reconcile/gjvending/order_query/vs/vendinghub/operating
   */
  @Get("reconcile/:aSource/:aReport/vs/:bSource/:bReport")
  reconcile(
    @Param("aSource") aSource: string,
    @Param("aReport") aReport: string,
    @Param("bSource") bSource: string,
    @Param("bReport") bReport: string,
  ) {
    return this.raw.reconcileSources(aSource, aReport, bSource, bReport);
  }

  /**
   * Объединённый журнал двух источников: каждый заказ один раз, по номеру.
   *
   * Пути: /raw/unify/gjvending/order_query/vs/vendinghub/operating
   */
  @Get("unify/:aSource/:aReport/vs/:bSource/:bReport")
  unify(
    @Param("aSource") aSource: string,
    @Param("aReport") aReport: string,
    @Param("bSource") bSource: string,
    @Param("bReport") bReport: string,
    @Query() query: Record<string, string>,
  ) {
    return this.raw.unifySources(aSource, aReport, bSource, bReport, normalizeRowsQuery(query));
  }

  /** Объединённый журнал файлом: весь союз в CSV, чтобы разобрать спорные в Excel. */
  @Get("unify/:aSource/:aReport/vs/:bSource/:bReport/export.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  unifyExportCsv(
    @Param("aSource") aSource: string,
    @Param("aReport") aReport: string,
    @Param("bSource") bSource: string,
    @Param("bReport") bReport: string,
  ): Promise<string> {
    return this.raw.unifyExportCsv(aSource, aReport, bSource, bReport);
  }

  /** Каким способом приходят деньги — срез для сверки с платёжными системами. */
  @Get("payments/:source/:report")
  payments(@Param("source") source: string, @Param("report") report: string) {
    return this.raw.paymentReview(source, report);
  }

  /**
   * Заготовки для фискальных полей: значения и карточки-доноры.
   *
   * Берутся из уже заполненных карточек, а не из справочника «правильных»
   * значений: своего мы не выдумываем.
   */
  @Get("fiscal-presets")
  fiscalPresets() {
    return this.raw.fiscalPresets();
  }

  /** Ассортимент источника: что продаётся и по чему не собирается чек. */
  @Get("products/:source/:report")
  products(@Param("source") source: string, @Param("report") report: string) {
    return this.raw.productReview(source, report);
  }

  /** Ассортимент и история цен одного автомата — для его карточки. */
  @Get("prices/:source/:report/machine/:serial")
  machinePrices(
    @Param("source") source: string,
    @Param("report") report: string,
    @Param("serial") serial: string,
  ) {
    return this.raw.machinePrices(source, report, serial).then((items) => ({ items }));
  }

  /** Что из выгрузки узнано по карточкам реестра, а что — нет. */
  @Get("mapping/:source/:report")
  mapping(@Param("source") source: string, @Param("report") report: string) {
    return this.raw.mapping(source, report);
  }

  /** Решение владельца: это значение источника — вот эта карточка. */
  @Post("link")
  link(@Body() dto: RawLinkDto) {
    return this.raw.setLink({
      sourceCode: dto.source,
      kind: dto.kind,
      label: dto.label,
      entityId: dto.entityId ?? null,
      ...(dto.note !== undefined ? { note: dto.note } : {}),
    });
  }

  /** Приём выгрузки. Ключ тот же, что у шлюза событий. */
  @Post("import/:key")
  import(@Param("key") key: string, @Body() dto: RawImportDto) {
    const expected = process.env.INGEST_KEY ?? "";
    if (!expected) {
      throw new ServiceUnavailableException(
        "Приём выгрузок выключен: INGEST_KEY не задан в .env",
      );
    }
    if (!secretEquals(key, expected)) {
      throw new UnauthorizedException("Неверный ключ приёма");
    }
    return this.raw.import(dto);
  }
}
