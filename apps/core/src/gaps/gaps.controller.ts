import { Controller, Get } from "@nestjs/common";
import { GapsService, type Gap } from "./gaps.service";

/**
 * Реестр пробелов (срез К, задача 5): что нельзя посчитать прямо сейчас,
 * явным адресным списком. Пустой массив — хорошая новость, а не ошибка.
 */
@Controller("gaps")
export class GapsController {
  constructor(private readonly gaps: GapsService) {}

  @Get()
  list(): Promise<Gap[]> {
    return this.gaps.list();
  }
}
