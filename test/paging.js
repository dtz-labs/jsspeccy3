import { exit } from 'process';
import core from './core.js';

/* The core pages memory in 8K units, so each 16K bank occupies two
   consecutive page numbers: 8K page 2n covers the same bytes as 16K page n.
   These tests read the page maps directly, which is the only way to assert on
   ROM paging without loading real ROM images. */
const readMap = new Uint8Array(core.memory.buffer, core.MEMORY_PAGE_READ_MAP, 8);
const writeMap = new Uint8Array(core.memory.buffer, core.MEMORY_PAGE_WRITE_MAP, 8);

let failureCount = 0;
function checkMap(testName, label, actual, expected) {
    const a = Array.from(actual).join(',');
    const e = expected.join(',');
    if (a !== e) {
        failureCount++;
        console.log(`FAIL ${testName} / ${label}: expected [${e}], got [${a}]`);
    }
}
function check(testName, label, actual, expected) {
    if (actual !== expected) {
        failureCount++;
        console.log(`FAIL ${testName} / ${label}: expected ${expected}, got ${actual}`);
    }
}

function testResetMaps() {
    const name = 'reset page maps';
    core.setMachineType(48);
    checkMap(name, '48K read', readMap, [20, 21, 10, 11, 4, 5, 0, 1]);
    checkMap(name, '48K write', writeMap, [22, 23, 10, 11, 4, 5, 0, 1]);

    core.setMachineType(128);
    checkMap(name, '128K read', readMap, [16, 17, 10, 11, 4, 5, 0, 1]);

    core.setMachineType(5);
    checkMap(name, 'Pentagon read', readMap, [24, 25, 10, 11, 4, 5, 0, 1]);

    core.setMachineType(2048);
    checkMap(name, 'TC2048 read', readMap, [28, 29, 10, 11, 4, 5, 0, 1]);
}

function test128RamBankSelect() {
    const name = '128K RAM bank select';
    core.setMachineType(128);
    for (let bank = 0; bank < 8; bank++) {
        core.writePort(0x7ffd, bank);
        // 16K bank n occupies 8K pages 2n and 2n+1, in slots 6 and 7
        checkMap(name, `bank ${bank}`, readMap.slice(6, 8), [bank * 2, bank * 2 + 1]);
        checkMap(name, `bank ${bank} write`, writeMap.slice(6, 8), [bank * 2, bank * 2 + 1]);
    }
}

function test128RamBankIsAddressable() {
    /* Both 8K halves of the paged bank must be reachable, which is what would
       break if only slot 6 were updated. */
    const name = '128K bank addressable';
    core.setMachineType(128);
    for (let bank = 0; bank < 8; bank++) {
        core.writePort(0x7ffd, bank);
        core.poke(0xc000, 0xa0 + bank);   // low half  -> slot 6
        core.poke(0xe000, 0xb0 + bank);   // high half -> slot 7
    }
    for (let bank = 0; bank < 8; bank++) {
        core.writePort(0x7ffd, bank);
        check(name, `bank ${bank} low`, core.peek(0xc000), 0xa0 + bank);
        check(name, `bank ${bank} high`, core.peek(0xe000), 0xb0 + bank);
    }
}

function test128RomSelect() {
    const name = '128K ROM select';
    core.setMachineType(128);
    core.writePort(0x7ffd, 0x00);
    checkMap(name, 'ROM 0', readMap.slice(0, 2), [16, 17]);
    core.writePort(0x7ffd, 0x10);
    checkMap(name, 'ROM 1', readMap.slice(0, 2), [18, 19]);
}

function testPagingLock() {
    const name = '128K paging lock';
    core.setMachineType(128);
    core.writePort(0x7ffd, 0x20 | 0x03);        // select bank 3 and lock
    checkMap(name, 'locked selection', readMap.slice(6, 8), [6, 7]);
    core.writePort(0x7ffd, 0x05);               // must be ignored
    checkMap(name, 'still bank 3', readMap.slice(6, 8), [6, 7]);
}

function test48KPagingIgnored() {
    const name = '48K ignores paging';
    core.setMachineType(48);
    const before = Array.from(readMap);
    core.writePort(0x7ffd, 0x07);
    checkMap(name, 'unchanged', readMap, before);
}

function testScreenBankFollowsPaging() {
    /* Bit 3 of 0x7ffd switches the displayed screen from bank 5 to bank 7.
       Poke a marker into each and confirm the framebuffer follows. */
    const name = 'shadow screen select';
    const FRAME_BUFFER_SIZE = 0x6a00;
    const frame = new Uint8Array(core.memory.buffer, core.FRAME_BUFFER, FRAME_BUFFER_SIZE);
    const firstScreenByte = 0x0f00 + 0x10;

    core.setMachineType(128);
    core.setTapeTraps(false);

    core.writePort(0x7ffd, 0x05);   // page bank 5 in at 0xc000 so we can write it
    core.poke(0xc000, 0x5a);
    core.writePort(0x7ffd, 0x07);
    core.poke(0xc000, 0x77);

    core.writePort(0x7ffd, 0x00);   // normal screen = bank 5
    core.runFrame();
    check(name, 'normal screen', frame[firstScreenByte], 0x5a);

    core.writePort(0x7ffd, 0x08);   // shadow screen = bank 7
    core.runFrame();
    check(name, 'shadow screen', frame[firstScreenByte], 0x77);
}

testResetMaps();
test128RamBankSelect();
test128RamBankIsAddressable();
test128RomSelect();
testPagingLock();
test48KPagingIgnored();
testScreenBankFollowsPaging();

if (failureCount) {
    console.log(`${failureCount} paging test failure(s)`);
    exit(1);
}
console.log('Paging tests passed');
