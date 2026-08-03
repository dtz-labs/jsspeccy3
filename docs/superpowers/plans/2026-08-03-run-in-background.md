# Run in Background Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the emulator running in real time, with continuous audio, while the page is hidden (background tab / minimised window), controlled by a `runInBackground` option (default on) and a "Run in background" File-menu checkbox.

**Architecture:** Today frames are driven solely by `requestAnimationFrame` on the main thread, which browsers suspend for hidden pages. We add a second driving mode, *worker-paced*, switched by `visibilitychange`: the worker paces frame execution with its own `setTimeout` (worker timers are not throttled) and the main thread requests the next frame the moment one completes (`postMessage` delivery is not throttled either). Audio is untouched — the existing ring buffer keeps being fed from `frameCompleted`.

**Tech Stack:** Plain ES-module JavaScript (no framework), webpack build, Web Worker + WASM core. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-03-run-in-background-design.md`

## Global Constraints

- `msPerFrame` is a constant 20 ms for every machine (`runtime/jsspeccy.js:54`); no per-machine handling needed.
- Option name is exactly `runInBackground`, default `true`; menu label is exactly "Run in background", in the **File** menu below "Instant tape loading".
- No new npm dependencies; follow the existing code style (4-space indent, block comments that explain constraints, not narration).
- Commit messages: plain imperative mood (repo style, no `feat:`/`fix:` prefixes), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- There is no DOM/worker unit-test harness in this repo and the Page Visibility behaviour cannot be exercised from the Node test suite; per the spec, verification is by build + existing suite (regression) + scripted browser check (Task 5). Do not invent a jsdom harness.
- The build must stay green: `npm run build` after every code task, full `npm test` before the final commit of each task.

---

### Task 1: Worker-paced frame execution (`runtime/worker.js`)

**Files:**
- Modify: `runtime/worker.js` (message handler, ~lines 131-206)

**Interfaces:**
- Consumes: existing `runFrame` message shape `{message, frameBuffer, audioBufferLeft?, audioBufferRight?}`.
- Produces: new worker message `{message: 'setPaced', paced: boolean, msPerFrame?: number}` (`msPerFrame` required when `paced` is true). In paced mode, received `runFrame` messages execute spaced `msPerFrame` apart instead of immediately. Task 2 sends this message.

- [ ] **Step 1: Add pacing state**

Near the top of `runtime/worker.js`, alongside the existing module-level state (`stopped`, `tape`, etc.), add:

```js
let paced = false;
let pacedMsPerFrame = 20;
let nextFrameDue = 0;
```

- [ ] **Step 2: Extract the frame body into `executeFrame`**

Take the entire body of the `case 'runFrame':` block *after* the `if (stopped) return;` guard (from `const frameBuffer = e.data.frameBuffer;` down to the closing `postMessage` calls) and move it into a module-level function defined above `onmessage`:

```js
const executeFrame = (data) => {
    if (stopped) return;
    const frameBuffer = data.frameBuffer;
    const frameData = new Uint8Array(frameBuffer);
    /* ... existing body unchanged, with every `e.data` replaced by `data` ... */
};
```

The `if (stopped) return;` moves *into* `executeFrame` so that a frame deferred by `setTimeout` still respects a `stopped` flag set in the meantime.

- [ ] **Step 3: Rewrite the `runFrame` case and add `setPaced`**

```js
        case 'runFrame':
            if (paced) {
                /* while the page is hidden the main thread cannot pace
                frames (rAF is suspended), so the worker spaces them
                msPerFrame apart with its own timer */
                const now = performance.now();
                if (nextFrameDue < now - 2 * pacedMsPerFrame) {
                    /* fallen too far behind (system sleep, long stall) -
                    rebase rather than catching up with a burst of frames */
                    nextFrameDue = now;
                }
                setTimeout(() => executeFrame(e.data), Math.max(0, nextFrameDue - now));
                nextFrameDue += pacedMsPerFrame;
            } else {
                executeFrame(e.data);
            }
            break;
        case 'setPaced':
            paced = e.data.paced;
            if (paced) {
                pacedMsPerFrame = e.data.msPerFrame;
                nextFrameDue = performance.now();
            }
            break;
```

Note the transferred `ArrayBuffer`s in `e.data` remain valid inside the deferred closure — they were transferred into this worker and nothing else touches them.

- [ ] **Step 4: Build and run the suite**

Run: `npm test` (builds, then runs the Node unit suites)
Expected: build succeeds, all suites pass — this task must not change foreground behaviour (`paced` is never set yet).

- [ ] **Step 5: Commit**

```bash
git add runtime/worker.js
git commit -m "Let the worker pace frame execution on request

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Main-thread mode switching (`runtime/jsspeccy.js`)

**Files:**
- Modify: `runtime/jsspeccy.js` — Emulator constructor (~line 46-58), `frameCompleted` handler (~lines 94-106), `start()` (~line 155), `pause()` (~line 184), `runAnimationFrame()` (~lines 242-256), `exit()` (~line 443)

**Interfaces:**
- Consumes: `{message: 'setPaced', ...}` from Task 1.
- Produces: `Emulator.runInBackground` (boolean field read from `opts`, default `true`; the `window.JSSpeccy` factory pass-through comes in Task 3), `Emulator.isPacedByWorker` (boolean), `Emulator.updatePacingMode()` (no args, no return). Task 3's setter calls `updatePacingMode()`.

- [ ] **Step 1: Add state and the visibility listener to the constructor**

After the `this.tapeTrapsEnabled = ...` line add:

```js
        this.runInBackground = ('runInBackground' in opts) ? opts.runInBackground : true;
```

After the `this.machineType = null;` line add:

```js
        this.isPacedByWorker = false;
        this.onVisibilityChange = () => {
            this.updatePacingMode();
        };
        document.addEventListener('visibilitychange', this.onVisibilityChange);
```

- [ ] **Step 2: Add `updatePacingMode()`**

Insert as a method between `start()` and `focus()`:

```js
    /* While the page is hidden, requestAnimationFrame stops firing, so frame
    pacing is handed to the worker, whose timers are not throttled; the main
    thread then requests the next frame as soon as one completes. */
    updatePacingMode() {
        const shouldPace = document.hidden && this.isRunning && this.runInBackground;
        if (shouldPace && !this.isPacedByWorker) {
            this.isPacedByWorker = true;
            this.worker.postMessage({
                message: 'setPaced',
                paced: true,
                msPerFrame: this.msPerFrame,
            });
            if (!this.isExecutingFrame) {
                this.runFrame();
            }
        } else if (!shouldPace && this.isPacedByWorker) {
            this.isPacedByWorker = false;
            this.worker.postMessage({
                message: 'setPaced',
                paced: false,
            });
            this.nextFrameTime = performance.now();
        }
    }
```

- [ ] **Step 3: Chain frames immediately in the `frameCompleted` handler when paced**

Replace the `if (this.isRunning) { ... } else { this.isExecutingFrame = false; }` block inside `case 'frameCompleted':` with:

```js
                    if (this.isRunning) {
                        if (this.isPacedByWorker) {
                            /* the worker paces execution - keep the next
                            frame request in flight immediately */
                            this.runFrame();
                        } else {
                            const time = performance.now();
                            if (time > this.nextFrameTime) {
                                /* running at full blast - start next frame but adjust time base
                                to give it the full time allocation */
                                this.runFrame();
                                this.nextFrameTime = time + this.msPerFrame;
                            } else {
                                this.isExecutingFrame = false;
                            }
                        }
                    } else {
                        this.isExecutingFrame = false;
                    }
```

- [ ] **Step 4: Guard the rAF driver and hook mode changes into start/pause/exit**

In `runAnimationFrame()`, change the frame-driving condition so a stale rAF callback cannot double-drive after returning to visibility (display `show()` stays unconditional):

```js
            if (!this.isPacedByWorker && time > this.nextFrameTime && !this.isExecutingFrame) {
```

In `start()`, after `this.emit('start');` add:

```js
            this.updatePacingMode();
```

(This makes a `start()` issued while the page is already hidden enter paced mode directly instead of waiting on a suspended rAF.)

In `pause()`, after `this.emit('pause');` add:

```js
            this.updatePacingMode();
```

In `exit()`, before `this.worker.terminate();` add:

```js
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
```

- [ ] **Step 5: Build and run the suite**

Run: `npm test`
Expected: build succeeds, all suites pass. (The Node suites drive the core directly, not this file — this is a regression check on the build.)

- [ ] **Step 6: Commit**

```bash
git add runtime/jsspeccy.js
git commit -m "Hand frame pacing to the worker while the page is hidden

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Option surface — setter, factory opt, menu item (`runtime/jsspeccy.js`)

**Files:**
- Modify: `runtime/jsspeccy.js` — setters (~line 419), `window.JSSpeccy` factory opts (~line 461), File menu construction (~lines 508-521)

**Interfaces:**
- Consumes: `Emulator.runInBackground`, `updatePacingMode()` from Task 2; `fileMenu.addItem(title, onClick)` returning `{setCheckbox(), unsetCheckbox()}` (see `runtime/ui.js:103-140`); the `setAutoLoadTapes` pattern at `runtime/jsspeccy.js:419`.
- Produces: `emu.setRunInBackground(val)` emitting a `'setRunInBackground'` event; constructor option `runInBackground` accepted by `window.JSSpeccy(container, opts)`; "Run in background" checkbox in the File menu.

- [ ] **Step 1: Add the setter next to `setAutoLoadTapes`**

```js
    setRunInBackground(val) {
        this.runInBackground = val;
        this.updatePacingMode();
        this.emit('setRunInBackground', val);
    }
```

(`updatePacingMode()` makes turning the option off while hidden and paced exit paced mode immediately, and turning it on while hidden enter it.)

- [ ] **Step 2: Pass the option through the factory**

In `window.JSSpeccy`, add to the `new Emulator(canvas, {...})` options object:

```js
        runInBackground: ('runInBackground' in opts) ? opts.runInBackground : true,
```

- [ ] **Step 3: Add the menu checkbox**

In the `if (uiEnabled)` block, directly after the `updateTapeTrapsCheckbox()` call (note: *outside* the `!opts.sandbox` guard — the option applies in sandbox mode too, same as "Instant tape loading"):

```js
        const runInBackgroundMenuItem = fileMenu.addItem('Run in background', () => {
            emu.setRunInBackground(!emu.runInBackground);
            emu.focus();
        });
        const updateRunInBackgroundCheckbox = () => {
            if (emu.runInBackground) {
                runInBackgroundMenuItem.setCheckbox();
            } else {
                runInBackgroundMenuItem.unsetCheckbox();
            }
        }
        emu.on('setRunInBackground', updateRunInBackgroundCheckbox);
        updateRunInBackgroundCheckbox();
```

- [ ] **Step 4: Build and run the suite**

Run: `npm test`
Expected: build succeeds, all suites pass.

- [ ] **Step 5: Commit**

```bash
git add runtime/jsspeccy.js
git commit -m "Add a run-in-background option and File menu toggle

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Documentation (`README.md`, `CHANGELOG.md`)

**Files:**
- Modify: `README.md` (options list ~lines 61-67, API list ~lines 82-88)
- Modify: `CHANGELOG.md` (top of the `Unreleased` section)

**Interfaces:**
- Consumes: option and API names from Task 3 (`runInBackground`, `emu.setRunInBackground(val)`).
- Produces: user-facing docs; nothing downstream.

- [ ] **Step 1: Document the constructor option in README**

Add to the options bullet list (after the `sandbox` bullet):

```markdown
* `runInBackground`: if true (the default), the emulator keeps running - with audio - while the page is hidden, such as in a background browser tab. Frame scheduling is handed to the emulation worker, whose timers browsers do not throttle. Set to false to pause emulation whenever the page is hidden.
```

- [ ] **Step 2: Document the API method in README**

Add to the `emu.*` API list, after `emu.setZoom(zoomLevel)`:

```markdown
* `emu.setRunInBackground(val)` - enable or disable running while the page is hidden
```

- [ ] **Step 3: Add the CHANGELOG entry**

At the top of the `Unreleased` bullet list in `CHANGELOG.md`:

```markdown
* Keep running - with audio - while the page is hidden, by handing frame
  pacing to the emulation worker, whose timers are not throttled in
  background tabs. Controlled by the "Run in background" File menu option
  and the `runInBackground` constructor option (default on)
```

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "Document the run-in-background option

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Browser verification (no code changes expected)

**Files:**
- None modified. Serves `dist/` and drives Chrome. `dist/index.html` already exposes the emulator as a global `emu` (assigned without `var` in its `onload`), and starts `attribute-raid.tap` on a Timex 2048.

**Interfaces:**
- Consumes: the built `dist/` bundle from `npm run build`; `emu.audioHandler.writePtr` (ring-buffer write pointer, advances by `sampleRate/50` samples per completed frame while audio is active; ring size `0x10000` samples wraps every ~1.4 s, so ≥1 sample/s polling cannot alias); `emu.audioHandler.audioContext.sampleRate`.
- Produces: pass/fail evidence for the feature. Any failure loops back to the offending task.

**Measurement principle:** cumulative growth of `writePtr` divided by `sampleRate` equals seconds of *emulated* audio produced. While hidden with the option ON it must track wall-clock time; with the option OFF it must stall. Page-side `setInterval` sampling is throttled to ~1 tick/s in hidden tabs, which is still frequent enough (< 1.4 s wrap).

- [ ] **Step 1: Build and serve**

```bash
npm run build
cd dist && python3 -m http.server 8099
```

(Run the server in the background.)

- [ ] **Step 2: Start the emulator with audio**

Using claude-in-chrome: open `http://localhost:8099/` in a new tab, click the play ▶ button inside the emulator (the click is the user gesture that unlocks the AudioContext), wait ~5 s for the tape to auto-load.

- [ ] **Step 3: Install the sample counter**

Via `javascript_tool` on that tab:

```js
window.__bg = { total: 0, last: emu.audioHandler.writePtr, t0: performance.now() };
window.__bgTimer = setInterval(() => {
    const p = emu.audioHandler.writePtr;
    window.__bg.total += (p - window.__bg.last + 0x10000) % 0x10000;
    window.__bg.last = p;
}, 500);
```

- [ ] **Step 4: Verify background running (option ON, the default)**

Open a fresh `about:blank` tab (this hides the emulator tab), wait ≥ 10 s, switch back, then evaluate:

```js
({elapsed: (performance.now() - __bg.t0) / 1000,
  emulated: __bg.total / emu.audioHandler.audioContext.sampleRate})
```

Expected: `emulated` ≥ 0.9 × `elapsed` (emulation kept real-time pace while hidden). Also confirm by ear/description that audio kept playing and that the demo visibly advanced.

- [ ] **Step 5: Verify the toggle OFF restores freezing**

In the emulator tab: File menu → click "Run in background" (checkbox clears). Note `__bg.total`, hide the tab again for ≥ 10 s, return, re-evaluate. Expected: `__bg.total` grew by < 1 s worth of samples during the hidden interval (emulation froze), and resumes growing after return.

- [ ] **Step 6: Foreground regression check**

With the tab visible: toggle the option back ON, confirm the demo runs smoothly, keyboard input works (press a key at the 2048 BASIC prompt if reachable), pause/play button works, and the File-menu checkbox state tracks toggling.

- [ ] **Step 7: Clean up**

```js
clearInterval(window.__bgTimer);
```

Stop the HTTP server. No commit — this task produces evidence only. If any step fails, fix in the owning task (1-3), re-run `npm test`, amend nothing — add a follow-up commit — and repeat this task.
