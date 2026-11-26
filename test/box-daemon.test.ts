import { expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const daemon = readFileSync(join(import.meta.dir, "..", "daemon.ts"), "utf8")
const between = (from: string, to: string) => daemon.slice(daemon.indexOf(from), daemon.indexOf(to, daemon.indexOf(from)))
const rent = between("const rentBox = async", "const handleBoxApi = async")
const api = between("const handleBoxApi = async", "// Alarms (alarms.ts)")

it("only a site's running server rents, and all three gates are checked first", () => {
  expect(api).toMatch(/if \(grant\.kind !== 'srv'\) return Response\.json\(\{ error:/)
  expect(rent.indexOf("boxBlocker(grant.name, config)")).toBeLessThan(rent.indexOf("parseBoxRequest("))
  const blocker = between("const boxBlocker = ", "const rentBox = async")
  expect(blocker).toContain("manifestNow(name)?.boxes")          // the site asks (candy.json)
  expect(blocker).toContain("validateBoxQuota(config.boxes)")    // the operator allows
  expect(blocker).toContain("SANDBOX_AVAILABLE")
  expect(blocker).toContain("managed?.unit")                      // there is a unit to bind to
})

it("the quota counts rents under way, so two at once can't both take the last box", () => {
  expect(rent).toMatch(/boxes\.held\(grant\.name\) \+ \(boxRenting\.get\(grant\.name\) \?\? 0\)/)
  expect(rent).toMatch(/if \(busy >= quota\.max\) return refuse\(/)
  expect(rent).toContain("finally {")
})

it("every grant is checked on the file it holds open, as the site's user, and the box is told which file that was", () => {
  expect(rent).toMatch(/fd = openSync\(g\.path, O_PATH\)/)
  expect(rent).toMatch(/const source = readlinkSync\(`\/proc\/self\/fd\/\$\{fd\}`\)/)
  expect(rent).toMatch(/boxPathProblem\(source, .*\) \?\? grantProblem\(source, g\.mode, \{ writable, privateTmp: true, secret: CLI_SECRET_PATHS \}, userCanReach\(source, account\.uid, gids\)\)/)
  expect(rent).toMatch(/grants\.push\(\{ path: g\.path, mode: g\.mode, source, check: `\$\{st\.dev\}:\$\{st\.ino\}` \}\)/)
  // held until the box is gone, released when a rent fails
  expect(rent).toContain("if (started) unpinBox(started)")
  expect(daemon).toContain("unpinBox(box.id)")
  expect(rent).toContain("account.uid === 0")
})

it("the site's environment is a root-only file, never systemd-run's own environment", () => {
  expect(rent).toMatch(/writeFile\(boxEnvPath\(box\), boxEnvFile\(\{[\s\S]*?\.\.\.request\.env,\s*\}\), \{ mode: 0o600, flag: 'wx' \}\)/)
  const start = rent.slice(rent.indexOf("boxes.start({"), rent.indexOf("} catch (e)"))
  expect(start).not.toContain("request.env")
  expect(start).not.toContain("process.env,")
  expect(rent).toMatch(/mkdir\(BOX_ENV_DIR, \{ recursive: true, mode: 0o700 \}\)/)
})

it("a site's boxes are stopped when its server ends, and all of them when candy stops", () => {
  expect(daemon).toMatch(/proc\.exited\.then\(\(exitCode\) => \{\n    resetJtiBloom\(name\)\n[^\n]*\n    boxes\.stopSite\(name, 'site-stopped'\)/)
  expect(daemon).toContain("boxes.stopAll('stopped')")
})

it("the audit line for a rent never has the environment or arguments", () => {
  expect(rent).toMatch(/auditLog\('BOX_RENT', `.*\$\{boxAuditLine\(request\)\}`, 'System'\)/)
  expect(rent.match(/auditLog\([^\n]*/g)!.join("\n")).not.toMatch(/request\.env|request\.cmd/)
})

it("a site's user can reach its socket folder: the folder above is passable, its own is group-readable", () => {
  expect(rent).toMatch(/mkdir\(BOX_RUN_DIR, \{ recursive: true, mode: 0o711 \}\)\n\s*await chmod\(BOX_RUN_DIR, 0o711\)/)
  expect(rent).toMatch(/await chown\(dir, 0, account\.gid\)\n\s*await chmod\(dir, 0o750\)/)
})
