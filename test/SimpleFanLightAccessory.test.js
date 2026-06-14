'use strict';

const SimpleFanLightAccessory = require('../lib/SimpleFanLightAccessory');
const { makeInstance } = require('./support/mocks');

// Mirrors the parts of _registerCharacteristics that the colour-temperature
// helpers depend on, without standing up the full HAP service graph.
// minWhiteColor/maxWhiteColor are only copied onto the instance when the config
// provides them, so omitting them exercises the in-method default fallback.
function makeFanLight(state = {}, context = {}) {
    const result = makeInstance(SimpleFanLightAccessory, state, context);
    const { instance, device } = result;
    instance.dpColorTemp = '23';
    instance.useStrings = device.context.useStrings ?? true;
    if (device.context.minWhiteColor !== undefined) instance.minWhiteColor = parseInt(device.context.minWhiteColor);
    if (device.context.maxWhiteColor !== undefined) instance.maxWhiteColor = parseInt(device.context.maxWhiteColor);
    return result;
}

// ---------------------------------------------------------------------------
// convertColorTempFromTuyaToHomeKit — default range, inverted (issue #44)
// ---------------------------------------------------------------------------
describe('SimpleFanLightAccessory.convertColorTempFromTuyaToHomeKit (default range)', () => {
    test('Tuya 0 (warmest) maps to the warm mired end (370)', () => {
        const { instance } = makeFanLight();
        expect(instance.convertColorTempFromTuyaToHomeKit(0)).toBe(370);
    });

    test('Tuya 1000 (coolest) maps to the cool mired end (154)', () => {
        const { instance } = makeFanLight();
        expect(instance.convertColorTempFromTuyaToHomeKit(1000)).toBe(154);
    });

    test('Tuya midpoint maps to the mired midpoint', () => {
        const { instance } = makeFanLight();
        // 370 - 500*(370-154)/1000 = 262
        expect(instance.convertColorTempFromTuyaToHomeKit(500)).toBe(262);
    });

    test('accepts Tuya values as strings', () => {
        const { instance } = makeFanLight();
        expect(instance.convertColorTempFromTuyaToHomeKit('0')).toBe(370);
        expect(instance.convertColorTempFromTuyaToHomeKit('1000')).toBe(154);
    });

    test('out-of-range / undefined Tuya values stay within bounds', () => {
        const { instance } = makeFanLight();
        expect(instance.convertColorTempFromTuyaToHomeKit(99999)).toBe(154);
        expect(instance.convertColorTempFromTuyaToHomeKit(-5)).toBe(370);
        const undef = instance.convertColorTempFromTuyaToHomeKit(undefined);
        expect(Number.isFinite(undef)).toBe(true);
        expect(undef).toBeGreaterThanOrEqual(154);
        expect(undef).toBeLessThanOrEqual(370);
    });
});

// ---------------------------------------------------------------------------
// convertColorTempFromHomeKitToTuya — default range, inverted (issue #44)
// ---------------------------------------------------------------------------
describe('SimpleFanLightAccessory.convertColorTempFromHomeKitToTuya (default range)', () => {
    test('warm mired end (370) maps to Tuya 0 (warmest)', () => {
        const { instance } = makeFanLight();
        expect(instance.convertColorTempFromHomeKitToTuya(370)).toBe(0);
    });

    test('cool mired end (154) maps to Tuya 1000 (coolest)', () => {
        const { instance } = makeFanLight();
        expect(instance.convertColorTempFromHomeKitToTuya(154)).toBe(1000);
    });

    test("Apple's warm preset (~370 mired) lands warm, not neutral (issue #44 regression)", () => {
        const { instance } = makeFanLight();
        // The old code produced 313 for the warm preset; it must now be the warm extreme.
        expect(instance.convertColorTempFromHomeKitToTuya(370)).toBeLessThan(100);
    });

    test('cool input (low mired) produces a high Tuya value, warm input (high mired) a low one', () => {
        const { instance } = makeFanLight();
        const cool = instance.convertColorTempFromHomeKitToTuya(154);
        const warm = instance.convertColorTempFromHomeKitToTuya(370);
        expect(cool).toBeGreaterThan(warm);
    });

    test('values outside the configured range are clamped before mapping', () => {
        const { instance } = makeFanLight();
        expect(instance.convertColorTempFromHomeKitToTuya(500)).toBe(0);    // clamped to 370 -> warm
        expect(instance.convertColorTempFromHomeKitToTuya(140)).toBe(1000); // clamped to 154 -> cool
    });
});

// ---------------------------------------------------------------------------
// Configurable range via minWhiteColor / maxWhiteColor (issue #44)
// ---------------------------------------------------------------------------
describe('SimpleFanLightAccessory colour temperature with a configured range', () => {
    test('honours a custom 140..500 mired range', () => {
        const { instance } = makeFanLight({}, { minWhiteColor: 140, maxWhiteColor: 500 });
        expect(instance.convertColorTempFromHomeKitToTuya(500)).toBe(0);     // warm end
        expect(instance.convertColorTempFromHomeKitToTuya(140)).toBe(1000);  // cool end
        expect(instance.convertColorTempFromTuyaToHomeKit(0)).toBe(500);
        expect(instance.convertColorTempFromTuyaToHomeKit(1000)).toBe(140);
    });

    test('string config values are coerced to numbers', () => {
        const { instance } = makeFanLight({}, { minWhiteColor: '154', maxWhiteColor: '370' });
        expect(instance.convertColorTempFromHomeKitToTuya(370)).toBe(0);
        expect(instance.convertColorTempFromTuyaToHomeKit(1000)).toBe(154);
    });
});

// ---------------------------------------------------------------------------
// Round-trip stability
// ---------------------------------------------------------------------------
describe('SimpleFanLightAccessory colour temperature round-trips', () => {
    test('HomeKit -> Tuya -> HomeKit is stable across the default range', () => {
        const { instance } = makeFanLight();
        for (let hk = 154; hk <= 370; hk += 1) {
            const tuya = instance.convertColorTempFromHomeKitToTuya(hk);
            const back = instance.convertColorTempFromTuyaToHomeKit(tuya);
            // Allow ±1 mired for rounding through the 0..1000 integer scale.
            expect(Math.abs(back - hk)).toBeLessThanOrEqual(1);
        }
    });
});

// ---------------------------------------------------------------------------
// getColorTemp / setColorTemp integration
// ---------------------------------------------------------------------------
describe('SimpleFanLightAccessory.getColorTemp / setColorTemp', () => {
    test('getColorTemp reads and converts the Tuya DP', () => {
        const { instance } = makeFanLight({ '23': 0 });
        expect(instance.getColorTemp()).toBe(370); // Tuya 0 -> warm
    });

    test('setColorTemp writes the inverted, range-mapped Tuya value as a string', () => {
        const { instance, device } = makeFanLight({ '23': 500 });
        instance.setColorTemp(370); // warm preset -> Tuya 0
        expect(device.update).toHaveBeenCalledWith({ '23': '0' });
    });

    test('setColorTemp writes a numeric value when useStrings is false', () => {
        const { instance, device } = makeFanLight({ '23': 500 }, { useStrings: false });
        instance.setColorTemp(154); // cool end -> Tuya 1000
        expect(device.update).toHaveBeenCalledWith({ '23': 1000 });
    });

    test('setColorTemp does not write when the device is disconnected', () => {
        const { instance, device } = makeFanLight({ '23': 500 });
        device.connected = false;
        expect(() => instance.setColorTemp(370)).not.toThrow();
        expect(device.update).not.toHaveBeenCalled();
    });
});
