import assert from "node:assert/strict";
import { io, type Socket } from "socket.io-client";
import type { ServerToClientEvents } from "@hint/contracts";
import { getRoom } from "../roomManager.js";
import type { RawIncomingEvents } from "../types.js";
export type Client = Socket<ServerToClientEvents, RawIncomingEvents>;
export const createClient: (url: string, options: Parameters<typeof io>[1]) => Client = io;
export function required<T>(value: T): NonNullable<T> {
  assert.ok(value !== null && value !== undefined);
  return value;
}
export function roomForTest(code: string) {
  return required(getRoom(code));
}
type Events = ServerToClientEvents & { connect: () => void; disconnect: () => void };
type Payload<K extends keyof Events> = Parameters<Events[K]>[0];
export function once<K extends keyof Events>(
  socket: Client,
  event: K,
  // The root runner executes the server and client suites in parallel, and the
  // twelve-player journeys perform many sequential round trips. Under that load a 3s
  // budget still produced occasional timeouts in unrelated tests, so the wait is
  // generous; every assertion stays exact.
  timeoutMs = 5_000,
): Promise<Payload<K>> {
  return onceWhere(socket, event, () => true, timeoutMs);
}
export function onceWhere<K extends keyof Events>(
  socket: Client,
  event: K,
  predicate: (data: Payload<K>) => boolean,
  timeoutMs = 1500,
): Promise<Payload<K>> {
  return new Promise((resolve, reject) => {
    const on = socket.on.bind(socket) as (event: K, listener: (data: Payload<K>) => void) => void;
    const off = socket.off.bind(socket) as (event: K, listener: (data: Payload<K>) => void) => void;
    const timeout = setTimeout(() => {
      off(event, onEvent);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    function onEvent(data: Payload<K>): void {
      if (!predicate(data)) return;
      clearTimeout(timeout);
      off(event, onEvent);
      resolve(data);
    }
    on(event, onEvent);
  });
}
