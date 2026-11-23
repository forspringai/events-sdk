export declare const SIGNATURE_TOLERANCE_S = 300;
/** The header for `body`. Pass one secret, or several (newest first) while a rotation's grace window lasts. */
export declare function sign(secret: string | readonly string[], body: string, now: number): Promise<string>;
export type Verification = {
    ok: true;
} | {
    ok: false;
    reason: "malformed" | "mismatch" | "stale";
};
/** Any v1 matching the HMAC under any held secret, and t within the tolerance of `now`. Staleness is judged only once a signature matches. */
export declare function verify(header: string, body: string, secrets: readonly string[], now: number, toleranceS?: number): Promise<Verification>;
