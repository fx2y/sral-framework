import { describe, it, expect, vi, beforeEach } from "vitest";
import worker from "./index";
import type { GenerateRequest } from "@sral/shared";

describe("Generator Integration Tests", () => {
  let mockEnv: any;
  let mockCtx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockEnv = {
      AI: {
        run: vi.fn()
      },
      R2_BUCKET: {
        put: vi.fn()
      },
      ORCHESTRATOR: {
        idFromString: vi.fn(),
        get: vi.fn()
      }
    };

    mockCtx = {
      waitUntil: vi.fn((promise) => promise),
      passThroughOnException: vi.fn()
    };
  });

  describe("Worker Interface Contract", () => {
    it("should export default worker with correct structure", () => {
      expect(worker).toBeDefined();
      expect(typeof worker.fetch).toBe("function");
      expect(worker.fetch.length).toBe(3); // request, env, ctx
    });

    it("should handle HTTP method validation", async () => {
      const methods = ["GET", "PUT", "DELETE", "PATCH"];
      
      for (const method of methods) {
        const request = new Request("http://generator.dev/", { method });
        const response = await worker.fetch(request, mockEnv, mockCtx);
        expect(response.status).toBe(405);
        expect(await response.text()).toBe("Method not allowed");
      }
    });

    it("should accept POST requests", async () => {
      mockEnv.AI.run.mockResolvedValue({ response: "test" });
      mockEnv.R2_BUCKET.put.mockResolvedValue({});
      mockEnv.ORCHESTRATOR.idFromString.mockReturnValue("test-id");
      mockEnv.ORCHESTRATOR.get.mockReturnValue({ 
        fetch: vi.fn().mockResolvedValue(new Response()) 
      });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orchestrator_id: "a".repeat(64),
          artifact_id: "test-artifact",
          meta_prompt: "test prompt",
          output_r2_path: "test.html",
        } as GenerateRequest),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);
      expect(response.status).toBe(202);
    });
  });

  describe("Service Binding Integration", () => {
    it("should interact correctly with AI binding", async () => {
      const aiResponse = {
        response: "<h1>AI Generated Content</h1>",
        usage: { prompt_tokens: 20, completion_tokens: 30 }
      };
      
      mockEnv.AI.run.mockResolvedValue(aiResponse);
      mockEnv.R2_BUCKET.put.mockResolvedValue({});
      mockEnv.ORCHESTRATOR.idFromString.mockReturnValue("test-orchestrator");
      mockEnv.ORCHESTRATOR.get.mockReturnValue({ 
        fetch: vi.fn().mockResolvedValue(new Response()) 
      });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orchestrator_id: "b".repeat(64),
          artifact_id: "ai-integration-test",
          meta_prompt: "Create a test HTML page",
          output_r2_path: "ai-test.html",
        } as GenerateRequest),
      });

      await worker.fetch(request, mockEnv, mockCtx);
      
      // Execute the waitUntil promise
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      expect(mockEnv.AI.run).toHaveBeenCalledWith("@cf/meta/llama-3-8b-instruct", {
        prompt: "Create a test HTML page"
      });
    });

    it("should interact correctly with R2 binding", async () => {
      const testContent = "<html><body>Test Content</body></html>";
      
      mockEnv.AI.run.mockResolvedValue({
        response: testContent,
        usage: { prompt_tokens: 10, completion_tokens: 20 }
      });
      mockEnv.R2_BUCKET.put.mockResolvedValue({});
      mockEnv.ORCHESTRATOR.idFromString.mockReturnValue("test-orchestrator");
      mockEnv.ORCHESTRATOR.get.mockReturnValue({ 
        fetch: vi.fn().mockResolvedValue(new Response()) 
      });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orchestrator_id: "c".repeat(64),
          artifact_id: "r2-integration-test",
          meta_prompt: "Generate test content",
          output_r2_path: "r2-test/output.html",
        } as GenerateRequest),
      });

      await worker.fetch(request, mockEnv, mockCtx);
      
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      expect(mockEnv.R2_BUCKET.put).toHaveBeenCalledWith(
        "r2-test/output.html",
        testContent,
        { httpMetadata: { contentType: "text/html" } }
      );
    });

    it("should interact correctly with Orchestrator binding", async () => {
      const mockOrchestratorFetch = vi.fn().mockResolvedValue(new Response("OK"));
      
      mockEnv.AI.run.mockResolvedValue({
        response: "<h1>Orchestrator Test</h1>",
        usage: { prompt_tokens: 15, completion_tokens: 25 }
      });
      mockEnv.R2_BUCKET.put.mockResolvedValue({});
      mockEnv.ORCHESTRATOR.idFromString.mockReturnValue("test-orchestrator-id");
      mockEnv.ORCHESTRATOR.get.mockReturnValue({ fetch: mockOrchestratorFetch });

      const orchestratorId = "d".repeat(64);
      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orchestrator_id: orchestratorId,
          artifact_id: "orchestrator-integration-test",
          meta_prompt: "Generate orchestrator test content",
          output_r2_path: "orchestrator-test.html",
        } as GenerateRequest),
      });

      await worker.fetch(request, mockEnv, mockCtx);
      
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      // Verify orchestrator ID parsing
      expect(mockEnv.ORCHESTRATOR.idFromString).toHaveBeenCalledWith(orchestratorId);
      expect(mockEnv.ORCHESTRATOR.get).toHaveBeenCalledWith("test-orchestrator-id");

      // Verify callback
      expect(mockOrchestratorFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifact_id: "orchestrator-integration-test",
            r2_path: "orchestrator-test.html",
            status: "SUCCESS",
            cost_metrics: { prompt_tokens: 15, completion_tokens: 25 },
          }),
        }
      );
    });
  });

  describe("Cross-Component Data Flow", () => {
    it("should maintain data consistency across all components", async () => {
      const testScenario = {
        orchestratorId: "integration-test-" + "1".repeat(50),
        artifactId: "data-flow-test-artifact",
        prompt: "Create HTML with data flow test marker: INTEGRATION_TEST_123",
        r2Path: "integration-tests/data-flow/artifact.html"
      };

      const expectedAiResponse = {
        response: "<html><body>INTEGRATION_TEST_123</body></html>",
        usage: { prompt_tokens: 25, completion_tokens: 35 }
      };

      const mockOrchestratorFetch = vi.fn().mockResolvedValue(new Response("OK"));
      
      mockEnv.AI.run.mockResolvedValue(expectedAiResponse);
      mockEnv.R2_BUCKET.put.mockResolvedValue({});
      mockEnv.ORCHESTRATOR.idFromString.mockReturnValue("parsed-orchestrator-id");
      mockEnv.ORCHESTRATOR.get.mockReturnValue({ fetch: mockOrchestratorFetch });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orchestrator_id: testScenario.orchestratorId,
          artifact_id: testScenario.artifactId,
          meta_prompt: testScenario.prompt,
          output_r2_path: testScenario.r2Path,
        } as GenerateRequest),
      });

      await worker.fetch(request, mockEnv, mockCtx);
      
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      // Verify complete data flow integrity
      expect(mockEnv.AI.run).toHaveBeenCalledWith("@cf/meta/llama-3-8b-instruct", {
        prompt: testScenario.prompt
      });

      expect(mockEnv.R2_BUCKET.put).toHaveBeenCalledWith(
        testScenario.r2Path,
        expectedAiResponse.response,
        { httpMetadata: { contentType: "text/html" } }
      );

      expect(mockOrchestratorFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifact_id: testScenario.artifactId,
            r2_path: testScenario.r2Path,
            status: "SUCCESS",
            cost_metrics: expectedAiResponse.usage,
          }),
        }
      );
    });

    it("should handle error propagation across components", async () => {
      const mockOrchestratorFetch = vi.fn().mockResolvedValue(new Response("OK"));
      
      // Mock R2 failure
      mockEnv.AI.run.mockResolvedValue({
        response: "<h1>Success</h1>",
        usage: { prompt_tokens: 10, completion_tokens: 20 }
      });
      mockEnv.R2_BUCKET.put.mockRejectedValue(new Error("R2 storage error"));
      mockEnv.ORCHESTRATOR.idFromString.mockReturnValue("error-test-id");
      mockEnv.ORCHESTRATOR.get.mockReturnValue({ fetch: mockOrchestratorFetch });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orchestrator_id: "e".repeat(64),
          artifact_id: "error-propagation-test",
          meta_prompt: "Test error handling",
          output_r2_path: "error-test.html",
        } as GenerateRequest),
      });

      await worker.fetch(request, mockEnv, mockCtx);
      
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      // Verify error is properly reported to orchestrator
      expect(mockOrchestratorFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifact_id: "error-propagation-test",
            r2_path: null,
            status: "FAILED",
            cost_metrics: { prompt_tokens: 0, completion_tokens: 0 },
          }),
        }
      );
    });
  });

  describe("Asynchronous Processing Integration", () => {
    it("should handle ctx.waitUntil properly for async operations", async () => {
      mockEnv.AI.run.mockResolvedValue({ response: "async test" });
      mockEnv.R2_BUCKET.put.mockResolvedValue({});
      mockEnv.ORCHESTRATOR.idFromString.mockReturnValue("async-test-id");
      mockEnv.ORCHESTRATOR.get.mockReturnValue({ 
        fetch: vi.fn().mockResolvedValue(new Response()) 
      });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orchestrator_id: "f".repeat(64),
          artifact_id: "async-test",
          meta_prompt: "async processing test",
          output_r2_path: "async.html",
        } as GenerateRequest),
      });

      const response = await worker.fetch(request, mockEnv, mockCtx);

      // Should return immediately
      expect(response.status).toBe(202);
      expect(response.body).toBeNull();

      // Should have registered async work
      expect(mockCtx.waitUntil).toHaveBeenCalledOnce();
      expect(mockCtx.waitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    });

    it("should ensure all async operations complete before finishing", async () => {
      let aiCallCompleted = false;
      let r2CallCompleted = false;
      let orchestratorCallCompleted = false;

      mockEnv.AI.run.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        aiCallCompleted = true;
        return { response: "delayed response" };
      });

      mockEnv.R2_BUCKET.put.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        r2CallCompleted = true;
        return {};
      });

      const mockOrchestratorFetch = vi.fn().mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        orchestratorCallCompleted = true;
        return new Response("OK");
      });

      mockEnv.ORCHESTRATOR.idFromString.mockReturnValue("timing-test-id");
      mockEnv.ORCHESTRATOR.get.mockReturnValue({ fetch: mockOrchestratorFetch });

      const request = new Request("http://generator.dev/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orchestrator_id: "g".repeat(64),
          artifact_id: "timing-test",
          meta_prompt: "timing test",
          output_r2_path: "timing.html",
        } as GenerateRequest),
      });

      await worker.fetch(request, mockEnv, mockCtx);

      // Execute the async work
      const waitUntilPromise = mockCtx.waitUntil.mock.calls[0][0];
      await waitUntilPromise;

      // All operations should be completed
      expect(aiCallCompleted).toBe(true);
      expect(r2CallCompleted).toBe(true);
      expect(orchestratorCallCompleted).toBe(true);
    });
  });

  describe("Request/Response Format Integration", () => {
    it("should handle various input formats correctly", async () => {
      const testCases = [
        {
          name: "minimal valid request",
          input: {
            orchestrator_id: "h".repeat(64),
            artifact_id: "minimal-test",
            meta_prompt: "minimal",
            output_r2_path: "minimal.html"
          }
        },
        {
          name: "request with special characters",
          input: {
            orchestrator_id: "i".repeat(64),
            artifact_id: "special-chars-test-äöü-123",
            meta_prompt: "Create HTML with special chars: äöü ñ 中文 🌟",
            output_r2_path: "special/chars/test.html"
          }
        }
      ];

      for (const testCase of testCases) {
        mockEnv.AI.run.mockResolvedValue({ response: `<h1>${testCase.name}</h1>` });
        mockEnv.R2_BUCKET.put.mockResolvedValue({});
        mockEnv.ORCHESTRATOR.idFromString.mockReturnValue("format-test-id");
        mockEnv.ORCHESTRATOR.get.mockReturnValue({ 
          fetch: vi.fn().mockResolvedValue(new Response()) 
        });

        const request = new Request("http://generator.dev/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(testCase.input),
        });

        const response = await worker.fetch(request, mockEnv, mockCtx);
        expect(response.status).toBe(202);

        const waitUntilPromise = mockCtx.waitUntil.mock.calls[mockCtx.waitUntil.mock.calls.length - 1][0];
        await waitUntilPromise;
      }
    });
  });
});