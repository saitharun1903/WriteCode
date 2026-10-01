import { BadRequestException, Body, Controller, HttpCode, HttpException, Inject, NotFoundException, Post, Req } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import type { Request } from "express";
import type { Redis } from "ioredis";
import { SHARE_ID, SHARE_LIMITS, TRANSFER_ID, cleanSharedCode, cleanTransferProject, type Project, type SharedCode } from "@cw/shared";
import { clientHash } from "../common/request-context.js";
import { REDIS } from "../infra/infra.module.js";

/** Links one person may create per hour: plenty for sharing, too few to use the server as storage. */
const SHARES_PER_HOUR = 30;
const TRANSFERS_PER_HOUR = 12;
/** Opening links (people click around, pages reload): generous, but not a way to guess ids. */
const OPENS_PER_HOUR = 600;

const shareKey = (id: string) => `share:${id}`;
const transferKey = (id: string) => `transfer:${id}`;
/** The code already made for these exact projects, so asking again does not store them twice. */
const transferOfKey = (json: string) => `transfer:of:${createHash("sha256").update(json).digest("base64url")}`;

/**
 * Code shared by link and projects moved between browsers. Both are kept in
 * Redis with an expiry: a share for 90 days after it was last opened,
 * a transfer for 12 hours after it was made, however many people open them. Ids come in the request body, not
 * the address, so they are not written to access logs.
 */
@Controller()
export class ShareController {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  private async limit(req: Request, what: string, max: number, message: string) {
    const key = `${what}:c:${clientHash(req.ip)}:${Math.floor(Date.now() / 3_600_000)}`;
    const counts = await this.redis.multi().incr(key).expire(key, 3601).exec();
    if (Number(counts?.[0]?.[1] ?? 0) > max) throw new HttpException(message, 429);
  }

  /** Shares a read-only copy of a project's files. Returns the id for its link. */
  @Post("shares")
  @HttpCode(201)
  async share(@Body() body: unknown, @Req() req: Request): Promise<{ id: string }> {
    const code = cleanSharedCode(body);
    if (!code) throw new BadRequestException(`This project cannot be shared: at most ${SHARE_LIMITS.maxFiles} files and 1 MB of code.`);
    await this.limit(req, "share", SHARES_PER_HOUR, "You have shared a lot of links in the last hour. Try again later.");
    const id = randomBytes(12).toString("base64url");
    await this.redis.set(shareKey(id), JSON.stringify(code), "EX", SHARE_LIMITS.ttlSeconds);
    return { id };
  }

  /** The code behind a share link. Opening it keeps it alive. */
  @Post("shares/open")
  @HttpCode(200)
  async openShare(@Body() body: unknown, @Req() req: Request): Promise<SharedCode> {
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !SHARE_ID.test(id)) throw new NotFoundException("This link is not complete. Ask for it again.");
    await this.limit(req, "open", OPENS_PER_HOUR, "Too many links opened. Try again later.");
    const raw = await this.redis.getex(shareKey(id), "EX", SHARE_LIMITS.ttlSeconds);
    if (!raw) throw new NotFoundException("This shared code no longer exists. Links stop working 90 days after they were last opened.");
    return JSON.parse(raw) as SharedCode;
  }

  /** Puts projects aside for other browsers to pick up, any number of times. */
  @Post("transfers")
  @HttpCode(201)
  async transfer(@Body() body: unknown, @Req() req: Request): Promise<{ id: string; projects: number; expiresInSeconds: number }> {
    const list = body && typeof body === "object" ? (body as { projects?: unknown }).projects : undefined;
    if (!Array.isArray(list) || list.length === 0 || list.length > SHARE_LIMITS.transferMaxProjects) {
      throw new BadRequestException(`Send between 1 and ${SHARE_LIMITS.transferMaxProjects} projects.`);
    }
    const projects = list.map((p) => cleanTransferProject(p));
    if (projects.some((p) => !p)) throw new BadRequestException("One of the projects cannot be moved (too large, or its files are not valid).");
    const json = JSON.stringify(projects);
    if (json.length > SHARE_LIMITS.transferMaxBytes) throw new BadRequestException("These projects are too large to move at once. Move fewer at a time.");
    // The same projects, unchanged: the code made for them before is still the one.
    const known = await this.redis.get(transferOfKey(json));
    if (known && (await this.redis.expire(transferKey(known), SHARE_LIMITS.transferTtlSeconds)) === 1) {
      await this.redis.expire(transferOfKey(json), SHARE_LIMITS.transferTtlSeconds);
      return { id: known, projects: projects.length, expiresInSeconds: SHARE_LIMITS.transferTtlSeconds };
    }
    await this.limit(req, "transfer", TRANSFERS_PER_HOUR, "You have moved projects many times in the last hour. Try again later.");
    const id = randomBytes(18).toString("base64url");
    await this.redis.multi().set(transferKey(id), json, "EX", SHARE_LIMITS.transferTtlSeconds).set(transferOfKey(json), id, "EX", SHARE_LIMITS.transferTtlSeconds).exec();
    return { id, projects: projects.length, expiresInSeconds: SHARE_LIMITS.transferTtlSeconds };
  }

  /** The projects of a transfer: any number of times, until it is 12 hours old. */
  @Post("transfers/open")
  @HttpCode(200)
  async openTransfer(@Body() body: unknown, @Req() req: Request): Promise<{ projects: Project[] }> {
    const id = body && typeof body === "object" ? (body as { id?: unknown }).id : undefined;
    if (typeof id !== "string" || !TRANSFER_ID.test(id)) throw new NotFoundException("This code is not complete. Scan it again.");
    await this.limit(req, "open", OPENS_PER_HOUR, "Too many links opened. Try again later.");
    const raw = await this.redis.get(transferKey(id));
    if (!raw) throw new NotFoundException("This code has stopped working. Codes work for 12 hours: make a new one on the other device.");
    return { projects: JSON.parse(raw) as Project[] };
  }
}
