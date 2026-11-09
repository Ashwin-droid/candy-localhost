import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { userInfo } from "node:os"
import { readSecrets, secretFileCandidates, SHARED_SECRET_FILE } from "../secret.ts"

const saved = { HOME: process.env.HOME, CANDY_SECRET_FILE: process.env.CANDY_SECRET_FILE }
afterEach(() => {
  process.env.HOME = saved.HOME
  if (saved.CANDY_SECRET_FILE === undefined) delete process.env.CANDY_SECRET_FILE
  else process.env.CANDY_SECRET_FILE = saved.CANDY_SECRET_FILE
})

describe("secret lookup", () => {
  it("checks the override, the user's own secrets, then the shared one", () => {
    process.env.HOME = "/home/someone"
    process.env.CANDY_SECRET_FILE = "/tmp/override"
    expect(secretFileCandidates()).toEqual([
      "/tmp/override",
      "/home/someone/.config/candy/mcp-secret",
      `/run/candy/users/${userInfo().username}/secret`,
      SHARED_SECRET_FILE,
    ])
  })

  it("skips unreadable files and de-duplicates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "candy-secret-"))
    const file = join(dir, "s")
    writeFileSync(file, "abc\n")
    process.env.HOME = join(dir, "nohome")
    process.env.CANDY_SECRET_FILE = file
    const secrets = await readSecrets()
    expect(secrets[0]).toBe("abc")
    expect(secrets.filter(s => s === "abc").length).toBe(1)
  })
})
