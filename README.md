# candy-localhost

We hand out domains like it's 1980.

```
App: "hey can I get a domain?"
candy-localhost: "sure bestie, you're vite.localhost now"
```

(no iana was harmed in making of this app)

## Install

```bash
bun install
```

## Run

```bash
bun run start
```

Starts proxy on `:80` and control API on `:9999`.

## Usage

**Register a route:**
```bash
curl -X POST localhost:9999/register \
  -H "Content-Type: application/json" \
  -d '{"name":"vite","port":5173}'
```

Now `http://vite.localhost` proxies to `localhost:5173`.

**List routes:**
```bash
curl localhost:9999/routes
```

**Remove a route:**
```bash
curl -X DELETE localhost:9999/register/vite
```

## Requirements

- Bun
- Port 80 available (might need sudo on Linux/Mac)
- Modern browser (auto-resolves `*.localhost` to `127.0.0.1`)

## Why

Because typing `localhost:5173` is boring and `vite.localhost` is fun.

## License

WTFPL
