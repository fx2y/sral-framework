import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import worker from './index.js';
import { EvaluationRequest, EvaluationResponse } from '@sral/shared';

// Integration tests using vitest-pool-workers with mocked bindings
describe('Evaluator Worker Integration Tests', () => {
  const CLOUDFLARE_ACCOUNT_ID = 'test-account';
  const CLOUDFLARE_API_TOKEN = 'test-token';

  // Mock Environment with R2 and AI bindings
  const createMockEnv = () => {
    const mockR2Bucket = {
      get: async (key: string) => {
        const testArtifacts: Record<string, string> = {
          'test-pass.html': '<!DOCTYPE html><html><body><p>Clean Code</p></body></html>',
          'test-lint-fail.html': '<unclosed-tag>',
          'test-js-clean.js': 'export function add(a, b) { return a + b; }',
          'test-js-errors.js': 'export function bad() { const unused = "var"; console.log("test"); return "no-semicolon" }',
        };

        if (testArtifacts[key]) {
          return {
            text: async () => testArtifacts[key],
          };
        }
        return null;
      },
    };

    const mockAI = {
      run: async (model: string, params: any) => {
        // Mock AI responses based on source code content
        const sourceCode = params.messages?.[1]?.content || '';
        
        if (sourceCode.includes('Clean Code') || sourceCode.includes('add(a, b)')) {
          return {
            response: JSON.stringify({
              score: 90,
              reasoning: 'Code is excellent with good structure and readability.',
              strengths: ['Clear naming', 'Good structure'],
              improvements: ['Consider adding comments'],
            }),
          };
        } else if (sourceCode.includes('unclosed-tag') || sourceCode.includes('bad()')) {
          return {
            response: JSON.stringify({
              score: 30,
              reasoning: 'Code has significant issues that need attention.',
              strengths: ['Basic functionality'],
              improvements: ['Fix syntax errors', 'Remove unused variables'],
            }),
          };
        } else {
          return {
            response: JSON.stringify({
              score: 75,
              reasoning: 'Code is acceptable with minor improvements needed.',
              strengths: ['Works as expected'],
              improvements: ['Minor optimizations possible'],
            }),
          };
        }
      },
    };

    return {
      R2_BUCKET: mockR2Bucket,
      AI: mockAI,
    };
  };

  describe('Successful Evaluation (Happy Path)', () => {
    it('should evaluate clean HTML artifact with perfect scores', async () => {
      const mockEnv = createMockEnv();
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test-pass.html',
          scorecard: {
            tests: [
              { type: 'linter', weight: 0.5, config: {} },
              { type: 'llm_evaluation', weight: 0.5, config: { prompt: 'Evaluate this code.' } },
            ],
          },
        } as EvaluationRequest),
      });

      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      
      const result = await response.json() as EvaluationResponse;
      expect(result).toHaveProperty('quality_score');
      expect(result).toHaveProperty('details');
      
      // Quality score should be weighted average: (90 * 0.5) + (90 * 0.5) = 90
      // HTML is treated as invalid JS by ESLint, so score is 90
      expect(result.quality_score).toBe(90);
      
      expect(result.details).toHaveProperty('linter');
      expect(result.details.linter).toHaveProperty('score', 90);
      
      expect(result.details).toHaveProperty('llm_evaluation');
      expect(result.details.llm_evaluation).toHaveProperty('score', 90);
    });

    it('should evaluate JavaScript artifact with linter errors', async () => {
      const mockEnv = createMockEnv();
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test-js-errors.js',
          scorecard: {
            tests: [
              { 
                type: 'linter', 
                weight: 0.7, 
                config: { 
                  rules: { 
                    'no-unused-vars': 'error',
                    'no-console': 'error',
                    'semi': ['error', 'always']
                  } 
                } 
              },
              { type: 'llm_evaluation', weight: 0.3, config: {} },
            ],
          },
        } as EvaluationRequest),
      });

      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      
      const result = await response.json() as EvaluationResponse;
      
      // Linter should catch multiple errors, LLM should give low score
      expect(result.quality_score).toBeLessThan(70);
      expect(result.details.linter.score).toBeLessThan(80);
      expect(result.details.linter.details.errors).toBeGreaterThan(0);
      expect(result.details.llm_evaluation.score).toBe(30);
    });
  });

  describe('Resilience to Partial Test Failure', () => {
    it('should handle linter errors but continue with LLM evaluation', async () => {
      const mockEnv = createMockEnv();
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test-lint-fail.html',
          scorecard: {
            tests: [
              { type: 'linter', weight: 0.5, config: {} },
              { type: 'llm_evaluation', weight: 0.5, config: { prompt: 'Evaluate this code.' } },
            ],
          },
        } as EvaluationRequest),
      });

      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      
      const result = await response.json() as EvaluationResponse;
      
      // Should be (90 * 0.5) + (30 * 0.5) = 60
      // HTML still gets 90 score from linter
      expect(result.quality_score).toBe(60);
      expect(result.details.linter.score).toBe(90);
      expect(result.details.llm_evaluation.score).toBe(30);
    });
  });

  describe('Resilience to Internal Handler Failure', () => {
    it('should handle AI service failures gracefully', async () => {
      const mockEnv = createMockEnv();
      
      // Override AI to throw an error
      mockEnv.AI.run = async () => {
        throw new Error('AI service unavailable');
      };
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test-pass.html',
          scorecard: {
            tests: [
              { type: 'linter', weight: 0.5, config: {} },
              { type: 'llm_evaluation', weight: 0.5, config: {} },
            ],
          },
        } as EvaluationRequest),
      });

      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      
      const result = await response.json() as EvaluationResponse;
      
      // Should be (90 * 0.5) + (0 * 0.5) = 45
      // HTML gets 90 score from linter
      expect(result.quality_score).toBe(45);
      expect(result.details.linter.score).toBe(90);
      expect(result.details.llm_evaluation.score).toBe(0);
      expect(result.details.llm_evaluation).toHaveProperty('error');
      expect(result.details.llm_evaluation.error).toContain('AI service unavailable');
    });
  });

  describe('Invalid and Edge Case Request Handling', () => {
    it('should reject non-POST requests', async () => {
      const mockEnv = createMockEnv();
      
      const request = new Request('http://localhost/', { method: 'GET' });
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(405);
      const text = await response.text();
      expect(text).toBe('Method not allowed');
    });

    it('should handle invalid JSON gracefully', async () => {
      const mockEnv = createMockEnv();
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-json',
      });

      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(500);
      const result = await response.json();
      expect(result).toHaveProperty('error');
      expect(result.error).toBe('Evaluation failed for artifact');
    });

    it('should handle missing artifact gracefully', async () => {
      const mockEnv = createMockEnv();
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'non-existent.html',
          scorecard: { tests: [] },
        } as EvaluationRequest),
      });

      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(404);
      const result = await response.json();
      expect(result).toHaveProperty('error');
      expect(result.error).toContain('Artifact not found: non-existent.html');
    });

    it('should handle empty scorecard', async () => {
      const mockEnv = createMockEnv();
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test-pass.html',
          scorecard: { tests: [] },
        } as EvaluationRequest),
      });

      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      const result = await response.json() as EvaluationResponse;
      expect(result.quality_score).toBe(0);
      expect(result.details).toEqual({});
    });

    it('should handle unknown test types', async () => {
      const mockEnv = createMockEnv();
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test-pass.html',
          scorecard: {
            tests: [
              { type: 'unknown_test_type', weight: 1.0, config: {} },
            ],
          },
        } as EvaluationRequest),
      });

      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      const result = await response.json() as EvaluationResponse;
      expect(result.quality_score).toBe(0);
      expect(result.details.unknown_test_type).toHaveProperty('error');
      expect(result.details.unknown_test_type.error).toBe('Unknown test type: unknown_test_type');
    });
  });

  describe('Multiple Test Types Execution', () => {
    it('should execute multiple test types in parallel and calculate weighted scores', async () => {
      const mockEnv = createMockEnv();
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test-js-clean.js',
          scorecard: {
            tests: [
              { type: 'linter', weight: 0.3, config: {} },
              { type: 'llm_evaluation', weight: 0.7, config: { prompt: 'Rate this JavaScript function' } },
            ],
          },
        } as EvaluationRequest),
      });

      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      
      const result = await response.json() as EvaluationResponse;
      
      // Expected: (100 * 0.3) + (90 * 0.7) = 30 + 63 = 93
      expect(result.quality_score).toBe(93);
      expect(result.details).toHaveProperty('linter');
      expect(result.details).toHaveProperty('llm_evaluation');
      expect(result.details.linter.score).toBe(100);
      expect(result.details.llm_evaluation.score).toBe(90);
    });
  });
});