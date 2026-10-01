import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, HttpException, Inject, Post, Req, ServiceUnavailableException } from "@nestjs/common";
import type { Request } from "express";
import type { Redis } from "ioredis";
import { cleanInterviewSetup } from "@cw/shared";
import { clientHash } from "../common/request-context.js";
import { config } from "../config.js";
import { emailAvailable, inviteEmail, sendEmail } from "../email/resend.js";
import { REDIS } from "../infra/infra.module.js";
import { LiveService } from "./live.gateway.js";
import { LiveError, cleanName } from "./rooms.js";
import { iceServers } from "./turn.js";

const EMAIL = /^[^\s@,;<>"]{1,64}@[^\s@,;<>"]{1,190}\.[A-Za-z]{2,}$/;
/** Emails one person may send per hour, and one session per day: enough to invite a class, too few to spam. */
const PER_CLIENT_HOUR = 40;
const PER_ROOM_DAY = 60;
const MAX_RECIPIENTS = 10;
/** Camera set-ups one person may ask for per hour (each interview needs one or two). */
const ICE_PER_CLIENT_HOUR = 60;

@Controller()
export class LiveController {
  constructor(
    private readonly live: LiveService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /**
   * Starts a live session, or an interview when `interview` (problem, duration,
   * hidden tests) is given. The owner token proves ownership; keep it secret.
   */
  @Post("live")
  @HttpCode(201)
  async create(@Body() body: unknown, @Req() req: Request) {
    const raw = body && typeof body === "object" ? (body as { interview?: unknown }).interview : undefined;
    const interview = raw === undefined ? null : cleanInterviewSetup(raw);
    if (raw !== undefined && !interview) throw new BadRequestException("Invalid interview setup.");
    try {
      return await this.live.rooms.create(clientHash(req.ip), interview);
    } catch (e) {
      if (e instanceof LiveError && e.code === "rate") throw new HttpException(e.message, 429);
      throw e;
    }
  }

  /**
   * The servers a browser uses to connect an interview's camera: STUN, and the relay (TURN)
   * with a credential that expires. Only for interviews that are open, and rate-limited,
   * so the relay cannot be used as a free service.
   */
  @Post("live/ice")
  @HttpCode(200)
  async ice(@Body() body: unknown, @Req() req: Request) {
    const room = body && typeof body === "object" ? (body as { room?: unknown }).room : undefined;
    if (!(await this.live.rooms.isOpenInterview(room))) throw new ForbiddenException("The camera is only used in an interview that is open.");
    const key = `ice:c:${clientHash(req.ip)}:${Math.floor(Date.now() / 3_600_000)}`;
    const counts = await this.redis.multi().incr(key).expire(key, 3601).exec();
    if (Number(counts?.[0]?.[1] ?? 0) > ICE_PER_CLIENT_HOUR) throw new HttpException("Too many camera connections. Try again later.", 429);
    return { iceServers: iceServers(config.turn, String(room).slice(0, 8)) };
  }

  /** Whether invitations can be emailed from this server. */
  @Get("live/email-status")
  emailStatus() {
    return { available: emailAvailable() };
  }

  /**
   * Emails the session link to people. Only the session's owner may do this
   * (proved by the owner token), and the message is a fixed template, so the
   * endpoint cannot be used to send arbitrary email.
   */
  @Post("live/invite")
  @HttpCode(200)
  async invite(@Body() body: unknown, @Req() req: Request) {
    if (!emailAvailable()) throw new ServiceUnavailableException("Email is not set up on this server.");
    const b = (body && typeof body === "object" ? body : {}) as { room?: unknown; ownerToken?: unknown; emails?: unknown; from?: unknown };
    const meta = await this.live.rooms.verifyOwner(b.room, b.ownerToken);
    if (!meta) throw new ForbiddenException("Only the person who started this session can email invitations.");
    const emails = Array.isArray(b.emails) ? [...new Set(b.emails.filter((e): e is string => typeof e === "string").map((e) => e.trim().toLowerCase()))] : [];
    if (!emails.length || emails.length > MAX_RECIPIENTS) throw new BadRequestException(`Send to between 1 and ${MAX_RECIPIENTS} addresses at a time.`);
    const bad = emails.filter((e) => !EMAIL.test(e));
    if (bad.length) throw new BadRequestException(`Check ${bad.length === 1 ? "this address" : "these addresses"}: ${bad.join(", ")}`);

    const hour = Math.floor(Date.now() / 3_600_000);
    const c = `mail:c:${clientHash(req.ip)}:${hour}`;
    const r = `mail:r:${meta.id}`;
    const counts = await this.redis.multi().incrby(c, emails.length).expire(c, 3601).incrby(r, emails.length).expire(r, 86_400).exec();
    if (Number(counts?.[0]?.[1] ?? 0) > PER_CLIENT_HOUR || Number(counts?.[2]?.[1] ?? 0) > PER_ROOM_DAY) {
      throw new HttpException("You have sent a lot of invitations. Share the link instead, or try again later.", 429);
    }

    const link = `${config.webOrigins[0]}/live#${meta.id}`;
    const iv = meta.interview?.public;
    const message = inviteEmail({ from: cleanName(b.from), link, kind: iv ? "interview" : "live", title: iv?.title, minutes: iv?.durationMin });
    // One email per person, so addresses are not shown to each other.
    const errors = await Promise.all(emails.map((to) => sendEmail({ ...message, to: [to] })));
    const failed = emails.filter((_, i) => errors[i]);
    if (failed.length === emails.length) throw new HttpException(errors.find(Boolean)!, 502);
    return { sent: emails.length - failed.length, failed };
  }
}
