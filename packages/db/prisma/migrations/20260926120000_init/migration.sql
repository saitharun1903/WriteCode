-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('QUEUED', 'COMPILING', 'RUNNING', 'SUCCESS', 'COMPILATION_ERROR', 'RUNTIME_ERROR', 'TIME_LIMIT', 'MEMORY_LIMIT', 'OUTPUT_LIMIT', 'CANCELLED', 'SYSTEM_ERROR');

-- CreateTable
CREATE TABLE "executions" (
    "id" UUID NOT NULL,
    "language" VARCHAR(32) NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'QUEUED',
    "entry_file" VARCHAR(200) NOT NULL,
    "file_count" INTEGER NOT NULL,
    "source_bytes" INTEGER NOT NULL,
    "runtime_version" VARCHAR(64) NOT NULL,
    "exit_code" INTEGER,
    "execution_time" INTEGER,
    "compile_time" INTEGER,
    "memory_used" BIGINT,
    "message" TEXT,
    "stdout" TEXT NOT NULL DEFAULT '',
    "stderr" TEXT NOT NULL DEFAULT '',
    "compile_output" TEXT NOT NULL DEFAULT '',
    "output_truncated" BOOLEAN NOT NULL DEFAULT false,
    "client_hash" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),

    CONSTRAINT "executions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "executions_created_at_idx" ON "executions"("created_at");

-- CreateIndex
CREATE INDEX "executions_status_idx" ON "executions"("status");

