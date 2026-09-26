import "reflect-metadata";
import { ConsoleLogger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { WsAdapter } from "@nestjs/platform-ws";
import { config } from "./config.js";
import { AppModule } from "./app.module.js";
import { requestContext } from "./common/request-context.js";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: new ConsoleLogger({ json: true, prefix: "api" }),
    bodyParser: false,
  });

  app.set("trust proxy", config.trustProxy);
  app.disable("x-powered-by");
  app.set("etag", false);
  app.useBodyParser("json", { limit: "2mb" });
  app.use(requestContext);
  app.use((_req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    next();
  });
  app.enableCors({ origin: config.webOrigins, methods: ["GET", "POST"], exposedHeaders: ["x-request-id"], maxAge: 600 });
  app.setGlobalPrefix("api/v1");
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();

  // All interfaces: in production the API is reached through the reverse proxy on a private network.
  await app.listen(config.port, "0.0.0.0");
  new ConsoleLogger({ json: true, prefix: "api" }).log(`API listening on port ${config.port}`, "Bootstrap");
}

void bootstrap();
