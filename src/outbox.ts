// A D1 outbox for events, lifted from the account's event_outbox: the event row commits in the caller's own batch
// beside its change, then drainOutbox delivers it to a sink (the hub binding or a signed POST), at least once.
// No Worker imports; D1 is declared structurally.
import { sign } from "./signing.js";
import { validate } from "./validate.js";
import { MAX_ATTEMPTS, RETENTION_DAYS, RETRY_MINUTES, type EventInput, type HubRpc } from "./types.js";

export interface D1StatementLike {
  bind(...values: any[]): D1StatementLike;
  run(): Promise<{ meta?: { changes?: number } }>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Like<S extends D1StatementLike = D1StatementLike> {
  prepare(sql: string): S;
}

export type SinkResult = { ok: true } | { ok: false; retry: boolean; error?: string };
export type Sink = (event: EventInput) => Promise<SinkResult>;

/** Times are milliseconds since the epoch. (org, source, event_id) is unique: the same event is written once, and one
 * org's event id never suppresses another org's (security read 2026-11-23). */
export const OUTBOX_MIGRATION = `create table if not exists "event_outbox" (
  "id" text not null primary key,
  "org" text not null,
  "source" text not null,
  "event_id" text not null,
  "type" text not null,
  "body" text not null,
  "status" text not null default 'pending' check ("status" in ('pending', 'delivered', 'dead')),
  "attempts" integer not null default 0,
  "next_attempt_at" integer not null,
  "last_error" text,
  "created_at" integer not null,
  "finished_at" integer
);
create unique index if not exists "event_outbox_event_idx" on "event_outbox" ("org", "source", "event_id");
create index if not exists "event_outbox_finished_idx" on "event_outbox" ("status", "finished_at");
create index if not exists "event_outbox_due_idx" on "event_outbox" ("status", "next_attempt_at");
`;

const DAY_MS = 86_400_000;

/** When the attempt after `attempts` failed ones is due, or null when the row is dead. */
export function nextAttemptAt(attempts: number, from: number): number | null {
  if (attempts >= MAX_ATTEMPTS) return null;
  const m = RETRY_MINUTES[attempts - 1];
  return m === undefined ? null : from + m * 60_000;
}

/** The statement to put in the caller's own db.batch([...]) beside its change. Throws on an invalid event. A repeat of an event id is ignored. */
export function outboxStatements<S extends D1StatementLike>(db: D1Like<S>, event: EventInput, now = Date.now()): S[] {
  const v = validate(event);
  if (!v.ok) throw new Error(`invalid event (${v.reason}): ${v.note}`);
  return [
    (db
      .prepare(
        `insert or ignore into event_outbox (id, org, source, event_id, type, body, status, attempts, next_attempt_at, created_at) values (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .bind(crypto.randomUUID(), event.org, event.source, event.id, event.type, JSON.stringify(event), now, now)) as S,
  ];
}

type Row = { id: string; event_id: string; body: string; attempts: number; next_attempt_at: number };

export interface DrainOptions {
  now?: number;
  batch?: number;
  leaseS?: number;
}
export interface DrainCounts {
  due: number;
  delivered: number;
  retried: number;
  dead: number;
  pruned: number;
}

/** Delivers what is due. Never throws for a sink's failure. A leased row is not due again for leaseS, so two drains do not both deliver it. */
export async function drainOutbox<S extends D1StatementLike>(db: D1Like<S>, sink: Sink, opts: DrainOptions = {}): Promise<DrainCounts> {
  const now = opts.now ?? Date.now();
  const batch = opts.batch ?? 50;
  // At least 10 s: a lease of 0 would let two drains claim the same row.
  const leaseMs = Math.max(10, opts.leaseS ?? 60) * 1000;
  const { results } = await db
    .prepare(`select id, event_id, body, attempts, next_attempt_at from event_outbox where status = 'pending' and next_attempt_at <= ? order by next_attempt_at limit ?`)
    .bind(now, batch)
    .all<Row>();
  const counts: DrainCounts = { due: results.length, delivered: 0, retried: 0, dead: 0, pruned: 0 };

  await Promise.all(
    results.map(async (row) => {
      const claimed = await db
        .prepare(`update event_outbox set next_attempt_at = ? where id = ? and status = 'pending' and next_attempt_at = ?`)
        .bind(now + leaseMs, row.id, row.next_attempt_at)
        .run();
      if (!claimed.meta?.changes) return;
      let out: SinkResult;
      try {
        out = await sink(JSON.parse(row.body) as EventInput);
      } catch (e) {
        out = { ok: false, retry: true, error: `sink threw: ${String((e as Error)?.message ?? e)}` };
      }
      const attempts = row.attempts + 1;
      if (out.ok) {
        counts.delivered++;
        await db
          .prepare(`update event_outbox set status = 'delivered', attempts = ?, last_error = null, finished_at = ? where id = ? and status = 'pending'`)
          .bind(attempts, now, row.id)
          .run();
        return;
      }
      const next = out.retry ? nextAttemptAt(attempts, now) : null;
      if (next === null) counts.dead++;
      else counts.retried++;
      await db
        .prepare(`update event_outbox set status = ?, attempts = ?, next_attempt_at = ?, last_error = ?, finished_at = ? where id = ? and status = 'pending'`)
        .bind(next === null ? "dead" : "pending", attempts, next ?? now, (out.error ?? (out.retry ? "failed" : "refused")).slice(0, 500), next === null ? now : null, row.id)
        .run();
    }),
  );

  const pruned = await db
    // At most 500 rows a drain, so a long-idle outbox is pruned over several drains, never in one huge statement.
    .prepare(`delete from event_outbox where id in (select id from event_outbox where (status = 'delivered' and finished_at < ?) or (status = 'dead' and finished_at < ?) limit 500)`)
    .bind(now - 7 * DAY_MS, now - RETENTION_DAYS * DAY_MS)
    .run();
  counts.pruned = pruned.meta?.changes ?? 0;
  return counts;
}

/** The hub's service binding as a sink. A duplicate counts as delivered; a refusal is final; a thrown error retries. */
export function bindingSink(hub: Pick<HubRpc, "publish">): Sink {
  return async (event) => {
    try {
      // A hanging publish would otherwise be re-leased forever without counting an attempt.
      const r = await Promise.race([
        hub.publish(event),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the hub did not answer within 15 s")), 15_000)),
      ]);
      return r.ok ? { ok: true } : { ok: false, retry: false, error: `${r.reason}: ${r.note}` };
    } catch (e) {
      return { ok: false, retry: true, error: String((e as Error)?.message ?? e) };
    }
  };
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: "manual"; signal?: AbortSignal }) => Promise<{ status: number; body?: { cancel(): Promise<void> } | null }>;

/** A signed POST of the event (for a producer on another Cloudflare account). 2xx ok; 4xx except 408 and 429 is final; anything else retries. */
export function postSink(url: string, secret: string | readonly string[], fetchFn: FetchLike = fetch as unknown as FetchLike, nowFn: () => number = Date.now): Sink {
  if (!url.startsWith("https://")) throw new Error("postSink needs an https:// URL");
  return async (event) => {
    const body = JSON.stringify(event);
    try {
      const res = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-forspring-event": event.type,
          "x-forspring-event-id": event.id,
          "x-forspring-signature": await sign(secret, body, nowFn()),
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      // A body that fails to close after a 2xx must not turn a delivered event into a resend.
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return { ok: true };
      const retry = !(res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429);
      return { ok: false, retry, error: `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, retry: true, error: (e as Error)?.name === "TimeoutError" ? "timeout" : "network error" };
    }
  };
}
