# Timex TC2048 support — design

**Status:** proposed
**Date:** 2026-07-26
**Phase:** 1 of 2 (phase 2 = TS2068, see `2026-07-26-timex-ts2068-design.md`)
**Target:** conservative, additive diff suitable for an upstream PR to `gasman/jsspeccy3`

## Goal

Add the Timex Computer 2048 as a selectable machine, with all three Timex SCLD
video modes:

| `port 0xFF & 0x07` | Mode |
|---|---|
| 0 | Standard Spectrum screen, display file 0 at `0x4000` |
| 1 | Standard Spectrum screen, display file 1 at `0x6000` |
| 2 | Hi-colour: 256x192 bitmap at `0x4000`, one attribute per **8x1** row at `0x6000` |
| 6 | Hi-res: 512x192 monochrome, two display files interleaved |

Mode numbering confirmed against ZEsarUX (`FEATURES`: "Mode 0 standard, 1 dual
screen, 2 hires colour 8x1, 6 512x192 monochrome"). Bits are independent enables:
bit 0 selects the display file, bit 1 enables hi-colour, bit 2 enables hi-res,
and bit 2 wins over bit 1.

## Why TC2048 is cheap

Three findings from inspecting the codebase and the ROMs establish the scope.

**1. `tc2048.rom` is `48.rom` with exactly 7 bytes changed**, none of them below
address `0x0600`. Verified by byte comparison against ZEsarUX's `tc2048.rom`
(first difference `0x129A`, last `0x3873`). Consequences:

- The tape-loading trap keeps working: `LD-BYTES` is byte-identical and at the
  same address, so the PC constants in `generator/core.ts.in:863`
  (`pc == 0x056b || pc == 0x0111`) are already correct. The *page-identity* half
  of that condition does need extending — it currently tests
  `memoryPageReadMap[0] == 9 || memoryPageReadMap[0] == 10`, and the TC2048 ROM
  is page 14. Add page 14 to the test.
- The 48K tape-loader snapshot `static/tapeloaders/tape_48.szx` can be reused.
- Snapshot register/memory loading needs no new logic.

TC2048 is therefore *almost entirely a video problem*.

**2. The frame buffer does not need to change size.** The format is a log of
bytes in ULA fetch order: 4 bytes per 16-pixel group (`bitmap, attr, bitmap, attr`).
All three Timex modes also consume exactly 4 bytes per 16-pixel group:

- hi-colour fetches `bitmap, attr, bitmap, attr` — same shape, different addresses
- hi-res fetches 4 bitmap bytes covering 32 hi-res pixels

The pixel log stays at `0x6600` bytes. Only the *mode* has to reach the renderer.

**3. Hi-colour needs no renderer change at all.** Because the byte stream shape is
identical to standard mode, `render.js`'s existing inner loop already decodes
hi-colour correctly. The entire feature is an addressing change inside
`updateFramebuffer()`.

## Design

### Machine identity

New `machineType = 2048` (existing values: 48, 128, 5 = Pentagon, 1212 = test).

`setMachineType(2048)` reuses 48K timing wholesale — PAL, 3.5 MHz:

```
frameCycleCount = 69888;
buildScreenEventsTable(14335, 224, 0xfc);
buildContentionTable(14335, 224, frameCycleCount);
betadiskEnabled = false;
timexVideoEnabled = true;     // new
screenDirtyLimit = 0x3b00;    // new
```

`reset()` gains a `2048` branch:

```
memoryPageReadMap  = [14, 5, 2, 0];   // page 14 = tc2048.rom
memoryPageWriteMap = [11, 5, 2, 0];   // page 11 = ROM-write scratch area
pagingLocked = 1;
timexScreenMode = 0;
```

ROM page 14 fits inside the existing `machineMemory[0x40000]` (16 pages of 16K).
No memory growth, no `asconfig.json` change.

Note that phase 2 converts the core to 8 KB paging and renumbers every page
(`n` becomes `2n`, so TC2048's ROM becomes pages 28–29). That renumbering is
phase 2's problem; nothing in phase 1 should be shaped around it.

### `screenDirtyLimit`

`writeMem` currently flushes the framebuffer when a write lands in the screen page
below offset `0x1b00` (`core.ts.in:424`). TC2048's second display file occupies
`0x6000..0x7AFF`, i.e. offset `0x2000..0x3AFF` in the same 16K page, so the
threshold must widen to `0x3b00` for Timex and stay at `0x1b00` for every other
machine. One module-level variable, one comparison — no cost to existing machines.

### Bug fix: `pageIsContended` is undersized

`#alloc pageIsContended[12]` (`core.ts.in:18`) is indexed with page 12 (Pentagon
ROM) and page 13 (TRDOS). `gencore.js` rewrites array access to unchecked
`load<u8>`, so those reads land on the `AF` register pair allocated immediately
after it. This is currently unobservable because Pentagon zeroes its contention
table, but adding page 14 with *active* contention would make it a real defect.

Widen to `pageIsContended[16]`, with entries for pages 12–15 set to 0.

### Port `0xFF` — the SCLD register

`0xFF` has A0=1, so it can never collide with the ULA border/speaker branch
(which tests `!(addr & 0x0001)`). New guarded branch in `writePort`:

```
} else if (timexVideoEnabled && (addr & 0x00ff) == 0x00ff) {
    updateFramebuffer();          // flush pixels up to the current t-state first
    logScreenModeChange(val);
    timexScreenMode = val;
}
```

`readPort` returns `timexScreenMode` for the same decode when
`timexVideoEnabled`. The guard means 48K/128/Pentagon behaviour stays
bit-identical, including the existing floating-bus read on port `0xFF`.

The built-in Kempston joystick at port `0x1F` is already covered by the existing
`!(addr & 0x00e0)` branch, which returns 0 (no input). No change needed.

### `updateFramebuffer()`

The Timex test is hoisted **outside** the event loop so non-Timex machines pay one
branch per call rather than one per fetch:

```
if (!timexVideoEnabled) {
    ... existing loop, untouched ...
} else {
    ... Timex loop ...
}
```

Per screen event, the Timex loop selects addresses from the low half of the
existing `screenEvents` address word (`off`) and its high half (`attrOff`):

| `mode & 0x07` | byte 0 | byte 1 | byte 2 | byte 3 |
|---|---|---|---|---|
| 0 | `off` | `attrOff` | `off+1` | `attrOff+1` |
| 1 | `0x2000+off` | `0x2000+attrOff` | `0x2000+off+1` | `0x2000+attrOff+1` |
| 2, 3 | `off` | `0x2000+off` | `off+1` | `0x2000+off+1` |
| 4–7 | `off` | `0x2000+off` | `off+1` | `0x2000+off+1` |

All addresses are relative to `screenPageIndex << 14`. Note that hi-colour and
hi-res fetch **identical addresses** — only the renderer's interpretation differs,
and the mode byte in the change log tells it which. So this is one code path, not
two.

No new `screenEvents` table is required: every Timex address is derivable from the
existing entries.

`floatingBusValue` continues to be set from the last fetched byte.

### Frame buffer contract

`FRAME_BUFFER_SIZE`: `0x6600` -> `0x6a00`.

- `0x0000..0x65ff` — pixel/attr/border fetch log, **format unchanged**
- `0x6600..0x69ff` — screen-mode change log, up to 255 records:

```
u16 framebufferIndex   // byte offset into the pixel log where this mode takes effect
u8  portFFValue
u8  padding            // keeps 4-byte alignment
...
u16 0xffff             // terminator
```

`runFrame()` resets the log pointer and writes an initial record
`(0, timexScreenMode)`, so the renderer always has a mode in hand before the first
pixel. A terminator is written at frame end.

**Accepted limit:** more than 255 mode changes in one frame drops the remainder.
A per-scanline effect needs at most 192, so this is a documented cap. The core
must not silently truncate without the constant being visible in the source.

For non-Timex machines the core writes the single record `(0, 0)` plus terminator,
so the renderer has one uniform code path.

### Incidental fix in `worker.js`

`worker.js:22` reads:

```js
workerFrameData = memoryData.subarray(core.FRAME_BUFFER, FRAME_BUFFER_SIZE);
```

`subarray` takes `(begin, end)`, but a *size* is being passed as the end offset.
This works today only because `core.FRAME_BUFFER` happens to be 0. Correct to
`core.FRAME_BUFFER + FRAME_BUFFER_SIZE`.

### Renderer

`CanvasRenderer` gains a backing-store width:

- non-Timex machines: 320x240, unchanged
- Timex machines: 640x240

Hi-res pixels are half-width, so the *displayed* size stays 320x240 logical.
`ui.js:394` (`const displayWidth = 320 * this.zoom`) therefore needs **no change** —
the canvas CSS width is set explicitly in pixels, so a 640-wide backing store
scales into the same box.

Fullscreen does need attention: `ui.js:312` sets `width/height: 100%` with
`objectFit: contain`, which would infer an 8:3 aspect ratio from the intrinsic
640x240. Add an explicit `aspect-ratio: 4 / 3` on the canvas.

`showFrame` walks the mode-change log and switches decoder per segment:

- **standard / DF1 / hi-colour** — the existing inner loop verbatim, each pixel
  written twice when the backing store is 640 wide
- **hi-res** — 4 bytes decode to 32 pixels; ink and paper come from
  `HIRES_COLOURS[(portFFValue >> 3) & 7]`

Byte order in hi-res is `mem[off]`, `mem[off+0x2000]`, `mem[off+1]`,
`mem[off+0x2001]` — the SCLD interleaves the two display files, even pixel
columns from DF0 and odd from DF1.

### Runtime and file formats

- `jsspeccy.js:186` — add `await this.loadRom('roms/tc2048.rom', 14)`
- ship the 16 KB `tc2048.rom` in `static/roms/`
- `setMachine(2048)` — set `canvas.width` and have `DisplayHandler` rebuild the
  renderer's `ImageData`
- machine menu item "Timex TC2048"; the existing `else` branch at
  `jsspeccy.js:530` already unsets the other bullets
- `TAPE_LOADERS_BY_MACHINE['2048']` -> reuse `tapeloaders/tape_48.szx`
- `snapshot.js` — SZX `machineId 8` (`ZXSTMID_TC2048`) and `.z80` hardware mode 14
  map to model 2048; restore the SCLD byte through
  `core.writePort(0x00ff, mode)` in `worker.js`'s `loadSnapshot`
- README machine list, CHANGELOG entry

### ROM licensing

`static/roms/` already ships `48.rom`, `128-0.rom`, `128-1.rom`,
`pentagon-0.rom` and `trdos.rom`. Amstrad's blanket permission covers the
Sinclair ROMs; `tc2048.rom` has a different rightsholder (Timex Corporation).

Decision: ship it, and raise the licensing question explicitly in the PR
description so the upstream maintainer can decide. Structure ROM loading so it can
be swapped to a configurable URL in a single commit if upstream objects — nothing
else in the change depends on the ROM being bundled.

## Testing

`test/test.js` already instantiates the wasm core directly under Node, so a screen
harness reuses that machinery. New `test/screen/` tests:

1. **Standard DF0** — poke a known pattern at `0x4000`/`0x5800`, run a frame,
   assert the pixel log matches the 48K output byte for byte.
2. **DF1 select** — write `0x01` to port `0xFF`, assert fetches come from
   `0x6000`/`0x7800`.
3. **Hi-colour addressing** — write `0x02`, assert the attribute byte for row `y`
   comes from `0x6000 + rowOffset`, i.e. one attribute per 8x1 row.
4. **Hi-res interleave** — write `0x06`, assert the four bytes per group are
   `off`, `off+0x2000`, `off+1`, `off+0x2001` in that order.
5. **Mid-frame mode change** — write port `0xFF` partway through a frame, assert a
   log record appears with the correct `framebufferIndex`.
6. **Non-Timex regression** — assert 48K/128/Pentagon pixel logs are unchanged
   from before the patch.
7. **Tape trap** — assert the trap fires with the TC2048 ROM paged in, i.e. that
   page 14 was added to the page-identity test.

Then a manual reference comparison: a small `.tap` that draws a known pattern in
each mode, run in both JSSpeccy and ZEsarUX (`tc2048`), screenshots compared.
ZEsarUX emulates all four Timex modes, so it is a usable reference.

## Details to settle empirically

Each has a concrete starting assumption, confirmed or corrected during the
ZEsarUX comparison step. These are assumptions to test, not gaps in the design.

1. **Hi-res colour table.** Assume `paper = ((portFF >> 3) & 7) | BRIGHT` and
   `ink = paper ^ 7`. Sources disagree on whether bits 3–5 select ink or paper;
   the table is a single 8-entry constant either way.
2. **Port `0xFF` read value.** Assume the last written SCLD byte. The alternative
   is floating-bus behaviour as on a stock 48K.
3. **Contention in hi-res modes.** Assume the 48K contention table is correct.
   The SCLD fetches from both display files, which may alter the pattern; if it
   does, TC2048 needs its own `buildContentionTable` variant.
4. **Port `0xFF` bit 6.** On TS2068 this disables the ULA interrupt. Assume it is
   unused on TC2048 and ignore it.

## Out of scope for this phase

- TS2068 / TC2068 (phase 2)
- `.DCK` cartridge loading (TS2068 only)
- AY sound (TC2048 has no AY chip)
- Timex-specific `.z80` extensions beyond the hardware-mode byte
