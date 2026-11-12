// Answers /api/*; anything else that reaches the worker is handed to the ASSETS binding.
interface Env { ASSETS: { fetch(req: Request | string): Promise<Response> } }

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url)
    if (url.pathname.startsWith("/api/")) return Response.json({ ok: true, path: url.pathname, method: req.method })
    return env.ASSETS.fetch(req)
  },
}
