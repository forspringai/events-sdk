// The suite signature format, the account's (src/events/signing.ts): `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">`,
// one v1 per live secret during a rotation. WebCrypto only. `now` is milliseconds (Date.now()) throughout this package.
export const SIGNATURE_TOLERANCE_S = 300;
const enc = new TextEncoder();
async function hmacHex(secret, message) {
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
    return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}
/** The header for `body`. Pass one secret, or several (newest first) while a rotation's grace window lasts. */
export async function sign(secret, body, now) {
    const secrets = typeof secret === "string" ? [secret] : secret;
    if (secrets.length === 0 || secrets.some((s) => !s))
        throw new Error("no secret to sign with");
    const t = Math.floor(now / 1000);
    const parts = [`t=${t}`];
    for (const s of secrets)
        parts.push(`v1=${await hmacHex(s, `${t}.${body}`)}`);
    return parts.join(",");
}
/** Any v1 matching the HMAC under any held secret, and t within the tolerance of `now`. Staleness is judged only once a signature matches. */
export async function verify(header, body, secrets, now, toleranceS = SIGNATURE_TOLERANCE_S) {
    let t = null;
    const given = [];
    for (const part of header.split(",")) {
        const [name, value] = part.trim().split("=", 2);
        if (name === "t" && value && /^\d+$/.test(value))
            t = Number(value);
        else if (name === "v1" && value)
            given.push(value);
    }
    if (t === null || given.length === 0)
        return { ok: false, reason: "malformed" };
    // A NaN clock or tolerance (an unset env var through Number()) must fail closed, not accept any age.
    if (!Number.isFinite(now) || !Number.isFinite(toleranceS) || toleranceS < 0)
        return { ok: false, reason: "stale" };
    for (const s of secrets) {
        if (!s)
            continue;
        const expected = await hmacHex(s, `${t}.${body}`);
        if (given.some((g) => constantTimeEqual(g, expected)))
            return Math.abs(Math.floor(now / 1000) - t) > toleranceS ? { ok: false, reason: "stale" } : { ok: true };
    }
    return { ok: false, reason: "mismatch" };
}
