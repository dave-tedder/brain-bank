// Types for receipt-shape.js (loop-closing Task 5.4). Deno reads this through
// the @ts-self-types directive on the module's first line; Node ignores it.

export declare const REQUIRED_RECEIPT_SECTIONS: readonly string[];
export declare const REASON_ALIASES: Readonly<Record<string, string>>;
export declare const REFERENCE_SCOPE_PATTERN: RegExp;
export declare const INSTALLABLE_DELIVERABLE_PATTERN: RegExp;

export type RouteCapabilityField =
  | "has_workspace"
  | "has_tracker"
  | "has_session_log"
  | "has_capture_tag";

export declare const ROUTE_CAPABILITIES: ReadonlyArray<{
  readonly field: RouteCapabilityField;
  readonly path: "workspace_path" | "tracker_path" | "session_log_path" | null;
  readonly reason: string;
}>;

export type RouteCapabilities = Record<RouteCapabilityField, boolean>;

export interface ParsedReceipt {
  sections: Record<string, string>;
  missing: string[];
  reasons: string[];
}

export interface Augmentation {
  sections: Record<string, string>;
  missing: string[];
  augmented: string[];
  reasons: string[];
}

export type OperatorMarker =
  | { operator_action: string; operator_target: string | null; reference_only?: undefined }
  | { operator_action: "none"; reference_only: true; operator_target?: undefined };

export interface ParsedOperatorAction {
  operator: OperatorMarker | null;
  reasons: string[];
}

export interface ReceiptContractInput {
  receiptText?: string;
  reviewReason?: string | null;
  desiredOutcome?: string | null;
  title?: string | null;
}

export interface ReceiptContractResult {
  reasons: string[];
  receipt: ParsedReceipt;
  augmentation: Augmentation;
  operator: ParsedOperatorAction;
  stagedDeliverable: boolean;
}

export declare function receiptNamesDeliverable(text: unknown): boolean;
export declare function referenceDeliverables(text: unknown): string[];
export declare function canonicalHeading(value: string): string;
export declare function isSafeOperatorTarget(value: unknown): boolean;
export declare function parseOperatorAction(followUpText: unknown): ParsedOperatorAction;
export declare function parseReceipt(text: unknown): ParsedReceipt;
export declare function countOperatorMarkers(text: unknown): number;
export declare function augmentFromReviewNote(
  receipt: ParsedReceipt,
  reviewReason: unknown,
): Augmentation;
export declare function evaluateReceiptContract(
  input?: ReceiptContractInput,
): ReceiptContractResult;
export declare function routeCapabilities(
  route: Record<string, unknown> | null | undefined,
  pathExists: (path: string) => boolean,
): RouteCapabilities;
export declare function routeCapabilityReasons(
  caps: Partial<Record<RouteCapabilityField, unknown>> | null | undefined,
): string[];
export declare function holdMessage(
  reasons: string[],
  receipt: { missing: string[] },
): string;
