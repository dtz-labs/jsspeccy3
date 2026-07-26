import { exit } from 'process';
import * as core from '../dist/jsspeccy/jsspeccy-core.wasm';

const FRAME_BUFFER_SIZE = 0x6a00;
const MODE_LOG_OFFSET = 0x6600;

/* Frame buffer landmarks, per tech_notes.md.
   Main screen line N starts at 0x0f00 + N * 0x60, and its 32 cells of
   (bitmap, attr) pairs start 0x10 bytes into that, after the left border. */
const screenLine = (n) => 0x0f00 + n * 0x60 + 0x10;

const frame = new Uint8Array(core.memory.buffer, core.FRAME_BUFFER, FRAME_BUFFER_SIZE);

let failureCount = 0;
function check(testName, label, actual, expected) {
    if (actual !== expected) {
        failureCount++;
        console.log(
            `FAIL ${testName} / ${label}: expected 0x${expected.toString(16)}, got 0x${actual.toString(16)}`
        );
    }
}

function fail(testName, message) {
    failureCount++;
    console.log(`FAIL ${testName}: ${message}`);
}

/* Clear the 16K of RAM that page 5 holds, so tests never see stale bytes. */
function clearScreenRam() {
    for (let addr = 0x4000; addr < 0x8000; addr++) core.poke(addr, 0x00);
}

/* Select a machine and put it in a state where a whole frame will run.

   No ROM is loaded under test, so ROM pages read as zeroes, which the Z80
   executes as NOPs. PC therefore walks up through 0x056b -- the tape trap
   address -- at t ~= 5548, which would abort runFrame() with status 2 before
   the main screen is reached at t = 14335. Disable traps so the frame
   completes; testTapeTrap re-enables them deliberately. */
function selectMachine(type) {
    core.setMachineType(type);
    core.setTapeTraps(false);
    clearScreenRam();
}

function test48KBaseline() {
    const name = '48K baseline';
    selectMachine(48);
    core.poke(0x4000, 0xaa);   // line 0, cell 0 bitmap
    core.poke(0x5800, 0x47);   // line 0, cell 0 attribute
    core.runFrame();
    const p = screenLine(0);
    check(name, 'bitmap', frame[p], 0xaa);
    check(name, 'attr', frame[p + 1], 0x47);
}

function testTC2048StandardMode() {
    const name = 'TC2048 mode 0 (standard, DF0)';
    selectMachine(2048);
    core.writePort(0x00ff, 0x00);
    core.poke(0x4000, 0xaa);
    core.poke(0x5800, 0x47);
    core.runFrame();
    const p = screenLine(0);
    check(name, 'bitmap', frame[p], 0xaa);
    check(name, 'attr', frame[p + 1], 0x47);
}

function testTC2048TapeTrap() {
    const name = 'TC2048 tape trap';
    core.setMachineType(2048);
    core.setTapeTraps(true);
    core.setPC(0x056b);
    check(name, 'status', core.runFrame(), 2);
    core.setTapeTraps(false);
}

test48KBaseline();
testTC2048StandardMode();
testTC2048TapeTrap();

if (failureCount) {
    console.log(`${failureCount} screen test failure(s)`);
    exit(1);
}
console.log('Screen tests passed');
