import { config } from "dotenv";
import { defineConfig } from "prisma/config";

// The repository keeps one .env at the root for every service.
config({ path: ["../../.env", ".env"], quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: {
    url: process.env.DATABASE_URL ?? "postgresql://cw:cw_local_dev@localhost:5432/code_workspace",
  },
});
