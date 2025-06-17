// Core Data Structures
export interface SpecConfig {
  title: string;
  version: string;
  author: string;
  output_format: "self_contained_html" | string;
  generator_type: "stateless_worker" | "stateful_agent";
  generator_count_per_wave: number;
}

export interface ScorecardTest {
  type: "linter" | "static_analysis" | "llm_evaluation" | string;
  weight: number; // A value between 0 and 1.
  config: Record<string, any>; // Test-specific configuration
}

export interface Scorecard {
  tests: ScorecardTest[];
}

export interface TerminationConditions {
  maxWaves?: number;
  maxCost?: number; // In USD.
  minViableCandidates?: number;
  qualityPlateau?: {
    waves: number; // Number of waves to look back.
    delta: number; // Minimum quality improvement required.
  };
  manualApproval?: boolean; // If true, the loop pauses after analysis.
}

// API Contract Schemas
export interface StartRequest {
  spec_content: string; // Base64 encoded content of spec.md.
  scorecard_content: string; // Base64 encoded content of scorecard.json.
  termination_conditions?: Partial<TerminationConditions>; // Optional overrides.
}

export interface StartResponse {
  message: string;
  projectId: string;
  status_endpoint: string; // URL to check the status of the run.
}

export interface GenerateRequest {
  orchestrator_id: string; // The Durable Object ID string for the callback.
  artifact_id: string;
  meta_prompt: string; // The full, evolved prompt for the LLM.
  output_r2_path: string; // The target R2 path for the generated artifact.
}

export interface CostMetrics {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ReportGenerationRequest {
  artifact_id: string;
  r2_path: string | null; // null if generation failed.
  status: "SUCCESS" | "FAILED";
  cost_metrics: CostMetrics;
}

export interface AnalyzeRequestArtifact {
  id: string;
  r2_path: string;
}

export interface AnalyzeRequest {
  orchestrator_id: string; // The Durable Object ID string for the callback.
  artifacts: AnalyzeRequestArtifact[];
  scorecard: Scorecard;
}

export interface EvaluationResult {
  artifact_id: string;
  quality_score: number; // Final weighted score (0-100).
  details: Record<string, any>; // Raw scores and outputs from each test.
}

export interface ReportAnalysisRequest {
  results: EvaluationResult[];
  learnings_md: string; // The distilled, actionable patterns and principles in Markdown format.
}

export interface EvaluationRequest {
  artifact_path: string;
  scorecard: Scorecard;
}

export interface EvaluationResponse {
  quality_score: number;
  details: Record<string, any>;
}

export interface OverrideControlRequest {
  human_guidance_r2_path: string;
}

export interface ReviewResponse {
  top_artifacts: Array<{ r2_path: string; quality_score: number; }>;
  analysis_summary: string; // Concise summary from the Analyzer.
}

// Orchestrator Internal State Schemas
export interface CostTracker {
  totalTokens: number;
  estimatedCostUSD: number;
}

export interface ArtifactRecord {
  id: string; // PRIMARY KEY
  project_id: string;
  wave_number: number;
  r2_path: string;
  status: "SUCCESS" | "FAILED";
  quality_score: number | null;
  evaluation_details: string | null; // JSON blob of detailed scores.
  created_at: number; // Unix timestamp.
}

export interface DispatchedJob {
  job_id: string; // PRIMARY KEY
  artifact_id: string; // Correlates to an artifact
  type: "generation" | "analysis";
  status: "pending" | "complete" | "failed" | "timed_out";
  retries: number;
  created_at: number; // Unix timestamp.
}

export interface OrchestratorState {
  projectId: string;
  status: "IDLE" | "GENERATING" | "ANALYZING" | "AWAITING_APPROVAL" | "COMPLETED" | "FAILED" | "COMPLETED_BUDGET_EXCEEDED";
  currentWave: number;
  config: {
    specPath: string; // R2 path to spec.md
    scorecardPath: string; // R2 path to scorecard.json
  };
  terminationConditions: TerminationConditions;
  costTracker: CostTracker;
  latest_learnings_md: string; // The distilled knowledge from the most recent analysis.
  proposedLearningsForReview?: ReviewResponse; // Populated when status is AWAITING_APPROVAL.
}