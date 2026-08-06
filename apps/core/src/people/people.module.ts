import { Module } from "@nestjs/common";
import { InvitesService } from "./invites.service";
import { PeopleController } from "./people.controller";
import { PeopleService } from "./people.service";

@Module({
  controllers: [PeopleController],
  providers: [PeopleService, InvitesService],
  exports: [PeopleService, InvitesService],
})
export class PeopleModule {}
