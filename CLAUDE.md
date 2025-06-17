# SRAL Agent Development Guide

This document is a tactical, high-density guide for developing the Self-Refining Agentic Loop (SRAL) framework. It details the project's architecture, data contracts, and development patterns.

### 1. Project Vision & Core Loop

SRAL is a stateful, multi-agent framework on Cloudflare for continuous, iterative problem-solving. It evolves beyond a simple "infinite loop" by externalizing state and introducing a formal feedback mechanism.

**Core Loop:** `GENERATE -> ANALYZE -> EVOLVE`
1.  **Generate:** A wave of `Generator` workers creates multiple, unique solution artifacts in parallel.
2.  **Analyze:** An `Analyzer` worker orchestrates parallel evaluation of artifacts, then synthesizes successful patterns from the top performers into a `learnings.md` file.
3.  **Evolve:** The `Orchestrator` agent uses the `learnings.md` to refine the instructions (`meta-prompt`) for the next generation wave, guiding the system toward higher-quality solutions.

### 2. System Architecture

All communication between components is asynchronous HTTP (`fetch`). The `Orchestrator` is the only stateful component.

```mermaid
graph TD
    subgraph "User Environment"
        CLI[SRAL CLI]
    end

    subgraph "Cloudflare Platform"
        Gateway[API Gateway<br>@sral/gateway]
        Orchestrator[Orchestrator Agent (DO)<br>@sral/orchestrator]
        Generator[Generator Worker<br>@sral/generator]
        Analyzer[Analyzer Worker<br>@sral/analyzer]
        Evaluator[Evaluator Worker<br>@sral/evaluator]
        R2[(R2 Storage<br>Artifacts, Logs)]
        AI[(Workers AI)]
    end

    CLI -- 1. `sral run` (HTTP API Call) --> Gateway
    Gateway -- 2. Authenticates & Creates/Forwards --> Orchestrator
    Orchestrator -- 3. Dispatches N Jobs (HTTP) --> Generator
    Generator -- 4. Calls LLM --> AI
    Generator -- 5. Writes artifact --> R2
    Generator -- 6. Reports completion --> Orchestrator
    Orchestrator -- 7. Dispatches Analysis Job (HTTP) --> Analyzer
    Analyzer -- 8. Fans-out N evaluation jobs (HTTP) --> Evaluator
    Evaluator -- 9. Fetches artifact --> R2
    Evaluator -- 10. Reports score --> Analyzer
    Analyzer -- 11. Synthesizes `learnings.md` --> AI
    Analyzer -- 12. Reports `learnings.md` & scores --> Orchestrator
    Orchestrator -- Loops to 3 --> Orchestrator
    Orchestrator -- Persists State & Logs --> R2
```

### 3. Monorepo Project Structure

The project uses an `npm` workspace-based monorepo for shared types and utilities.

```
sral-framework/
├── packages/
│   ├── gateway/          # API Gateway Worker
│   ├── orchestrator/     # Orchestrator Agent (Durable Object)
│   ├── generator/        # Generator Worker (Stateless)
│   ├── analyzer/         # Analysis Coordinator Worker (Stateless)
│   ├── evaluator/        # Single-Artifact Evaluation Worker (Stateless)
│   ├── cli/              # SRAL CLI tool (Node.js)
│   └── shared/           # Shared TypeScript types and utilities
├── .dev.vars             # Local secrets (gitignored)
├── package.json          # Root workspace config
└── wrangler.toml         # Root wrangler config for shared bindings
```

### 4. End-to-End Data Flow: `sral run`

1.  **CLI:** User runs `sral run spec.md --cost=5.00`. CLI reads files, parses flags, and sends a `StartRequest` to the Gateway.
2.  **Gateway:** Authenticates request, generates a `projectId`, gets a Durable Object stub for the `Orchestrator` via `idFromName(projectId)`, and forwards the request.
3.  **Orchestrator:** `start()` method is called. It initializes its state (`OrchestratorState`), stores configs in R2, and calls `run_generation_wave()`.
4.  **Orchestrator (Evolve):** Checks if it can afford the wave (`canAffordNextWave()`). Constructs a `meta-prompt` by combining the `spec.md` and the latest `learnings.md`.
5.  **Orchestrator (Dispatch & Resiliency):**
    *   Loops `N` times, sending a `GenerateRequest` to the `Generator` worker binding.
    *   For each job, it writes a record to its internal `dispatched_jobs` SQL table.
    *   Schedules a timeout callback for each job using `this.schedule()`.
6.  **Generator:** Receives request, calls Workers AI, writes the output artifact to R2, and sends a `ReportGenerationRequest` (with token costs) back to the Orchestrator.
7.  **Orchestrator (Callback):** Receives the report, updates the `artifacts` and `dispatched_jobs` tables, and updates its `costTracker`. If a job times out, its `handle_job_timeout` method is triggered for retry/failure logic.
8.  **Orchestrator (Trigger Analysis):** Once all generation jobs for the wave are complete (or failed/timed out), it calls `run_analysis()`, sending an `AnalyzeRequest` to the `Analyzer` worker and creating a corresponding job in `dispatched_jobs`.
9.  **Analyzer (Fan-Out/Fan-In):**
    *   Receives request. For each artifact, it sends a parallel `EvaluationRequest` to the `Evaluator` worker.
    *   Awaits all `EvaluationResponse`s.
10. **Analyzer (Synthesize):** It identifies the top-performing artifacts, fetches their source code from R2, and makes a final LLM call to synthesize the `learnings.md` content.
11. **Analyzer (Report):** Sends a `ReportAnalysisRequest` (with all scores and the `learnings.md` string) back to the Orchestrator.
12. **Orchestrator (Loop):** Receives analysis, updates its state with the new `learnings.md`, checks termination conditions (`checkTerminationConditions()`). If not met, it increments the wave counter and loops back to step 4.

### 5. Key Data Schemas & Contracts (`@sral/shared`)

All components MUST use these shared types for communication.

*   **`SpecConfig`**: The problem definition.
    ```typescript
    interface SpecConfig {
      title: string;
      output_format: "self_contained_html" | string;
      generator_count_per_wave: number;
      // ... plus user-defined markdown content
    }
    ```
*   **`Scorecard`**: Defines how to evaluate an artifact.
    ```typescript
    interface Scorecard {
      tests: Array<{
        type: "linter" | "llm_evaluation" | string;
        weight: number; // e.g., 0.5
        config: object; // Test-specific configuration
      }>;
    }
    ```
*   **`OrchestratorState`**: The brain of the operation, stored in the DO.
    ```typescript
    interface OrchestratorState {
      projectId: string;
      status: 'GENERATING' | 'ANALYZING' | 'AWAITING_APPROVAL' | 'COMPLETED';
      currentWave: number;
      terminationConditions: { maxWaves?: number; maxCost?: number; /* ... */ };
      costTracker: { estimatedCostUSD: number; };
      latest_learnings_md: string; // The distilled knowledge from the last wave
    }
    ```
*   **`DispatchedJob` (SQL Table)**: For resiliency.
    ```typescript
    interface DispatchedJob {
      job_id: string;
      artifact_id: string;
      type: 'generation' | 'analysis';
      status: 'pending' | 'complete' | 'failed' | 'timed_out';
      retries: number;
    }
    ```
*   **`ReportAnalysisRequest`**: The key feedback payload.
    ```typescript
    interface ReportAnalysisRequest {
      results: Array<{ artifact_id: string; quality_score: number; details: object; }>;
      learnings_md: string; // The synthesized patterns/principles
    }
    ```

### 6. Development & Testing Workflow

1.  **Setup:** Clone the monorepo. Run `npm install` at the root.
2.  **Secrets:** Create `packages/sral-framework/.dev.vars` and add necessary API keys (e.g., `OPENAI_API_KEY`).
3.  **Local Dev:** Run `wrangler dev` from the root. This starts all services locally using Miniflare.
4.  **Interaction:** Use the CLI (`packages/cli`) to interact with the local gateway (e.g., `npm --workspace=@sral/cli run dev -- run spec.md`).
5.  **Testing:** Run `npm test` from the root to execute all `vitest` tests across all packages.

### 7. Core Engineering Principles & Patterns

*   **Stateful Core, Stateless Periphery:** All long-term state resides **only** in the `@sral/orchestrator` Durable Object. All other workers (`generator`, `analyzer`, `evaluator`, `gateway`) are stateless and can be scaled independently.
*   **Structured Logging:** Use the `@sral/shared` logging utility. All logs are structured JSON containing `projectId`, `service`, `level`, etc., for aggregation via Cloudflare Logpush.
*   **Configuration over Code:** System behavior is driven by `spec.md` and `scorecard.json`. To solve a new problem, change the config, not the agent code.
*   **Resiliency via Polling & Timeouts:** The Orchestrator is responsible for tracking job status via its `dispatched_jobs` table and using `this.schedule()` to implement timeouts and retries. It does not trust workers to always call back.
*   **Proactive Cost Governance:** The Orchestrator MUST estimate the cost of the next wave *before* dispatching it and terminate if the budget will be exceeded.
*   **Type Safety:** All inter-service communication MUST use the interfaces defined in `@sral/shared`.
*   **Security:** All evaluation tools (linters, etc.) are bundled into the `@sral/evaluator` worker at build time. No `npm install` at runtime. Network access is disabled by default on evaluation workers.