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

function testTC2048SCLDPortRoundTrip() {
    const name = 'TC2048 SCLD port';
    selectMachine(2048);
    core.writePort(0x00ff, 0x06);
    check(name, 'read back', core.readPort(0x00ff), 0x06);

    // port 0xFE must still drive the border, not the SCLD
    core.writePort(0x00fe, 0x02);
    check(name, 'unchanged by 0xFE', core.readPort(0x00ff), 0x06);

    // any port whose low byte is 0xff hits the SCLD
    core.writePort(0x7fff, 0x01);
    check(name, 'decoded on low byte', core.readPort(0xbfff), 0x01);

    core.reset();
    check(name, 'cleared by reset', core.readPort(0x00ff), 0x00);
}

function test48KPortFFUnaffected() {
    const name = '48K port 0xFF';
    selectMachine(48);
    // On a 48K the SCLD does not exist; 0xFF is the floating bus and a write
    // to it must not be swallowed by the Timex branch.
    core.writePort(0x00ff, 0x06);
    const result = core.readPort(0x00ff);
    if (result === 0x06) {
        fail(name, 'port 0xFF behaved as an SCLD register on a 48K');
    }
}

function testTC2048SecondDisplayFile() {
    const name = 'TC2048 mode 1 (DF1)';
    selectMachine(2048);
    core.writePort(0x00ff, 0x01);
    core.poke(0x4000, 0x11);   // DF0 - must be ignored
    core.poke(0x5800, 0x22);
    core.poke(0x6000, 0x3c);   // DF1 bitmap
    core.poke(0x7800, 0x12);   // DF1 attribute
    core.runFrame();
    const p = screenLine(0);
    check(name, 'bitmap', frame[p], 0x3c);
    check(name, 'attr', frame[p + 1], 0x12);
}

function testTC2048HiColour() {
    const name = 'TC2048 mode 2 (hi-colour)';
    selectMachine(2048);
    core.writePort(0x00ff, 0x02);
    // line 0: bitmap at 0x4000, attribute at 0x6000
    core.poke(0x4000, 0xaa);
    core.poke(0x6000, 0x21);
    // line 1: bitmap at 0x4100, attribute at 0x6100 - proves 8x1 attributes
    core.poke(0x4100, 0x55);
    core.poke(0x6100, 0x34);
    // the classic attribute file must be ignored entirely
    core.poke(0x5800, 0xff);
    core.runFrame();
    const p0 = screenLine(0);
    check(name, 'line 0 bitmap', frame[p0], 0xaa);
    check(name, 'line 0 attr', frame[p0 + 1], 0x21);
    const p1 = screenLine(1);
    check(name, 'line 1 bitmap', frame[p1], 0x55);
    check(name, 'line 1 attr', frame[p1 + 1], 0x34);
}

function testTC2048HiRes() {
    const name = 'TC2048 mode 6 (hi-res)';
    selectMachine(2048);
    core.writePort(0x00ff, 0x06);
    core.poke(0x4000, 0x11);
    core.poke(0x6000, 0x22);
    core.poke(0x4001, 0x33);
    core.poke(0x6001, 0x44);
    core.runFrame();
    const p = screenLine(0);
    check(name, 'byte 0 (DF0 n)', frame[p], 0x11);
    check(name, 'byte 1 (DF1 n)', frame[p + 1], 0x22);
    check(name, 'byte 2 (DF0 n+1)', frame[p + 2], 0x33);
    check(name, 'byte 3 (DF1 n+1)', frame[p + 3], 0x44);
}

test48KBaseline();
testTC2048StandardMode();
testTC2048SecondDisplayFile();
testTC2048HiColour();
testTC2048HiRes();
testTC2048TapeTrap();
testTC2048SCLDPortRoundTrip();
test48KPortFFUnaffected();

if (failureCount) {
    console.log(`${failureCount} screen test failure(s)`);
    exit(1);
}
console.log('Screen tests passed');
