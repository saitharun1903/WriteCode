-- Interactive stdin and finer-grained timings.
ALTER TYPE "ExecutionStatus" ADD VALUE 'STARTING' AFTER 'QUEUED';
ALTER TYPE "ExecutionStatus" ADD VALUE 'WAITING_FOR_INPUT' AFTER 'RUNNING';

ALTER TABLE "executions" ADD COLUMN "queue_time" INTEGER,
ADD COLUMN "startup_time" INTEGER,
ADD COLUMN "interactive" BOOLEAN NOT NULL DEFAULT false;
