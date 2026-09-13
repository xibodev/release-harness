// The vocabulary of the contract model.
//
// Every type here names something a person decides or the harness observes.
// There is deliberately no PRODUCT_BUG: attribution is a conclusion reached by
// `attributeFailure` from evidence and eligibility, never a label a probe gets
// to apply at the point of observation.

/** What is known about a claim, and whether an accepted assertion may rest on it. */
export type EpistemicStatus =
  | 'observed'
  | 'observed_absent'
  | 'asserted_absent'
  | 'inferred'
  | 'not_established';

/** Who or what is responsible for a failure. Only PRODUCT accuses the subject. */
export type Cause =
  | 'PRODUCT'
  | 'CONTRACT_INVALID'
  | 'BINDING_INVALID'
  | 'HARNESS_ENVIRONMENT'
  | 'HARNESS_INTERNAL'
  | 'EVIDENCE_INVALID'
  | 'UNKNOWN';

/** Whether a run is entitled to certify. Decided before execution begins. */
export type Mode = 'CERTIFYING' | 'EXPLORATORY';

/** The outcome of a run. An exploratory run never reaches PASS. */
export type RunStatus = 'PASS' | 'FAIL' | 'UNPROVEN';

export type EvidenceCategory = 'log' | 'trace' | 'screenshot' | 'probe' | 'result' | 'other';
export type EvidenceLifecycleState = 'COLLECTING' | 'SANITIZING' | 'SEALED' | 'EVALUATING' | 'FINALIZED';

export interface Subject {
  id: string;
  name?: string;
  description?: string;
}

export interface Assertion {
  id: string;
  kind: string;
  /** A symbolic name. What it resolves to is an execution binding, not part of the contract. */
  target: string;
  description?: string;
  expect?: Record<string, unknown>;
}

export interface NormativeReference {
  ref: string;
  digest: string;
  description?: string;
}

export interface AcceptedContract {
  schema_version: string;
  subject: Subject;
  assertions: Assertion[];
  requires?: NormativeReference[];
  /** sha256 over the canonical proposition. The filename it is stored under. */
  digest: string;
}
