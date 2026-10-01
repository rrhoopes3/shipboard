// A classic, blocking <head> script so a chosen theme applies before first paint. The board CSP has
// no 'unsafe-inline', so this cannot be inline. With no choice stored, CSS follows the OS.
;(() => {
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
