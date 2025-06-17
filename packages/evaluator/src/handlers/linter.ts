import { ESLint } from 'eslint';

interface TestResult {
  score: number;
  details: Record<string, any>;
  error?: string;
}

interface Env {
  R2_BUCKET: R2Bucket;
  AI: Ai;
}

export async function handleLinter(sourceCode: string, config: Record<string, any>, env: Env): Promise<TestResult> {
  try {
    // Handle empty or whitespace-only source code
    if (!sourceCode || sourceCode.trim() === '') {
      return {
        score: 100,
        details: {
          errors: 0,
          warnings: 0,
          totalIssues: 0,
          messages: [],
        },
      };
    }

    // Create ESLint instance with default configuration
    const eslint = new ESLint({
      baseConfig: {
        env: {
          browser: true,
          es2021: true,
          node: true,
        },
        extends: [
          'eslint:recommended',
        ],
        parserOptions: {
          ecmaVersion: 'latest',
          sourceType: 'module',
        },
        rules: {
          // Basic rules that work without TypeScript parser
          'no-unused-vars': 'error',
          'no-console': 'warn',
          'semi': ['error', 'always'],
          // Override with any custom rules from config
          ...config.rules,
        },
      },
      useEslintrc: false,
    });

    // Lint the source code
    const results = await eslint.lintText(sourceCode, { filePath: 'artifact.js' });
    
    const result = results[0];
    const errorCount = result?.errorCount || 0;
    const warningCount = result?.warningCount || 0;
    const totalIssues = errorCount + warningCount;

    // Calculate score based on issues found
    // Errors are weighted more heavily than warnings
    const errorPenalty = errorCount * 10;
    const warningPenalty = warningCount * 2;
    const totalPenalty = errorPenalty + warningPenalty;
    
    // Score starts at 100 and decreases based on issues
    const score = Math.max(0, 100 - totalPenalty);

    return {
      score,
      details: {
        errors: errorCount,
        warnings: warningCount,
        totalIssues,
        messages: (result?.messages || []).map(msg => ({
          line: msg.line,
          column: msg.column,
          severity: msg.severity === 2 ? 'error' : 'warning',
          message: msg.message,
          ruleId: msg.ruleId,
        })),
      },
    };
  } catch (error) {
    return {
      score: 0,
      details: {
        errors: 0,
        warnings: 0,
        totalIssues: 0,
        messages: [],
      },
      error: error instanceof Error ? error.message : 'Linting failed',
    };
  }
}