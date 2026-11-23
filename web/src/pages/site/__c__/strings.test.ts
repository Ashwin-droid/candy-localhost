// Copy parity for package C (SPEC §9.1): the §5.12 confirms and the old strings (01 §11, §13) the Logs,
// Requests, Deployments and Data tabs show. Each must appear verbatim in the named files.

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const DIR = join(import.meta.dir, "..")
const read = (f: string) => readFileSync(join(DIR, f), "utf8")

const STRINGS: [string, string[]][] = [
  // §5.12 confirms
  ["Roll ${name} back to ${id}?", ["DeploymentsTab.tsx"]],
  ["Requests go to that snapshot right away.", ["DeploymentsTab.tsx"]],
  ["Unpin ${name} and serve the live source folder again?", ["DeploymentsTab.tsx"]],
  [`verb: "Back to dev"`, ["DeploymentsTab.tsx"]],
  [`verb: "Roll back"`, ["DeploymentsTab.tsx"]],
  ["Replay with a cut-off body?", ["RequestDetail.tsx"]],
  ["This request's body was cut off when it was logged. Replay it with the part that was kept?", ["RequestDetail.tsx"]],
  [`verb: "Replay"`, ["RequestDetail.tsx"]],
  ["Delete ${key} from ${b}?", ["DataTab.tsx"]],
  // Logs (§5.7)
  ["Reconnected. Showing the log from the start.", ["LogViewer.tsx"]],
  ["Older lines were dropped from this view.", ["LogViewer.tsx"]],
  ["Keys go to the process. Press Esc to stop.", ["LogViewer.tsx"]],
  ["Search the whole file", ["LogViewer.tsx"]],
  ["Jump to latest", ["LogViewer.tsx"]],
  ["Send a line to the process", ["LogViewer.tsx"]],
  ["Clear view", ["LogViewer.tsx"]],
  ["Raw keys", ["LogViewer.tsx"]],
  ["Follow", ["LogViewer.tsx"]],
  ["${name}.log", ["LogViewer.tsx"]],
  ["isn’t running, so there’s no log yet.", ["LogsTab.tsx"]],
  // Requests (§5.8, 01 §13.2)
  ["New requests appear as they finish", ["RequestsTab.tsx"]],
  [`"Live"`, ["RequestsTab.tsx"]],
  [`"Connecting…"`, ["RequestsTab.tsx"]],
  [`"Paused"`, ["RequestsTab.tsx"]],
  ["No requests match.", ["RequestsTab.tsx"]],
  ["No requests in the last 24 hours. Open the site and they show up here as they finish.", ["RequestsTab.tsx"]],
  ["Couldn’t load requests: ", ["RequestsTab.tsx"]],
  ["new request", ["RequestsTab.tsx"]],
  ["From candy’s access log. Bodies and timings are recorded for functions only.", ["RequestsTab.tsx"]],
  ["No requests yet.", ["RequestsTab.tsx"]],
  ["Pick a request to see its headers, bodies, logs and timings.", ["RequestsTab.tsx"]],
  ["Couldn’t load this request: ", ["RequestDetail.tsx"]],
  ["Send this request again to the code running now", ["RequestDetail.tsx"]],
  ["the daemon, from the asset folder (no process)", ["RequestDetail.tsx"]],
  [`"the code"`, ["RequestDetail.tsx"]],
  ["cold (new instance)", ["RequestDetail.tsx"]],
  ["Nothing logged during this request.", ["RequestDetail.tsx"]],
  ["(truncated)", ["RequestDetail.tsx"]],
  ["Replayed: ${res.status}", ["RequestDetail.tsx"]],
  ["Replay result ${result.status} · logged as ${result.requestId}", ["RequestDetail.tsx"]],
  ["Replay failed: ${msg}", ["RequestDetail.tsx"]],
  ["Empty body", ["RequestDetail.tsx"]],
  ["Back to requests", ["RequestDetail.tsx"]],
  ["Binary body, stored as size and hash only.", ["lib/requests.ts"]],
  ["truncated at 64 KB", ["lib/requests.ts"]],
  [`"Empty"`, ["lib/requests.ts"]],
  [", cold", ["lib/requests.ts"]],
  // Deployments (§5.9, 01 §13.1)
  ["dev, live from the source folder", ["DeploymentsTab.tsx"]],
  ["No deploys yet. Deploy bundles the current code into a snapshot that doesn’t change when you edit the source. The last 10 are kept for rollback.", ["DeploymentsTab.tsx"]],
  ["Couldn’t load deploys: ", ["DeploymentsTab.tsx"]],
  ["${name} is running ${id}", ["DeploymentsTab.tsx"]],
  ["Rollback failed: ", ["DeploymentsTab.tsx"]],
  ["${name} is back on the live source", ["DeploymentsTab.tsx"]],
  ["Couldn’t switch to dev: ", ["DeploymentsTab.tsx"]],
  ["Deploying ${name}…", ["DeploymentsTab.tsx"]],
  ["${name} deployed ", ["DeploymentsTab.tsx"]],
  ["Deploy failed: ", ["DeploymentsTab.tsx"]],
  ["Deploying…", ["DeploymentsTab.tsx"]],
  ["no code", ["DeploymentsTab.tsx"]],
  ["Current", ["DeploymentsTab.tsx"]],
  // Data (§5.10, 01 §13.3)
  ["Keys starting with", ["DataTab.tsx"]],
  ["There are more keys.", ["DataTab.tsx"]],
  ["Load more", ["DataTab.tsx"]],
  ["No keys in ${s.binding}${s.prefix ? ` starting with ${s.prefix}` : \"\"}.", ["DataTab.tsx"]],
  ["Not found. It may have expired.", ["DataTab.tsx"]],
  ["Couldn’t read ${k.name}: ", ["DataTab.tsx"]],
  ["Couldn’t list keys: ", ["DataTab.tsx"]],
  ["Saved ${a.key} in ${a.binding}", ["DataTab.tsx"]],
  ["Deleted ${a.key}", ["DataTab.tsx"]],
  ["Save key", ["DataTab.tsx"]],
  ["Enter a key", ["DataTab.tsx"]],
  ["Couldn’t save: ", ["DataTab.tsx"]],
  ["Couldn’t delete: ", ["DataTab.tsx"]],
  ["SELECT * FROM sqlite_master", ["DataTab.tsx"]],
  ["Values for ?", ["DataTab.tsx"]],
  [`Values for ? go in a list, like [1, "a"]`, ["DataTab.tsx"]],
  ["Running…", ["DataTab.tsx"]],
  ["Runs on the function's own database, right away. Changes can't be undone.", ["DataTab.tsx"]],
  ["Only the first rows are shown", ["DataTab.tsx"]],
  ["No rows.", ["DataTab.tsx"]],
  ["Enter some SQL", ["DataTab.tsx"]],
  [`"NULL"`, ["DataTab.tsx"]],
]

for (const [s, files] of STRINGS) {
  test(`"${s}"`, () => {
    for (const f of files) expect(read(f)).toContain(s)
  })
}
