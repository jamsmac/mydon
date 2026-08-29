import { Body, Controller, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import {
  ClaimTaskLlmDispatchDto,
  CompleteTaskLlmJobDto,
  EnsureTaskLlmJobDto,
} from "./task-llm-jobs.dto";
import { TaskLlmJobsService } from "./task-llm-jobs.service";

/** All endpoints are POST-only because GET is intentionally public in Core. */
@Controller("tasks/:taskId/agent-run/llm-jobs")
export class TaskLlmJobsController {
  constructor(private readonly jobs: TaskLlmJobsService) {}

  @Post("ensure")
  ensure(@Param("taskId", ParseUUIDPipe) taskId: string, @Body() dto: EnsureTaskLlmJobDto) {
    return this.jobs.ensure(taskId, dto);
  }

  @Post(":jobId/claim-dispatch")
  claimDispatch(
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Body() dto: ClaimTaskLlmDispatchDto,
  ) {
    return this.jobs.claimDispatch(taskId, jobId, dto);
  }

  @Post(":jobId/complete")
  complete(
    @Param("taskId", ParseUUIDPipe) taskId: string,
    @Param("jobId", ParseUUIDPipe) jobId: string,
    @Body() dto: CompleteTaskLlmJobDto,
  ) {
    return this.jobs.complete(taskId, jobId, dto);
  }
}
