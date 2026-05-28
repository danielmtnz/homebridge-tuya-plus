'use strict';

const SimpleGarageDoorAccessory = require('../lib/SimpleGarageDoorAccessory');
const { HAP, makeInstance } = require('./support/mocks');

const { CurrentDoorState: CDS, TargetDoorState: TDS } = HAP.Characteristic;

const POST_RESET_DELAY_MS = 500;
const STOP_RESET_TIMEOUT_MS = 3000;
const DIRECTION_RESET_TIMEOUT_MS = 3000;

// Give the device's `on`/`removeListener` mocks real subscription semantics
// so the accessory can wait for `change` events the way it does in production.
function installRealEvents(device) {
    const handlers = new Map();
    device.on = jest.fn((event, handler) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event).push(handler);
    });
    device.removeListener = jest.fn((event, handler) => {
        const list = handlers.get(event);
        if (!list) return;
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
    });
    device.emit = (event, ...args) => {
        const list = handlers.get(event);
        if (list) list.slice().forEach(h => h(...args));
    };
    device.listenerCount = (event) => (handlers.get(event) || []).length;
}

function makeSimpleGarage(initialContext = {}) {
    const { instance, device, accessory, platform } = makeInstance(
        SimpleGarageDoorAccessory,
        {},
        { manufacturer: 'Generic', ...initialContext }
    );

    installRealEvents(device);

    // Mirror the state that _registerCharacteristics would set up. We can't
    // call it directly because the mock service shares a single mock
    // characteristic across calls — wiring each role manually keeps the
    // assertions untangled.
    instance.dpOpen = '1';
    instance.dpStop = '2';
    instance.dpClose = '3';
    instance.currentDoorState = CDS.OPEN;
    instance.desiredTarget = TDS.OPEN;
    instance.worker = null;
    instance.characteristicCurrentDoorState = {
        value: CDS.OPEN,
        updateValue: jest.fn().mockImplementation(function(v) { this.value = v; return this; }),
    };
    accessory.context.cachedTargetDoorState = TDS.OPEN;

    // Mirror the persistent change listener registered in production.
    device.on('change', changes => instance._onDeviceChange(changes));

    return { instance, device, accessory, platform };
}

// Simulate the device echoing a DP back to false (its "command consumed"
// signal). Drives both the worker's per-step listener and the persistent
// CurrentDoorState listener.
function emitReset(device, dp) {
    device.emit('change', { [dp]: false }, { [dp]: false });
}

// ---------------------------------------------------------------------------
// _onDeviceChange — the persistent listener that drives CurrentDoorState
// ---------------------------------------------------------------------------
describe('SimpleGarageDoorAccessory._onDeviceChange', () => {
    test('Open DP resetting to false sets CurrentDoorState to OPEN', () => {
        const { instance } = makeSimpleGarage();
        instance.currentDoorState = CDS.CLOSED;
        instance.characteristicCurrentDoorState.value = CDS.CLOSED;

        instance._onDeviceChange({ '1': false });

        expect(instance.currentDoorState).toBe(CDS.OPEN);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);
    });

    test('Close DP resetting to false sets CurrentDoorState to CLOSED', () => {
        const { instance } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;
        instance.characteristicCurrentDoorState.value = CDS.OPEN;

        instance._onDeviceChange({ '3': false });

        expect(instance.currentDoorState).toBe(CDS.CLOSED);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.CLOSED);
    });

    test('Open DP echoing back to true does not change CurrentDoorState', () => {
        const { instance } = makeSimpleGarage();
        instance.currentDoorState = CDS.CLOSED;

        instance._onDeviceChange({ '1': true });

        expect(instance.currentDoorState).toBe(CDS.CLOSED);
    });

    test('Stop DP resets do not change CurrentDoorState', () => {
        const { instance } = makeSimpleGarage();
        instance.currentDoorState = CDS.CLOSED;

        instance._onDeviceChange({ '2': false });

        expect(instance.currentDoorState).toBe(CDS.CLOSED);
    });

    test('No characteristic write when CurrentDoorState already matches', () => {
        const { instance } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;

        instance._onDeviceChange({ '1': false });

        expect(instance.characteristicCurrentDoorState.updateValue).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// setTargetDoorState — single command (target differs from current)
// ---------------------------------------------------------------------------
describe('SimpleGarageDoorAccessory.setTargetDoorState — single command', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('OPEN sends stop, waits for stop reset + 500ms, then sends open; CurrentDoorState flips on open reset', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.CLOSED;
        instance.characteristicCurrentDoorState.value = CDS.CLOSED;
        instance.desiredTarget = TDS.CLOSED;

        instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenNthCalledWith(1, { '2': true });

        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS - 1);
        expect(device.update).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        expect(device.update).toHaveBeenNthCalledWith(2, { '1': true });
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.CLOSED);

        emitReset(device, '1');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);
        expect(instance.worker).toBeNull();
    });

    test('CLOSE sends stop, waits, then sends close; CurrentDoorState flips on close reset', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;
        instance.characteristicCurrentDoorState.value = CDS.OPEN;

        instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenNthCalledWith(1, { '2': true });

        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '3': true });

        emitReset(device, '3');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.CLOSED);
        expect(instance.worker).toBeNull();
    });

    test('Target matching current produces no commands', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;
        instance.desiredTarget = TDS.OPEN;

        instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(
            STOP_RESET_TIMEOUT_MS + POST_RESET_DELAY_MS + DIRECTION_RESET_TIMEOUT_MS
        );

        expect(device.update).not.toHaveBeenCalled();
        expect(instance.worker).toBeNull();
    });

    test('Custom DPs are respected', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.dpOpen = '101';
        instance.dpStop = '102';
        instance.dpClose = '103';
        instance.currentDoorState = CDS.CLOSED;

        instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenNthCalledWith(1, { '102': true });

        emitReset(device, '102');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '101': true });

        emitReset(device, '101');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);
    });
});

// ---------------------------------------------------------------------------
// Spam / re-entrancy
// ---------------------------------------------------------------------------
describe('SimpleGarageDoorAccessory.setTargetDoorState — spam toggling', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('Toggling back to current state during stop suppresses the direction command', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;

        instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenNthCalledWith(1, { '2': true });

        // User reverts mid-stop.
        instance.setTargetDoorState(TDS.OPEN);

        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);

        // Only stop was sent — no direction.
        expect(device.update).toHaveBeenCalledTimes(1);
        expect(instance.worker).toBeNull();
    });

    test('Latest desired target wins among multiple toggles during stop', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;

        instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);

        // Spam — final state is CLOSED.
        instance.setTargetDoorState(TDS.OPEN);
        instance.setTargetDoorState(TDS.CLOSED);
        instance.setTargetDoorState(TDS.OPEN);
        instance.setTargetDoorState(TDS.CLOSED);

        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '3': true });

        emitReset(device, '3');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.CLOSED);
        expect(instance.worker).toBeNull();
    });

    test('Toggling to opposite after the direction completes triggers a fresh stop+direction', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;
        instance.characteristicCurrentDoorState.value = CDS.OPEN;

        instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);
        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        emitReset(device, '3');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.CLOSED);
        expect(instance.worker).toBeNull();

        // User reverses.
        instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenNthCalledWith(3, { '2': true });

        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(4, { '1': true });

        emitReset(device, '1');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);
    });

    test('Toggling to opposite while the direction is in flight queues a follow-up stop+direction', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;
        instance.characteristicCurrentDoorState.value = CDS.OPEN;

        instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);
        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '3': true });

        // Reverse mid-direction.
        instance.setTargetDoorState(TDS.OPEN);
        emitReset(device, '3');
        await jest.advanceTimersByTimeAsync(0);
        // Close reset flipped UI to CLOSED, then the loop noticed target=OPEN
        // and sent the next stop.
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.CLOSED);
        expect(device.update).toHaveBeenNthCalledWith(3, { '2': true });

        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(4, { '1': true });

        emitReset(device, '1');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);
        expect(instance.worker).toBeNull();
    });

    test('Pressing the same target repeatedly while the worker runs is a no-op', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;

        instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);
        const callsAfterFirstStop = device.update.mock.calls.length;

        instance.setTargetDoorState(TDS.CLOSED);
        instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);
        expect(device.update.mock.calls.length).toBe(callsAfterFirstStop);

        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        emitReset(device, '3');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.worker).toBeNull();
    });

    test('Only a single worker is active across rapid toggles', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;

        instance.setTargetDoorState(TDS.CLOSED);
        const workerA = instance.worker;
        instance.setTargetDoorState(TDS.OPEN);
        instance.setTargetDoorState(TDS.CLOSED);
        expect(instance.worker).toBe(workerA);

        await jest.advanceTimersByTimeAsync(0);
        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        emitReset(device, '3');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.worker).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Timeout fallbacks
// ---------------------------------------------------------------------------
describe('SimpleGarageDoorAccessory — timeout fallbacks', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('Falls back to sending the direction after STOP_RESET_TIMEOUT_MS if no echo arrives', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.CLOSED;

        instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(STOP_RESET_TIMEOUT_MS + POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '1': true });

        emitReset(device, '1');
        await jest.advanceTimersByTimeAsync(0);
        expect(instance.worker).toBeNull();
    });

    test('Worker exits and force-flips CurrentDoorState after DIRECTION_RESET_TIMEOUT_MS when the echo is missed', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.CLOSED;
        instance.characteristicCurrentDoorState.value = CDS.CLOSED;

        instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(0);
        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '1': true });

        await jest.advanceTimersByTimeAsync(DIRECTION_RESET_TIMEOUT_MS);
        // No echo arrived, but the worker mirrors the target anyway so the
        // loop can settle.
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);
        expect(instance.worker).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Disconnect handling
// ---------------------------------------------------------------------------
describe('SimpleGarageDoorAccessory — disconnected', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('Skips writes when the device is disconnected', async () => {
        const { instance, device } = makeSimpleGarage();
        device.connected = false;
        instance.currentDoorState = CDS.CLOSED;

        instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(
            STOP_RESET_TIMEOUT_MS + POST_RESET_DELAY_MS + DIRECTION_RESET_TIMEOUT_MS
        );
        expect(device.update).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
describe('SimpleGarageDoorAccessory persistence', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('Stores the latest target on the accessory context', async () => {
        const { instance, device, accessory } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;

        instance.setTargetDoorState(TDS.CLOSED);
        expect(accessory.context.cachedTargetDoorState).toBe(TDS.CLOSED);

        instance.setTargetDoorState(TDS.OPEN);
        expect(accessory.context.cachedTargetDoorState).toBe(TDS.OPEN);

        // Drain so the worker resolves cleanly.
        await jest.advanceTimersByTimeAsync(0);
        emitReset(device, '2');
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
    });
});
