// Unified diffs as GET /api/attempts/:id/diff returns them (git-style sections, baseSha..headSha,
// brief file excluded). Rendered as a table of text nodes with a +/− sign column, never as HTML.

import { h, icon, plural, short } from "./dom.js"

export function parseDiff(text) {
  const files = []
  let file = null
  let inHunk = false
  let oldNo = 0
  let newNo = 0
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("diff --git ")) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      file = { path: m ? m[2] : line.slice(11), status: "modified", rows: [], add: 0, del: 0 }
      files.push(file)
      inHunk = false
      continue
    }
    if (!file) continue
    if (!inHunk) {
      if (line.startsWith("new file mode")) file.status = "added"
      else if (line.startsWith("deleted file mode")) file.status = "deleted"
      else if (line.startsWith("old mode") || line.startsWith("new mode")) file.rows.push({ t: "meta", text: line })
      else if (line.startsWith("Binary files")) file.rows.push({ t: "meta", text: "A binary file. Its contents are not shown." })
      else if (line.startsWith("(diff too large")) file.rows.push({ t: "meta", text: "Too large to show line by line." })
      if (!line.startsWith("@@")) continue
    }
    if (line.startsWith("@@")) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line)
      oldNo = m ? Number(m[1]) : 0
      newNo = m ? Number(m[2]) : 0
      inHunk = true
      file.rows.push({ t: "hunk", text: line })
      continue
    }
    if (line.startsWith("+")) {
      file.rows.push({ t: "add", o: "", n: newNo++, text: line.slice(1) })
      file.add++
    } else if (line.startsWith("-")) {
      file.rows.push({ t: "del", o: oldNo++, n: "", text: line.slice(1) })
      file.del++
    } else if (line.startsWith(" ")) {
      file.rows.push({ t: "ctx", o: oldNo++, n: newNo++, text: line.slice(1) })
    } else if (line.startsWith("\\")) {
      file.rows.push({ t: "meta", text: line.replace(/^\\\s*/, "") })
    }
  }
  return files
}

const LETTER = { added: "A", deleted: "D", modified: "M" }

/** The diff pane body. `unexpected` and `conflicts` are path sets that get flagged in file headers. */
export function renderDiff(result, { unexpected = new Set(), conflicts = new Set() } = {}) {
  const files = parseDiff(result.diff)
  const add = files.reduce((n, f) => n + f.add, 0)
  const del = files.reduce((n, f) => n + f.del, 0)
  const out = document.createDocumentFragment()
  out.append(
    h(
      "p",
      { class: "diff-meta" },
      h("span", null, "base ", short(result.base), " → head ", short(result.head)),
      h("span", null, plural(files.length, "file", "files")),
      h("span", null, h("span", { class: "file-add" }, `+${add}`), " ", h("span", { class: "file-del" }, `−${del}`)),
      h("span", null, "brief file not shown"),
    ),
  )
  if (result.truncated) {
    out.append(h("p", { class: "diff-note" }, "The diff is longer than 80,000 characters. Showing the start."))
  }
  if (!files.length) {
    out.append(h("p", { class: "diff-note" }, "No changes against the base, apart from the brief file."))
    return out
  }
  for (const f of files) {
    const body = h("tbody")
    for (const r of f.rows) {
      if (r.t === "hunk") {
        body.append(h("tr", { class: "hunk" }, h("td", { class: "ln" }), h("td", { class: "ln" }), h("td", { colspan: "2" }, r.text)))
      } else if (r.t === "meta") {
        body.append(h("tr", { class: "meta" }, h("td", { class: "ln" }), h("td", { class: "ln" }), h("td", { colspan: "2" }, r.text)))
      } else {
        const sign = r.t === "add" ? "+" : r.t === "del" ? "−" : " "
        body.append(
          h(
            "tr",
            { class: r.t },
            h("td", { class: "ln" }, String(r.o)),
            h("td", { class: "ln" }, String(r.n)),
            h("td", { class: "sign", "aria-label": r.t === "add" ? "added" : r.t === "del" ? "removed" : null }, sign),
            h("td", { class: "code-cell" }, r.text),
          ),
        )
      }
    }
    out.append(
      h(
        "section",
        { class: "diff-file", "aria-label": `Changes to ${f.path}` },
        h(
          "header",
          { class: "diff-file-head" },
          h("span", { class: "file-status", "data-s": f.status, title: f.status }, LETTER[f.status] ?? "M"),
          h("span", { class: "path" }, f.path),
          unexpected.has(f.path) ? h("span", { class: "diff-flag", "data-tone": "lamp" }, icon("flag"), "outside the brief") : null,
          conflicts.has(f.path) ? h("span", { class: "diff-flag", "data-tone": "buoy" }, icon("x"), "conflicts with main") : null,
          h("span", { class: "counts" }, h("span", { class: "file-add" }, `+${f.add}`), h("span", { class: "file-del" }, `−${f.del}`)),
        ),
        h("table", { class: "diff-table" }, h("caption", { class: "visually-hidden" }, `Changes to ${f.path}`), body),
      ),
    )
  }
  return out
}
