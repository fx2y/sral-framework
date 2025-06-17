import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "./index";
import type { GenerateRequest } from "@sral/shared";

// Mock Cloudflare runtime environment
const createMockEnv = () => ({
  AI: {
    run: vi.fn(),
  },
  R2_BUCKET: {
    put: vi.fn(),
  },
  ORCHESTRATOR: {
    get: vi.fn(),
    idFromString: vi.fn(),
  },
});

const createMockExecutionContext = () => ({
  waitUntil: vi.fn((promise) => promise),
  passThroughOnException: vi.fn(),
});

describe("Generator Worker", () => {
  let env: ReturnType<typeof createMockEnv>;
  let ctx: ReturnType<typeof createMockExecutionContext>;

  beforeEach(() => {
    vi.resetAllMocks();
    env = createMockEnv();
    ctx = createMockExecutionContext();
  });

  const createValidRequest = (overrides: Partial<GenerateRequest> = {}): GenerateRequest => ({
    orchestrator_id: "0".repeat(64),
    artifact_id: "test-artifact",
    meta_prompt: "Generate a simple HTML page with 'Hello World'",
    output_r2_path: "test/artifact.html",
    ...overrides,
  });

  const createHttpRequest = (body: any) =>
    new Request("http://generator.dev/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  describe("HTTP Interface Validation", () => {
    it("should reject all non-POST HTTP methods", async () => {
      const methods = ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"];
      
      for (const method of methods) {
        const request = new Request("http://generator.dev/", { method });
        const response = await worker.fetch(request, env as any, ctx as any);

        expect(response.status).toBe(405);
        expect(await response.text()).toBe("Method not allowed");
      }
    });

    it("should return 400 for malformed JSON payloads", async () => {
      const malformedPayloads = [
        "invalid json",
        "{invalid: json}",
        '{"unclosed": "json"',
        "{",
        "null",
        ""
      ];

      for (const payload of malformedPayloads) {
        const request = new Request("http://generator.dev/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
        });
        const response = await worker.fetch(request, env as any, ctx as any);

        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Invalid request body");
      }
    });

    it("should validate all required fields in GenerateRequest", async () => {
      const requiredFields = ["orchestrator_id", "artifact_id", "meta_prompt", "output_r2_path"];
      
      for (const missingField of requiredFields) {
        const incompleteRequest = createValidRequest();
        delete (incompleteRequest as any)[missingField];
        
        const request = createHttpRequest(incompleteRequest);
        const response = await worker.fetch(request, env as any, ctx as any);

        expect(response.status).toBe(400);
        expect(await response.text()).toBe("Missing required fields");
      }
    });

    it("should accept valid requests and return 202 immediately", async () => {
      // Setup mocks to prevent errors in background processing
      env.AI.run.mockResolvedValue({
        response: "<h1>Valid Request Test</h1>",
        usage: { prompt_tokens: 8, completion_tokens: 12 },
      });
      env.R2_BUCKET.put.mockResolvedValue({});
      const mockFetch = vi.fn().mockResolvedValue(new Response("OK"));
      env.ORCHESTRATOR.idFromString.mockReturnValue("valid-request-id");
      env.ORCHESTRATOR.get.mockReturnValue({ fetch: mockFetch });

      const validRequest = createValidRequest({
        artifact_id: "http-validation-test",
        meta_prompt: "Generate a test page for HTTP validation",
        output_r2_path: "validation/test.html"
      });
      const request = createHttpRequest(validRequest);
      const response = await worker.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(202);
      expect(response.body).toBeNull();
      expect(ctx.waitUntil).toHaveBeenCalledOnce();
    });

    it("should handle requests with various valid content types", async () => {
      env.AI.run.mockResolvedValue({ response: "<h1>Content Type Test</h1>" });
      env.R2_BUCKET.put.mockResolvedValue({});
      env.ORCHESTRATOR.idFromString.mockReturnValue("content-type-id");
      env.ORCHESTRATOR.get.mockReturnValue({ 
        fetch: vi.fn().mockResolvedValue(new Response()) 
      });

      const contentTypes = [
        "application/json",
        "application/json; charset=utf-8",
        "Application/JSON", // case insensitive
      ];

      for (const contentType of contentTypes) {
        const request = new Request("http://generator.dev/", {
          method: "POST",
          headers: { "Content-Type": contentType },
          body: JSON.stringify(createValidRequest({ 
            artifact_id: `content-type-test-${contentType}` 
          })),
        });
        
        const response = await worker.fetch(request, env as any, ctx as any);
        expect(response.status).toBe(202);
      }
    });
  });

  describe("Generation Logic Integration", () => {
    it("should execute complete generation workflow via waitUntil", async () => {
      const testRequest = createValidRequest({
        artifact_id: "waituntil-test-artifact",
        meta_prompt: "Create a modern dashboard with CSS Grid and JavaScript interactions",
        output_r2_path: "waituntil-test/dashboard.html"
      });
      const request = createHttpRequest(testRequest);
      
      // Mock successful AI response with realistic content
      const aiResponse = {
        response: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Modern Dashboard</title>
    <style>
        .dashboard { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
        .card { background: #f5f5f5; padding: 20px; border-radius: 8px; }
    </style>
</head>
<body>
    <div class="dashboard">
        <div class="card">Analytics</div>
        <div class="card">Reports</div>
    </div>
    <script>
        document.querySelectorAll('.card').forEach(card => {
            card.addEventListener('click', () => card.style.background = '#e0e0e0');
        });
    </script>
</body>
</html>`,
        usage: { prompt_tokens: 45, completion_tokens: 85 },
      };
      
      env.AI.run.mockResolvedValue(aiResponse);
      env.R2_BUCKET.put.mockResolvedValue({});
      const mockFetch = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
      env.ORCHESTRATOR.idFromString.mockReturnValue("waituntil-orchestrator-id");
      env.ORCHESTRATOR.get.mockReturnValue({ fetch: mockFetch });

      const response = await worker.fetch(request, env as any, ctx as any);

      // Verify immediate response
      expect(response.status).toBe(202);
      expect(response.body).toBeNull();

      // Verify waitUntil was called with a promise
      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      const promiseArg = ctx.waitUntil.mock.calls[0][0];
      expect(promiseArg).toBeInstanceOf(Promise);

      // Execute the waitUntil promise to verify the complete workflow
      await promiseArg;

      // Verify AI was called with exact prompt
      expect(env.AI.run).toHaveBeenCalledWith("@cf/meta/llama-3-8b-instruct", {
        prompt: "Create a modern dashboard with CSS Grid and JavaScript interactions",
      });

      // Verify R2 was called with exact content
      expect(env.R2_BUCKET.put).toHaveBeenCalledWith(
        "waituntil-test/dashboard.html",
        aiResponse.response,
        { httpMetadata: { contentType: "text/html" } }
      );

      // Verify orchestrator callback with correct data
      expect(mockFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifact_id: "waituntil-test-artifact",
            r2_path: "waituntil-test/dashboard.html",
            status: "SUCCESS",
            cost_metrics: { prompt_tokens: 45, completion_tokens: 85 },
          }),
        }
      );

      // Verify orchestrator binding interactions
      expect(env.ORCHESTRATOR.idFromString).toHaveBeenCalledWith(testRequest.orchestrator_id);
      expect(env.ORCHESTRATOR.get).toHaveBeenCalledWith("waituntil-orchestrator-id");
    });

    it("should handle AI response as string", async () => {
      const request = createHttpRequest(createValidRequest());
      
      // Mock AI response as plain string (no usage info)
      env.AI.run.mockResolvedValue("<h1>Hello String</h1>");
      env.R2_BUCKET.put.mockResolvedValue({});
      const mockFetch = vi.fn().mockResolvedValue(new Response());
      env.ORCHESTRATOR.idFromString.mockReturnValue("mock-id");
      env.ORCHESTRATOR.get.mockReturnValue({ fetch: mockFetch });

      await worker.fetch(request, env as any, ctx as any);
      const promiseArg = ctx.waitUntil.mock.calls[0][0];
      await promiseArg;

      // Should still work with zero cost metrics
      expect(mockFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        expect.objectContaining({
          body: JSON.stringify({
            artifact_id: "test-artifact",
            r2_path: "test/artifact.html",
            status: "SUCCESS",
            cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        })
      );
    });

    it("should handle AI failure and report to orchestrator", async () => {
      const request = createHttpRequest(createValidRequest({ artifact_id: "fail-test" }));
      
      // Mock AI failure
      env.AI.run.mockRejectedValue(new Error("AI service unavailable"));
      const mockFetch = vi.fn().mockResolvedValue(new Response());
      env.ORCHESTRATOR.idFromString.mockReturnValue("mock-id");
      env.ORCHESTRATOR.get.mockReturnValue({ fetch: mockFetch });

      await worker.fetch(request, env as any, ctx as any);
      const promiseArg = ctx.waitUntil.mock.calls[0][0];
      await promiseArg;

      // R2 should not be called
      expect(env.R2_BUCKET.put).not.toHaveBeenCalled();

      // Should report failure to orchestrator
      expect(mockFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifact_id: "fail-test",
            r2_path: null,
            status: "FAILED",
            cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        }
      );
    });

    it("should handle R2 failure and report to orchestrator", async () => {
      const request = createHttpRequest(createValidRequest({ artifact_id: "r2-fail-test" }));
      
      // Mock successful AI but R2 failure
      env.AI.run.mockResolvedValue({
        response: "<h1>Content</h1>",
        usage: { prompt_tokens: 8, completion_tokens: 12 },
      });
      env.R2_BUCKET.put.mockRejectedValue(new Error("R2 storage unavailable"));
      const mockFetch = vi.fn().mockResolvedValue(new Response());
      env.ORCHESTRATOR.idFromString.mockReturnValue("mock-id");
      env.ORCHESTRATOR.get.mockReturnValue({ fetch: mockFetch });

      await worker.fetch(request, env as any, ctx as any);
      const promiseArg = ctx.waitUntil.mock.calls[0][0];
      await promiseArg;

      // Should report failure to orchestrator
      expect(mockFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifact_id: "r2-fail-test",
            r2_path: null,
            status: "FAILED",
            cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        }
      );
    });

    it("should handle orchestrator callback failure gracefully", async () => {
      const request = createHttpRequest(createValidRequest());
      
      env.AI.run.mockResolvedValue({ response: "<h1>Test</h1>" });
      env.R2_BUCKET.put.mockResolvedValue({});
      const mockFetch = vi.fn().mockRejectedValue(new Error("Orchestrator unreachable"));
      env.ORCHESTRATOR.idFromString.mockReturnValue("mock-id");
      env.ORCHESTRATOR.get.mockReturnValue({ fetch: mockFetch });

      await worker.fetch(request, env as any, ctx as any);
      const promiseArg = ctx.waitUntil.mock.calls[0][0];
      
      // Should not throw even if orchestrator callback fails
      await expect(promiseArg).resolves.toBeUndefined();
    });

    it("should handle malformed AI response object", async () => {
      const request = createHttpRequest(createValidRequest({ artifact_id: "malformed-test" }));
      
      // Mock malformed AI response (neither string nor object with response)
      env.AI.run.mockResolvedValue(42); // Invalid response type
      const mockFetch = vi.fn().mockResolvedValue(new Response());
      env.ORCHESTRATOR.idFromString.mockReturnValue("mock-id");
      env.ORCHESTRATOR.get.mockReturnValue({ fetch: mockFetch });

      await worker.fetch(request, env as any, ctx as any);
      const promiseArg = ctx.waitUntil.mock.calls[0][0];
      await promiseArg;

      // Should report failure
      expect(mockFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        expect.objectContaining({
          body: JSON.stringify({
            artifact_id: "malformed-test",
            r2_path: null,
            status: "FAILED",
            cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        })
      );
    });

  });
});