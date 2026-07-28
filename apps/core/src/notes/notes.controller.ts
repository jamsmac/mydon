import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { ArrayMaxSize, IsArray, IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";
import { NotesService } from "./notes.service";

export class CreateNoteDto {
  @IsOptional() @IsString() @MaxLength(512)
  title?: string;

  @IsString() @IsNotEmpty() @MaxLength(20000)
  body!: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true }) @MaxLength(64, { each: true })
  tags?: string[];
}

/** Знания MYDON: перенесённая память и выжимки разговоров. */
@Controller("notes")
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Get()
  list(@Query("q") q?: string) {
    return q && q.trim().length > 0 ? this.notes.search(q.trim()) : this.notes.list();
  }

  @Post()
  create(@Body() dto: CreateNoteDto) {
    return this.notes.create(dto);
  }
}
