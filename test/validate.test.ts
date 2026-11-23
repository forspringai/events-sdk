import { describe, expect, it } from "vitest";

import { eventType, validate } from "../src/index.js";
import type { EventInput } from "../src/index.js";
import { form } from "./helpers.js";

const reason = (e: unknown) => {
  const v = validate(e as EventInput);
  return v.ok ? "ok" : v.reason;
};

describe("validate", () => {
  it("accepts a good event of each type", () => {
    expect(validate(form())).toEqual({ ok: true });
    const base = { time: "2026-11-23T12:00:00Z", org: "acme", subject: "x:y/1", actor: { kind: "system" as const, id: null }, cause: { key: "k" } };
    expect(validate({ ...base, id: "a1", source: "appspring", type: "appspring.record.changed", data: { object: "o", id: "1", change: "transitioned", from: "a", to: "b", fieldNames: ["x"] } })).toEqual({ ok: true });
    expect(validate({ ...base, id: "a2", source: "appspring", type: "appspring.approval.decided", data: { object: "o", record: "1", action: "x", decision: "approved", request: "r" } })).toEqual({ ok: true });
    for (const type of ["dataspring.watch.fired", "dataspring.watch.cleared"])
      expect(validate({ ...base, id: type, source: "dataspring", type, data: { watch: "w", metric: "m", value: 3, previous: null, level: "warn", window: "7d", grain: "day" } })).toEqual({ ok: true });
  });

  it("looks types up", () => {
    expect(eventType("sitespring.form.submitted")?.private).toEqual(["fields"]);
    expect(eventType("nope")).toBeUndefined();
  });

  it.each([
    ["empty id", { id: "" }],
    ["long id", { id: "a".repeat(201) }],
    ["unprintable id", { id: "a\nb" }],
    ["bad time", { time: "yesterday" }],
    ["date only time", { time: "2026-11-23" }],
    ["bad org", { org: "Acme" }],
    ["org starting with dash", { org: "-a" }],
    ["empty subject", { subject: "" }],
    ["bad actor kind", { actor: { kind: "alien", id: null } }],
    ["actor id number", { actor: { kind: "person", id: 3 } }],
    ["bad cause", { cause: {} }],
    ["cursor set by producer", { cursor: "1" }],
    ["data not an object", { data: [] }],
  ])("refuses %s", (_n, over) => expect(reason({ ...form(), ...over })).toBe("bad_envelope"));

  it("refuses an unknown type and a wrong source", () => {
    expect(reason(form({ type: "sitespring.form.nope" }))).toBe("unknown_type");
    expect(reason(form({ source: "appspring" }))).toBe("source_mismatch");
  });

  it("refuses an event over the size limit", () => {
    const e = form();
    e.data = { ...e.data, consent: { text: "x".repeat(300 * 1024) } };
    expect(reason(e)).toBe("too_large");
  });

  it("refuses unknown fields, missing fields and wrong values in data", () => {
    const d = form().data;
    expect(reason(form({ data: { ...d, extra: 1 } }))).toBe("bad_data");
    expect(reason(form({ data: { site: "s1", form: "f1", fields: d.fields } }))).toBe("bad_data");
    expect(reason(form({ data: { ...d, site: 5 } }))).toBe("bad_data");
    const rec = { id: "r", time: "2026-11-23T12:00:00Z", org: "a", source: "appspring", type: "appspring.record.changed", subject: "s", actor: { kind: "robot" as const, id: "x" }, cause: null };
    expect(reason({ ...rec, data: { object: "o", id: "1", change: "exploded" } })).toBe("bad_data");
    expect(reason({ ...rec, data: { object: "o", id: "1", change: "created", fieldNames: [1] } })).toBe("bad_data");
  });

  it("refuses a private field sent as a value", () => {
    const d = form().data;
    expect(reason(form({ data: { ...d, fields: { name: "Ada" } } }))).toBe("private_value");
    expect(reason(form({ data: { ...d, fields: "Ada" } }))).toBe("private_value");
  });

  it("requires a ref to outlive the event by 7 days", () => {
    const d = form().data;
    expect(reason(form({ data: { ...d, fields: { ref: "r", expires: "2026-11-29T12:00:00Z" } } }))).toBe("ref_too_short");
    expect(reason(form({ data: { ...d, fields: { ref: "r", expires: "2026-11-30T12:00:00Z" } } }))).toBe("ok");
    expect(reason(form({ data: { ...d, fields: { ref: "r", expires: "soon" } } }))).toBe("bad_data");
  });
});

describe("validate: the security read of 2026-11-23", () => {
  it("refuses __proto__, constructor and prototype keys anywhere in data, as JSON.parse makes them", () => {
    const top = JSON.parse(JSON.stringify(form()));
    top.data = JSON.parse(`{"site":"s","form":"f","submission":"1","fields":${JSON.stringify(form().data.fields)},"__proto__":{"email":"a@b.c"}}`);
    expect(reason(top)).toBe("bad_data");
    const nested = JSON.parse(JSON.stringify(form()));
    nested.data.fields = JSON.parse(`{"ref":"r","expires":"2026-12-30T00:00:00Z","__proto__":{"value":"secret"}}`);
    expect(reason(nested)).not.toBe("ok");
    const ctor = JSON.parse(JSON.stringify(form()));
    ctor.data.constructor = { x: 1 };
    expect(reason(ctor)).toBe("bad_data");
  });

  it("refuses ids with path or query characters, and control characters in strings", () => {
    expect(reason(form({ id: "../../etc/passwd?x#y" }))).toBe("bad_envelope");
    expect(reason(form({ id: "a b" }))).toBe("bad_envelope");
    expect(reason(form({ subject: "x\ny" }))).toBe("bad_envelope");
    expect(reason(form({ cause: { key: "k\u0000" } }))).toBe("bad_envelope");
    expect(reason(form({ data: { ...form().data, site: "s\r\n" } }))).toBe("bad_data");
  });

  it("closes consent: no form values ride along in it", () => {
    expect(reason(form({ data: { ...form().data, consent: { given: true, email: "a@b.c" } } }))).toBe("bad_data");
    expect(reason(form({ data: { ...form().data, consent: { given: true, version: "2026-11", at: "2026-11-23T12:00:00Z" } } }))).toBe("ok");
  });
});

describe("m365.mail.received (0.2.0)", () => {
  const ref = { ref: "r1.x.1.sig", expires: "2026-12-07T12:00:00Z" };
  const mail = (data: Record<string, unknown> = {}) => ({
    id: "m365:noon:abc", time: "2026-11-23T12:00:00Z", org: "noon", source: "connector:m365", type: "m365.mail.received",
    subject: "m365:mail/abc", actor: { kind: "system" as const, id: null }, cause: null,
    data: { mailbox: "orders@nooncph.dk", from_address: "noreply@officeguru.com", from_domain: "officeguru.com", has_attachment: true, subject: "Ordrer for 24-11-2026", received_at: "2026-11-23T12:00:00Z", message_id_hash: "abc", attachments: [{ name: "production-list-20261124.csv", size: 1200, sha256: "a".repeat(64), ref }, { name: "big.pdf", size: 30_000_000, sha256: null, ref: null }], body: ref, ...data },
  });
  it("accepts a mail with refs, and an oversized attachment listed without content", () => {
    expect(reason(mail())).toBe("ok");
  });
  it("refuses the body or an attachment's content as a value", () => {
    expect(reason(mail({ body: "Hej, her er ordren" }))).toBe("private_value");
    expect(reason(mail({ attachments: [{ name: "a.csv", size: 1, sha256: null, ref: null, content: "x;y" }] }))).toBe("bad_data");
    expect(reason(mail({ attachments: [{ name: "a.csv", size: 1, sha256: null, ref: "inline" }] }))).toBe("bad_data");
  });
  it("lists the filterable fields FlowSpring asked for", () => {
    expect(eventType("m365.mail.received")?.filterable).toEqual(["mailbox", "from_address", "from_domain", "has_attachment"]);
  });
});
