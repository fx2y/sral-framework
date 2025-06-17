import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";
export default defineWorkersConfig({
    test: {
        poolOptions: {
            workers: {
                wrangler: { configPath: "./wrangler.toml" },
                miniflare: {
                    r2Buckets: ["R2_BUCKET"],
                    bindings: {},
                },
            },
        },
    },
});
