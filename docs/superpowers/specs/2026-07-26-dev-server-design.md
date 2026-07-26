# Dev server with automatic rebuild and browser reload

Date: 2026-07-26
Status: approved, ready to implement
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
- `devtool: 'cheap-module-source-map'` in development, `false` in production. Not an
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
- `target: 'webworker'` on the worker config. Semantically correct regardless, and it
  is the intended defence against risk 1 below.

The absolute path to `dist/` uses the ESM idiom `fileURLToPath(import.meta.url)`;
`package.json` sets `"type": "module"`, so `__dirname` does not exist here.

### `package.json`

- New `dev` script, as above.
- New devDependencies: `webpack-dev-server`, `concurrently`.
- `concurrently -n webpack,core,wasm,static` with distinct colours. With four watchers
  sharing one terminal, unlabelled output makes an `asc` error indistinguishable from
  a webpack error.

`webpack-dev-server` 6.0.0 declares peer `webpack ^5.101.0`; the project is on
`^5.109.0`.

## Risks, and how each is verified

Each of these can produce a black screen rather than a readable error, so none is
accepted on theory alone.

1. **Dev-server client injected into the worker bundle.** The client is added as an
   extra entry and touches `window` and `document`, neither of which exists in a Web
   Worker; if it lands in `jsspeccy-worker.js` the worker dies on startup and the
   emulator never runs. `target: 'webworker'` is expected to suppress injection.
   *Verify:* load the page in a real browser and confirm the worker starts and the
   console is clean. *Fallback:* scope client injection to the first compiler.
2. **Wasm MIME type.** `runtime/worker.js:17` uses `WebAssembly.instantiateStreaming`,
   which hard-rejects on a `Content-Type` other than `application/wasm` instead of
   falling back. *Verify:* inspect the response header directly, not merely that the
   page loads.
3. **Reload loops and double reloads.** In serve mode webpack keeps bundles in memory
   and does not write to `dist/`, so `static.watch` should not observe the dev server's
   own output. However `asc` also emits `jsspeccy-core.wasm.map` (~950 KB), so one core
   rebuild produces two file events in the watched directory. *Verify:* edit a core
   source file and confirm the page reloads once, not twice.

## Acceptance criteria

- `npm run dev` serves the emulator and it boots to the usual Spectrum screen.
- Editing `runtime/ui.js` reloads the page with the change present.
- Editing `static/index.html` reloads the page with the change present.
- Editing `generator/core.ts.in` rebuilds the wasm and reloads the page.
- The browser console is free of errors attributable to the dev server.
- `npm run build`, `npm run build:release` and `npm test` behave exactly as before.
