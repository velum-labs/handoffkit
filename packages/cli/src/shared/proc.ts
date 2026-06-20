/**
 * Process helpers live in `@fusionkit/tools` so tool packages and the CLI share
 * one implementation. Re-exported here to keep the CLI's existing import paths.
 */
export {
  distillLog,
  freePort,
  sleep,
  spawnLogged,
  spawnTool,
  terminate,
  waitForHttp,
  waitForOutput
} from "@fusionkit/tools";
export type { LoggedChild, LoggedSpawnOptions } from "@fusionkit/tools";
