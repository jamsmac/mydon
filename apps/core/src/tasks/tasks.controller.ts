import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from "@nestjs/common";
import { IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { DOMAINS, type Domain } from "@mydon/shared";
import { TasksService } from "./tasks.service";

const STATUSES = ["todo", "in_progress", "done", "cancelled"] as const;
type Status = (typeof STATUSES)[number];

export class CreateTaskDto {
  @IsString() @IsNotEmpty() @MaxLength(512)
  title!: string;

  @IsIn(["human", "agent"], { message: "ownerKind: human или agent" })
  ownerKind!: "human" | "agent";

  @IsOptional() @IsString() @MaxLength(128)
  ownerRef?: string;

  @IsOptional() @IsIn([...DOMAINS])
  domain?: Domain;

  @IsOptional() @IsISO8601({}, { message: "due: дата в формате ISO" })
  due?: string;

  @IsOptional() @IsString() @MaxLength(128)
  source?: string;
}

export class ListTasksDto {
  @IsOptional() @IsIn([...STATUSES])
  status?: Status;

  @IsOptional() @IsIn([...DOMAINS])
  domain?: Domain;
}

export class SetStatusDto {
  @IsIn([...STATUSES])
  status!: Status;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

@Controller("tasks")
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Post()
  create(@Body() dto: CreateTaskDto) {
    return this.tasks.create({
      title: dto.title,
      ownerKind: dto.ownerKind,
      ...(dto.ownerRef ? { ownerRef: dto.ownerRef } : {}),
      ...(dto.domain ? { domain: dto.domain } : {}),
      ...(dto.due ? { due: new Date(dto.due) } : {}),
      ...(dto.source ? { source: dto.source } : {}),
    });
  }

  // Объявлено ВЫШЕ параметрических маршрутов, иначе "overdue" уедет в :id.
  @Get("overdue")
  overdue() {
    return this.tasks.overdue();
  }

  @Get()
  list(@Query() filter: ListTasksDto) {
    return this.tasks.list(filter);
  }

  @Patch(":id")
  setStatus(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetStatusDto) {
    return this.tasks.setStatus(id, dto.status, dto.actor ?? "owner");
  }
}
