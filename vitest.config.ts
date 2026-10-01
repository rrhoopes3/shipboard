import { fileURLToPath } from "node:url"
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  resolve: {
    // The Cloudflare host's Durable Object and Workflow classes run in Node tests against a stand-in base class.
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/cloudflare/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    exclude: [...configDefaults.exclude, ".claude/**", ".wrangler/**", ".data/**"],
  },
})
