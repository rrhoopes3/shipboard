import path from "node:path"
import { serve } from "@hono/node-server"
import { createApp } from "./app.ts"
import { git } from "./git.ts"
import { BoardService } from "./service.ts"

const port = Number(process.env.PORT || 8787)
const dataDir = process.env.SHIPBOARD_DATA
  ? path.resolve(process.env.SHIPBOARD_DATA)
  : path.join(process.cwd(), ".data")

try {
  await git(process.cwd(), ["--version"])
} catch {
  console.error("Shipboard needs git on PATH. Trial-merge uses the git binary.")
  process.exit(1)
}

const service = await BoardService.open(dataDir)
const app = await createApp(service)

serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  console.log(`Shipboard board http://127.0.0.1:${info.port}`)
})
