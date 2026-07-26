# Dev server with automatic rebuild and browser reload

Date: 2026-07-26
Status: implemented, pending user verification
Branch: `feat/dev-server` (off `main`)

## Problem

There is no single command that serves the emulator and picks up source changes.
`npm run watch` rebuilds into `dist/`, but nothing serves `dist/` and nothing tells
the browser that anything changed. Every iteration is: edit, wait, switch to the
browser, hit reload manually, and hope the build actually finished first.

## Goal

`npm run dev` starts a server and keeps the browser in sync with the source tree.
Saving any file that feeds the build results in a rebuild followed by an automatic
page reload.

**Hard constraint: the production build must not change.** This is a fork tracking
upstream, so `npm run build` and `npm run build:release` have to keep emitting exactly
what they emitted before. Verified by hash, see Verification.

## Non-goal: state-preserving hot module replacement

Next.js-style Fast Refresh keeps component state alive across an edit. That is not
achievable here without a substantial refactor, and it is explicitly out of scope.

Three properties of this codebase are why:

1. **Emulator state lives in a Web Worker.** `runtime/jsspeccy.js:27` spawns the
   worker; `runtime/worker.js:16` fetches and instantiates the wasm core inside it.
   Machine memory, Z80 registers and tape position all live there. Webpack's HMR
   runtime does not reach into workers — they have no `module.hot`.
2. **There is no module-level state boundary to swap.** The runtime exposes a single
   global (`window.JSSpeccy`, `runtime/jsspeccy.js:402`) loaded via a classic
   `<script src>` tag. React's Fast Refresh works because components declare where
   state lives; nothing equivalent exists here.
3. **There is no teardown path.** `this.worker.terminate()` (`runtime/jsspeccy.js:398`)
   is the only cleanup in the runtime. UI and keyboard handlers attach listeners to
   `document` with no symmetric removal, so re-instantiating over a live instance
   would leak listeners.

Consequence, accepted by the user: **every change triggers a full page reload and the
emulator restarts from reset.** A loaded tape or snapshot is lost.

If state-preserving HMR is ever wanted, it needs its own spec: a real `dispose()` on
`JSSpeccy`, and a split between the UI layer and the worker+wasm layer so the former
can be replaced without killing the latter. Even then it would only cover
`runtime/*.js` edits — a wasm core change means a worker restart regardless.

## Architecture

The build has four stages, and only the third is something webpack knows about:

| Stage | Command | Input | Output |
|---|---|---|---|
| 1 | `build:core` | `generator/*.js`, `core.ts.in` | `build/core.ts` |
| 2 | `build:wasm:debug` | `build/core.ts` | `dist/jsspeccy/jsspeccy-core.wasm` |
| 3 | `build:js` | `runtime/*.js`, `runtime/icons/*.svg` | `dist/jsspeccy/*.js` |
| 4 | `build:static` | `static/` | `dist/` |

`npm run dev` therefore runs four processes under `concurrently`:

```
npm run dev
├─ webpack serve --mode development   stage 3, in memory, plus serving and reload
├─ npm-watch build:core               stage 1
├─ npm-watch build:wasm:debug         stage 2
└─ npm-watch build:static             stage 4
```

`npm-watch` accepts exactly one task name (`cli.js` reads `process.argv[2]`), which is
why stages 1, 2 and 4 are three separate invocations rather than one.

Running bare `npm-watch` instead would be shorter but would also run `build:js` — a
full production webpack build on every `runtime/*.js` save, duplicating work the dev
server already does incrementally, and firing a second reload. Correctness would
survive (dev middleware takes precedence over static file serving for the same path)
but each save would cost seconds.

The dev server covers stage 3 itself and watches `dist/` (`static.watch`) so output
from the other three stages also triggers a reload.

A one-off build of stages 1, 2 and 4 runs before the watchers start, because without
`dist/index.html` and the wasm binary the first page load would 404.

`npm run dev` is additive. The `watch` block and the `watch` script in `package.json`
are left untouched, so `npm run watch` stays byte-identical to upstream.

### Why `publicPath` needs no change

`runtime/jsspeccy.js:21` reads `document.currentScript.src` at load time and derives
the worker URL and the wasm URL from it. The bundle locates itself, so it works from
any directory on any server without a baked-in prefix.

The default `publicPath: '/'` combined with the existing
`output.filename: 'jsspeccy/jsspeccy.js'` serves the bundle at `/jsspeccy/jsspeccy.js`.
The worker then resolves to `/jsspeccy/jsspeccy-worker.js` (served from dev-server
memory) and the core to `/jsspeccy/jsspeccy-core.wasm` (served from disk under
`static`). The paths line up without intervention.

## Changes

### `webpack.config.js`

- Export a function `(env, argv) => [...]` instead of an array, and take the mode from
  `argv.mode`. Bare `webpack` (used by `build:js`) leaves `argv.mode` undefined, so it
  falls back to `production` and every existing build behaves exactly as before.
- `devtool: 'cheap-module-source-map'` in development, `false` in production
  (`false` is webpack's own production default, so it is a no-op there). Not an
  `eval-*` variant: the rebuild-speed gain is imperceptible on a bundle this size, and
  real `.map` files behave identically in the main thread and inside the worker.
- A `devServer` block on the **first** config only — with an array config, the dev
  server reads the setting from one compiler.
  - `host: '0.0.0.0'`, `allowedHosts: 'all'` — the host is developed on remotely and
    the browser runs on a different machine, so `localhost` would be unreachable.
    Accepted cost: the dev server is visible on the local network.
  - `port: 8080`, overridable with `--port`.
  - `static: { directory: <abs>/dist, watch: true }`.
  - `hot: false`, `liveReload: true` — stated explicitly. With no `module.hot.accept`
    anywhere, HMR would degrade to a full reload anyway while filling the console with
    unaccepted-update warnings.

The absolute path to `dist/` uses the ESM idiom `fileURLToPath(import.meta.url)`;
`package.json` sets `"type": "module"`, so `__dirname` does not exist here.

The worker config deliberately gets **no** `target`. See risk 1.

### `package.json`

- New `dev` script, as above.
- New devDependencies: `webpack-dev-server` ^6.0.0, `concurrently` ^10.0.4.
- `concurrently -n webpack,core,wasm,static` with distinct colours. With four watchers
  sharing one terminal, unlabelled output makes an `asc` error indistinguishable from
  a webpack error.

`webpack-dev-server` 6.0.0 declares peer `webpack ^5.101.0`; the project is on
`^5.109.0`.

## Risks

### 1. Dev-server client injected into the worker bundle — CONFIRMED, accepted

The dev-server client is added as an extra entry to every compiler it considers a web
target, and it reaches for `window` and `document`, neither of which exists in a Web
Worker.

`target: 'webworker'` was tried as a fix. **It does not work.** `Server.isWebTarget`
(`node_modules/webpack-dev-server/lib/Server.js:591-603`) decides on
`compiler.platform.web`, and a webworker sets that flag — a web worker is a web
platform. The client is injected either way.

It was removed again, because it had no upside left and one real downside: it changed
the production worker bundle by 104 bytes, violating the hard constraint above.

Observed behaviour with the client injected into the worker:

- the worker starts, the emulator boots, and **no errors are raised** — the client
  tolerates the worker environment;
- the dev worker bundle grows from ~11 KiB to ~161 KiB (in memory only, never on disk);
- `[webpack-dev-server] Server started` is logged twice, once per bundle, i.e. the
  worker opens a second, redundant WebSocket to the dev server.

This is cosmetic waste confined to development. **The production build is unaffected.**

If it ever becomes worth removing, the escape hatch is `webpack serve --config-name
jsspeccy`, so the dev server compiles only the main bundle, plus a separate watcher
building the worker into `dist/`, where `static` would serve it. That trades a cosmetic
issue for an extra watcher process, which did not look like a good deal.

### 2. Wasm MIME type — VERIFIED CLEAN

`runtime/worker.js:17` uses `WebAssembly.instantiateStreaming`, which hard-rejects on a
`Content-Type` other than `application/wasm` rather than falling back. The dev server
serves `Content-Type: application/wasm`, checked against a running server.

### 3. Reload loops and double reloads — NOT VERIFIED

In serve mode webpack keeps bundles in memory and does not write to `dist/`, so
`static.watch` should not observe the dev server's own output. However `asc` also emits
`jsspeccy-core.wasm.map` (~950 KB), so one core rebuild produces two file events in the
watched directory. Whether that yields one reload or two is unverified.

## Verification

Done:

- Production output is **byte-identical** to a build from the unmodified config. Both
  bundles hash the same before and after the change:
  `jsspeccy.js` → `f6a3247703f8f541159b87830bd7497931fca719abbfb2bde808b00a871b3df9`,
  `jsspeccy-worker.js` → `d76a04c83fc011499c38ed1a688ec42dac31f56b51e04d568175326d6305fd2a`.
  (Measured against the `feat/timex-tc2068` tree, where the change was first written;
  the hashes are a before/after pair on identical sources, not a cross-branch value.)
- Full test suite passes.
- The dev server starts and serves `index.html`, both bundles and the wasm core.
- `Content-Type: application/wasm` confirmed on the wire.
- The worker starts and the page raises no errors.

Left to the user:

- Editing `runtime/ui.js` reloads the page with the change present.
- Editing `static/index.html` reloads the page with the change present.
- Editing `generator/core.ts.in` rebuilds the wasm and reloads the page — once, not
  twice (risk 3).
- The emulator runs after pressing the start button. A blank white screen on first
  load is normal and not a dev-server artefact: `runtime/jsspeccy.js:422` defaults
  `autoStart` to `false` and `static/index.html` does not override it, so the emulator
  waits behind the play button.
