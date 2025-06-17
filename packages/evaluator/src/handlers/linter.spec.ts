import { describe, it, expect, vi } from 'vitest';
import { handleLinter } from './linter.js';

// Mock the Env interface
const mockEnv = {
  R2_BUCKET: {} as R2Bucket,
  AI: {} as Ai,
};

describe('handleLinter', () => {
  it('should return perfect score for clean code', async () => {
    const sourceCode = `
      export function add(a, b) {
        return a + b;
      }
    `;
    
    const config = {};
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(100);
    expect(result.details.errors).toBe(0);
    expect(result.details.warnings).toBe(0);
    expect(result.details.totalIssues).toBe(0);
    expect(result.error).toBeUndefined();
  });

  it('should penalize code with syntax errors', async () => {
    const sourceCode = `
      export function add(a, b) {
        return a + b
      }
    `;
    
    const config = {};
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    expect(result.score).toBeLessThan(100);
    expect(result.details.errors).toBeGreaterThan(0);
    expect(result.details.totalIssues).toBeGreaterThan(0);
    expect(result.details.messages).toBeInstanceOf(Array);
    expect(result.details.messages.length).toBeGreaterThan(0);
  });

  it('should apply custom rules from config', async () => {
    const sourceCode = `
      export function add(a, b) {
        const unused = 'variable';
        return a + b;
      }
    `;
    
    const config = {
      rules: {
        'no-unused-vars': 'error',
      },
    };
    
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    expect(result.score).toBeLessThan(100);
    expect(result.details.errors).toBeGreaterThan(0);
    const unusedVarError = result.details.messages.find(
      (msg: any) => msg.ruleId === 'no-unused-vars'
    );
    expect(unusedVarError).toBeDefined();
  });

  it('should handle warnings with lower penalty than errors', async () => {
    const sourceCode = `
      export function add(a, b) {
        console.log('adding', a, b); // This will be a warning
        return a + b;
      }
    `;
    
    const config = {
      rules: {
        'no-console': 'warn',
      },
    };
    
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    expect(result.score).toBeLessThan(100);
    expect(result.score).toBeGreaterThan(90); // Warning penalty is only 2 points
    expect(result.details.warnings).toBeGreaterThan(0);
    expect(result.details.errors).toBe(0);
  });

  it('should calculate score correctly with multiple issues', async () => {
    const sourceCode = `
      export function add(a, b) {
        const unused = 'variable'; // Error: unused variable
        console.log('adding'); // Warning: console.log
        return a + b
      }
    `;
    
    const config = {
      rules: {
        'no-unused-vars': 'error',
        'no-console': 'warn',
      },
    };
    
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    // Should have 1 error (10 points) + 1 warning (2 points) + 1 syntax error (10 points) = 22 points penalty
    expect(result.score).toBeLessThan(100);
    expect(result.details.errors).toBeGreaterThan(0);
    expect(result.details.warnings).toBeGreaterThan(0);
    expect(result.details.totalIssues).toBeGreaterThan(2);
  });

  it('should return minimum score of 0 for heavily flawed code', async () => {
    const sourceCode = `
      export function badFunction() {
        const unused1 = 'var1';
        const unused2 = 'var2';
        const unused3 = 'var3';
        const unused4 = 'var4';
        const unused5 = 'var5';
        const unused6 = 'var6';
        console.log('test');
        console.log('test2');
        console.log('test3');
        console.log('test4');
        console.log('test5');
        return 'test'
      }
    `;
    
    const config = {
      rules: {
        'no-unused-vars': 'error',
        'no-console': 'error',
      },
    };
    
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(0);
    expect(result.details.errors).toBeGreaterThan(5);
    expect(result.details.totalIssues).toBeGreaterThan(5);
  });

  it('should handle linting errors gracefully', async () => {
    // Test with invalid TypeScript syntax that might cause ESLint to throw
    const sourceCode = `
      this is not valid code at all
    `;
    
    const config = {};
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    // Should still return a result, not throw
    expect(result).toBeDefined();
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('should include detailed message information', async () => {
    const sourceCode = `
      export function test() {
        const unused = 'variable';
        return 'test';
      }
    `;
    
    const config = {
      rules: {
        'no-unused-vars': 'error',
      },
    };
    
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    expect(result.details.messages).toBeInstanceOf(Array);
    expect(result.details.messages.length).toBeGreaterThan(0);
    
    const message = result.details.messages[0];
    expect(message).toHaveProperty('line');
    expect(message).toHaveProperty('column');
    expect(message).toHaveProperty('severity');
    expect(message).toHaveProperty('message');
    expect(message).toHaveProperty('ruleId');
    expect(message.severity).toMatch(/^(error|warning)$/);
  });

  it('should handle empty source code', async () => {
    const sourceCode = '';
    const config = {};
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(100);
    expect(result.details.errors).toBe(0);
    expect(result.details.warnings).toBe(0);
    expect(result.details.totalIssues).toBe(0);
  });

  it('should handle whitespace-only source code', async () => {
    const sourceCode = '   \n  \t  \n  ';
    const config = {};
    const result = await handleLinter(sourceCode, config, mockEnv);
    
    expect(result.score).toBe(100);
    expect(result.details.errors).toBe(0);
    expect(result.details.warnings).toBe(0);
    expect(result.details.totalIssues).toBe(0);
  });
});