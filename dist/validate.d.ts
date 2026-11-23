import { type EventInput } from "./types.js";
export type Validation = {
    ok: true;
} | {
    ok: false;
    reason: ValidationReason;
    note: string;
};
export type ValidationReason = "bad_envelope" | "unknown_type" | "source_mismatch" | "too_large" | "bad_data" | "private_value" | "ref_too_short";
/** A minimal JSON Schema check: type, enum, properties, required, additionalProperties:false, items, string and array bounds. Returns the first problem, or null. */
export declare function checkSchema(schema: Record<string, unknown>, value: unknown, path?: string): string | null;
export declare function validate(event: EventInput): Validation;
