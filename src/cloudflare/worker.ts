/**
 * The Worker. Static assets serve the board UI; only /api/* and /preview/* run this code
 * (`assets.run_worker_first`). The API is the same Hono app the local host serves.
 */

import { appFor, isApiPath } from "./app.ts"
import type { Env } from "./env.ts"

export { ProjectDO } from "./project-do.ts"
export { PushWorkflow } from "./push-workflow.ts"
export { RegistryDO } from "./registry-do.ts"

export default {
  async fetch(request, env, ctx): Promise<Response> {
    // Anything else that reaches the Worker belongs to the static assets.
    if (!isApiPath(new URL(request.url).pathname)) return env.ASSETS.fetch(request)
    return appFor(env).fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
