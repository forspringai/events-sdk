// The suite event contract (DESIGN.md §1 and §4). Shared by the publishing package and the hub: change it
// only together with DESIGN.md, and never rename or drop a field (suite standards §8).
export const MAX_EVENT_BYTES = 256 * 1024;
export const RETRY_MINUTES = [1, 5, 15, 60, 120, 240, 480];
export const MAX_ATTEMPTS = 8;
export const RETENTION_DAYS = 30;
export const MIN_REF_DAYS = 7;
