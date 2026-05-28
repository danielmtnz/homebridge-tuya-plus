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

function makeSimpleGarage(contextOverrides = {}) {
    const { instance, device, accessory, platform } = makeInstance(
        SimpleGarageDoorAccessory,
        {},
        { manufacturer: 'Generic', ...contextOverrides }
    );

    installRealEvents(device);

    // Replicate what _registerCharacteristics would set up.
    instance.dpOpen = '1';
    instance.dpStop = '2';
    instance.dpClose = '3';
    instance.opToken = 0;
    instance.currentDoorState = CDS.OPEN;
    instance.characteristicCurrentDoorState = {
        value: CDS.OPEN,
        updateValue: jest.fn().mockImplementation(function(v) { this.value = v; return this; }),
    };

    return { instance, device, accessory, platform };
}

// ---------------------------------------------------------------------------
// setTargetDoorState — device commands
// ---------------------------------------------------------------------------
describe('SimpleGarageDoorAccessory.setTargetDoorState — device commands', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('OPEN sends stop=true, waits for stop reset, then sends open=true 500ms later', async () => {
        const { instance, device } = makeSimpleGarage();
        const op = instance.setTargetDoorState(TDS.OPEN);

        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenCalledTimes(1);
        expect(device.update).toHaveBeenNthCalledWith(1, { '2': true });

        // Even after a full second the open should not have been sent yet —
        // we're still waiting on the reset echo.
        await jest.advanceTimersByTimeAsync(1000);
        expect(device.update).toHaveBeenCalledTimes(1);

        // Device echoes the stop DP back to false (it auto-resets).
        device.emit('change', { '2': false }, { '2': false });

        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS - 1);
        expect(device.update).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1);
        expect(device.update).toHaveBeenCalledTimes(2);
        expect(device.update).toHaveBeenNthCalledWith(2, { '1': true });

        // Direction reset closes out the chain.
        device.emit('change', { '1': false }, { '1': false });
        await op;
    });

    test('CLOSED waits for stop reset, then sends close=true', async () => {
        const { instance, device } = makeSimpleGarage();
        const op = instance.setTargetDoorState(TDS.CLOSED);

        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenNthCalledWith(1, { '2': true });

        device.emit('change', { '2': false }, { '2': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '3': true });

        device.emit('change', { '3': false }, { '3': false });
        await op;
    });

    test('A {dp: true} echo does not satisfy the reset wait', async () => {
        const { instance, device } = makeSimpleGarage();
        const op = instance.setTargetDoorState(TDS.OPEN);

        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenCalledTimes(1);

        // Device first echoes the stop DP back to true (acknowledging our write).
        // This should NOT be treated as the reset.
        device.emit('change', { '2': true }, { '2': true });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenCalledTimes(1);

        // Then the device resets it to false.
        device.emit('change', { '2': false }, { '2': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '1': true });

        device.emit('change', { '1': false }, { '1': false });
        await op;
    });

    test('Falls back to sending the direction after STOP_RESET_TIMEOUT_MS if no echo arrives', async () => {
        const { instance, device } = makeSimpleGarage();
        const op = instance.setTargetDoorState(TDS.OPEN);

        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(STOP_RESET_TIMEOUT_MS - 1);
        expect(device.update).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1 + POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '1': true });

        device.emit('change', { '1': false }, { '1': false });
        await op;
    });

    test('Cleans up the change listener once the wait resolves', async () => {
        const { instance, device } = makeSimpleGarage();
        const op = instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(0);
        expect(device.listenerCount('change')).toBe(1);

        device.emit('change', { '2': false }, { '2': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        // Direction listener should now be attached.
        expect(device.listenerCount('change')).toBe(1);

        device.emit('change', { '1': false }, { '1': false });
        await op;
        expect(device.listenerCount('change')).toBe(0);
    });

    test('Custom DPs are respected', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.dpOpen = '101';
        instance.dpStop = '102';
        instance.dpClose = '103';
        const op = instance.setTargetDoorState(TDS.OPEN);

        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenNthCalledWith(1, { '102': true });

        device.emit('change', { '102': false }, { '102': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenNthCalledWith(2, { '101': true });

        device.emit('change', { '101': false }, { '101': false });
        await op;
    });

    test('Skips writes when the device is disconnected', async () => {
        const { instance, device } = makeSimpleGarage();
        device.connected = false;
        const op = instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(
            STOP_RESET_TIMEOUT_MS + POST_RESET_DELAY_MS + DIRECTION_RESET_TIMEOUT_MS
        );
        await op;
        expect(device.update).not.toHaveBeenCalled();
    });

    test('Reversing during the stop->direction wait cancels the pending direction command', async () => {
        const { instance, device } = makeSimpleGarage();
        const op1 = instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(0);
        expect(device.update).toHaveBeenNthCalledWith(1, { '2': true });

        const op2 = instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);

        // A second stop is sent; the originally-pending open must not fire.
        expect(device.update).toHaveBeenCalledTimes(2);
        expect(device.update).toHaveBeenNthCalledWith(2, { '2': true });

        device.emit('change', { '2': false }, { '2': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(device.update).toHaveBeenCalledTimes(3);
        expect(device.update).toHaveBeenNthCalledWith(3, { '3': true });

        device.emit('change', { '3': false }, { '3': false });
        await op1;
        await op2;
    });
});

// ---------------------------------------------------------------------------
// CurrentDoorState transition
// ---------------------------------------------------------------------------
describe('SimpleGarageDoorAccessory.setTargetDoorState — CurrentDoorState transition', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    test('CurrentDoorState flips when the direction DP echoes back to false', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.CLOSED;
        instance.characteristicCurrentDoorState.value = CDS.CLOSED;

        const op = instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(0);
        device.emit('change', { '2': false }, { '2': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);

        // Direction has been sent but not yet acknowledged — UI still old.
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.CLOSED);

        device.emit('change', { '1': false }, { '1': false });
        await op;
        expect(instance.currentDoorState).toBe(CDS.OPEN);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);
    });

    test('CurrentDoorState falls back to DIRECTION_RESET_TIMEOUT_MS if the device never resets the direction DP', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;
        instance.characteristicCurrentDoorState.value = CDS.OPEN;

        const op = instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);
        device.emit('change', { '2': false }, { '2': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);

        await jest.advanceTimersByTimeAsync(DIRECTION_RESET_TIMEOUT_MS - 1);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);

        await jest.advanceTimersByTimeAsync(1);
        await op;
        expect(instance.currentDoorState).toBe(CDS.CLOSED);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.CLOSED);
    });

    test('Reversing direction mid-transition cancels the stale CurrentDoorState update', async () => {
        const { instance, device } = makeSimpleGarage();
        instance.currentDoorState = CDS.OPEN;
        instance.characteristicCurrentDoorState.value = CDS.OPEN;

        const op1 = instance.setTargetDoorState(TDS.CLOSED);
        await jest.advanceTimersByTimeAsync(0);
        device.emit('change', { '2': false }, { '2': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);

        // Close has been sent; before its echo arrives, user reverses.
        const op2 = instance.setTargetDoorState(TDS.OPEN);
        await jest.advanceTimersByTimeAsync(0);

        // The stale close-reset echo arriving now must not flip UI to CLOSED.
        device.emit('change', { '3': false }, { '3': false });
        device.emit('change', { '2': false }, { '2': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        device.emit('change', { '1': false }, { '1': false });

        await op1;
        await op2;
        expect(instance.currentDoorState).toBe(CDS.OPEN);
        expect(instance.characteristicCurrentDoorState.value).toBe(CDS.OPEN);
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
        const op1 = instance.setTargetDoorState(TDS.CLOSED);
        expect(accessory.context.cachedTargetDoorState).toBe(TDS.CLOSED);
        const op2 = instance.setTargetDoorState(TDS.OPEN);
        expect(accessory.context.cachedTargetDoorState).toBe(TDS.OPEN);

        await jest.advanceTimersByTimeAsync(0);
        device.emit('change', { '2': false }, { '2': false });
        await jest.advanceTimersByTimeAsync(POST_RESET_DELAY_MS);
        device.emit('change', { '1': false }, { '1': false });
        await op1;
        await op2;
    });
});
