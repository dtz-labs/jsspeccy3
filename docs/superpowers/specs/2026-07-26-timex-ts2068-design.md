# Timex TS2068 support — design

**Status:** proposed
**Date:** 2026-07-26
**Phase:** 2 of 2 (phase 1 = TC2048, see `2026-07-26-timex-tc2048-design.md`)
**Depends on:** phase 1 landing first — the SCLD video work carries over unchanged
**Target:** conservative, additive diff suitable for an upstream PR to `gasman/jsspeccy3`

## Goal

Add the Timex Sinclair 2068 as a selectable machine:

- the three Timex SCLD video modes (delivered by phase 1, reused as-is)
- the TS2068 memory model: HOME / EXROM / DOCK banks with 8 KB-granular paging
  via port `0xF4`
- AY-3-8912 sound on ports `0xF5` / `0xF6`
- NTSC timing
- tape loading
- `.DCK` cartridge images

## Why TS2068 is substantially harder than TC2048

Where TC2048 is `48.rom` plus a video register, TS2068 is a different machine
wearing a Spectrum's clothes. Verified by inspecting ZEsarUX's `ts2068.rom`:

- The ROM is **24 KB**: HOME (16 KB at file offset `0x0000`) + EXROM (8 KB at
  `0x4000`).
- HOME differs from `48.rom` in **15,279 of 16,384 bytes**. It is not a
  patched Spectrum ROM; the token table at `0x0100` is already shifted by two
  bytes.
- The address space is banked in **8 KB chunks**, which the current 16 KB paging
  model cannot express.

One thing turned out much easier than expected — see the tape trap section.

## Design

### 1. Prerequisite: 8 KB paging granularity

Port `0xF4` maps each of eight 8 KB chunks independently. The core currently uses
`memoryPageReadMap[4]` / `memoryPageWriteMap[4]`, indexed by `addr >> 14`, with
page offsets `page << 14`.

**Decision: convert the core to 8 KB granularity globally**, as its own commit,
landing before any TS2068 code.

- `memoryPageReadMap[8]` / `memoryPageWriteMap[8]`
- index becomes `addr >> 13`, offset becomes `page << 13`
- every existing machine's maps double in length, e.g. 48K read map
  `[10, 5, 2, 0]` becomes `[20, 21, 10, 11, 4, 5, 0, 1]` in 8 KB page numbers

Rejected alternative: keep 16 KB maps and add a parallel Timex-only chunk map
consulted behind a flag. That puts an extra branch in *every* memory access for
*every* machine, and duplicates paging state in two places that must agree.

Cost of the global conversion: wide but mechanical. Call sites are `readMem`,
`readMemInternal`, `writeMem`, `contendRead`, `contendDirtyRead`,
`contendDirtyWrite`, `peek`, `poke`, `readPort`, `writePort`, the 128K paging
branch, the betadisk ROM swap, `reset()`, `worker.js`'s `loadMemoryPage`, and
snapshot loading. Performance is unchanged — same instruction count, a shift by
13 instead of 14 and an 8-entry array instead of 4.

**Verification for this commit alone:** the existing Z80 test suite plus phase 1's
screen tests must pass with zero output differences. No behaviour change is
intended, so any diff is a bug.

### 2. Memory budget

New 8 KB page allocation:

| Pages | Contents | Size |
|---|---|---|
| 0–15 | 128 KB RAM | 128 KB |
| 16–17 | 128 ROM 0 | 16 KB |
| 18–19 | 128 ROM 1 | 16 KB |
| 20–21 | 48 ROM | 16 KB |
| 22–23 | ROM-write scratch | 16 KB |
| 24–25 | Pentagon ROM 0 | 16 KB |
| 26–27 | TRDOS ROM | 16 KB |
| 28–29 | TC2048 ROM (phase 1) | 16 KB |
| 30–31 | TS2068 HOME ROM | 16 KB |
| 32 | TS2068 EXROM | 8 KB |
| 33–40 | DOCK cartridge | 64 KB |

That is 41 pages = 328 KB. Round `machineMemory` up to 64 pages = **512 KB
(`0x80000`)**, leaving room for later machines.

Static allocations currently total roughly 537 KB against a `memoryBase` of
589,824 in `asconfig.json`. Growing `machineMemory` from `0x40000` to `0x80000`
adds 256 KB, pushing the total to about 800 KB. **`memoryBase` must rise to
1,048,576 (`0x100000`).**

### 3. Machine identity and timing

New `machineType = 2068`.

TS2068 is NTSC: 3.528 MHz, 262 scanlines. The visible 240-line window
(24 + 192 + 24) still fits, so only three parameters change — the frame buffer
layout and `screenEvents` structure are untouched.

**Starting assumption: 224 T-states per line x 262 lines = 58,688 T-states per
frame** (about 60.1 Hz). This is the single least certain number in this design
and **must be confirmed before anything else is tuned**, by comparing interrupt
timing and frame rate against ZEsarUX's `ts2068`. `mainScreenStartTstate` must be
derived from the same reference rather than assumed.

`buildContentionTable` is called with the TS2068 row length; whether the Timex
contention *pattern* matches the Spectrum's is item 3 in the verification list
below.

Optional near-free variant: **TC2068** is the same machine with PAL timing
(3.5469 MHz, 69,888 T-states). Once TS2068 works it is a timing-table entry and a
menu item. Treat as a follow-up, not part of this phase.

### 4. Memory banking: ports `0xF4` and `0xFF` bit 7

**Port `0xF4` — horizontal select register.** An 8-bit bank-enable register, one
bit per 8 KB chunk. Bit N controls the chunk at address `N * 0x2000`:

- bit clear -> chunk comes from the HOME bank
- bit set -> chunk comes from the currently selected alternate bank

Reads of `0xF4` return the current register value.

**Port `0xFF` bit 7** selects the alternate bank: 0 = DOCK, 1 = EXROM. This is the
same SCLD register phase 1 already handles for video, so the write path exists —
bit 7 just gains a meaning, and a change to it must trigger a re-evaluation of the
page maps.

**HOME bank layout:** chunks 0–1 = HOME ROM (read-only, writes go to scratch),
chunks 2–7 = the 48 KB RAM.

**EXROM is only 8 KB**, so when EXROM is selected it appears *mirrored* in every
enabled chunk. This is real hardware behaviour, not a shortcut, and the tape trap
depends on it (see below).

Implementation shape: a single `updateTimexPageMaps()` that rebuilds
`memoryPageReadMap` / `memoryPageWriteMap` from `(port0xF4, port0xFF bit 7,
dockChunkPresent[], dockChunkIsRAM[])`. Called on writes to `0xF4`, on writes to
`0xFF` that change bit 7, on reset, and after a cartridge is inserted. Nothing on
the hot memory-access path changes.

### 5. AY-3-8912 on ports `0xF5` / `0xF6`

TS2068 puts the AY at `0xF5` (register select, write) and `0xF6` (data,
read/write) — not at the 128K's `0xFFFD` / `0xBFFD`. The AY emulation itself
(`writeAYRegister`, `readAYRegister`, the mixer in `updateAudioBufferInner`) is
already present and complete; only the port decode is new.

**Decode conflict to resolve.** `0xF6` has A0 = 0, so under the current
`writePort` structure it would *also* hit the ULA border/speaker branch
(`!(addr & 0x0001)`). Writing an AY data byte would flicker the border.

Default resolution: for `machineType == 2068`, test the Timex port decodes
**before** the generic ULA branch, so `0xF6` reaches the AY only. This is item 2
in the verification list — confirm against ZEsarUX whether a write to `0xF6` on a
real TS2068 disturbs the border.

Because writes to `0xF6` change AY state, the branch must call
`updateAudioBuffer(t)` before `writeAYRegister`, exactly as the existing
`0xBFFD` branch does.

**Joysticks.** TS2068's two joystick ports are read through AY I/O port A
(register 14). Initial implementation: reading register 14 returns `0xFF`
(active-low, nothing pressed), matching how the existing Kempston stub returns
"no input". Wiring real input is a follow-up.

### 6. Tape loading — easier than expected

`LD-BYTES` is not in the HOME ROM at all. It lives in the **EXROM**, and it is the
48K routine **relocated by a uniform −0x045A**:

| 48K ROM | TS2068 EXROM | Note |
|---|---|---|
| `0x0562` | `0x0108` | `IN A,(0FEh)` — start of the sampling loop |
| `0x0567` | `0x010D` | 11 bytes identical |
| `0x056B` | `0x0111` | `RET NZ` — **the existing trap point** |
| `0x05E7` | `0x018D` | `CALL LD-EDGE-1`, delta 0x85 preserved |
| `0x05E2` | `0x0188` | trap **exit** address |

Since the EXROM is mapped at `0x0000`–`0x1FFF` when selected, the trap fires at
**`pc == 0x0111`** — which is *already* one of the two constants in the existing
check at `core.ts.in:863`:

```
if ((pc == 0x056b || pc == 0x0111)
    && (memoryPageReadMap[0] == 9 || memoryPageReadMap[0] == 10)
    && tapeTrapsEnabled && willTrap)
```

Only the page-identity test needs extending to recognise the EXROM page. The
trap exit in `worker.js:113` (`core.setPC(0x05e2)`) becomes machine-dependent:
`0x0188` for TS2068.

Pulse-level loading remains the fallback for anything that loads through DOCK
code or a custom loader, exactly as it is for other machines.

**Tape autoload.** `tape_48.szx` will not work — different ROM, different BASIC
entry points. TS2068 is omitted from `TAPE_LOADERS_BY_MACHINE` in this phase and
autoload is disabled for it, documented in the README. Producing a TS2068
autoloader snapshot is a follow-up.

### 7. `.DCK` cartridge images

Format (to be confirmed against the published spec and Fuse's `dck.c` before
implementation):

```
byte 0      bank ID: 0 = DOCK, 1 = EXROM
bytes 1..8  one descriptor per 8 KB chunk:
              bit 0 -> chunk is RAM (else ROM)
              bit 1 -> chunk data is present in the file
              0     -> chunk absent
then        8192 bytes per chunk marked "data present", in ascending chunk order
```

Loading a `.DCK` populates the DOCK pages and sets the per-chunk present/RAM
flags used by `updateTimexPageMaps()`. Plumbing follows the existing file-open
path in `jsspeccy.js` and a new `openDCKFile` worker message, mirroring
`openTAPFile`.

Many TS2068 cartridges auto-start on reset, so inserting one should reset the
machine.

### 8. Runtime, UI and snapshots

- `jsspeccy.js` — load `ts2068-home.rom` and `ts2068-exrom.rom` (split from
  ZEsarUX's 24 KB `ts2068.rom` at offset `0x4000`); machine menu item; canvas
  width 640 as for TC2048
- `snapshot.js` — SZX `ZXSTMID_TS2068` (12) and `ZXSTMID_TC2068` (9); `.z80`
  hardware mode 128 for TS2068 and 15 for TC2068 (both to be confirmed against
  the format specs). DOCK/EXROM contents and the `0xF4` register must be
  restored, not just RAM
- `worker.js` — restore `0xF4` and the SCLD byte in `loadSnapshot`
- README machine list and cartridge instructions, CHANGELOG

### 9. ROM licensing

Same position as phase 1: the TS2068 ROMs belong to Timex Corporation, not
Amstrad, so they fall outside the permission that covers the Sinclair ROMs
already in `static/roms/`. Ship them for usability, raise the question explicitly
in the PR, and keep ROM loading structured so it can be swapped to configurable
URLs in one commit.

## Suggested commit sequence

1. 8 KB paging conversion — no behaviour change, existing tests must be identical
2. `memoryBase` bump and page-number reallocation
3. TS2068 machine type, timing tables, ROM loading, reset state
4. Port `0xF4` / `0xFF` bit 7 banking
5. AY on `0xF5` / `0xF6`, including the `0xF6` decode-order fix
6. Tape trap extension
7. `.DCK` cartridge loading
8. Snapshots, menu, README, CHANGELOG

Steps 1 and 2 are pure refactoring and should be reviewable independently of
anything Timex-specific.

## Testing

Building on phase 1's `test/screen/` harness:

1. **Paging conversion regression** — all existing Z80 tests plus phase 1 screen
   tests byte-identical before and after step 1.
2. **`0xF4` banking** — set each bit, assert reads at `N * 0x2000` come from
   DOCK/EXROM/HOME as expected; assert EXROM mirroring across multiple enabled
   chunks.
3. **`0xFF` bit 7** — flip DOCK/EXROM with `0xF4` non-zero, assert the maps
   change without touching video mode bits.
4. **AY decode** — write `0xF5`/`0xF6`, assert the register file updates and the
   border does **not** change.
5. **Tape trap** — assert the trap fires at `pc == 0x0111` only when EXROM is
   mapped into chunk 0, and exits at `0x0188`.
6. **`.DCK` load** — a synthetic cartridge with a known pattern per chunk.

Then side-by-side against ZEsarUX's `ts2068`, which emulates all four Timex video
modes and the cartridge system.

## Details to settle empirically

Concrete starting assumptions, each with a stated way to confirm it. Item 1 gates
the rest.

1. **NTSC frame timing.** Assume 224 T-states x 262 lines = 58,688 T/frame at
   3.528 MHz. Confirm against ZEsarUX before tuning anything else — every other
   timing-sensitive result depends on it. `mainScreenStartTstate` to be derived
   from the same reference.
2. **Port `0xF6` and the border.** Assume the Timex decode takes precedence and
   `0xF6` does not disturb the border. Confirm by writing `0xF6` in ZEsarUX and
   watching the border.
3. **Contention pattern.** Assume the Spectrum pattern with the TS2068 row
   length. The SCLD's dual-display-file fetches may differ.
4. **`.DCK` chunk descriptor encoding.** Assume the bit-0 = RAM / bit-1 = data
   present reading above; confirm against the format spec.
5. **`.z80` hardware-mode numbers** for TS2068 and TC2068.
6. **Port `0xFF` bit 6** — disables the ULA interrupt on TS2068. Assume software
   rarely uses it; implement it as a simple gate on interrupt generation.

## Out of scope

- TC2068 PAL variant (near-free follow-up once TS2068 works)
- Real joystick input through AY port A
- A TS2068 tape autoloader snapshot
- The TS2068's serial and cartridge-bus peripherals
