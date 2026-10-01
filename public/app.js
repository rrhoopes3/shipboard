const appEl = document.querySelector("#app")
let flash = null
let pending = false

function el(tag, attrs = {}, kids = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue
    if (key === "class") node.className = String(value)
    else if (key === "text") node.textContent = String(value)
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value)
    else if (value === true) node.setAttribute(key, "")
    else node.setAttribute(key, String(value))
  }
  for (const kid of kids) {
    if (kid == null) continue
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)))
  }
  return node
}

async function api(pathname, options = {}) {
  const headers = { ...(options.headers || {}) }
  if (options.body) headers["content-type"] = "application/json"
  const res = await fetch(pathname, { ...options, headers })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || "The board could not do that.")
  return data
}

function route() {
  if (location.pathname === "/") return { name: "home" }
  const match = location.pathname.match(/^\/p\/([a-z0-9-]+)$/)
  if (match) return { name: "board", id: match[1] }
  return { name: "missing" }
}

function go(href, nextFlash) {
  flash = nextFlash ?? null
  history.pushState({}, "", href)
  draw()
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-nav]")
  if (!link) return
  const href = link.getAttribute("href")
  if (!href || href.startsWith("http")) return
  event.preventDefault()
  go(href)
})

window.addEventListener("popstate", () => {
  flash = null
  draw()
})

function flashNode() {
  if (!flash) return null
  return el("p", { class: `flash ${flash.kind}`, role: "status", text: flash.text })
}

function splitList(value) {
  return value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean)
}

function when(iso) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ""
  return date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
}

function mount(nodes) {
  appEl.replaceChildren(el("main", { class: "wrap" }, nodes))
}

function renderHome(projects) {
  const demo = el("button", {
    class: "primary",
    type: "button",
    text: "Open the pier demo",
    onclick: () => openPier(demo),
  })
  const form = projectForm()
  const list = projects.length
    ? el("ul", { class: "projects" }, projects.map(projectRow))
    : el("p", { class: "empty", text: "No projects on the board." })
  const create = projects.length
    ? el("details", { class: "dispatch" }, [
        el("summary", { text: "Create a project" }),
        form,
      ])
    : el("div", { class: "panel" }, [el("p", { class: "section-label", text: "Create a project" }), form])

  mount([
    el("header", { class: "mast" }, [
      el("p", { class: "brand-static", text: "Shipboard" }),
      el("h1", { text: "Agents fork. Humans ship." }),
      el("p", {
        class: "lede",
        text: "Each agent gets a fork and a brief. You get one action: ship the change, or re-run the agent when it no longer merges.",
      }),
      flashNode(),
    ]),
    el("div", { class: "row-actions" }, [demo]),
    create,
    list,
    el("p", { class: "foot", text: "Trial-merge uses git on this machine. A conflict asks for a re-run, not a merge editor." }),
  ])
}

function projectRow(project) {
  const bits = []
  if (project.open) bits.push(`${project.open} open`)
  if (project.conflict) bits.push(`${project.conflict} conflict`)
  if (project.shipped) bits.push(`${project.shipped} shipped`)
  if (!bits.length) bits.push("No forks yet")
  return el("li", {}, [
    el("a", { class: "project-row", href: `/p/${project.id}`, "data-nav": "1" }, [
      el("span", {}, [
        el("strong", { text: project.name }),
        project.description ? el("p", { text: project.description }) : null,
      ]),
      el("span", { class: "meta", text: bits.join(" · ") }),
    ]),
  ])
}

function projectForm() {
  const name = el("input", { name: "name", required: true, maxlength: "60" })
  const description = el("input", { name: "description", maxlength: "280" })
  const form = el("form", { class: "form" }, [
    el("label", {}, [el("span", { class: "lbl", text: "Name" }), name]),
    el("label", {}, [el("span", { class: "lbl", text: "What this repo is" }), description]),
    el("button", { class: "secondary", type: "submit", text: "Create project" }),
  ])
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (pending) return
    if (!name.value.trim()) {
      flash = { kind: "bad", text: "Name the project." }
      draw()
      return
    }
    pending = true
    try {
      const result = await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: name.value.trim(), description: description.value.trim() }),
      })
      go(`/p/${result.project.id}`, { kind: "ok", text: "Project created. Dispatch a fork with a brief." })
    } catch (error) {
      flash = { kind: "bad", text: error.message }
      draw()
    } finally {
      pending = false
    }
  })
  return form
}

async function openPier(button) {
  if (pending) return
  pending = true
  button.disabled = true
  mount([el("p", { class: "loading", text: "Opening the pier. Three agents are pushing." })])
  try {
    const board = await api("/api/demo", { method: "POST" })
    pending = false
    go(`/p/${board.project.id}`, {
      kind: "ok",
      text: board.notice || "Three agents pushed.",
    })
  } catch (error) {
    pending = false
    flash = { kind: "bad", text: error.message }
    draw()
  }
}

function renderBoard(board, projects) {
  const forks = board.forks
  const open = forks.filter((fork) => ["ship", "ship-anyway", "rerun", "wait"].includes(fork.action))
  const parked = forks.filter((fork) => fork.action === "parked")
  const shipped = forks.filter((fork) => fork.action === "shipped")
  const earlier = forks.filter((fork) => fork.action === "superseded")
  const column = [
    el("header", { class: "mast" }, [
      el("a", { class: "brand", href: "/", "data-nav": "1", text: "Shipboard" }),
      el("h1", { text: board.project.name }),
      el("p", { class: "tagline", text: board.project.description || "Open forks, one action each." }),
      flashNode(),
    ]),
    dispatchForm(board.project.id),
    el("p", { class: "section-label", text: "Open" }),
    open.length ? el("div", { class: "cards" }, open.map((fork) => forkCard(fork, board.project.id))) : el("p", { class: "empty", text: "No open forks. Dispatch one with a task, the paths it may touch, and an acceptance check." }),
  ]
  if (parked.length) {
    column.push(el("p", { class: "section-label", text: "Parked" }), el("div", { class: "cards" }, parked.map((fork) => forkCard(fork, board.project.id))))
  }
  if (shipped.length) {
    column.push(el("p", { class: "section-label", text: "Shipped" }), el("div", { class: "cards" }, shipped.map((fork) => forkCard(fork, board.project.id))))
  }
  if (earlier.length) {
    column.push(el("details", { class: "earlier" }, [
      el("summary", { text: "Earlier runs" }),
      el("div", { class: "cards" }, earlier.map((fork) => forkCard(fork, board.project.id))),
    ]))
  }

  mount([
    el("div", { class: "shell" }, [
      rail(board, projects || []),
      el("div", {}, column),
    ]),
  ])
}

function rail(board, projects) {
  return el("aside", { class: "rail" }, [
    el("p", { class: "sha", text: `main ${board.project.mainShort}` }),
    el("a", { class: "quiet", href: board.project.previewUrl, target: "_blank", rel: "noreferrer", text: "Main preview" }),
    el("p", { class: "meta", text: `${board.counts.open} open · ${board.counts.conflict} conflict · ${board.counts.shipped} shipped` }),
    el("a", { class: "rail-link", href: "/", "data-nav": "1", text: "All projects" }),
    ...projects.map((project) =>
      el("a", {
        class: `rail-link${project.id === board.project.id ? " current" : ""}`,
        href: `/p/${project.id}`,
        "data-nav": "1",
        text: project.name,
      }),
    ),
  ])
}

function dispatchForm(projectId) {
  const task = el("textarea", { required: true, maxlength: "240", rows: "2" })
  const constraints = el("textarea", { rows: "3", placeholder: "One constraint per line" })
  const acceptance = el("textarea", {
    class: "mono-field",
    rows: "3",
    placeholder: 'contains site/index.html "expected text"',
  })
  const paths = el("textarea", { class: "mono-field", rows: "2", text: "" })
  paths.value = "site/index.html"
  const agentNames = { cursor: "Cursor", claude: "Claude", codex: "Codex", grok: "Grok" }
  const agent = el("select", {}, Object.entries(agentNames).map(([name, label]) => el("option", { value: name, text: label })))
  const form = el("form", { class: "form" }, [
    el("label", {}, [el("span", { class: "lbl", text: "Task" }), task]),
    el("label", {}, [el("span", { class: "lbl", text: "Constraints" }), constraints]),
    el("label", {}, [
      el("span", { class: "lbl", text: "Acceptance check" }),
      acceptance,
      el("p", { class: "hint", text: 'One check per line: contains site/index.html "expected text". Other text is left for you to read.' }),
    ]),
    el("label", {}, [el("span", { class: "lbl", text: "Paths the agent may touch" }), paths]),
    el("label", {}, [el("span", { class: "lbl", text: "Agent" }), agent]),
    el("button", { class: "primary", type: "submit", text: "Dispatch fork" }),
  ])
  const details = el("details", { class: "dispatch" }, [el("summary", { text: "Dispatch a fork" }), form])
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (pending) return
    if (!task.value.trim()) {
      flash = { kind: "bad", text: "Write the task." }
      draw()
      return
    }
    if (splitList(paths.value).length === 0) {
      flash = { kind: "bad", text: "Name at least one path the agent may touch." }
      draw()
      return
    }
    pending = true
    try {
      const board = await api(`/api/projects/${projectId}/forks`, {
        method: "POST",
        body: JSON.stringify({
          task: task.value.trim(),
          constraints: splitList(constraints.value),
          acceptance: acceptance.value.trim(),
          paths: splitList(paths.value),
          agent: agent.value,
        }),
      })
      flash = { kind: "ok", text: board.notice || "Fork dispatched." }
      const projects = await api("/api/projects")
      renderBoard(board, projects)
    } catch (error) {
      flash = { kind: "bad", text: error.message }
      draw()
    } finally {
      pending = false
    }
  })
  return details
}

function stampFor(fork) {
  if (fork.action === "rerun") return ["CONFLICT", "conflict", "Conflicts with main"]
  if (fork.action === "wait") return ["WAITING", "wait", "Waiting for a push"]
  if (fork.action === "parked") return ["PARKED", "parked", "Parked"]
  if (fork.action === "shipped") return ["SHIPPED", "shipped", "Shipped onto main"]
  if (fork.action === "superseded") return ["RERAN", "reran", "Re-ran onto a new fork"]
  if (fork.action === "ship-anyway") return ["CLEAN", "clean", "Merges cleanly. Acceptance checks did not pass."]
  return ["CLEAN", "clean", "Merges cleanly into main"]
}

function forkCard(fork, projectId) {
  const [word, kind, label] = stampFor(fork)
  const kids = [
    el("div", { class: "card-top" }, [
      el("p", { class: "meta", text: `${fork.agentLabel} · ${fork.id} · ${fork.head}` }),
      el("div", { class: `stamp ${kind}`, role: "img", "aria-label": label, text: word }),
    ]),
    el("h2", { text: fork.task }),
  ]
  if (fork.acceptance) kids.push(el("p", { class: "acceptance", text: fork.acceptance }))
  if (fork.constraints.length) {
    kids.push(el("ul", { class: "constraints" }, fork.constraints.map((item) => el("li", { text: item }))))
  }
  if (fork.digest.reasons.length) {
    kids.push(el("ul", { class: "reasons" }, fork.digest.reasons.map((item) => el("li", { text: item }))))
  }
  if (fork.digest.files.length) {
    kids.push(el("div", { class: "chips" }, fork.digest.files.map((file) => {
      const chip = el("span", { class: "chip" })
      chip.append(el("span", { text: file.path }))
      chip.append(el("span", { class: "add", text: ` +${file.additions}` }))
      chip.append(el("span", { class: "del", text: ` −${file.deletions}` }))
      return chip
    })))
  }
  if (fork.merge.state === "conflict") {
    const where = fork.merge.paths.length ? fork.merge.paths.join(", ") : "an unknown path"
    kids.push(el("p", { class: "conflict-line", text: `Conflicts with main in ${where}.` }))
  }
  const actions = []
  if (fork.previewUrl) {
    actions.push(el("a", { class: "quiet", href: fork.previewUrl, target: "_blank", rel: "noreferrer", text: "Open preview" }))
    const preview = el("button", { class: "quiet", type: "button", text: "Show preview" })
    preview.addEventListener("click", () => togglePreview(preview, fork.previewUrl))
    actions.push(preview)
  }
  const diffButton = el("button", { class: "quiet", type: "button", text: "Read the diff" })
  diffButton.addEventListener("click", () => toggleDiff(diffButton, fork.id))
  actions.push(diffButton)
  if (fork.action === "ship" || fork.action === "ship-anyway" || fork.action === "rerun" || fork.action === "wait") {
    const park = el("button", { class: "quiet", type: "button", text: "Park" })
    park.addEventListener("click", () => mutate(park, `/api/forks/${fork.id}/park`))
    actions.push(park)
  }
  kids.push(el("div", { class: "actions" }, actions))
  const primary = primaryButton(fork)
  if (primary) kids.push(el("div", { class: "primary-row" }, [primary]))
  if (fork.action === "wait" || fork.action === "ship" || fork.action === "ship-anyway" || fork.action === "rerun") {
    kids.push(pushForm(fork, projectId))
  }
  kids.push(el("p", { class: "meta", text: when(fork.createdAt) }))
  return el("article", { class: "card" }, kids)
}

function primaryButton(fork) {
  if (fork.action === "ship") return actionButton("Ship", `/api/forks/${fork.id}/ship`)
  if (fork.action === "ship-anyway") return actionButton("Ship anyway", `/api/forks/${fork.id}/ship`)
  if (fork.action === "rerun") return actionButton("Re-run agent", `/api/forks/${fork.id}/rerun`)
  if (fork.action === "parked") return actionButton("Return to board", `/api/forks/${fork.id}/return`)
  return null
}

function actionButton(label, pathname) {
  const button = el("button", { class: "primary", type: "button", text: label })
  button.addEventListener("click", () => mutate(button, pathname))
  return button
}

async function mutate(button, pathname) {
  if (pending) return
  pending = true
  button.disabled = true
  try {
    const board = await api(pathname, { method: "POST" })
    flash = { kind: "ok", text: board.notice || "Done." }
    const projects = await api("/api/projects")
    renderBoard(board, projects)
  } catch (error) {
    flash = { kind: "bad", text: error.message }
    draw()
  } finally {
    pending = false
  }
}

function pushForm(fork) {
  const filePath = el("input", { class: "mono-field", value: fork.paths[0] || "site/index.html" })
  const content = el("textarea", { class: "mono-field", rows: "6", placeholder: "File contents" })
  const message = el("input", { placeholder: "Commit message" })
  const form = el("form", { class: "form" }, [
    el("label", {}, [el("span", { class: "lbl", text: "Path" }), filePath]),
    el("label", {}, [el("span", { class: "lbl", text: "Contents" }), content]),
    el("label", {}, [el("span", { class: "lbl", text: "Message" }), message]),
    el("button", { class: "secondary", type: "submit", text: "Push files" }),
  ])
  form.addEventListener("submit", async (event) => {
    event.preventDefault()
    if (pending) return
    pending = true
    try {
      const board = await api(`/api/forks/${fork.id}/push`, {
        method: "POST",
        body: JSON.stringify({
          message: message.value.trim(),
          files: [{ path: filePath.value.trim(), content: content.value }],
        }),
      })
      flash = { kind: "ok", text: board.notice || "Pushed." }
      const projects = await api("/api/projects")
      renderBoard(board, projects)
    } catch (error) {
      flash = { kind: "bad", text: error.message }
      draw()
    } finally {
      pending = false
    }
  })
  return el("details", { class: "push", open: fork.action === "wait" }, [
    el("summary", { text: "Push files" }),
    form,
  ])
}

function togglePreview(button, url) {
  const card = button.closest("article")
  const existing = card.querySelector(".preview-frame")
  if (existing) {
    existing.remove()
    button.textContent = "Show preview"
    return
  }
  if (!url.startsWith("/preview/")) return
  const frame = el("iframe", {
    class: "preview-frame",
    sandbox: "",
    title: "Fork preview",
    src: url,
  })
  card.append(frame)
  button.textContent = "Hide preview"
}

async function toggleDiff(button, forkId) {
  const card = button.closest("article")
  const existing = card.querySelector(".diff")
  if (existing) {
    existing.remove()
    button.textContent = "Read the diff"
    return
  }
  button.disabled = true
  try {
    const data = await api(`/api/forks/${forkId}/diff`)
    const pre = el("pre", { class: "diff" })
    const text = data.diff || "No diff against main."
    for (const line of text.split("\n")) {
      const span = el("span", { text: `${line}\n` })
      if (line.startsWith("+") && !line.startsWith("+++")) span.className = "add"
      else if (line.startsWith("-") && !line.startsWith("---")) span.className = "del"
      else if (line.startsWith("@@")) span.className = "hunk"
      pre.append(span)
    }
    if (data.truncated) pre.append(el("span", { text: "\nDiff truncated.\n" }))
    card.append(pre)
    button.textContent = "Hide the diff"
  } catch (error) {
    flash = { kind: "bad", text: error.message }
    draw()
  } finally {
    button.disabled = false
  }
}

function renderMissing() {
  mount([
    el("header", { class: "mast" }, [
      el("a", { class: "brand", href: "/", "data-nav": "1", text: "Shipboard" }),
      el("h1", { text: "That page is not on the board." }),
      el("p", { class: "lede" }, [
        "Go back to ",
        el("a", { href: "/", "data-nav": "1", text: "projects" }),
        ".",
      ]),
    ]),
  ])
}

function renderLoadError(error) {
  mount([
    el("header", { class: "mast" }, [
      el("p", { class: "brand-static", text: "Shipboard" }),
      el("h1", { text: "The board could not be loaded." }),
      el("p", { class: "flash bad", role: "alert", text: error.message }),
      el("button", { class: "secondary", type: "button", text: "Try again", onclick: () => draw() }),
    ]),
  ])
}

async function draw() {
  const here = route()
  mount([el("p", { class: "loading", text: "Loading the board…" })])
  try {
    if (here.name === "home") {
      renderHome(await api("/api/projects"))
      return
    }
    if (here.name === "board") {
      const [board, projects] = await Promise.all([
        api(`/api/projects/${here.id}`),
        api("/api/projects"),
      ])
      renderBoard(board, projects)
      return
    }
    renderMissing()
  } catch (error) {
    if (here.name === "board" && /no project/i.test(error.message)) {
      mount([
        el("header", { class: "mast" }, [
          el("a", { class: "brand", href: "/", "data-nav": "1", text: "Shipboard" }),
          el("h1", { text: "No project with that id." }),
          el("p", { class: "lede" }, [
            el("a", { href: "/", "data-nav": "1", text: "Back to projects" }),
          ]),
        ]),
      ])
      return
    }
    renderLoadError(error)
  }
}

draw()
