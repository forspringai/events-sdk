// Checks an event before it is written or published: envelope, size, data against the type's schema, and that
// every private field is a PrivateRef. No Worker imports.
import { eventType } from "./catalog.js";
import { MAX_EVENT_BYTES, MIN_REF_DAYS } from "./types.js";
const ORG = /^[a-z0-9][a-z0-9-]{0,62}$/;
// No spaces, slashes, dots-only segments, query or fragment characters: an id may end up in a path or a key.
const ID = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,199}$/;
// Keys that would reach Object.prototype through a plain-object lookup, or pollute a merge downstream.
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CONTROL = /[\u0000-\u001f\u007f]/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const KEYS = ["id", "time", "org", "source", "type", "subject", "actor", "cause", "data"];
const DAY_MS = 86_400_000;
const fail = (reason, note) => ({ ok: false, reason, note });
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o, k) => Object.hasOwn(o, k);
const isTime = (v) => typeof v === "string" && ISO.test(v) && !Number.isNaN(Date.parse(v));
/** A minimal JSON Schema check: type, enum, properties, required, additionalProperties:false, items, string and array bounds. Returns the first problem, or null. */
export function checkSchema(schema, value, path = "data") {
    const types = schema.type === undefined ? null : [].concat(schema.type);
    if (types && !types.some((t) => matches(t, value)))
        return `${path} must be ${types.join(" or ")}`;
    if (Array.isArray(schema.enum) && !schema.enum.includes(value))
        return `${path} must be one of ${schema.enum.join(", ")}`;
    if (typeof value === "string") {
        if (CONTROL.test(value))
            return `${path} contains a control character`;
        if (typeof schema.minLength === "number" && value.length < schema.minLength)
            return `${path} is too short`;
        if (typeof schema.maxLength === "number" && value.length > schema.maxLength)
            return `${path} is too long`;
    }
    if (typeof value === "number") {
        if (typeof schema.minimum === "number" && value < schema.minimum)
            return `${path} is below ${schema.minimum}`;
        if (typeof schema.maximum === "number" && value > schema.maximum)
            return `${path} is above ${schema.maximum}`;
    }
    if (Array.isArray(value)) {
        if (typeof schema.maxItems === "number" && value.length > schema.maxItems)
            return `${path} has too many items`;
        if (isObject(schema.items)) {
            for (let i = 0; i < value.length; i++) {
                const p = checkSchema(schema.items, value[i], `${path}[${i}]`);
                if (p)
                    return p;
            }
        }
    }
    if (isObject(value)) {
        const props = isObject(schema.properties) ? schema.properties : {};
        for (const r of schema.required ?? [])
            if (!own(value, r))
                return `${path}.${r} is required`;
        for (const [k, v] of Object.entries(value)) {
            if (FORBIDDEN_KEYS.has(k))
                return `${path}.${k} is not an allowed key`;
            // Own properties only: props["__proto__"] would otherwise be Object.prototype, an empty schema.
            const sub = own(props, k) ? props[k] : undefined;
            if (isObject(sub)) {
                const p = checkSchema(sub, v, `${path}.${k}`);
                if (p)
                    return p;
            }
            else if (schema.additionalProperties === false)
                return `${path}.${k} is not a known field`;
        }
    }
    return null;
}
function matches(type, v) {
    switch (type) {
        case "string": return typeof v === "string";
        case "number": return typeof v === "number" && Number.isFinite(v);
        case "integer": return typeof v === "number" && Number.isInteger(v);
        case "boolean": return typeof v === "boolean";
        case "null": return v === null;
        case "array": return Array.isArray(v);
        case "object": return isObject(v);
        default: return false;
    }
}
export function validate(event) {
    const e = event;
    if (!isObject(e))
        return fail("bad_envelope", "the event must be an object");
    for (const k of Object.keys(e))
        if (!KEYS.includes(k))
            return fail("bad_envelope", `${k} is not an envelope field (the hub sets cursor)`);
    if (typeof e.id !== "string" || !ID.test(e.id))
        return fail("bad_envelope", "id must be 1-200 characters of A-Z a-z 0-9 : _ . @ -, starting with a letter or digit");
    if (!isTime(e.time))
        return fail("bad_envelope", "time must be an ISO 8601 timestamp");
    if (typeof e.org !== "string" || !ORG.test(e.org))
        return fail("bad_envelope", "org must match ^[a-z0-9][a-z0-9-]{0,62}$");
    if (typeof e.type !== "string")
        return fail("bad_envelope", "type must be a string");
    if (typeof e.source !== "string")
        return fail("bad_envelope", "source must be a string");
    if (typeof e.subject !== "string" || e.subject.length === 0 || e.subject.length > 500 || CONTROL.test(e.subject))
        return fail("bad_envelope", "subject must be 1-500 characters, no control characters");
    const actor = e.actor;
    if (!isObject(actor) || !["person", "robot", "system"].includes(actor.kind) || !(actor.id === null || (typeof actor.id === "string" && actor.id.length <= 200 && !CONTROL.test(actor.id)))) {
        return fail("bad_envelope", "actor must be {kind: person|robot|system, id: string|null}");
    }
    if (!(e.cause === null || (isObject(e.cause) && typeof e.cause.key === "string" && e.cause.key.length > 0 && e.cause.key.length <= 200 && !CONTROL.test(e.cause.key))))
        return fail("bad_envelope", "cause must be null or {key} (1-200 characters, no control characters)");
    if (!isObject(e.data))
        return fail("bad_envelope", "data must be an object");
    const type = eventType(e.type);
    if (!type)
        return fail("unknown_type", `${e.type} is not in the catalog`);
    if (e.source !== type.source)
        return fail("source_mismatch", `${e.type} comes from ${type.source}, not ${e.source}`);
    let size;
    try {
        size = new TextEncoder().encode(JSON.stringify(e)).length;
    }
    catch {
        return fail("bad_envelope", "the event is not JSON");
    }
    if (size > MAX_EVENT_BYTES)
        return fail("too_large", `the event is ${size} bytes; the limit is ${MAX_EVENT_BYTES}`);
    const data = e.data;
    const earliest = Date.parse(e.time) + MIN_REF_DAYS * DAY_MS;
    for (const name of type.private) {
        if (!own(data, name))
            continue;
        const v = data[name];
        if (!isObject(v) || typeof v.ref !== "string" || typeof v.expires !== "string")
            return fail("private_value", `${name} is private: send {ref, expires}, never the value`);
        if (!isTime(v.expires))
            return fail("bad_data", `data.${name}.expires must be an ISO 8601 timestamp`);
        if (Date.parse(v.expires) < earliest)
            return fail("ref_too_short", `data.${name}.expires must be at least ${MIN_REF_DAYS} days after time`);
    }
    const problem = checkSchema(type.schema, data);
    if (problem)
        return fail("bad_data", problem);
    return { ok: true };
}
