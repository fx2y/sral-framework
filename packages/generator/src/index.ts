import { GenerateRequest, ReportGenerationRequest, CostMetrics, createLogger } from "@sral/shared";

interface Env {
  AI: any;
  R2_BUCKET: R2Bucket;
  ORCHESTRATOR: DurableObjectNamespace;
}

const logger = createLogger("generator");

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    try {
      const payload = await request.json<GenerateRequest>();
      
      // Validate required fields
      if (!payload.orchestrator_id || !payload.artifact_id || !payload.meta_prompt || !payload.output_r2_path) {
        return new Response("Missing required fields", { status: 400 });
      }

      // Defer the long-running task and immediately respond
      ctx.waitUntil(handleGeneration(payload, env));

      return new Response(null, { status: 202 });
    } catch (e) {
      logger.error("Invalid request body", e instanceof Error ? e : new Error(String(e)));
      return new Response("Invalid request body", { status: 400 });
    }
  },
};

async function handleGeneration(payload: GenerateRequest, env: Env) {
  const { orchestrator_id, artifact_id, meta_prompt, output_r2_path } = payload;
  
  const logContext = { 
    projectId: orchestrator_id, 
    artifactId: artifact_id 
  };
  const contextLogger = createLogger("generator", logContext);

  try {
    // Get orchestrator stub for callback
    const orchestratorId = env.ORCHESTRATOR.idFromString(orchestrator_id);
    const orchestrator = env.ORCHESTRATOR.get(orchestratorId);

    contextLogger.info("Starting generation task", { 
      metaPromptLength: meta_prompt.length,
      outputPath: output_r2_path 
    });

    // Call Workers AI
    const aiResponse = await env.AI.run("@cf/meta/llama-3-8b-instruct", {
      prompt: meta_prompt,
    });

    // Extract content and cost metrics
    let generatedContent: string;
    let costMetrics: CostMetrics = { prompt_tokens: 0, completion_tokens: 0 };

    if (typeof aiResponse === "string") {
      generatedContent = aiResponse;
    } else if (aiResponse && typeof aiResponse === "object") {
      generatedContent = aiResponse.response || String(aiResponse);
      // Extract cost metrics if available
      if (aiResponse.usage) {
        costMetrics = {
          prompt_tokens: aiResponse.usage.prompt_tokens || 0,
          completion_tokens: aiResponse.usage.completion_tokens || 0,
        };
      }
    } else {
      throw new Error("Unexpected AI response format");
    }

    contextLogger.info("AI generation completed", {
      contentLength: generatedContent.length,
      promptTokens: costMetrics.prompt_tokens,
      completionTokens: costMetrics.completion_tokens,
    });

    // Write artifact to R2
    await env.R2_BUCKET.put(output_r2_path, generatedContent, {
      httpMetadata: {
        contentType: "text/html",
      },
    });

    contextLogger.info("Artifact written to R2", { path: output_r2_path });

    // Report success back to Orchestrator
    const reportPayload: ReportGenerationRequest = {
      artifact_id,
      r2_path: output_r2_path,
      status: "SUCCESS",
      cost_metrics: costMetrics,
    };

    await orchestrator.fetch("https://orchestrator.internal/report/generation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(reportPayload),
    });

    contextLogger.info("Success reported to orchestrator");

  } catch (err) {
    contextLogger.error("Generation failed", err instanceof Error ? err : new Error(String(err)));

    try {
      // Get orchestrator stub for error callback
      const orchestratorId = env.ORCHESTRATOR.idFromString(orchestrator_id);
      const orchestrator = env.ORCHESTRATOR.get(orchestratorId);

      // Report failure back to Orchestrator
      const errorPayload: ReportGenerationRequest = {
        artifact_id,
        r2_path: null,
        status: "FAILED",
        cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
      };

      await orchestrator.fetch("https://orchestrator.internal/report/generation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(errorPayload),
      });

      contextLogger.info("Failure reported to orchestrator");
    } catch (callbackErr) {
      contextLogger.error("Failed to report failure to orchestrator", 
        callbackErr instanceof Error ? callbackErr : new Error(String(callbackErr)));
    }
  }
}