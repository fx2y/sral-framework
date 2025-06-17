interface TestResult {
  score: number;
  details: Record<string, any>;
  error?: string;
}

interface Env {
  R2_BUCKET: R2Bucket;
  AI: Ai;
}

interface LintIssue {
  line: number;
  column: number;
  severity: 'error' | 'warning';
  message: string;
  ruleId: string;
}

// Simple syntax checker that can run in Workers runtime
function performBasicLinting(sourceCode: string): { errors: LintIssue[], warnings: LintIssue[] } {
  const errors: LintIssue[] = [];
  const warnings: LintIssue[] = [];
  const lines = sourceCode.split('\n');

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    
    // Check for basic syntax issues
    // Missing semicolons (simplified check)
    if (line.trim().match(/^(let|const|var|return|break|continue)\s+.*[^;{}]\s*$/) && !line.includes('//')) {
      warnings.push({
        line: lineNumber,
        column: line.length,
        severity: 'warning',
        message: 'Missing semicolon',
        ruleId: 'semi'
      });
    }

    // Check for unused variables (very basic check)
    const unusedVarMatch = line.match(/^\s*(let|const|var)\s+(\w+)\s*=/);
    if (unusedVarMatch) {
      const varName = unusedVarMatch[2];
      const restOfCode = lines.slice(index + 1).join('\n');
      if (!restOfCode.includes(varName)) {
        warnings.push({
          line: lineNumber,
          column: line.indexOf(varName) + 1,
          severity: 'warning',
          message: `'${varName}' is assigned a value but never used`,
          ruleId: 'no-unused-vars'
        });
      }
    }

    // Check for basic JavaScript syntax errors
    if (line.includes('function') && !line.includes('(') && !line.includes('=>')) {
      errors.push({
        line: lineNumber,
        column: line.indexOf('function') + 1,
        severity: 'error',
        message: 'Invalid function declaration',
        ruleId: 'syntax-error'
      });
    }

    // Check for unmatched brackets (simplified)
    const openBrackets = (line.match(/\{/g) || []).length;
    const closeBrackets = (line.match(/\}/g) || []).length;
    if (openBrackets !== closeBrackets && line.trim() && !line.includes('//')) {
      // This is a very basic check - in reality we'd need proper parsing
      const diff = openBrackets - closeBrackets;
      if (Math.abs(diff) > 0) {
        warnings.push({
          line: lineNumber,
          column: 1,
          severity: 'warning',
          message: 'Potential bracket mismatch',
          ruleId: 'bracket-match'
        });
      }
    }
  });

  // Try to parse as JavaScript to catch basic syntax errors
  try {
    new Function(sourceCode);
  } catch (syntaxError) {
    if (syntaxError instanceof SyntaxError) {
      errors.push({
        line: 1,
        column: 1,
        severity: 'error',
        message: syntaxError.message,
        ruleId: 'syntax-error'
      });
    }
  }

  return { errors, warnings };
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

    // Perform basic linting using our simple checker
    const { errors, warnings } = performBasicLinting(sourceCode);
    
    const errorCount = errors.length;
    const warningCount = warnings.length;
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
        messages: [...errors, ...warnings],
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