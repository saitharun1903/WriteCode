import { Body, Controller, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { LANGUAGES } from "@cw/shared";
import { clientHash } from "../common/request-context.js";
import { ExecutionsService } from "./executions.service.js";

@Controller()
export class ExecutionsController {
  constructor(private readonly executions: ExecutionsService) {}

  @Post("executions")
  @HttpCode(202)
  create(@Body() body: unknown, @Req() req: Request) {
    return this.executions.create(body, clientHash(req.ip));
  }

  @Get("executions/:id")
  get(@Param("id") id: string) {
    return this.executions.get(id);
  }

  @Post("executions/:id/cancel")
  @HttpCode(200)
  cancel(@Param("id") id: string) {
    return this.executions.cancel(id);
  }

  /** Public language metadata (no sandbox internals such as images or commands). */
  @Get("languages")
  languages() {
    return LANGUAGES.map(({ id, name, version, extensions, supportLevel, entryFile }) => ({
      id,
      name,
      version,
      extensions,
      supportLevel,
      entryFile,
    }));
  }
}
