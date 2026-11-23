export type ActorKind = "person" | "robot" | "system";
/** A private field's place in `data`: the value stays at the producer; this resolves there for 7 days or more. */
export interface PrivateRef {
    ref: string;
    expires: string;
}
/** An event as a producer publishes it (no cursor yet). */
export interface EventInput {
    id: string;
    time: string;
    org: string;
    source: string;
    type: string;
    subject: string;
    actor: {
        kind: ActorKind;
        id: string | null;
    };
    cause: {
        key: string;
    } | null;
    data: Record<string, unknown>;
}
/** An event as the hub stores and delivers it. */
export interface SuiteEvent extends EventInput {
    cursor: string;
}
/** One type in the catalog (DESIGN.md §2). */
export interface EventType {
    type: string;
    source: string;
    /** JSON Schema for `data`. */
    schema: Record<string, unknown>;
    /** Fields a subscription may filter on (equals, or one of a list). */
    filterable: readonly string[];
    /** Fields that never reach the hub as values: a PrivateRef instead. */
    private: readonly string[];
}
export type FilterValue = string | number | boolean;
export type Filter = Record<string, FilterValue | FilterValue[]>;
export interface Trigger {
    type: string;
    filter: Filter;
    /** Private fields the go names; only their refs are passed on. */
    fields: string[];
}
export interface SubscriptionInput {
    mode: "live" | "preview";
    /** The org robot's account id: the principal the hub checks at the account before every delivery. */
    principal: string;
    triggers: Trigger[];
}
export type SubscriptionState = "active" | "suspended";
export interface Subscription extends SubscriptionInput {
    org: string;
    id: string;
    owner: string;
    state: SubscriptionState;
    createdAt: string;
    updatedAt: string;
}
export interface DeliveryContext {
    subscription: string;
    attempt: number;
    replay?: string;
}
export type DeliveryAnswer = {
    ok: true;
} | {
    ok: false;
    retry: boolean;
};
/** The hub's RPC entrypoint as a product's service binding sees it. */
export interface HubRpc {
    types(): Promise<EventType[]>;
    publish(event: EventInput): Promise<{
        ok: true;
        cursor: string;
        duplicate: boolean;
    } | {
        ok: false;
        reason: string;
        note: string;
    }>;
    putSubscription(org: string, id: string, body: SubscriptionInput): Promise<{
        ok: true;
        subscription: Subscription;
    } | {
        ok: false;
        reason: string;
        note: string;
    }>;
    deleteSubscription(org: string, id: string): Promise<{
        ok: true;
        deleted: boolean;
    }>;
    getSubscription(org: string, id: string): Promise<(Subscription & {
        delivered: number;
        dead: number;
    }) | null>;
    listSubscriptions(org: string, opts: {
        owner?: string;
    }): Promise<Subscription[]>;
    replay(org: string, id: string, range: {
        from: string;
        to: string;
    }): Promise<{
        ok: true;
        replay: string;
        events: number;
    } | {
        ok: false;
        reason: string;
        note: string;
    }>;
    dead(org: string, id: string): Promise<{
        event: SuiteEvent;
        attempts: number;
        lastError: string | null;
        deadAt: string;
    }[]>;
    events(org: string, opts: {
        type?: string;
        after?: string;
        limit?: number;
    }): Promise<{
        events: SuiteEvent[];
        next: string | null;
    }>;
}
/** What a subscriber exports for the hub to call (FlowSpring: WorkerEntrypoint "EventDelivery"). */
export interface EventDeliveryRpc {
    deliver(event: SuiteEvent, ctx: DeliveryContext): Promise<DeliveryAnswer>;
}
export declare const MAX_EVENT_BYTES: number;
export declare const RETRY_MINUTES: readonly [1, 5, 15, 60, 120, 240, 480];
export declare const MAX_ATTEMPTS = 8;
export declare const RETENTION_DAYS = 30;
export declare const MIN_REF_DAYS = 7;
