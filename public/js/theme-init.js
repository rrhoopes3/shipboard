// A classic, blocking <head> script. Two jobs, both before first paint, because the board CSP has
// no 'unsafe-inline' and a module would run too late:
// 1. #unlock=<token> is stored and stripped before the address bar can sit on it. The fragment is
//    never a request. test/ui/unlock-hash.test.js loads this file.
// 2. A chosen theme applies before paint. With no choice stored, CSS follows the OS.
;(() => {
  const match = /^#unlock=([\s\S]*)$/.exec(location.hash || "")
  if (match) {
    let value = match[1]
    try {
      value = decodeURIComponent(value)
    } catch {
      // Keep the raw fragment when it is not valid percent-encoding.
    }
    value = value.trim()
    let stored = false
    if (value && value.length <= 512 && !/[\r\n]/.test(value)) {
      try {
        localStorage.setItem("shipboard.boardToken", value)
        stored = true
      } catch {
        // Leave the fragment in place when storage is blocked, so a reload can try again.
      }
      if (stored) {
        try {
          sessionStorage.setItem("shipboard.justUnlocked", "1")
        } catch {
          // The token is stored. Missing the toast is harmless.
        }
      }
    }
    if (stored || !value) {
      try {
        history.replaceState(null, "", `${location.pathname || "/"}${location.search || ""}`)
      } catch {
        // The token is already stored. A stuck fragment is ugly, not a second copy of the secret on the server.
      }
    }
  }

  let theme = null
  try {
    theme = localStorage.getItem("shipboard.theme")
  } catch {
    theme = null
  }
  const asked = new URLSearchParams(location.search).get("theme")
  if (asked === "light" || asked === "dark") theme = asked
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme
})()
