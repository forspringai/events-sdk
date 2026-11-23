// The first event types (DESIGN.md §2). A field is added, never renamed or removed; a breaking change is a
// new type version. Private fields carry a PrivateRef in `data`, so their schema is the ref's.
import type { EventType } from "./types.js";

const str = { type: "string", minLength: 1, maxLength: 500 } as const;
const optStr = { type: "string", maxLength: 500 } as const;
const privateRef = {
  type: "object",
  properties: { ref: { type: "string", minLength: 1, maxLength: 2000 }, expires: { type: "string", minLength: 1 } },
  required: ["ref", "expires"],
  additionalProperties: false,
} as const;

const object = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required, additionalProperties: false });

const watch = object(
  {
    watch: str,
    metric: str,
    value: { type: "number" },
    previous: { type: ["number", "null"] },
    level: str,
    window: str,
    grain: str,
  },
  ["watch", "metric", "value", "level"],
);

export const CATALOG: readonly EventType[] = [
  {
    type: "sitespring.form.submitted",
    source: "sitespring",
    schema: object({ site: str, form: str, submission: str, fields: privateRef, consent: object({ given: { type: "boolean" }, version: str, at: str }, ["given"]) }, ["site", "form", "submission", "fields"]),
    filterable: ["site", "form"],
    private: ["fields"],
  },
  {
    type: "appspring.record.changed",
    source: "appspring",
    schema: object(
      {
        object: str,
        id: str,
        change: { type: "string", enum: ["created", "updated", "transitioned", "deleted"] },
        fieldNames: { type: "array", items: str, maxItems: 500 },
        from: optStr,
        to: optStr,
      },
      ["object", "id", "change"],
    ),
    filterable: ["object", "change", "from", "to"],
    private: [],
  },
  {
    type: "appspring.approval.decided",
    source: "appspring",
    schema: object(
      { object: str, record: str, action: str, decision: { type: "string", enum: ["approved", "rejected"] }, request: str },
      ["object", "record", "action", "decision", "request"],
    ),
    filterable: ["object", "action", "decision"],
    private: [],
  },
  {
    type: "dataspring.watch.fired",
    source: "dataspring",
    schema: watch,
    filterable: ["watch", "grain"],
    private: [],
  },
  {
    type: "dataspring.watch.cleared",
    source: "dataspring",
    schema: watch,
    filterable: ["watch", "grain"],
    private: [],
  },
];

export function eventType(name: string): EventType | undefined {
  return CATALOG.find((t) => t.type === name);
}
