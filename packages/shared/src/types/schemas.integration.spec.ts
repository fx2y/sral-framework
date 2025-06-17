import { describe, it, expect } from 'vitest';
import {
  StartRequest,
  StartResponse,
  GenerateRequest,
  ReportGenerationRequest,
  AnalyzeRequest,
  ReportAnalysisRequest,
  EvaluationRequest,
  EvaluationResponse,
  OrchestratorState,
  SpecConfig,
  Scorecard,
} from '../index.js';

describe('Inter-service Communication Contracts', () => {
  describe('Start Request/Response Flow', () => {
    it('validates StartRequest structure', () => {
      const request: StartRequest = {
        spec_content: "base64encoded_spec_content",
        scorecard_content: "base64encoded_scorecard_content",
        termination_conditions: {
          maxWaves: 10,
          maxCost: 50.0
        }
      };

      expect(request.spec_content).toBeDefined();
      expect(request.scorecard_content).toBeDefined();
      expect(request.termination_conditions?.maxWaves).toBe(10);
      expect(request.termination_conditions?.maxCost).toBe(50.0);
    });

    it('validates StartResponse structure', () => {
      const response: StartResponse = {
        message: "Project started successfully",
        projectId: "proj-12345",
        status_endpoint: "https://api.example.com/status/proj-12345"
      };

      expect(response.message).toBeDefined();
      expect(response.projectId).toBeDefined();
      expect(response.status_endpoint).toBeDefined();
    });
  });

  describe('Generation Request/Response Flow', () => {
    it('validates GenerateRequest structure', () => {
      const request: GenerateRequest = {
        orchestrator_id: "orch-123",
        artifact_id: "art-456",
        meta_prompt: "Generate a solution for the given problem",
        output_r2_path: "artifacts/wave-1/art-456.html"
      };

      expect(request.orchestrator_id).toBeDefined();
      expect(request.artifact_id).toBeDefined();
      expect(request.meta_prompt).toBeDefined();
      expect(request.output_r2_path).toBeDefined();
    });

    it('validates ReportGenerationRequest structure', () => {
      const request: ReportGenerationRequest = {
        artifact_id: "art-456",
        r2_path: "artifacts/wave-1/art-456.html",
        status: "SUCCESS",
        cost_metrics: {
          prompt_tokens: 1500,
          completion_tokens: 800
        }
      };

      expect(request.artifact_id).toBeDefined();
      expect(request.r2_path).toBeDefined();
      expect(request.status).toBe("SUCCESS");
      expect(request.cost_metrics.prompt_tokens).toBe(1500);
      expect(request.cost_metrics.completion_tokens).toBe(800);
    });
  });

  describe('Analysis Request/Response Flow', () => {
    it('validates AnalyzeRequest structure', () => {
      const request: AnalyzeRequest = {
        orchestrator_id: "orch-123",
        artifacts: [
          { id: "art-456", r2_path: "artifacts/wave-1/art-456.html" },
          { id: "art-789", r2_path: "artifacts/wave-1/art-789.html" }
        ],
        scorecard: {
          tests: [
            { type: "linter", weight: 0.4, config: { rules: ["html-validate"] } },
            { type: "llm_evaluation", weight: 0.6, config: { criteria: "completeness" } }
          ]
        }
      };

      expect(request.orchestrator_id).toBeDefined();
      expect(request.artifacts).toHaveLength(2);
      expect(request.scorecard.tests).toHaveLength(2);
      expect(request.scorecard.tests[0].weight).toBe(0.4);
      expect(request.scorecard.tests[1].weight).toBe(0.6);
    });

    it('validates ReportAnalysisRequest structure', () => {
      const request: ReportAnalysisRequest = {
        results: [
          { artifact_id: "art-456", quality_score: 85.5, details: { linter_score: 90, llm_score: 82 } },
          { artifact_id: "art-789", quality_score: 92.3, details: { linter_score: 95, llm_score: 90 } }
        ],
        learnings_md: "# Key Learnings\n\n- Top performers used semantic HTML\n- Proper error handling improved scores"
      };

      expect(request.results).toHaveLength(2);
      expect(request.results[0].quality_score).toBe(85.5);
      expect(request.results[1].quality_score).toBe(92.3);
      expect(request.learnings_md).toContain("Key Learnings");
    });
  });

  describe('Evaluation Request/Response Flow', () => {
    it('validates EvaluationRequest structure', () => {
      const request: EvaluationRequest = {
        artifact_path: "artifacts/wave-1/art-456.html",
        scorecard: {
          tests: [
            { type: "linter", weight: 0.5, config: { rules: ["html-validate"] } },
            { type: "static_analysis", weight: 0.5, config: { tools: ["eslint"] } }
          ]
        }
      };

      expect(request.artifact_path).toBeDefined();
      expect(request.scorecard.tests).toHaveLength(2);
    });

    it('validates EvaluationResponse structure', () => {
      const response: EvaluationResponse = {
        quality_score: 87.2,
        details: {
          linter_results: { errors: 0, warnings: 2 },
          static_analysis_results: { complexity: "low", security: "passed" }
        }
      };

      expect(response.quality_score).toBe(87.2);
      expect(response.details.linter_results).toBeDefined();
      expect(response.details.static_analysis_results).toBeDefined();
    });
  });

  describe('Orchestrator State Management', () => {
    it('validates OrchestratorState structure', () => {
      const state: OrchestratorState = {
        projectId: "proj-12345",
        status: "GENERATING",
        currentWave: 2,
        config: {
          specPath: "specs/project.md",
          scorecardPath: "scorecards/default.json"
        },
        terminationConditions: {
          maxWaves: 10,
          maxCost: 100.0,
          qualityPlateau: { waves: 3, delta: 0.05 }
        },
        costTracker: {
          totalTokens: 15000,
          estimatedCostUSD: 25.50
        },
        latest_learnings_md: "# Previous Learnings\n\n- Use descriptive variable names"
      };

      expect(state.projectId).toBe("proj-12345");
      expect(state.status).toBe("GENERATING");
      expect(state.currentWave).toBe(2);
      expect(state.costTracker.estimatedCostUSD).toBe(25.50);
      expect(state.latest_learnings_md).toContain("Previous Learnings");
    });
  });

  describe('Configuration Validation', () => {
    it('validates SpecConfig structure', () => {
      const config: SpecConfig = {
        title: "Test Project",
        version: "1.0.0",
        author: "Test User",
        output_format: "self_contained_html",
        generator_type: "stateless_worker",
        generator_count_per_wave: 5
      };

      expect(config.title).toBe("Test Project");
      expect(config.output_format).toBe("self_contained_html");
      expect(config.generator_count_per_wave).toBe(5);
    });

    it('validates Scorecard structure', () => {
      const scorecard: Scorecard = {
        tests: [
          { type: "linter", weight: 0.3, config: { rules: ["html-validate", "css-lint"] } },
          { type: "llm_evaluation", weight: 0.7, config: { criteria: "completeness,correctness" } }
        ]
      };

      expect(scorecard.tests).toHaveLength(2);
      expect(scorecard.tests[0].weight + scorecard.tests[1].weight).toBe(1.0);
    });
  });
});