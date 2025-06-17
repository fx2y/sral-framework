interface TestResult {
  score: number;
  details: Record<string, any>;
  error?: string;
}

interface Env {
  R2_BUCKET: R2Bucket;
  AI: Ai;
}

export async function handleLLMEvaluation(sourceCode: string, config: Record<string, any>, env: Env): Promise<TestResult> {
  try {
    const prompt = config.prompt || 'Evaluate this code for quality, readability, and best practices. Provide a score from 0-100.';
    const model = config.model || '@cf/meta/llama-3-8b-instruct';

    const response = await env.AI.run(model, {
      messages: [
        {
          role: 'system',
          content: `${prompt}

IMPORTANT: You must provide your response in the following JSON format:
{
  "score": <number between 0 and 100>,
  "reasoning": "<detailed explanation of your evaluation>",
  "strengths": ["<list of positive aspects>"],
  "improvements": ["<list of areas for improvement>"]
}

Only return valid JSON. Do not include any other text.`
        },
        {
          role: 'user',
          content: sourceCode
        }
      ],
    });

    // Extract text from response
    let responseText: string;
    if (typeof response === 'string') {
      responseText = response;
    } else if (response && typeof response === 'object' && 'response' in response) {
      responseText = response.response as string;
    } else {
      throw new Error('Unexpected response format from AI model');
    }

    // Try to parse JSON response
    let parsedResponse;
    try {
      // Clean up the response text - remove markdown code blocks if present
      const cleanedResponse = responseText
        .replace(/```json\n?/g, '')
        .replace(/```\n?/g, '')
        .trim();
      
      parsedResponse = JSON.parse(cleanedResponse);
    } catch (parseError) {
      // If JSON parsing fails, try to extract score from text
      const scoreMatch = responseText.match(/score["\s]*:?\s*(\d+)/i);
      const score = scoreMatch ? parseInt(scoreMatch[1], 10) : 50; // Default to 50 if no score found
      
      return {
        score: Math.min(100, Math.max(0, score)),
        details: {
          reasoning: responseText,
          parseError: 'Failed to parse JSON response',
          rawResponse: responseText,
        },
      };
    }

    // Validate and extract score
    const score = typeof parsedResponse.score === 'number' 
      ? Math.min(100, Math.max(0, parsedResponse.score))
      : 50;

    return {
      score,
      details: {
        reasoning: parsedResponse.reasoning || 'No reasoning provided',
        strengths: parsedResponse.strengths || [],
        improvements: parsedResponse.improvements || [],
        rawResponse: responseText,
      },
    };

  } catch (error) {
    return {
      score: 0,
      details: {},
      error: error instanceof Error ? error.message : 'LLM evaluation failed',
    };
  }
}