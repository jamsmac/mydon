import { Module } from "@nestjs/common";
import { OwnerMutationGuard } from "../common/owner-mutation.guard";
import { InvitesService } from "./invites.service";
import { PeopleController } from "./people.controller";
import { PeopleService } from "./people.service";

@Module({
  controllers: [PeopleController],
  providers: [PeopleService, InvitesService, OwnerMutationGuard],
  exports: [PeopleService, InvitesService],
})
export class PeopleModule {}
