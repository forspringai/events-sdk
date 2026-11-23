import type { EventInput } from "../src/types.js";

export const T0 = Date.parse("2026-11-23T12:00:00Z");

export const form = (over: Partial<EventInput> = {}): EventInput => ({
  id: "sitespring:form:sub1",
  time: "2026-11-23T12:00:00Z",
  org: "acme",
  source: "sitespring",
  type: "sitespring.form.submitted",
  subject: "sitespring:form/f1",
  actor: { kind: "person", id: null },
  cause: null,
  data: { site: "s1", form: "f1", submission: "sub1", fields: { ref: "r/1", expires: "2026-12-10T12:00:00Z" } },
  ...over,
});
