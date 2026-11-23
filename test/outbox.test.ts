import { beforeEach, describe, expect, it } from "vitest";

import { drainOutbox, nextAttemptAt, OUTBOX_MIGRATION, outboxStatements, type Sink } from "../src/index.js";
import { form, T0 } from "./helpers.js";
import { sqliteD1, type SqliteD1 } from "./sqlite-d1.js";

const ok: Sink = async () => ({ ok: true });
const retry: Sink = async () => ({ ok: false, retry: true, error: "boom" });
const rows = (db: SqliteD1) => db.raw.prepare("select * from event_outbox order by created_at, id").all() as Record<string, any>[];
const MIN = 60_000;

let db: SqliteD1;
beforeEach(() => {
  db = sqliteD1();
  db.exec(OUTBOX_MIGRATION);
});
const write = async (id = "sitespring:form:sub1", now = T0) => db.batch(outboxStatements(db, form({ id }), now));

describe("outboxStatements", () => {
  it("writes in the caller's batch beside its own change", async () => {
    db.exec("create table t (x)");
    await db.batch([db.prepare("insert into t values (1)"), ...outboxStatements(db, form(), T0)]);
    expect(rows(db)).toHaveLength(1);
    expect(rows(db)[0]).toMatchObject({ event_id: "sitespring:form:sub1", type: "sitespring.form.submitted", status: "pending", attempts: 0, next_attempt_at: T0 });
    await expect(db.batch([db.prepare("insert into t values (2)"), db.prepare("insert into nope values (1)")])).rejects.toThrow();
    expect(db.raw.prepare("select count(*) n from t").get()).toEqual({ n: 1 });
  });
  it("throws on an invalid event and writes nothing", () => {
    expect(() => outboxStatements(db, form({ org: "BAD" }))).toThrow(/bad_envelope/);
    expect(rows(db)).toHaveLength(0);
  });
  it("dedupes on the event id", async () => {
    await write();
    await write();
    await write("sitespring:form:sub2");
    expect(rows(db)).toHaveLength(2);
  });
});

describe("drainOutbox", () => {
  it("delivers due rows and marks them delivered", async () => {
    await write();
    const seen: string[] = [];
    const c = await drainOutbox(db, async (e) => (seen.push(e.id), { ok: true }), { now: T0 });
    expect(c).toEqual({ due: 1, delivered: 1, retried: 0, dead: 0, pruned: 0 });
    expect(seen).toEqual(["sitespring:form:sub1"]);
    expect(rows(db)[0]).toMatchObject({ status: "delivered", attempts: 1, finished_at: T0 });
    expect((await drainOutbox(db, ok, { now: T0 + MIN })).due).toBe(0);
  });
  it("honours the batch size", async () => {
    for (let i = 0; i < 5; i++) await write(`sitespring:form:${i}`);
    expect((await drainOutbox(db, ok, { now: T0, batch: 2 })).due).toBe(2);
  });
  it("leases: two drains at once do not both deliver", async () => {
    await write();
    let calls = 0;
    const slow: Sink = async () => (calls++, await new Promise((r) => setTimeout(r, 20)), { ok: true });
    const [a, b] = await Promise.all([drainOutbox(db, slow, { now: T0 }), drainOutbox(db, slow, { now: T0 })]);
    expect(calls).toBe(1);
    expect(a.delivered + b.delivered).toBe(1);
  });
  it("a leased row is due again after the lease if the drainer died", async () => {
    await write();
    db.raw.prepare("update event_outbox set next_attempt_at = ?").run(T0 + 60_000);
    expect((await drainOutbox(db, ok, { now: T0 + 59_000 })).due).toBe(0);
    expect((await drainOutbox(db, ok, { now: T0 + 60_000 })).delivered).toBe(1);
  });
  it("follows the retry ladder", async () => {
    await write();
    let now = T0;
    const waits = [1, 5, 15, 60, 120, 240, 480];
    for (let i = 0; i < 7; i++) {
      const c = await drainOutbox(db, retry, { now });
      expect(c).toMatchObject({ delivered: 0, retried: 1, dead: 0 });
      const r = rows(db)[0]!;
      expect(r).toMatchObject({ status: "pending", attempts: i + 1, last_error: "boom", next_attempt_at: now + waits[i]! * MIN });
      expect((await drainOutbox(db, retry, { now: now + waits[i]! * MIN - 1 })).due).toBe(0);
      now += waits[i]! * MIN;
    }
  });
  it("is dead after 8 failed attempts", async () => {
    await write();
    let now = T0;
    for (let i = 0; i < 7; i++) {
      await drainOutbox(db, retry, { now });
      now = rows(db)[0]!.next_attempt_at;
    }
    const c = await drainOutbox(db, retry, { now });
    expect(c.dead).toBe(1);
    expect(rows(db)[0]).toMatchObject({ status: "dead", attempts: 8, finished_at: now });
    expect((await drainOutbox(db, ok, { now: now + 1000 * MIN })).due).toBe(0);
    expect(nextAttemptAt(8, 0)).toBeNull();
    expect(nextAttemptAt(1, 0)).toBe(MIN);
  });
  it("is dead at once on retry:false", async () => {
    await write();
    const c = await drainOutbox(db, async () => ({ ok: false, retry: false, error: "no" }), { now: T0 });
    expect(c).toMatchObject({ dead: 1, retried: 0 });
    expect(rows(db)[0]).toMatchObject({ status: "dead", attempts: 1, last_error: "no" });
  });
  it("treats a throwing sink as a retry", async () => {
    await write();
    const c = await drainOutbox(db, async () => { throw new Error("kaput"); }, { now: T0 });
    expect(c.retried).toBe(1);
    expect(rows(db)[0]!.last_error).toContain("kaput");
  });
  it("prunes delivered after 7 days and dead after 30", async () => {
    await write("a");
    await write("b");
    await write("c");
    db.raw.exec(`update event_outbox set status='delivered', finished_at=${T0} where event_id='a'`);
    db.raw.exec(`update event_outbox set status='dead', finished_at=${T0} where event_id='b'`);
    const day = 86_400_000;
    let c = await drainOutbox(db, ok, { now: T0 + 7 * day - 1, batch: 0 });
    expect(c.pruned).toBe(0);
    c = await drainOutbox(db, retry, { now: T0 + 7 * day + 1, batch: 0 });
    expect(c.pruned).toBe(1);
    expect(rows(db).map((r) => r.event_id).sort()).toEqual(["b", "c"]);
    c = await drainOutbox(db, retry, { now: T0 + 30 * day + 1, batch: 0 });
    expect(c.pruned).toBe(1);
    expect(rows(db).map((r) => r.event_id)).toEqual(["c"]);
  });
});

describe("outbox: the security read of 2026-11-23", () => {
  it("dedupes per org: the same event id in two orgs is two rows, and a repeat in one org is one", async () => {
    await db.batch(outboxStatements(db, form({ id: "same", org: "acme" }), T0));
    await db.batch(outboxStatements(db, form({ id: "same", org: "globex" }), T0));
    await db.batch(outboxStatements(db, form({ id: "same", org: "acme" }), T0));
    expect(rows(db).map((r) => r.org).sort()).toEqual(["acme", "globex"]);
  });

  it("never lets a lease of 0 make two drains deliver the same row", async () => {
    await write();
    let calls = 0;
    const slow: Sink = async () => { calls++; return { ok: true }; };
    await Promise.all([drainOutbox(db, slow, { now: T0, leaseS: 0 }), drainOutbox(db, slow, { now: T0, leaseS: 0 })]);
    expect(calls).toBe(1);
  });
});
