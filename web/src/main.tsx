// Entry: apply the theme before the first paint, then render the app.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { applyTheme, getTheme } from "./lib/theme.ts"
import "./styles/tokens.css"
import "./styles/fonts.css"
import "./styles/base.css"

applyTheme(getTheme())

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
