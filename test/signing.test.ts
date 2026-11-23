import { describe, expect, it } from "vitest";

import { sign, verify } from "../src/index.js";

const NOW = 1_795_000_000_000;
const body = '{"a":1}';

describe("signing", () => {
  it("has the t=,v1= shape", async () => {
    expect(await sign("s", body, NOW)).toMatch(/^t=1795000000,v1=[0-9a-f]{64}$/);
  });
  it("verifies and is deterministic", async () => {
    const h = await sign("s", body, NOW);
    expect(h).toBe(await sign("s", body, NOW));
    expect(await verify(h, body, ["s"], NOW)).toEqual({ ok: true });
  });
  it("enforces the tolerance both ways", async () => {
    const h = await sign("s", body, NOW);
    expect(await verify(h, body, ["s"], NOW + 300_000)).toEqual({ ok: true });
    expect(await verify(h, body, ["s"], NOW + 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(await verify(h, body, ["s"], NOW - 301_000)).toEqual({ ok: false, reason: "stale" });
    expect(await verify(h, body, ["s"], NOW + 3_000_000, 4000)).toEqual({ ok: true });
  });
  it("detects tampering", async () => {
    const h = await sign("s", body, NOW);
    expect(await verify(h, '{"a":2}', ["s"], NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(await verify(h, body, ["other"], NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(await verify(h.replace("t=1795000000", "t=1795000001"), body, ["s"], NOW)).toEqual({ ok: false, reason: "mismatch" });
    expect(await verify(h.slice(0, -1) + (h.endsWith("0") ? "1" : "0"), body, ["s"], NOW)).toEqual({ ok: false, reason: "mismatch" });
  });
  it("rejects malformed headers", async () => {
    for (const h of ["", "garbage", "t=abc,v1=ff", "t=1795000000", "v1=ff"]) expect(await verify(h, body, ["s"], NOW)).toEqual({ ok: false, reason: "malformed" });
  });
  it("supports dual secrets on both sides", async () => {
    const both = await sign(["new", "old"], body, NOW);
    expect(both.match(/v1=/g)).toHaveLength(2);
    expect(await verify(both, body, ["old"], NOW)).toEqual({ ok: true });
    expect(await verify(both, body, ["new"], NOW)).toEqual({ ok: true });
    const old = await sign("old", body, NOW);
    expect(await verify(old, body, ["new", "old"], NOW)).toEqual({ ok: true });
    expect(await verify(old, body, ["new"], NOW)).toEqual({ ok: false, reason: "mismatch" });
  });
  it("will not sign without a secret", async () => {
    await expect(sign([], body, NOW)).rejects.toThrow();
    await expect(sign("", body, NOW)).rejects.toThrow();
  });
});

describe("verify: a NaN clock or tolerance fails closed (security read 2026-11-23)", () => {
  it("answers stale, never ok, for NaN now or tolerance", async () => {
    const t = Date.parse("2025-11-23T12:00:00Z");
    const header = await sign("k", "body", t);
    expect(await verify(header, "body", ["k"], Number.NaN)).toEqual({ ok: false, reason: "stale" });
    expect(await verify(header, "body", ["k"], t, Number.NaN)).toEqual({ ok: false, reason: "stale" });
  });
});
