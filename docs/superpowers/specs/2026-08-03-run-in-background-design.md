# Run in background — design

Date: 2026-08-03
Status: approved (design discussion in session)

## Problem

The emulation loop is driven solely by `window.requestAnimationFrame` on the
main thread (`runtime/jsspeccy.js`, `runAnimationFrame`). Browsers suspend rAF
callbacks when the page is hidden — tab switched away, window minimised, or
(on macOS Chrome) the window fully occluded. When that happens nothing sends
`runFrame` messages to the worker any more: emulation freezes and the audio
ring buffer drains to silence.

Nothing in the codebase pauses on blur; this is purely browser scheduling
behaviour. Mere focus loss with the page still visible does not stop rAF (and
does not stop the emulator today).

## Goal

An option — on by default — that keeps the emulator running in real time,
with continuous audio, while the page is hidden.

## Approach

Add a second frame-driving mode, *worker-paced*, switched by the
`visibilitychange` event. Rationale: timers inside Web Workers and
`postMessage` delivery are not throttled for hidden pages, while main-thread
rAF is suspended and main-thread timers are clamped to ~1 tick/s. Driving
frames from the audio callback was rejected because it fails whenever the
AudioContext is suspended (autoplay policy) and leans on the deprecated
ScriptProcessorNode.

### Mechanism

1. **Entering background mode** — on `visibilitychange` where
   `document.hidden && emulator.isRunning && emulator.runInBackground`:
   the main thread sends `{message: 'setPaced', paced: true, msPerFrame}` to
   the worker, then immediately calls `runFrame()` if no frame is in flight
   (`!isExecutingFrame`). A flag `isPacedByWorker` is set on the Emulator.

2. **Paced mode in the worker** — the body of the worker's `runFrame` message
   case is extracted into an `executeFrame(data)` function. When paced, the
   worker does not execute a received frame immediately; it schedules
   `executeFrame` with its own `setTimeout` so frames run every `msPerFrame`
   (a constant 20 ms; `jsspeccy.js:54`). The worker keeps a `nextFrameDue`
   clock advanced by `msPerFrame` per frame, clamped: if it has fallen more
   than two frames (40 ms) behind the current time, reset it to now instead
   of catching up with a burst. When not paced, `executeFrame` runs
   synchronously exactly as today.

3. **The chain** — the worker posts `frameCompleted` as today. The main
   thread's `frameCompleted` handler (message delivery is not throttled),
   when `isPacedByWorker`, immediately calls `runFrame()` again regardless of
   `nextFrameTime`. Pacing responsibility lies entirely with the worker in
   this mode.

4. **Audio** — unchanged. `frameCompleted` keeps feeding the ring buffer in
   `AudioHandler`; `onaudioprocess` keeps firing for hidden pages, so sound
   plays continuously.

5. **Returning to visibility** — main thread sends `paced: false`, clears
   `isPacedByWorker`, resets `nextFrameTime = performance.now()`, and rAF
   pacing resumes. The rAF loop gets a guard: when `isPacedByWorker` it never
   calls `runFrame()` (it still calls `displayHandler.show()`), so the stale
   rAF callback that fires on return cannot double-drive the loop. The rAF
   request chain is kept alive throughout.

### Option surface

- Constructor option `runInBackground`, default `true`; documented in README
  alongside the other options.
- `Emulator.setRunInBackground(val)` emitting a `setRunInBackground` event —
  same pattern as `setAutoLoadTapes`.
- Menu item **"Run in background"** with a checkbox in the **File** menu,
  below "Instant tape loading" (where the other behaviour toggles live).
- Turning the option off while hidden and paced exits paced mode immediately;
  emulation then halts until the page is visible again (today's behaviour).

### Edge cases

- **User pause**: paced mode is only entered when `isRunning`; on `pause()`
  the main thread stops issuing `runFrame`, so the chain dies naturally. A
  `start()` while the page is already hidden (API call) enters paced mode
  directly instead of relying on rAF.
- **Machine type**: `msPerFrame` is a constant 20 ms for every machine, so
  `setPaced` sends it once and no machine-change handling is needed.
- **Message interleaving in the worker**: deferring `executeFrame` with
  `setTimeout` means other messages can be processed between scheduling and
  execution. Machine-state changes are only triggered by user interaction,
  which requires a visible page, so no hazardous interleaving is reachable in
  paced mode.
- **`stopped` worker flag**: the paced path respects the existing
  `if (stopped) return` guard exactly as the synchronous path does.

## Testing / verification

Browser visibility throttling cannot be exercised meaningfully in the
existing test suite, so verification is manual: build with webpack, load a
program with music (`static/attribute-raid.tap`), switch tabs, confirm audio
continues and emulation keeps real-time pace; confirm the menu toggle off
restores today's freeze behaviour; confirm normal foreground operation is
unchanged. Update README (new option) and CHANGELOG.
