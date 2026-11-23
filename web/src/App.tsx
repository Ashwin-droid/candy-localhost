// SessionProvider > BrowserRouter > AppFrame > the page for the current path.
import * as React from "react"
import { Component, lazy, Suspense, useMemo } from "react"
import { BrowserRouter, matchRoute, useRoute } from "./router.tsx"
import { guardedLoad, loadNotFound, ROUTES, UPDATED_MESSAGE } from "./routes.tsx"
import { SessionProvider } from "./session.tsx"
import { AppFrame, Button, Skeleton } from "./ui/index.ts"

type Page = React.LazyExoticComponent<React.ComponentType>
const pages = new Map<unknown, Page>()

/** One lazy component per loader; routes.tsx shares one loader per module, so "/" and "/sites", or a site's tabs, never remount the page. */
function pageFor(load: () => Promise<{ default: React.ComponentType }>): Page {
  let p = pages.get(load)
  if (!p) {
    p = lazy(guardedLoad(load, () => location.pathname))
    pages.set(load, p)
  }
  return p
}

export function App(): React.JSX.Element {
  return (
    <SessionProvider>
      <BrowserRouter>
        <AppFrame>
          <Outlet />
        </AppFrame>
      </BrowserRouter>
    </SessionProvider>
  )
}

function Outlet(): React.JSX.Element {
  const route = useRoute()
  const Page = useMemo(() => {
    const m = matchRoute(route.path)
    return pageFor(m ? ROUTES[m.index].load : loadNotFound)
  }, [route.path])
  return (
    <ChunkBoundary path={route.path}>
      <Suspense fallback={<div className="page-loading"><Skeleton rows={4} /></div>}>
        <Page />
      </Suspense>
    </ChunkBoundary>
  )
}

/** Catches a page that can't load or crashes while rendering, so the frame stays usable. */
class ChunkBoundary extends Component<{ path: string; children: React.ReactNode }, { error: Error | null; path: string }> {
  state = { error: null as Error | null, path: this.props.path }
  static getDerivedStateFromError(error: Error) { return { error } }
  static getDerivedStateFromProps(props: { path: string }, state: { error: Error | null; path: string }) {
    return props.path !== state.path ? { error: null, path: props.path } : null
  }
  render() {
    const e = this.state.error
    if (!e) return this.props.children
    const updated = e.name === "ChunkError"
    return (
      <div className="page-crash" role="alert">
        <p className="page-crash-title">{updated ? UPDATED_MESSAGE : "This page hit a problem."}</p>
        {!updated ? <p className="page-crash-detail">{e.message}</p> : null}
        <Button variant="primary" onClick={() => location.reload()}>Reload the page</Button>
      </div>
    )
  }
}
