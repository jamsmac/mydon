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
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";
import { RAW_LINK_KINDS, findRawReport, roleColumnIndex, type RawLinkKind } from "@mydon/shared";
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

  /** Последний снимок отчёта: чем именно мы располагаем. */
  @Get("report/:source/:report")
  async report(@Param("source") source: string, @Param("report") report: string) {
    const def = findRawReport(source, report);
    if (!def) {
      throw new NotFoundException("Такого отчёта нет в справочнике источников");
    }
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
    const def = findRawReport(source, report);
    if (!def) throw new NotFoundException("Такого отчёта нет в справочнике источников");
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
