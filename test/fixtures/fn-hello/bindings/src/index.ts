// Sample function using KV, D1 and a cron trigger.
type KV = { get(k: string): Promise<string | null>; put(k: string, v: string): Promise<void> }
type D1 = { exec(sql: string): Promise<unknown>; prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown>; first<T>(): Promise<T | null> } } }
type Env = { KV: KV; DB: D1; GREETING: string }

const init = (env: Env) => env.DB.exec("CREATE TABLE IF NOT EXISTS ticks (id INTEGER PRIMARY KEY, cron TEXT, at INTEGER)")

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url)
    if (url.pathname === "/count") {
      const n = Number((await env.KV.get("count")) ?? "0") + 1
      await env.KV.put("count", String(n))
      return Response.json({ count: n, greeting: env.GREETING })
    }
    if (url.pathname === "/ticks") {
      await init(env)
      const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM ticks").bind().first<{ n: number }>()
      return Response.json({ ticks: row?.n ?? 0 })
    }
    return new Response("not found", { status: 404 })
  },

  async scheduled(event: { cron: string; scheduledTime: number }, env: Env) {
    await init(env)
    await env.DB.prepare("INSERT INTO ticks (cron, at) VALUES (?, ?)").bind(event.cron, event.scheduledTime).run()
    if (event.cron === "fail") throw new Error("scheduled failure")
  },
}
