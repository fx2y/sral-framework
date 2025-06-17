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

  describe("HTTP Interface", () => {
    it("should return 405 for non-POST requests", async () => {
      const request = new Request("http://generator.dev/", { method: "GET" });
      const response = await worker.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(405);
      expect(await response.text()).toBe("Method not allowed");
    });

    it("should return 400 for invalid JSON", async () => {
      const request = new Request("http://generator.dev/", {
        method: "POST",
        body: "invalid json",
      });
      const response = await worker.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid request body");
    });

    it("should return 400 for missing required fields", async () => {
      const request = createHttpRequest({
        orchestrator_id: "test",
        // missing other required fields
      });
      const response = await worker.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Missing required fields");
    });

    it("should return 202 for valid request", async () => {
      const request = createHttpRequest(createValidRequest());
      const response = await worker.fetch(request, env as any, ctx as any);

      expect(response.status).toBe(202);
      expect(response.body).toBeNull();
      expect(ctx.waitUntil).toHaveBeenCalledOnce();
    });
  });

  describe("Generation Logic Integration", () => {
    it("should call waitUntil with proper generation logic", async () => {
      const request = createHttpRequest(createValidRequest());
      
      // Mock successful AI response
      env.AI.run.mockResolvedValue({
        response: "<h1>Hello World</h1>",
        usage: { prompt_tokens: 10, completion_tokens: 15 },
      });
      env.R2_BUCKET.put.mockResolvedValue({});
      const mockFetch = vi.fn().mockResolvedValue(new Response());
      env.ORCHESTRATOR.idFromString.mockReturnValue("mock-id");
      env.ORCHESTRATOR.get.mockReturnValue({ fetch: mockFetch });

      await worker.fetch(request, env as any, ctx as any);

      // Verify waitUntil was called with a promise
      expect(ctx.waitUntil).toHaveBeenCalledOnce();
      const promiseArg = ctx.waitUntil.mock.calls[0][0];
      expect(promiseArg).toBeInstanceOf(Promise);

      // Execute the waitUntil promise to verify the logic
      await promiseArg;

      // Verify AI was called
      expect(env.AI.run).toHaveBeenCalledWith("@cf/meta/llama-3-8b-instruct", {
        prompt: "Generate a simple HTML page with 'Hello World'",
      });

      // Verify R2 was called
      expect(env.R2_BUCKET.put).toHaveBeenCalledWith(
        "test/artifact.html",
        "<h1>Hello World</h1>",
        { httpMetadata: { contentType: "text/html" } }
      );

      // Verify orchestrator callback
      expect(mockFetch).toHaveBeenCalledWith(
        "https://orchestrator.internal/report/generation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifact_id: "test-artifact",
            r2_path: "test/artifact.html",
            status: "SUCCESS",
            cost_metrics: { prompt_tokens: 10, completion_tokens: 15 },
          }),
        }
      );
    });

  });
});