import { EvaluationRequest, EvaluationResponse, Scorecard, ScorecardTest } from '@sral/shared';
import { handleLinter } from './handlers/linter.js';
import { handleLLMEvaluation } from './handlers/llm.js';

interface Env {
  R2_BUCKET: R2Bucket;
  AI: Ai;
}

interface TestResult {
  score: number;
  details: Record<string, any>;
  error?: string;
}

type TestHandler = (sourceCode: string, config: Record<string, any>, env: Env) => Promise<TestResult>;

const testHandlers = new Map<string, TestHandler>([
  ['linter', handleLinter],
  ['llm_evaluation', handleLLMEvaluation],
]);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      if (request.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
      }

      const { artifact_path, scorecard }: EvaluationRequest = await request.json();

      // Fetch artifact from R2
      const r2Object = await env.R2_BUCKET.get(artifact_path);
      if (r2Object === null) {
        return new Response(
          JSON.stringify({ error: `Artifact not found: ${artifact_path}` }),
          { status: 404, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const sourceCode = await r2Object.text();

      // Execute all tests in parallel
      const testPromises = scorecard.tests.map(async (test: ScorecardTest) => {
        const handler = testHandlers.get(test.type);
        if (!handler) {
          return {
            type: test.type,
            weight: test.weight,
            result: {
              score: 0,
              details: {},
              error: `Unknown test type: ${test.type}`
            }
          };
        }

        try {
          const result = await handler(sourceCode, test.config, env);
          return {
            type: test.type,
            weight: test.weight,
            result
          };
        } catch (error) {
          return {
            type: test.type,
            weight: test.weight,
            result: {
              score: 0,
              details: {},
              error: error instanceof Error ? error.message : 'Unknown error'
            }
          };
        }
      });

      const testResults = await Promise.all(testPromises);

      // Calculate weighted quality score
      let totalWeightedScore = 0;
      let totalWeight = 0;
      const details: Record<string, any> = {};

      for (const { type, weight, result } of testResults) {
        totalWeightedScore += result.score * weight;
        totalWeight += weight;
        details[type] = result;
      }

      const quality_score = totalWeight > 0 ? totalWeightedScore / totalWeight : 0;

      const response: EvaluationResponse = {
        quality_score,
        details
      };

      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });

    } catch (error) {
      return new Response(
        JSON.stringify({ 
          error: 'Evaluation failed for artifact', 
          details: error instanceof Error ? error.message : 'Unknown error' 
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }
};