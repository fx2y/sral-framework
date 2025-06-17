import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker from "./index";
import type { GenerateRequest, ReportGenerationRequest } from "@sral/shared";

describe("Generator E2E Tests", () => {
  let mockOrchestratorFetch: ReturnType<typeof vi.fn>;
  let mockEnv: any;
  let mockCtx: any;

  beforeEach(() => {
    vi.resetAllMocks();
    
    // Setup mock orchestrator callback
    mockOrchestratorFetch = vi.fn().mockResolvedValue(new Response("OK", { status: 200 }));
    
    // Create mock environment
    mockEnv = {
      AI: {
        run: vi.fn()
      },
      R2_BUCKET: {
        put: vi.fn()
      },
      ORCHESTRATOR: {
        idFromString: vi.fn().mockReturnValue({ toString: () => "mock-orchestrator-id" }),
        get: vi.fn().mockReturnValue({ fetch: mockOrchestratorFetch })
      }
    };

    // Create mock execution context
    mockCtx = {
      waitUntil: vi.fn().mockImplementation(async (promise) => await promise),
      passThroughOnException: vi.fn()
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const createFullWorkflowRequest = (overrides: Partial<GenerateRequest> = {}): GenerateRequest => ({
    orchestrator_id: "abcd1234efgh5678ijkl9012mnop3456qrst7890uvwx1234yzab5678cdef9012",
    artifact_id: "e2e-test-artifact-001",
    meta_prompt: `Create a self-contained HTML file that displays a data visualization dashboard.
    Requirements:
    - Include embedded CSS and JavaScript
    - Create a responsive table with sample data
    - Add interactive sorting functionality
    - Use modern web standards
    - Output should be fully functional when opened in a browser`,
    output_r2_path: "project-e2e/wave_1/artifact_001/dashboard.html",
    ...overrides,
  });

  describe("Complete Generation Workflow", () => {
    it("should execute full generation pipeline from request to callback", async () => {
      // Mock successful AI response with realistic content
      const aiResponse = {
        response: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Data Dashboard</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
        th { background-color: #f2f2f2; cursor: pointer; }
    </style>
</head>
<body>
    <h1>Dashboard</h1>
    <table id="dataTable">
        <thead>
            <tr><th>Name</th><th>Value</th><th>Status</th></tr>
        </thead>
        <tbody>
            <tr><td>Item 1</td><td>100</td><td>Active</td></tr>
            <tr><td>Item 2</td><td>200</td><td>Inactive</td></tr>
        </tbody>
    </table>
</body>
</html>`,
        usage: { prompt_tokens: 125, completion_tokens: 340 }
      };

      mockEnv.AI.run.mockResolvedValue(aiResponse);
      mockEnv.R2_BUCKET.put.mockResolvedValue({} as any);

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createFullWorkflowRequest()),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);

      // Verify immediate response
      expect(response.status).toBe(202);
      expect(response.body).toBeNull();

      // Wait for background processing to complete
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      // Verify AI was called with correct parameters
      expect(mockEnv.AI.run).toHaveBeenCalledWith("@cf/meta/llama-3-8b-instruct", {
        prompt: expect.stringContaining("Create a self-contained HTML file"),
      });

      // Verify artifact was stored in R2
      expect(mockEnv.R2_BUCKET.put).toHaveBeenCalledWith(
        "project-e2e/wave_1/artifact_001/dashboard.html",
        aiResponse.response,
        { httpMetadata: { contentType: "text/html" } }
      );

      // Verify orchestrator callback
      expect(mockOrchestratorFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifact_id: "e2e-test-artifact-001",
            r2_path: "project-e2e/wave_1/artifact_001/dashboard.html",
            status: "SUCCESS",
            cost_metrics: { prompt_tokens: 125, completion_tokens: 340 },
          } as ReportGenerationRequest),
        }
      );
    });

    it("should handle complete failure scenario with proper error reporting", async () => {
      // Mock AI service failure
      const aiError = new Error("AI service temporarily unavailable");
      mockEnv.AI.run.mockRejectedValue(aiError);
      mockEnv.R2_BUCKET.put.mockResolvedValue({} as any);

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createFullWorkflowRequest({
          artifact_id: "e2e-failure-test"
        })),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);

      // Should still return 202 immediately
      expect(response.status).toBe(202);

      // Wait for background processing
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      // R2 should not be called on AI failure
      expect(mockEnv.R2_BUCKET.put).not.toHaveBeenCalled();

      // Should report failure to orchestrator
      expect(mockOrchestratorFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifact_id: "e2e-failure-test",
            r2_path: null,
            status: "FAILED",
            cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
          } as ReportGenerationRequest),
        }
      );
    });

    it("should handle partial failure with storage issues", async () => {
      // Mock successful AI but R2 failure
      mockEnv.AI.run.mockResolvedValue({
        response: "<h1>Generated Content</h1>",
        usage: { prompt_tokens: 50, completion_tokens: 20 }
      });
      
      const r2Error = new Error("R2 bucket quota exceeded");
      mockEnv.R2_BUCKET.put.mockRejectedValue(r2Error);

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(createFullWorkflowRequest({
          artifact_id: "e2e-storage-failure"
        })),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      // AI should have been called successfully
      expect(mockEnv.AI.run).toHaveBeenCalledOnce();

      // R2 put should have been attempted
      expect(mockEnv.R2_BUCKET.put).toHaveBeenCalledOnce();

      // Should report failure despite successful AI call
      expect(mockOrchestratorFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        expect.objectContaining({
          body: JSON.stringify({
            artifact_id: "e2e-storage-failure",
            r2_path: null,
            status: "FAILED",
            cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        })
      );
    });
  });

  describe("Real-world Scenario Simulation", () => {
    it("should handle high-volume concurrent requests", async () => {
      // Setup mocks for concurrent processing
      mockEnv.AI.run.mockImplementation(async (model, params) => {
        // Simulate variable AI response times
        await new Promise(resolve => setTimeout(resolve, Math.random() * 100));
        return {
          response: `<h1>Response to: ${params.prompt.slice(0, 50)}...</h1>`,
          usage: { prompt_tokens: 80, completion_tokens: 45 }
        };
      });
      mockEnv.R2_BUCKET.put.mockResolvedValue({} as any);

      const concurrentRequests = Array.from({ length: 5 }, (_, i) => {
        const request = new Request("http://generator.dev/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(createFullWorkflowRequest({
            artifact_id: `concurrent-test-${i}`,
            output_r2_path: `project-concurrent/artifact_${i}/output.html`,
          })),
        });
        const ctx = { ...mockCtx, waitUntil: vi.fn().mockImplementation(async (promise) => await promise) };
        return { request, ctx };
      });

      // Execute all requests concurrently
      const responses = await Promise.all(
        concurrentRequests.map(({ request, ctx }) =>
          worker.fetch(request, mockEnv, ctx).then(response => ({ response, ctx }))
        )
      );

      // All should return 202 immediately
      responses.forEach(({ response }) => {
        expect(response.status).toBe(202);
      });

      // Wait for all background processing to complete
      await Promise.all(
        responses.map(({ ctx }) => {
          const waitUntilPromise = ctx.waitUntil.mock.calls[0][0];
          return waitUntilPromise;
        })
      );

      // Verify all AI calls were made
      expect(mockEnv.AI.run).toHaveBeenCalledTimes(5);

      // Verify all R2 puts were made
      expect(mockEnv.R2_BUCKET.put).toHaveBeenCalledTimes(5);

      // Verify all orchestrator callbacks were made
      expect(mockOrchestratorFetch).toHaveBeenCalledTimes(5);

      // Verify each callback had correct artifact_id
      const callbackBodies = mockOrchestratorFetch.mock.calls.map(
        call => JSON.parse(call[1].body)
      );
      
      for (let i = 0; i < 5; i++) {
        expect(callbackBodies).toContainEqual(
          expect.objectContaining({
            artifact_id: `concurrent-test-${i}`,
            status: "SUCCESS",
          })
        );
      }
    });

    it("should maintain data integrity across the full pipeline", async () => {
      const testData = {
        orchestrator_id: "integrity-test-orchestrator-12345678901234567890123456789012",
        artifact_id: "integrity-artifact-uuid-12345",
        meta_prompt: "Generate HTML with specific marker: INTEGRITY_TEST_MARKER_XYZ",
        output_r2_path: "integrity-test/wave_1/artifact_xyz/output.html",
      };

      const expectedAiResponse = {
        response: "<html><body><h1>INTEGRITY_TEST_MARKER_XYZ</h1></body></html>",
        usage: { prompt_tokens: 15, completion_tokens: 25 }
      };

      mockEnv.AI.run.mockResolvedValue(expectedAiResponse);
      mockEnv.R2_BUCKET.put.mockResolvedValue({} as any);

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testData),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      // Verify AI was called with exact prompt
      expect(mockEnv.AI.run).toHaveBeenCalledWith("@cf/meta/llama-3-8b-instruct", {
        prompt: "Generate HTML with specific marker: INTEGRITY_TEST_MARKER_XYZ",
      });

      // Verify R2 was called with exact path and content
      expect(mockEnv.R2_BUCKET.put).toHaveBeenCalledWith(
        "integrity-test/wave_1/artifact_xyz/output.html",
        "<html><body><h1>INTEGRITY_TEST_MARKER_XYZ</h1></body></html>",
        { httpMetadata: { contentType: "text/html" } }
      );

      // Verify orchestrator callback has exact data integrity
      const callbackCall = mockOrchestratorFetch.mock.calls[0];
      const callbackBody = JSON.parse(callbackCall[1].body);
      
      expect(callbackBody).toEqual({
        artifact_id: "integrity-artifact-uuid-12345",
        r2_path: "integrity-test/wave_1/artifact_xyz/output.html",
        status: "SUCCESS",
        cost_metrics: { prompt_tokens: 15, completion_tokens: 25 },
      });

      // Verify orchestrator binding was called with correct ID
      expect(mockEnv.ORCHESTRATOR.idFromString).toHaveBeenCalledWith(
        "integrity-test-orchestrator-12345678901234567890123456789012"
      );
    });
  });

  describe("Edge Cases and Boundary Conditions", () => {
    it("should handle extremely large prompts", async () => {
      const largePrompt = "Create HTML content: " + "x".repeat(10000);
      
      mockEnv.AI.run.mockResolvedValue({
        response: "<h1>Large content processed</h1>",
        usage: { prompt_tokens: 2500, completion_tokens: 50 }
      });
      mockEnv.R2_BUCKET.put.mockResolvedValue({} as any);

      const testRequest = createFullWorkflowRequest({
        meta_prompt: largePrompt,
        artifact_id: "large-prompt-test",
        output_r2_path: "large-prompts/test.html"
      });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testRequest),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      expect(mockEnv.AI.run).toHaveBeenCalledWith("@cf/meta/llama-3-8b-instruct", {
        prompt: largePrompt,
      });

      expect(mockOrchestratorFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        expect.objectContaining({
          body: JSON.stringify({
            artifact_id: "large-prompt-test",
            r2_path: "large-prompts/test.html",
            status: "SUCCESS",
            cost_metrics: { prompt_tokens: 2500, completion_tokens: 50 },
          }),
        })
      );
    });

    it("should handle AI response with missing usage information", async () => {
      // Mock AI response without usage data
      mockEnv.AI.run.mockResolvedValue({
        response: "<h1>No usage data</h1>"
        // Missing usage field
      });
      mockEnv.R2_BUCKET.put.mockResolvedValue({} as any);

      const testRequest = createFullWorkflowRequest({
        artifact_id: "missing-usage-test",
        output_r2_path: "missing-usage/test.html"
      });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testRequest),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      // Should default to zero cost metrics
      expect(mockOrchestratorFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        expect.objectContaining({
          body: JSON.stringify({
            artifact_id: "missing-usage-test",
            r2_path: "missing-usage/test.html",
            status: "SUCCESS",
            cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        })
      );
    });

    it("should handle orchestrator callback network failures gracefully", async () => {
      // Create fresh mocks for this test
      const failingMockFetch = vi.fn().mockRejectedValue(new Error("Network timeout"));
      
      const freshMockEnv = {
        AI: {
          run: vi.fn().mockResolvedValue({
            response: "<h1>Content</h1>",
            usage: { prompt_tokens: 10, completion_tokens: 20 }
          })
        },
        R2_BUCKET: {
          put: vi.fn().mockResolvedValue({} as any)
        },
        ORCHESTRATOR: {
          idFromString: vi.fn().mockReturnValue({ toString: () => "callback-failure-orchestrator" }),
          get: vi.fn().mockReturnValue({ fetch: failingMockFetch })
        }
      };

      const freshMockCtx = {
        waitUntil: vi.fn().mockImplementation(async (promise) => await promise),
        passThroughOnException: vi.fn()
      };

      const testRequest = createFullWorkflowRequest({
        artifact_id: "callback-failure-test",
        output_r2_path: "callback-failure/test.html"
      });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(testRequest),
      });

      const response = await worker.fetch(request, freshMockEnv, freshMockCtx);
      
      // Should not throw even if callback fails
      const waitUntilPromise = freshMockCtx.waitUntil.mock.calls[0][0];
      await expect(waitUntilPromise).resolves.toBeUndefined();

      // Verify processing still occurred
      expect(freshMockEnv.AI.run).toHaveBeenCalledOnce();
      expect(freshMockEnv.R2_BUCKET.put).toHaveBeenCalledOnce();
      
      // Should call orchestrator twice: once for success (which fails) and once for error reporting (which also fails)
      expect(failingMockFetch).toHaveBeenCalledTimes(2);
      
      // Verify first call was for success
      expect(failingMockFetch).toHaveBeenNthCalledWith(1,
        "https://orchestrator.internal/report/generation",
        expect.objectContaining({
          body: JSON.stringify({
            artifact_id: "callback-failure-test",
            r2_path: "callback-failure/test.html",
            status: "SUCCESS",
            cost_metrics: { prompt_tokens: 10, completion_tokens: 20 },
          }),
        })
      );
      
      // Verify second call was for error reporting
      expect(failingMockFetch).toHaveBeenNthCalledWith(2,
        "https://orchestrator.internal/report/generation",
        expect.objectContaining({
          body: JSON.stringify({
            artifact_id: "callback-failure-test",
            r2_path: null,
            status: "FAILED",
            cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        })
      );
    });
  });
});