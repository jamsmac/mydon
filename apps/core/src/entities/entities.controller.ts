import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { EntitiesService } from "./entities.service";
import { CreateEntityDto, FindEntitiesDto, UpdateEntityDto } from "./entity.dto";

@Controller("entities")
export class EntitiesController {
  constructor(private readonly entities: EntitiesService) {}

  @Post()
  create(@Body() dto: CreateEntityDto) {
    return this.entities.create(dto);
  }

  @Get()
  find(@Query() filter: FindEntitiesDto) {
    return this.entities.find(filter);
  }

  @Get(":id")
  byId(@Param("id", ParseUUIDPipe) id: string) {
    return this.entities.byId(id);
  }

  @Patch(":id")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateEntityDto) {
    return this.entities.update(id, dto);
  }
}
