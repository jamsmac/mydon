import { Body, Controller, Delete, Get, Inject, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength, ValidateIf } from "class-validator";
import type { Request } from "express";
import {
  MACHINE_KINDS,
  MACHINE_STATUSES,
  MERGE_BASES,
  MERGE_REASON_MIN,
  type MachineKind,
  type MachineStatus,
  type MergeBasis,
} from "@mydon/shared";
import { DB, type Db } from "../db/db.module";
import { excludePersonal } from "../common/owner-enforcement";
import { EntitiesService } from "./entities.service";
import { PlaceCardService } from "./place-card.service";
import { PlaceMergeService } from "./place-merge.service";
import { CreateEntityDto, FindEntitiesDto, UpdateEntityDto } from "./entity.dto";
import { requestActor } from "../common/request-actor";

/** Предложение значения поля карточки — не запись, а заявка на неё. */
export class ProposeFieldDto {
  @IsString() @IsNotEmpty() @MaxLength(128)
  field!: string;

  @IsString() @MaxLength(2000)
  value!: string;

  /** Откуда взято — владелец читает это словами, решая, верить или нет. */
  @IsString() @IsNotEmpty() @MaxLength(128)
  origin!: string;

  @IsOptional() @IsString() @MaxLength(128)
  setBy?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  note?: string;
}


/**
 * Состояние автомата — работает он сейчас или нет.
 *
 * Отдельно от вида: вид называют один раз, состояние меняется каждый раз,
 * когда автомат уезжает в ремонт и возвращается.
 */
export class SetMachineStatusDto {
  @IsIn([...MACHINE_STATUSES])
  status!: MachineStatus;

  /** Почему: «отправлен в ремонт 05.08», номер заявки. */
  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;

  /**
   * Куда автомат уехал: склад, мастерская, точка продаж.
   *
   * Необязательно — уход из эксплуатации закрывает старое размещение в любом
   * случае, а место указывают, когда его знают. Пустое место честнее
   * выдуманного: «снят с точки, где именно — не записано».
   */
  @IsOptional() @IsUUID()
  placeId?: string;
}

/** Вид автомата — поле карточки, а не догадка по косвенным признакам. */
export class SetMachineKindDto {
  @IsIn([...MACHINE_KINDS])
  kind!: MachineKind;

  @IsOptional() @IsString() @MaxLength(2000)
  note?: string;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

/** Набор карточек к утверждению разом — «утвердить все» из очереди. */
export class ApproveBatchDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID("all", { each: true })
  ids!: string[];
}

/** Номер автомата: вписать/исправить (`null` — снять) или подтвердить наклейку. */
export class SetMachineNumberDto {
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(32)
  inventoryNo?: string | null;

  @IsOptional()
  @IsBoolean()
  confirmLabel?: boolean;
}

/** Владелец места; `null` — снять («не знаем, чьё помещение»). */
export class SetPlaceContractorDto {
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  contractorId!: string | null;
}

export class MergePlacesDto {
  @IsIn([...MERGE_BASES])
  basis!: MergeBasis;

  @IsString()
  @MinLength(MERGE_REASON_MIN)
  @MaxLength(500)
  reason!: string;
}

@Controller("entities")
export class EntitiesController {
  constructor(
    private readonly entities: EntitiesService,
    @Inject(DB) private readonly db: Db,
    private readonly placeCards: PlaceCardService,
    private readonly placeMerge: PlaceMergeService,
  ) {}

  /**
   * Исключать ли личный контур из domain-less чтения.
   *
   * Тот же механизм, что у PersonalDomainGuard (R-P5-6): ужесточение включено И
   * запрос НЕ доказан owner-токеном. Гейт ловит только явный `domain=personal`,
   * а generic-эндпоинты (find/byId/pending без домена) он пропускает — здесь мы
   * закрываем именно этот обход. Флаг выключен (дефолт) → false → выдача прода
   * не меняется.
   */
  private excludePersonal(req: Request): Promise<boolean> {
    return excludePersonal(req, this.db);
  }

  @Post()
  create(@Body() dto: CreateEntityDto) {
    return this.entities.create(dto);
  }

  /** Утвердить пачку карточек разом. Пропавшие/уже утверждённые пропускаются. */
  @Post("approve-batch")
  approveBatch(@Body() dto: ApproveBatchDto) {
    return this.entities.approveMany(dto.ids, "owner");
  }

  @Get()
  async find(@Query() filter: FindEntitiesDto, @Req() req: Request) {
    return this.entities.find(filter, await this.excludePersonal(req));
  }

  /**
   * Всё, что ждёт слова владельца: карточки и предложенные значения.
   *
   * Стоит ВЫШЕ маршрута `:id` — иначе «pending» ушло бы в него как в
   * идентификатор и вернуло бы ошибку разбора.
   */
  @Get("pending")
  async pending(@Req() req: Request) {
    return this.entities.pending(await this.excludePersonal(req));
  }

  @Get(":id")
  async byId(@Param("id", ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.entities.byId(id, await this.excludePersonal(req));
  }

  /** Предложенные значения полей карточки. */
  @Get(":id/drafts")
  async drafts(@Param("id", ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.entities.drafts(id, await this.excludePersonal(req));
  }

  /** Рецепт товара: состав, цены ингредиентов и себестоимость. */
  @Get(":id/recipe")
  async recipe(@Param("id", ParseUUIDPipe) id: string, @Req() req: Request) {
    return this.entities.recipeOf(id, await this.excludePersonal(req));
  }

  /** Предложить значение поля. В карточку оно не попадёт до утверждения. */
  @Post(":id/propose")
  propose(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ProposeFieldDto) {
    return this.entities.propose({ entityId: id, ...dto });
  }

  /** Утвердить карточку — вместе со всем, что ей предложено. */
  @Post(":id/approve")
  approve(@Param("id", ParseUUIDPipe) id: string) {
    return this.entities.approve(id, "owner");
  }

  /** Утвердить одно предложенное значение. */
  @Post(":id/approve-field/:field")
  approveField(@Param("id", ParseUUIDPipe) id: string, @Param("field") field: string) {
    return this.entities.approveField(id, field, "owner");
  }

  /** Отклонить предложенное значение: уходит без следа в карточке. */
  @Post(":id/reject-field/:field")
  rejectField(@Param("id", ParseUUIDPipe) id: string, @Param("field") field: string) {
    return this.entities.rejectField(id, field, "owner");
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateEntityDto) {
    return this.entities.update(id, dto);
  }

  @Delete(":id")
  async remove(@Param("id", ParseUUIDPipe) id: string) {
    await this.entities.remove(id);
    return { ok: true };
  }

  // ── Карточка автомата: вид ────────────────────────────────────────────────

  /** Виды всех размеченных автоматов. Отсутствие строки = не размечен. */
  /**
   * Перенос координат с автоматов на их места (волна 2, М-4). GET — только
   * план: его показывает экран «Места» при каждом открытии, и чтение не
   * должно идти записывающей дверью. POST — применить план.
   */
  @Get("places/adopt-machine-coords")
  adoptMachineCoordsPlan() {
    return this.entities.adoptMachineCoords({ dryRun: true });
  }

  @Post("places/adopt-machine-coords")
  adoptMachineCoords() {
    return this.entities.adoptMachineCoords({ dryRun: false });
  }

  // ── Место и его контрагент (волна 2б, М-1, М-2, М-11) ──────────────────────

  /** Владельцы всех мест одним запросом. */
  @Get("place-cards/owners")
  placeOwners() {
    return this.placeCards.owners();
  }

  @Get(":id/places-owned")
  placesOwned(@Param("id", ParseUUIDPipe) id: string) {
    return this.placeCards.placesOf(id);
  }

  @Put(":id/place-card")
  setPlaceContractor(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetPlaceContractorDto) {
    return this.placeCards.setContractor(id, dto.contractorId ?? null);
  }

  // ── Слияние карточек одного места (М-9, М-10) ─────────────────────────────

  /** Предпросмотр: что переедет и что мешает. Чтение — ничего не пишет. */
  @Get(":id/merge-into/:targetId")
  mergePreview(@Param("id", ParseUUIDPipe) id: string, @Param("targetId", ParseUUIDPipe) targetId: string) {
    return this.placeMerge.preview(id, targetId);
  }

  @Post(":id/merge-into/:targetId")
  merge(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("targetId", ParseUUIDPipe) targetId: string,
    @Body() dto: MergePlacesDto,
  ) {
    return this.placeMerge.merge(id, targetId, { basis: dto.basis, reason: dto.reason });
  }

  // ── Номер автомата (волна 3, М-6…М-8, М-12) ───────────────────────────────

  /** План присвоения номеров всем без номера — чтение. */
  @Get("machine-numbers/plan")
  machineNumberPlan() {
    return this.entities.machineNumberPlan();
  }

  /** Присвоить по плану: номер сразу, наклейка догоняет (label_pending). */
  @Post("machine-numbers/plan")
  applyMachineNumberPlan() {
    return this.entities.applyMachineNumberPlan();
  }

  @Put(":id/machine-number")
  setMachineNumber(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetMachineNumberDto) {
    return this.entities.setMachineNumber(id, {
      ...(dto.inventoryNo !== undefined ? { inventoryNo: dto.inventoryNo } : {}),
      ...(dto.confirmLabel !== undefined ? { confirmLabel: dto.confirmLabel } : {}),
    });
  }

  @Get("machine-cards/all")
  machineCards() {
    return this.entities.machineCards();
  }

  @Patch(":id/machine-status")
  setMachineStatus(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetMachineStatusDto) {
    return this.entities.setMachineStatus(id, dto.status, dto.actor ?? requestActor("owner"), dto.note, dto.placeId);
  }

  @Patch(":id/machine-kind")
  setMachineKind(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetMachineKindDto) {
    return this.entities.setMachineKind(id, dto.kind, dto.actor ?? requestActor("owner"), dto.note);
  }
}
