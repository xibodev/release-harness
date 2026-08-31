export type CertificationStatus = 'PASS' | 'FAIL' | 'UNPROVEN';
export type RunIntegrity = 'COMPLETE' | 'HARNESS_ERROR' | 'EVIDENCE_INVALID';

export type ScenarioStatus = 'PASS' | 'FAIL' | 'UNPROVEN' | 'ERROR' | 'SKIPPED';
export type ScenarioDisposition = 'EXECUTED' | 'CONDITION_UNMET' | 'MANUAL_APPROVED' | 'WAIVED' | 'NOT_APPLICABLE';
export type ScenarioCause =
  | 'PRODUCT_BUG'
  | 'HARNESS_ENVIRONMENT'
  | 'HARNESS_FIXTURE_MISSING'
  | 'HARNESS_CANARY_MISMATCH'
  | 'HARNESS_CONFIGURATION'
  | 'UNKNOWN'
  | 'NONE';

export type ScenarioPolicy = 'required' | 'conditional' | 'manual' | 'unsupported';
export type ScenarioTier = 'smoke' | 'core' | 'full';

export type EvidenceCategory = 'log' | 'trace' | 'screenshot' | 'probe' | 'result' | 'other';
export type EvidenceLifecycleState = 'COLLECTING' | 'SANITIZING' | 'SEALED' | 'EVALUATING' | 'FINALIZED';

export interface EvidenceFile {
  path: string;
  sha256: string;
  bytes: number;
  mime_type?: string;
  category: EvidenceCategory;
}

export interface EvidenceManifest {
  schema_version: '1.0.0';
  run_id: string;
  sealed_at: string;
  files: EvidenceFile[];
}

export interface ScenarioResult {
  id: string;
  name: string;
  origin_id: string;
  policy: ScenarioPolicy;
  status: ScenarioStatus;
  disposition: ScenarioDisposition;
  cause: ScenarioCause;
  duration_ms?: number;
  evidence_files?: string[];
  error_message?: string;
}

export interface OriginSummary {
  total: number;
  passed: number;
  failed: number;
  unproven: number;
  skipped: number;
  status: CertificationStatus;
}

export interface VerdictSummary {
  total: number;
  passed: number;
  failed: number;
  unproven: number;
  error: number;
  skipped: number;
  by_origin: Record<string, OriginSummary>;
}

export interface Verdict {
  schema_version: '1.0.0';
  run_id: string;
  evaluation_time: string;
  certification_status: CertificationStatus;
  run_integrity: RunIntegrity;
  exit_code: number;
  causes: ScenarioCause[];
  scenarios: ScenarioResult[];
  summary: VerdictSummary;
  evidence_manifest_sha256: string;
  violations?: Array<{ type: string; description: string; details?: Record<string, unknown> }>;
}

export interface ToolchainIdentity {
  node?: string;
  git?: string;
  docker_engine?: string;
  docker_compose?: string;
  playwright?: string;
  chromium?: string;
  firefox?: string;
  webkit?: string;
}
