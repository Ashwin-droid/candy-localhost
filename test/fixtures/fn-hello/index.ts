// Sample function: a tiny Hono-shaped app (an object with .fetch) and a switch router.
// No hono dependency, but `export default app` works the same way a Hono app does.
type Env = { GREETING?: string; SECRET?: string }
type Ctx = { waitUntil(p: Promise<unknown>): void }

const enc = new TextEncoder()

class App {
  hits = 0
  // Class method, so the shim must call it bound to the app (as Hono needs).
  async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    this.hits++
    const url = new URL(req.url)
    switch (`${req.method} ${url.pathname}`) {
      case "GET /":
        return new Response(`${env.GREETING ?? "hello"}\n`, { headers: { "content-type": "text/plain; charset=utf-8" } })
      case "GET /json":
        return Response.json({ path: url.pathname, query: Object.fromEntries(url.searchParams), hits: this.hits, ip: req.headers.get("cf-connecting-ip") })
      case "GET /secret":
        return new Response(env.SECRET ? "set" : "unset")
      case "POST /echo":
        // Streams the request body straight back.
        return new Response(req.body, { headers: { "content-type": req.headers.get("content-type") ?? "application/octet-stream" } })
      case "GET /stream": {
        let n = 0
        const body = new ReadableStream<Uint8Array>({
          async pull(c) {
            if (n === 3) return c.close()
            c.enqueue(enc.encode(`data: tick ${n++}\n\n`))
            await Bun.sleep(10)
          },
        })
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      }
      case "GET /big":
        // Bigger than one frame payload, so the shim has to split it.
        return new Response(new Uint8Array(3 * 1024 * 1024).fill(97))
      case "GET /cookies": {
        const h = new Headers()
        h.append("set-cookie", "a=1; Path=/")
        h.append("set-cookie", "b=2; Path=/")
        return new Response("ok", { headers: h })
      }
      case "GET /log":
        console.log("hello from /log")
        console.warn("careful")
        return new Response("logged")
      case "GET /wait":
        ctx.waitUntil(Bun.sleep(200).then(() => console.log("waitUntil done")))
        return new Response("waiting")
      case "GET /hang":
        // Never finishes on its own; resolves when the client goes away.
        return new Promise(resolve => req.signal.addEventListener("abort", () => resolve(new Response("aborted"))))
      case "GET /throw":
        throw new Error("boom")
      default:
        return new Response("not found\n", { status: 404 })
    }
  }
}

const app = new App()
export default app
