import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { DOMAINS, type Domain,
  MAX_ENTITY_NAME,
  MAX_FIND_LIMIT,
} from "@mydon/shared";

export class CreateEntityDto {
  @IsIn([...DOMAINS], { message: "domain должен быть одним из: " + DOMAINS.join(", ") })
  domain!: Domain;

  /** Тип сущности: contractor | machine | equipment | object | contract | ... */
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  type!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ENTITY_NAME)
  name!: string;

  /** Ссылка на источник: ИНН, id в VHM24 и т.п. Служит ключом при сведении справочников. */
  @IsOptional()
  @IsString()
  @MaxLength(256)
  externalRef?: string;

  @IsOptional()
  @IsObject()
  attrs?: Record<string, unknown>;

  /**
   * Откуда карточка взялась: код источника, имя агента.
   *
   * Пусто — завёл владелец, и карточка сразу считается утверждённой. Заполнено
   * — карточка ждёт его слова: всё, что по автоматам и товарам вписал не он,
   * фактом не считается, пока он не утвердил.
   */
  @IsOptional() @IsString() @MaxLength(128)
  createdFrom?: string;
}

export class UpdateEntityDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_ENTITY_NAME)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  externalRef?: string;

  @IsOptional()
  @IsObject()
  attrs?: Record<string, unknown>;
}

export class FindEntitiesDto {
  @IsOptional()
  @IsIn([...DOMAINS])
  domain?: Domain;

  @IsOptional()
  @IsString()
  type?: string;

  /** Поиск по имени (подстрока, без учёта регистра). */
  @IsOptional()
  @IsString()
  q?: string;

  @IsOptional()
  @IsUUID()
  id?: string;

  /**
   * Сколько карточек вернуть. По умолчанию 500 — сколько и было.
   *
   * ЗАЧЕМ ПАРАМЕТР. Предел был зашит числом, и выборка молча обрезалась: в
   * реестре 1156 карточек, из них 704 счёта, а проверка реестра видела первые
   * 500 и печатала «расхождений не найдено». Усечение, о котором никто не
   * знает, читается как «всё чисто» — худший вид ответа.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_FIND_LIMIT)
  limit?: number;
}
