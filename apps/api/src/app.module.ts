import { Module } from "@nestjs/common";
import { AssistantController } from "./assistant/assistant.controller.js";
import { ExecutionStore } from "./executions/execution-store.js";
import { ExecutionsController } from "./executions/executions.controller.js";
import { ExecutionsService } from "./executions/executions.service.js";
import { RateLimiter } from "./executions/rate-limiter.js";
import { HealthController } from "./health/health.controller.js";
import { RunnerStatusService } from "./health/runner-status.service.js";
import { InfraModule } from "./infra/infra.module.js";
import { StreamGateway } from "./stream/stream.gateway.js";
import { StreamHub } from "./stream/stream-hub.js";

@Module({
  imports: [InfraModule],
  controllers: [HealthController, ExecutionsController, AssistantController],
  providers: [RunnerStatusService, ExecutionStore, RateLimiter, ExecutionsService, StreamHub, StreamGateway],
})
export class AppModule {}
