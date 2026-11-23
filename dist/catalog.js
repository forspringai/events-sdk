const str = { type: "string", minLength: 1, maxLength: 500 };
const optStr = { type: "string", maxLength: 500 };
const privateRef = {
    type: "object",
    properties: { ref: { type: "string", minLength: 1, maxLength: 2000 }, expires: { type: "string", minLength: 1 } },
    required: ["ref", "expires"],
    additionalProperties: false,
};
const object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
const watch = object({
    watch: str,
    metric: str,
    value: { type: "number" },
    previous: { type: ["number", "null"] },
    level: str,
    window: str,
    grain: str,
}, ["watch", "metric", "value", "level"]);
// A new mail in a connected Microsoft 365 mailbox (the m365-intake connector). The body and the attachments' contents
// never travel: the body is a PrivateRef, and each attachment has a ref (or null when too large to store).
const nullableRef = { ...privateRef, type: ["object", "null"] };
const m365Mail = object({
    mailbox: str,
    from_address: optStr,
    from_domain: optStr,
    has_attachment: { type: "boolean" },
    subject: optStr,
    received_at: str,
    message_id_hash: { type: "string", minLength: 1, maxLength: 128 },
    attachments: {
        type: "array",
        maxItems: 100,
        items: object({ name: optStr, size: { type: "number", minimum: 0 }, sha256: { type: ["string", "null"], maxLength: 64 }, ref: nullableRef }, ["name", "size", "sha256", "ref"]),
    },
    body: privateRef,
}, ["mailbox", "from_address", "from_domain", "has_attachment", "received_at", "message_id_hash", "attachments", "body"]);
// A mail kept by mail-in (inbound mail as a platform feature: <name>.<org>@in.forspring.ai, catch-all). Everything a
// person wrote is private: the subject, the body, the raw .eml and the attachments (one ref to a JSON manifest of
// {name, size, sha256, content_type, ref}, since names can be personal). Only routing facts stay public.
const mailReceived = object({
    address: str,
    from_address: optStr,
    from_domain: optStr,
    has_attachment: { type: "boolean" },
    attachment_count: { type: "integer", minimum: 0, maximum: 100 },
    received_at: str,
    message_id_hash: { type: "string", minLength: 1, maxLength: 128 },
    subject: privateRef,
    body: privateRef,
    eml: privateRef,
    attachments: privateRef,
}, ["address", "from_address", "from_domain", "has_attachment", "attachment_count", "received_at", "message_id_hash", "subject", "body", "eml", "attachments"]);
export const CATALOG = [
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
        schema: object({
            object: str,
            id: str,
            change: { type: "string", enum: ["created", "updated", "transitioned", "deleted"] },
            fieldNames: { type: "array", items: str, maxItems: 500 },
            from: optStr,
            to: optStr,
        }, ["object", "id", "change"]),
        filterable: ["object", "change", "from", "to"],
        private: [],
    },
    {
        type: "appspring.approval.decided",
        source: "appspring",
        schema: object({ object: str, record: str, action: str, decision: { type: "string", enum: ["approved", "rejected"] }, request: str }, ["object", "record", "action", "decision", "request"]),
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
    {
        type: "m365.mail.received",
        source: "connector:m365",
        schema: m365Mail,
        filterable: ["mailbox", "from_address", "from_domain", "has_attachment"],
        private: ["body"],
    },
    {
        type: "mail.received",
        source: "mail-in",
        schema: mailReceived,
        filterable: ["address", "from_address", "from_domain", "has_attachment"],
        private: ["subject", "body", "eml", "attachments"],
    },
];
export function eventType(name) {
    return CATALOG.find((t) => t.type === name);
}
