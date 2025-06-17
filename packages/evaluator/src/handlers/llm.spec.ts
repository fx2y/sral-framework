import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLLMEvaluation } from './llm.js';

describe('handleLLMEvaluation', () => {
  let mockEnv: any;
  let mockAI: any;

  beforeEach(() => {
    mockAI = {
      run: vi.fn(),
    };
    mockEnv = {
      R2_BUCKET: {} as R2Bucket,
      AI: mockAI,
    };
  });

  it('should parse valid JSON response from AI', async () => {
    const mockResponse = {
      response: JSON.stringify({
        score: 85,
        reasoning: 'Good code quality with minor improvements needed',
        strengths: ['Clear function name', 'Type annotations'],
        improvements: ['Add error handling', 'Consider edge cases'],
      }),
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'export function add(a: number, b: number): number { return a + b; }';
    const config = { prompt: 'Evaluate this function' };
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(85);
    expect(result.details.reasoning).toBe('Good code quality with minor improvements needed');
    expect(result.details.strengths).toEqual(['Clear function name', 'Type annotations']);
    expect(result.details.improvements).toEqual(['Add error handling', 'Consider edge cases']);
    expect(result.error).toBeUndefined();
  });

  it('should handle JSON response wrapped in markdown code blocks', async () => {
    const mockResponse = {
      response: '```json\n{"score": 75, "reasoning": "Decent code"}\n```',
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(75);
    expect(result.details.reasoning).toBe('Decent code');
  });

  it('should fallback to regex parsing when JSON parsing fails', async () => {
    const mockResponse = {
      response: 'The code quality is decent. I would give it a score: 65 out of 100.',
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(65);
    expect(result.details.reasoning).toBe('The code quality is decent. I would give it a score: 65 out of 100.');
    expect(result.details.parseError).toBe('Failed to parse JSON response');
  });

  it('should default to score 50 when no score is found', async () => {
    const mockResponse = {
      response: 'This code looks fine but I cannot provide a numerical score.',
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(50);
    expect(result.details.reasoning).toBe('This code looks fine but I cannot provide a numerical score.');
    expect(result.details.parseError).toBe('Failed to parse JSON response');
  });

  it('should clamp scores to valid range (0-100)', async () => {
    const mockResponse = {
      response: JSON.stringify({
        score: 150, // Invalid score > 100
        reasoning: 'Excellent code',
      }),
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(100); // Should be clamped to 100
  });

  it('should clamp negative scores to 0', async () => {
    const mockResponse = {
      response: JSON.stringify({
        score: -10, // Invalid negative score
        reasoning: 'Poor code',
      }),
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(0); // Should be clamped to 0
  });

  it('should use custom model from config', async () => {
    const mockResponse = {
      response: JSON.stringify({ score: 80, reasoning: 'Good' }),
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {
      model: '@cf/custom/model',
      prompt: 'Custom evaluation prompt',
    };
    
    await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(mockAI.run).toHaveBeenCalledWith('@cf/custom/model', expect.any(Object));
  });

  it('should use default model when not specified', async () => {
    const mockResponse = {
      response: JSON.stringify({ score: 80, reasoning: 'Good' }),
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(mockAI.run).toHaveBeenCalledWith('@cf/meta/llama-3-8b-instruct', expect.any(Object));
  });

  it('should use custom prompt from config', async () => {
    const mockResponse = {
      response: JSON.stringify({ score: 80, reasoning: 'Good' }),
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {
      prompt: 'Rate this code for security vulnerabilities',
    };
    
    await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    const callArgs = mockAI.run.mock.calls[0][1];
    expect(callArgs.messages[0].content).toContain('Rate this code for security vulnerabilities');
  });

  it('should handle AI service errors gracefully', async () => {
    mockAI.run.mockRejectedValue(new Error('AI service unavailable'));
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(0);
    expect(result.details).toEqual({});
    expect(result.error).toBe('AI service unavailable');
  });

  it('should handle unexpected response formats', async () => {
    mockAI.run.mockResolvedValue('unexpected string response');
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(50); // Defaults to 50 when parsing fails
    expect(result.details.reasoning).toBe('unexpected string response');
    expect(result.details.parseError).toBe('Failed to parse JSON response');
  });

  it('should handle null/undefined response', async () => {
    mockAI.run.mockResolvedValue(null);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(0);
    expect(result.details).toEqual({});
    expect(result.error).toBe('Unexpected response format from AI model');
  });

  it('should handle response with missing score field', async () => {
    const mockResponse = {
      response: JSON.stringify({
        reasoning: 'Good code but no score provided',
      }),
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(50); // Default score when missing
    expect(result.details.reasoning).toBe('Good code but no score provided');
  });

  it('should handle response with non-numeric score', async () => {
    const mockResponse = {
      response: JSON.stringify({
        score: 'excellent', // Invalid non-numeric score
        reasoning: 'Great code',
      }),
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(50); // Default score for invalid score
    expect(result.details.reasoning).toBe('Great code');
  });

  it('should include raw response in details', async () => {
    const rawResponse = JSON.stringify({ score: 90, reasoning: 'Excellent' });
    const mockResponse = { response: rawResponse };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = 'const x = 1;';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.details.rawResponse).toBe(rawResponse);
  });

  it('should handle empty source code', async () => {
    const mockResponse = {
      response: JSON.stringify({ score: 0, reasoning: 'No code provided' }),
    };
    
    mockAI.run.mockResolvedValue(mockResponse);
    
    const sourceCode = '';
    const config = {};
    
    const result = await handleLLMEvaluation(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(0);
    expect(result.details.reasoning).toBe('No code provided');
  });
});