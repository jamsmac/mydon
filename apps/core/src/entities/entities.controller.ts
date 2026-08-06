import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";
import { MACHINE_KINDS, type MachineKind } from "@mydon/shared";
import { EntitiesService } from "./entities.service";
import { CreateEntityDto, FindEntitiesDto, UpdateEntityDto } from "./entity.dto";

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

@Controller("entities")
export class EntitiesController {
  constructor(private readonly entities: EntitiesService) {}

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
  find(@Query() filter: FindEntitiesDto) {
    return this.entities.find(filter);
  }

  /**
   * Всё, что ждёт слова владельца: карточки и предложенные значения.
   *
   * Стоит ВЫШЕ маршрута `:id` — иначе «pending» ушло бы в него как в
   * идентификатор и вернуло бы ошибку разбора.
   */
  @Get("pending")
  pending() {
    return this.entities.pending();
  }

  @Get(":id")
  byId(@Param("id", ParseUUIDPipe) id: string) {
    return this.entities.byId(id);
  }

  /** Предложенные значения полей карточки. */
  @Get(":id/drafts")
  drafts(@Param("id", ParseUUIDPipe) id: string) {
    return this.entities.drafts(id);
  }

  /** Рецепт товара: состав, цены ингредиентов и себестоимость. */
  @Get(":id/recipe")
  recipe(@Param("id", ParseUUIDPipe) id: string) {
    return this.entities.recipeOf(id);
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
  @Get("machine-cards/all")
  machineCards() {
    return this.entities.machineCards();
  }

  @Patch(":id/machine-kind")
  setMachineKind(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetMachineKindDto) {
    return this.entities.setMachineKind(id, dto.kind, dto.actor ?? "owner", dto.note);
  }
}
