import { describe, it, expect } from 'vitest';
import {
  StartRequest,
  StartResponse,
  GenerateRequest,
  ReportGenerationRequest,
  AnalyzeRequest,
  ReportAnalysisRequest,
  OrchestratorState,
  createLogger,
} from './index.js';

describe('End-to-End SRAL Workflow Simulation', () => {
  it('simulates complete SRAL generation-analysis cycle', () => {
    // 1. Simulate project start
    const startRequest: StartRequest = {
      spec_content: btoa("# Test Spec\nCreate a simple HTML page"),
      scorecard_content: btoa(JSON.stringify({
        tests: [
          { type: "linter", weight: 0.6, config: { rules: ["html-validate"] } },
          { type: "llm_evaluation", weight: 0.4, config: { criteria: "completeness" } }
        ]
      })),
      termination_conditions: { maxWaves: 3, maxCost: 25.0 }
    };

    const startResponse: StartResponse = {
      message: "Project started successfully",
      projectId: "proj-e2e-test",
      status_endpoint: "https://api.sral.com/status/proj-e2e-test"
    };

    expect(startRequest.spec_content).toBeDefined();
    expect(startResponse.projectId).toBe("proj-e2e-test");

    // 2. Simulate orchestrator state initialization
    const initialState: OrchestratorState = {
      projectId: "proj-e2e-test",
      status: "GENERATING",
      currentWave: 1,
      config: {
        specPath: "r2://specs/proj-e2e-test.md",
        scorecardPath: "r2://scorecards/proj-e2e-test.json"
      },
      terminationConditions: { maxWaves: 3, maxCost: 25.0 },
      costTracker: { totalTokens: 0, estimatedCostUSD: 0 },
      latest_learnings_md: ""
    };

    expect(initialState.status).toBe("GENERATING");
    expect(initialState.currentWave).toBe(1);

    // 3. Simulate generation wave dispatch
    const generateRequests: GenerateRequest[] = [
      {
        orchestrator_id: "proj-e2e-test",
        artifact_id: "art-001",
        meta_prompt: "Create a simple HTML page based on the specification",
        output_r2_path: "artifacts/wave-1/art-001.html"
      },
      {
        orchestrator_id: "proj-e2e-test",
        artifact_id: "art-002",
        meta_prompt: "Create a simple HTML page based on the specification",
        output_r2_path: "artifacts/wave-1/art-002.html"
      }
    ];

    expect(generateRequests).toHaveLength(2);
    expect(generateRequests[0].artifact_id).toBe("art-001");

    // 4. Simulate generation completion reports
    const generationReports: ReportGenerationRequest[] = [
      {
        artifact_id: "art-001",
        r2_path: "artifacts/wave-1/art-001.html",
        status: "SUCCESS",
        cost_metrics: { prompt_tokens: 150, completion_tokens: 300 }
      },
      {
        artifact_id: "art-002",
        r2_path: "artifacts/wave-1/art-002.html",
        status: "SUCCESS",
        cost_metrics: { prompt_tokens: 140, completion_tokens: 320 }
      }
    ];

    const totalCost = generationReports.reduce((sum, report) => 
      sum + report.cost_metrics.prompt_tokens + report.cost_metrics.completion_tokens, 0
    );
    expect(totalCost).toBe(910); // 150+300+140+320

    // 5. Simulate analysis phase
    const analyzeRequest: AnalyzeRequest = {
      orchestrator_id: "proj-e2e-test",
      artifacts: [
        { id: "art-001", r2_path: "artifacts/wave-1/art-001.html" },
        { id: "art-002", r2_path: "artifacts/wave-1/art-002.html" }
      ],
      scorecard: {
        tests: [
          { type: "linter", weight: 0.6, config: { rules: ["html-validate"] } },
          { type: "llm_evaluation", weight: 0.4, config: { criteria: "completeness" } }
        ]
      }
    };

    expect(analyzeRequest.artifacts).toHaveLength(2);
    expect(analyzeRequest.scorecard.tests).toHaveLength(2);

    // 6. Simulate analysis completion
    const analysisReport: ReportAnalysisRequest = {
      results: [
        { artifact_id: "art-001", quality_score: 75.5, details: { linter: 80, llm: 68 } },
        { artifact_id: "art-002", quality_score: 82.3, details: { linter: 85, llm: 78 } }
      ],
      learnings_md: "# Wave 1 Learnings\n\n- Better semantic HTML structure improves scores\n- Include meta tags for completeness"
    };

    expect(analysisReport.results).toHaveLength(2);
    expect(analysisReport.results[1].quality_score).toBeGreaterThan(analysisReport.results[0].quality_score);
    expect(analysisReport.learnings_md).toContain("Wave 1 Learnings");

    // 7. Simulate state evolution for next wave
    const evolvedState: OrchestratorState = {
      ...initialState,
      status: "GENERATING",
      currentWave: 2,
      costTracker: { totalTokens: 910, estimatedCostUSD: 1.82 }, // Assuming $0.002 per token
      latest_learnings_md: analysisReport.learnings_md
    };

    expect(evolvedState.currentWave).toBe(2);
    expect(evolvedState.latest_learnings_md).toBe(analysisReport.learnings_md);
    expect(evolvedState.costTracker.totalTokens).toBe(910);

    // 8. Simulate termination condition check
    const shouldTerminate = evolvedState.currentWave >= (evolvedState.terminationConditions.maxWaves || 0) ||
                           evolvedState.costTracker.estimatedCostUSD >= (evolvedState.terminationConditions.maxCost || 0);

    expect(shouldTerminate).toBe(false); // Should continue to wave 2
  });

  it('simulates logging throughout workflow', () => {
    const logger = createLogger('E2ETest', { projectId: 'proj-e2e-test', waveNumber: 1 });
    
    // Simulate orchestrator logging
    logger.info('Starting generation wave', { artifactCount: 2 });
    logger.warn('Cost approaching limit', { currentCost: 15.5, limit: 25.0 });
    
    // Simulate error handling
    const mockError = new Error('Generation timeout');
    logger.error('Generation failed', mockError, { artifactId: 'art-003' });

    // These calls should not throw and follow the structured logging format
    expect(true).toBe(true); // If we reach here, logging worked
  });

  it('validates complete data flow integrity', () => {
    // Test that all data structures can be serialized/deserialized
    const complexState: OrchestratorState = {
      projectId: "proj-integrity-test",
      status: "ANALYZING",
      currentWave: 3,
      config: {
        specPath: "r2://specs/complex-project.md",
        scorecardPath: "r2://scorecards/complex-project.json"
      },
      terminationConditions: {
        maxWaves: 5,
        maxCost: 100.0,
        qualityPlateau: { waves: 2, delta: 0.03 },
        manualApproval: true
      },
      costTracker: { totalTokens: 25000, estimatedCostUSD: 50.0 },
      latest_learnings_md: "# Complex Learnings\n\nMultiple insights from previous waves",
      proposedLearningsForReview: {
        top_artifacts: [
          { r2_path: "artifacts/wave-2/best-001.html", quality_score: 94.2 },
          { r2_path: "artifacts/wave-2/best-002.html", quality_score: 91.8 }
        ],
        analysis_summary: "Top performers showed excellent code structure and completeness"
      }
    };

    // Test JSON serialization round-trip
    const serialized = JSON.stringify(complexState);
    const deserialized = JSON.parse(serialized) as OrchestratorState;

    expect(deserialized.projectId).toBe(complexState.projectId);
    expect(deserialized.terminationConditions.qualityPlateau?.delta).toBe(0.03);
    expect(deserialized.proposedLearningsForReview?.top_artifacts).toHaveLength(2);
    expect(deserialized.costTracker.estimatedCostUSD).toBe(50.0);
  });
});