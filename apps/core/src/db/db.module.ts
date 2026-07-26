import { Global, Module } from "@nestjs/common";
import { createDb, type Database } from "@mydon/db";
import { appConfig } from "../config";

/** Токен внедрения подключения к MYDON Core. */
export const DB = Symbol("MYDON_DB");

export type Db = Database;

@Global()
@Module({
  providers: [
    {
      provide: DB,
      useFactory: (): Database => createDb(appConfig.databaseUrl),
    },
  ],
  exports: [DB],
})
export class DbModule {}
