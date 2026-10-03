/**
 * The parts of Node.js a program in WriteCode uses, as type declarations for the
 * editor's TypeScript checker, so `require("fs")`, `process.stdin` and
 * `import { createInterface } from "node:readline"` are not marked as errors.
 * (The full @types/node is megabytes; this is what reading input, printing,
 * files and timing need.)
 */
export const NODE_TYPES = `
declare var process: {
  argv: string[];
  env: Record<string, string | undefined>;
  exitCode: number | undefined;
  platform: string;
  version: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  exit(code?: number): never;
  cwd(): string;
  hrtime: { (time?: [number, number]): [number, number]; bigint(): bigint };
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
  nextTick(callback: (...args: any[]) => void, ...args: any[]): void;
  on(event: string, listener: (...args: any[]) => void): any;
};
declare namespace NodeJS {
  interface ReadStream extends AsyncIterable<any> {
    fd: number;
    isTTY?: boolean;
    setEncoding(encoding: string): this;
    on(event: "data", listener: (chunk: any) => void): this;
    on(event: "end" | "close", listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    resume(): this;
    pause(): this;
    read(size?: number): any;
  }
  interface WriteStream {
    write(chunk: string | Uint8Array, callback?: (err?: Error) => void): boolean;
    end(chunk?: string): void;
    isTTY?: boolean;
    columns?: number;
  }
}
declare var require: { (id: string): any; resolve(id: string): string; main: any };
declare var module: { exports: any; require: any; id: string; filename: string };
declare var exports: any;
declare var __dirname: string;
declare var __filename: string;
declare var global: typeof globalThis;
declare class Buffer extends Uint8Array {
  static from(data: string | ArrayLike<number> | ArrayBuffer, encoding?: string): Buffer;
  static alloc(size: number, fill?: number): Buffer;
  static concat(list: readonly Uint8Array[]): Buffer;
  static byteLength(text: string, encoding?: string): number;
  toString(encoding?: string, start?: number, end?: number): string;
}
declare function setImmediate(callback: (...args: any[]) => void, ...args: any[]): any;
declare function clearImmediate(handle: any): void;

declare module "fs" {
  export function readFileSync(path: string | number, options: string | { encoding: string; flag?: string }): string;
  export function readFileSync(path: string | number, options?: { flag?: string }): Buffer;
  export function writeFileSync(path: string | number, data: string | Uint8Array, options?: any): void;
  export function appendFileSync(path: string | number, data: string | Uint8Array, options?: any): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export function mkdirSync(path: string, options?: any): void;
  export function unlinkSync(path: string): void;
  export const promises: { readFile(path: string, encoding: string): Promise<string>; writeFile(path: string, data: string): Promise<void> };
}
declare module "node:fs" { export * from "fs"; }
declare module "fs/promises" {
  export function readFile(path: string | number, encoding: string): Promise<string>;
  export function writeFile(path: string, data: string | Uint8Array): Promise<void>;
}
declare module "node:fs/promises" { export * from "fs/promises"; }

declare module "readline" {
  export interface Interface extends AsyncIterable<string> {
    on(event: "line", listener: (line: string) => void): this;
    on(event: "close", listener: () => void): this;
    on(event: string, listener: (...args: any[]) => void): this;
    question(query: string, callback: (answer: string) => void): void;
    close(): void;
    prompt(): void;
    setPrompt(prompt: string): void;
  }
  export function createInterface(options: { input: any; output?: any; terminal?: boolean; crlfDelay?: number }): Interface;
}
declare module "node:readline" { export * from "readline"; }
declare module "readline/promises" {
  export interface Interface extends AsyncIterable<string> {
    question(query: string): Promise<string>;
    close(): void;
    on(event: string, listener: (...args: any[]) => void): this;
  }
  export function createInterface(options: { input: any; output?: any; terminal?: boolean }): Interface;
}
declare module "node:readline/promises" { export * from "readline/promises"; }

declare module "path" {
  export function join(...paths: string[]): string;
  export function resolve(...paths: string[]): string;
  export function basename(path: string, ext?: string): string;
  export function dirname(path: string): string;
  export function extname(path: string): string;
  export const sep: string;
}
declare module "node:path" { export * from "path"; }
declare module "os" {
  export const EOL: string;
  export function cpus(): any[];
  export function platform(): string;
}
declare module "node:os" { export * from "os"; }
declare module "util" {
  export function inspect(value: any, options?: any): string;
  export function format(format: any, ...args: any[]): string;
  export function promisify<T extends (...args: any[]) => any>(fn: T): (...args: any[]) => Promise<any>;
  export function isDeepStrictEqual(a: any, b: any): boolean;
}
declare module "node:util" { export * from "util"; }
declare module "events" {
  export class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
    once(event: string, listener: (...args: any[]) => void): this;
    emit(event: string, ...args: any[]): boolean;
    off(event: string, listener: (...args: any[]) => void): this;
  }
  export default EventEmitter;
}
declare module "node:events" { export * from "events"; export { default } from "events"; }
declare module "assert" {
  function assert(value: unknown, message?: string): asserts value;
  namespace assert {
    function strictEqual(actual: unknown, expected: unknown, message?: string): void;
    function deepStrictEqual(actual: unknown, expected: unknown, message?: string): void;
    function equal(actual: unknown, expected: unknown, message?: string): void;
    function ok(value: unknown, message?: string): asserts value;
  }
  export = assert;
}
declare module "node:assert" { import assert = require("assert"); export = assert; }
declare module "perf_hooks" { export const performance: { now(): number }; }
declare module "node:perf_hooks" { export * from "perf_hooks"; }
declare module "crypto" {
  export function randomInt(min: number, max?: number): number;
  export function randomUUID(): string;
  export function createHash(algorithm: string): { update(data: string): any; digest(encoding: string): string };
}
declare module "node:crypto" { export * from "crypto"; }
`;
