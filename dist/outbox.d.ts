import { type EventInput, type HubRpc } from "./types.js";
export interface D1StatementLike {
    bind(...values: any[]): D1StatementLike;
    run(): Promise<{
        meta?: {
            changes?: number;
        };
    }>;
    all<T = Record<string, unknown>>(): Promise<{
        results: T[];
    }>;
}
export interface D1Like<S extends D1StatementLike = D1StatementLike> {
    prepare(sql: string): S;
}
export type SinkResult = {
    ok: true;
} | {
    ok: false;
    retry: boolean;
    error?: string;
};
export type Sink = (event: EventInput) => Promise<SinkResult>;
/** Times are milliseconds since the epoch. (org, source, event_id) is unique: the same event is written once, and one
 * org's event id never suppresses another org's (security read 2026-11-23). */
export declare const OUTBOX_MIGRATION = "create table if not exists \"event_outbox\" (\n  \"id\" text not null primary key,\n  \"org\" text not null,\n  \"source\" text not null,\n  \"event_id\" text not null,\n  \"type\" text not null,\n  \"body\" text not null,\n  \"status\" text not null default 'pending' check (\"status\" in ('pending', 'delivered', 'dead')),\n  \"attempts\" integer not null default 0,\n  \"next_attempt_at\" integer not null,\n  \"last_error\" text,\n  \"created_at\" integer not null,\n  \"finished_at\" integer\n);\ncreate unique index if not exists \"event_outbox_event_idx\" on \"event_outbox\" (\"org\", \"source\", \"event_id\");\ncreate index if not exists \"event_outbox_finished_idx\" on \"event_outbox\" (\"status\", \"finished_at\");\ncreate index if not exists \"event_outbox_due_idx\" on \"event_outbox\" (\"status\", \"next_attempt_at\");\n";
/** When the attempt after `attempts` failed ones is due, or null when the row is dead. */
export declare function nextAttemptAt(attempts: number, from: number): number | null;
/** The statement to put in the caller's own db.batch([...]) beside its change. Throws on an invalid event. A repeat of an event id is ignored. */
export declare function outboxStatements<S extends D1StatementLike>(db: D1Like<S>, event: EventInput, now?: number): S[];
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
export declare function drainOutbox<S extends D1StatementLike>(db: D1Like<S>, sink: Sink, opts?: DrainOptions): Promise<DrainCounts>;
/** The hub's service binding as a sink. A duplicate counts as delivered; a refusal is final; a thrown error retries. */
export declare function bindingSink(hub: Pick<HubRpc, "publish">): Sink;
type FetchLike = (url: string, init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    redirect: "manual";
    signal?: AbortSignal;
}) => Promise<{
    status: number;
    body?: {
        cancel(): Promise<void>;
    } | null;
}>;
/** A signed POST of the event (for a producer on another Cloudflare account). 2xx ok; 4xx except 408 and 429 is final; anything else retries. */
export declare function postSink(url: string, secret: string | readonly string[], fetchFn?: FetchLike, nowFn?: () => number): Sink;
export {};
