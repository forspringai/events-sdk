import { describe, expect, it } from "vitest";

import { bindingSink, postSink, verify } from "../src/index.js";
import { form, T0 } from "./helpers.js";

describe("bindingSink", () => {
  it("is ok on published and on duplicate", async () => {
    const seen: string[] = [];
    const hub = { publish: async (e: { id: string }) => (seen.push(e.id), { ok: true as const, cursor: "1", duplicate: seen.length > 1 }) };
    expect(await bindingSink(hub)(form())).toEqual({ ok: true });
    expect(await bindingSink(hub)(form())).toEqual({ ok: true });
  });
  it("refuses for good when the hub refuses, retries when it throws", async () => {
    const no = { publish: async () => ({ ok: false as const, reason: "source_mismatch", note: "n" }) };
    expect(await bindingSink(no)(form())).toEqual({ ok: false, retry: false, error: "source_mismatch: n" });
    const boom = { publish: async () => { throw new Error("down"); } };
    expect(await bindingSink(boom)(form())).toMatchObject({ ok: false, retry: true });
  });
});

describe("postSink", () => {
  const run = async (status: number | Error) => {
    let seen: { url: string; init: any } | undefined;
    const f = async (url: string, init: any) => {
      seen = { url, init };
      if (status instanceof Error) throw status;
      return { status };
    };
    const result = await postSink("https://hub.example/v1/publish", "sekret", f, () => T0)(form());
    return { result, seen };
  };
  it("posts the event signed, with the headers", async () => {
    const { result, seen } = await run(204);
    expect(result).toEqual({ ok: true });
    const { init } = seen!;
    expect(seen!.url).toBe("https://hub.example/v1/publish");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect(init.headers["x-forspring-event"]).toBe("sitespring.form.submitted");
    expect(init.headers["x-forspring-event-id"]).toBe("sitespring:form:sub1");
    expect(JSON.parse(init.body).id).toBe("sitespring:form:sub1");
    expect(await verify(init.headers["x-forspring-signature"], init.body, ["sekret"], T0)).toEqual({ ok: true });
  });
  it.each([[200, true], [299, true], [400, false], [401, false], [404, false], [422, false]])("%i is final or ok", async (s, ok) => {
    expect((await run(s)).result).toMatchObject(ok ? { ok: true } : { ok: false, retry: false });
  });
  it.each([408, 429, 500, 502, 503, 301])("%i retries", async (s) => {
    expect((await run(s)).result).toMatchObject({ ok: false, retry: true });
  });
  it("retries on a network error", async () => {
    expect((await run(new TypeError("fetch failed"))).result).toEqual({ ok: false, retry: true, error: "network error" });
  });
});

describe("sinks: the security read of 2026-11-23", () => {
  it("postSink refuses a non-https URL, and a body that fails to close after a 2xx is still delivered", async () => {
    expect(() => postSink("http://hub.example/v1/publish", "sekret")).toThrow(/https/);
    const f = async () => ({ status: 202, body: { cancel: async () => { throw new Error("closed"); } } });
    expect(await postSink("https://hub.example/v1/publish", "sekret", f as never, () => T0)(form())).toEqual({ ok: true });
  });
});
