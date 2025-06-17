import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the handlers
vi.mock('./handlers/linter.js', () => ({
  handleLinter: vi.fn(),
}));

vi.mock('./handlers/llm.js', () => ({
  handleLLMEvaluation: vi.fn(),
}));

import { handleLinter } from './handlers/linter.js';
import { handleLLMEvaluation } from './handlers/llm.js';

// Import the default export (the worker)
import worker from './index.js';

describe('Evaluator Worker Core Logic', () => {
  let mockEnv: any;
  let mockR2Object: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockR2Object = {
      text: vi.fn().mockResolvedValue('mock source code'),
    };
    
    mockEnv = {
      R2_BUCKET: {
        get: vi.fn().mockResolvedValue(mockR2Object),
      },
      AI: {},
    };
  });

  describe('HTTP Method Validation', () => {
    it('should reject GET requests with 405', async () => {
      const request = new Request('http://localhost/', { method: 'GET' });
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(405);
      const text = await response.text();
      expect(text).toBe('Method not allowed');
    });

    it('should reject PUT requests with 405', async () => {
      const request = new Request('http://localhost/', { method: 'PUT' });
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(405);
    });

    it('should reject DELETE requests with 405', async () => {
      const request = new Request('http://localhost/', { method: 'DELETE' });
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(405);
    });
  });

  describe('Request Body Validation', () => {
    it('should handle invalid JSON with 500 error', async () => {
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid json',
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData).toHaveProperty('error');
      expect(responseData.error).toBe('Evaluation failed for artifact');
    });

    it('should handle missing artifact_path in request body', async () => {
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scorecard: { tests: [] },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      // Request with missing artifact_path triggers empty evaluation or error
      if (response.status === 200) {
        const responseData = await response.json();
        // Should return empty scorecard result with score 0
        expect(responseData).toHaveProperty('quality_score');
        expect(responseData.quality_score).toBe(0);
      } else {
        expect([404, 500]).toContain(response.status);
        const responseData = await response.json();
        expect(responseData).toHaveProperty('error');
      }
    });

    it('should handle missing scorecard in request body', async () => {
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData).toHaveProperty('error');
    });
  });

  describe('Artifact Retrieval', () => {
    it('should return 404 when artifact not found in R2', async () => {
      mockEnv.R2_BUCKET.get.mockResolvedValue(null);
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'nonexistent.ts',
          scorecard: { tests: [] },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(404);
      const responseData = await response.json();
      expect(responseData.error).toBe('Artifact not found: nonexistent.ts');
    });

    it('should fetch artifact from R2 with correct path', async () => {
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test-artifact.ts',
          scorecard: { tests: [] },
        }),
      });
      
      await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(mockEnv.R2_BUCKET.get).toHaveBeenCalledWith('test-artifact.ts');
      expect(mockR2Object.text).toHaveBeenCalled();
    });
  });

  describe('Test Handler Execution', () => {
    it('should execute linter handler when specified', async () => {
      const mockLinterResult = {
        score: 95,
        details: { errors: 0, warnings: 1 },
      };
      (handleLinter as any).mockResolvedValue(mockLinterResult);
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: {
            tests: [
              {
                type: 'linter',
                weight: 1.0,
                config: { rules: { 'no-console': 'warn' } },
              },
            ],
          },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      expect(handleLinter).toHaveBeenCalledWith(
        'mock source code',
        { rules: { 'no-console': 'warn' } },
        mockEnv
      );
      
      const responseData = await response.json();
      expect(responseData.quality_score).toBe(95);
      expect(responseData.details.linter).toEqual(mockLinterResult);
    });

    it('should execute LLM handler when specified', async () => {
      const mockLLMResult = {
        score: 88,
        details: { reasoning: 'Good code quality' },
      };
      (handleLLMEvaluation as any).mockResolvedValue(mockLLMResult);
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: {
            tests: [
              {
                type: 'llm_evaluation',
                weight: 1.0,
                config: { prompt: 'Evaluate this code' },
              },
            ],
          },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      expect(handleLLMEvaluation).toHaveBeenCalledWith(
        'mock source code',
        { prompt: 'Evaluate this code' },
        mockEnv
      );
      
      const responseData = await response.json();
      expect(responseData.quality_score).toBe(88);
      expect(responseData.details.llm_evaluation).toEqual(mockLLMResult);
    });

    it('should handle unknown test types gracefully', async () => {
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: {
            tests: [
              {
                type: 'unknown_test_type',
                weight: 1.0,
                config: {},
              },
            ],
          },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.quality_score).toBe(0);
      expect(responseData.details.unknown_test_type.error).toBe('Unknown test type: unknown_test_type');
    });

    it('should execute multiple tests in parallel', async () => {
      const mockLinterResult = { score: 90, details: { errors: 1 } };
      const mockLLMResult = { score: 85, details: { reasoning: 'Good' } };
      
      (handleLinter as any).mockResolvedValue(mockLinterResult);
      (handleLLMEvaluation as any).mockResolvedValue(mockLLMResult);
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: {
            tests: [
              { type: 'linter', weight: 0.4, config: {} },
              { type: 'llm_evaluation', weight: 0.6, config: {} },
            ],
          },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      expect(handleLinter).toHaveBeenCalled();
      expect(handleLLMEvaluation).toHaveBeenCalled();
      
      const responseData = await response.json();
      // Weighted score: (90 * 0.4) + (85 * 0.6) = 36 + 51 = 87
      expect(responseData.quality_score).toBe(87);
      expect(responseData.details.linter).toEqual(mockLinterResult);
      expect(responseData.details.llm_evaluation).toEqual(mockLLMResult);
    });
  });

  describe('Weighted Scoring Calculation', () => {
    it('should calculate weighted average correctly', async () => {
      const mockResults = [
        { score: 100, details: {} },
        { score: 80, details: {} },
        { score: 60, details: {} },
      ];
      
      (handleLinter as any).mockResolvedValue(mockResults[0]);
      (handleLLMEvaluation as any).mockResolvedValue(mockResults[1]);
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: {
            tests: [
              { type: 'linter', weight: 0.2, config: {} },      // 100 * 0.2 = 20
              { type: 'llm_evaluation', weight: 0.8, config: {} }, // 80 * 0.8 = 64
            ],
          },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      const responseData = await response.json();
      
      expect(responseData.quality_score).toBe(84); // (20 + 64) / (0.2 + 0.8) = 84
    });

    it('should handle zero total weight gracefully', async () => {
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: {
            tests: [], // No tests = zero total weight
          },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      const responseData = await response.json();
      
      expect(responseData.quality_score).toBe(0);
      expect(responseData.details).toEqual({});
    });
  });

  describe('Error Handling and Resilience', () => {
    it('should handle handler exceptions gracefully', async () => {
      (handleLinter as any).mockRejectedValue(new Error('Handler crashed'));
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: {
            tests: [
              { type: 'linter', weight: 1.0, config: {} },
            ],
          },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      const responseData = await response.json();
      expect(responseData.quality_score).toBe(0);
      expect(responseData.details.linter.error).toBe('Handler crashed');
    });

    it('should handle R2 read errors', async () => {
      mockR2Object.text.mockRejectedValue(new Error('R2 read failed'));
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: { tests: [] },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(500);
      const responseData = await response.json();
      expect(responseData.error).toBe('Evaluation failed for artifact');
    });

    it('should continue with other tests when one handler fails', async () => {
      const mockLLMResult = { score: 75, details: { reasoning: 'OK' } };
      
      (handleLinter as any).mockRejectedValue(new Error('Linter failed'));
      (handleLLMEvaluation as any).mockResolvedValue(mockLLMResult);
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: {
            tests: [
              { type: 'linter', weight: 0.5, config: {} },
              { type: 'llm_evaluation', weight: 0.5, config: {} },
            ],
          },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      const responseData = await response.json();
      
      // Should be (0 * 0.5) + (75 * 0.5) = 37.5
      expect(responseData.quality_score).toBe(37.5);
      expect(responseData.details.linter.error).toBe('Linter failed');
      expect(responseData.details.llm_evaluation).toEqual(mockLLMResult);
    });
  });

  describe('Response Format', () => {
    it('should return proper EvaluationResponse format', async () => {
      const mockLinterResult = { score: 95, details: { errors: 0 } };
      (handleLinter as any).mockResolvedValue(mockLinterResult);
      
      const request = new Request('http://localhost/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_path: 'test.ts',
          scorecard: {
            tests: [{ type: 'linter', weight: 1.0, config: {} }],
          },
        }),
      });
      
      const response = await worker.fetch(request, mockEnv, {} as ExecutionContext);
      
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('application/json');
      
      const responseData = await response.json();
      expect(responseData).toHaveProperty('quality_score');
      expect(responseData).toHaveProperty('details');
      expect(typeof responseData.quality_score).toBe('number');
      expect(typeof responseData.details).toBe('object');
    });
  });
});