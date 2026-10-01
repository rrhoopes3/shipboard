// A process tree that resists being stopped. Usage: node stubborn.mjs <signal_log> <mode>
//   hard:      parent ignores SIGINT and SIGTERM; its child ignores both. Only SIGKILL works.
//   soft:      parent ignores SIGINT only; its child ignores both.
//   polite:    parent exits on SIGINT; no child.
//   straggler: parent starts a child that holds stdout open, then exits 0 at once.
import { spawn } from "node:child_process"
import fs from "node:fs"

const [log, mode = "hard"] = process.argv.slice(2)
const note = (line) => fs.appendFileSync(log, `${line}\n`)
const childCode = 'process.on("SIGINT",()=>{});process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'

if (mode === "polite") {
  process.on("SIGINT", () => {
    note("parent SIGINT")
    process.exit(130)
  })
  console.log(JSON.stringify({ parent: process.pid }))
  setInterval(() => {}, 1_000)
} else if (mode === "straggler") {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "inherit" })
  console.log(JSON.stringify({ parent: process.pid, child: child.pid }))
  process.exit(0)
} else {
  process.on("SIGINT", () => note("parent SIGINT"))
  if (mode === "hard") process.on("SIGTERM", () => note("parent SIGTERM"))
  const child = spawn(process.execPath, ["-e", childCode], { stdio: "ignore" })
  console.log(JSON.stringify({ parent: process.pid, child: child.pid }))
  setInterval(() => {}, 1_000)
}
