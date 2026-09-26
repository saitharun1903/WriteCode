import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.js";

export { PrismaClient } from "./generated/prisma/client.js";
export type { Execution, Prisma } from "./generated/prisma/client.js";
export { ExecutionStatus as DbExecutionStatus } from "./generated/prisma/enums.js";

export const DEFAULT_DATABASE_URL = "postgresql://cw:cw_local_dev@localhost:5432/code_workspace";

/** Creates a Prisma client backed by the node-postgres driver adapter. */
export function createPrismaClient(url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
