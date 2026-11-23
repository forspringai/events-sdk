# @forspring/events

What a Forspring product uses to publish suite events to the event hub: the envelope types, the type catalog, `validate`, `sign`/`verify`, and a D1 outbox. ESM, no runtime dependencies, no Worker imports.

## Write an event in your own batch

The event row commits if and only if your change commits.

```ts
import { outboxStatements, type EventInput } from "@forspring/events";

const event: EventInput = {
  id: `sitespring:form:${submissionId}`, // stable across your retries
  time: new Date().toISOString(),
  org, source: "sitespring", type: "sitespring.form.submitted",
  subject: `sitespring:form/${formId}`,
  actor: { kind: "person", id: null }, cause: null,
  // private fields go as refs, never values
  data: { site, form: formId, submission: submissionId, fields: { ref, expires } },
};
await env.DB.batch([insertSubmission, ...outboxStatements(env.DB, event)]); // throws on an invalid event
```

Run `OUTBOX_MIGRATION` once as a D1 migration. The same event id is written once (INSERT OR IGNORE).

## Drain

Call `drainOutbox` after the request (`ctx.waitUntil`) and from a cron trigger.

```ts
import { bindingSink, drainOutbox, postSink } from "@forspring/events";

const sink = bindingSink(env.EVENT_HUB); // service binding
// or, from another Cloudflare account: postSink("https://events.forspring.ai/v1/publish", env.EVENTS_SECRET, fetch)
const counts = await drainOutbox(env.DB, sink, { now: Date.now() });
```

Rows are leased for 60 s, retried on 1, 5, 15, 60, 120, 240, 480 minutes, and dead after 8 attempts or a final refusal. Delivered rows are pruned after 7 days, dead after 30. Delivery is at least once; the hub dedupes on `(source, id)`.

## Signing

`sign(secret | secrets[], body, nowMs)` gives `t=<unix>,v1=<hex>`; `verify(header, body, secrets, nowMs, toleranceS = 300)` returns `{ok:true}` or `{ok:false, reason}`. Several secrets work during a rotation.
