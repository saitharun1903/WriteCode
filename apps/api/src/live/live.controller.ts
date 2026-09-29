import { Controller, HttpCode, HttpException, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { clientHash } from "../common/request-context.js";
import { LiveService } from "./live.gateway.js";
import { LiveError } from "./rooms.js";

@Controller()
export class LiveController {
  constructor(private readonly live: LiveService) {}

  /** Starts a live session. The owner token proves ownership when (re)connecting; keep it secret. */
  @Post("live")
  @HttpCode(201)
  async create(@Req() req: Request) {
    try {
      return await this.live.rooms.create(clientHash(req.ip));
    } catch (e) {
      if (e instanceof LiveError && e.code === "rate") throw new HttpException(e.message, 429);
      throw e;
    }
  }
}
