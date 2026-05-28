const BaseAccessory = require('./BaseAccessory');

// Delay after the device echoes the stop DP back to false (signalling the
// stop has finished) before sending the open/close command. Some controllers
// drop the direction command when it arrives too soon after the stop, even
// after the stop DP itself has been reset.
const POST_RESET_DELAY_MS = 500;

// Fallback if the device never echoes the stop DP back to false (e.g. when
// the stop was a no-op because the gate was already idle, or the echo is
// dropped). Picked to comfortably exceed the ~1s reset we observe in
// practice.
const STOP_RESET_TIMEOUT_MS = 3000;

// Delay between the direction command and flipping CurrentDoorState. The
// device has no position feedback so this is purely cosmetic — it keeps
// HomeKit's "Opening..."/"Closing..." caption visible for at least this long.
const CURRENT_STATE_DELAY_MS = 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class SimpleGarageDoorAccessory extends BaseAccessory {
    static getCategory(Categories) {
        return Categories.GARAGE_DOOR_OPENER;
    }

    constructor(...props) {
        super(...props);
    }

    _registerPlatformAccessory() {
        const {Service} = this.hap;

        this.accessory.addService(Service.GarageDoorOpener, this.device.context.name);

        super._registerPlatformAccessory();
    }

    _registerCharacteristics() {
        const {Service, Characteristic} = this.hap;
        const service = this.accessory.getService(Service.GarageDoorOpener);
        this._checkServiceName(service, this.device.context.name);

        this.dpOpen = this._getCustomDP(this.device.context.dpOpen) || '1';
        this.dpStop = this._getCustomDP(this.device.context.dpStop) || '2';
        this.dpClose = this._getCustomDP(this.device.context.dpClose) || '3';

        // The device only exposes momentary action DPs, so the target state is
        // tracked locally and persisted via the homebridge accessory context.
        if (this.accessory.context.cachedTargetDoorState !== Characteristic.TargetDoorState.OPEN &&
            this.accessory.context.cachedTargetDoorState !== Characteristic.TargetDoorState.CLOSED) {
            this.accessory.context.cachedTargetDoorState = Characteristic.TargetDoorState.OPEN;
        }
        const initialTarget = this.accessory.context.cachedTargetDoorState;
        this.currentDoorState = initialTarget === Characteristic.TargetDoorState.OPEN
            ? Characteristic.CurrentDoorState.OPEN
            : Characteristic.CurrentDoorState.CLOSED;

        // Each setTargetDoorState invocation bumps this token; an older
        // in-flight chain bails out at its next await when the token changes.
        this.opToken = 0;

        this.characteristicTargetDoorState = service.getCharacteristic(Characteristic.TargetDoorState)
            .updateValue(initialTarget)
            .onGet(() => this.accessory.context.cachedTargetDoorState)
            .onSet(value => this.setTargetDoorState(value));

        this.characteristicCurrentDoorState = service.getCharacteristic(Characteristic.CurrentDoorState)
            .updateValue(this.currentDoorState)
            .onGet(() => this.currentDoorState);

        service.getCharacteristic(Characteristic.ObstructionDetected)
            .updateValue(false)
            .onGet(() => false);
    }

    // Wraps the synchronous Tuya write so the caller can await it. The Tuya
    // transport is fire-and-forget at the JS level — the data has been handed
    // to the kernel by the time setMultiStateLegacyAsync returns — but using
    // an awaited call keeps the command sequence in one readable async chain.
    async _sendDps(dps) {
        this.setMultiStateLegacyAsync(dps);
    }

    // Resolves when the device echoes the given DP back to false, signalling
    // the momentary action has completed. Resolves anyway after timeoutMs so
    // a missing echo can't wedge the chain.
    _waitForDpReset(dp, timeoutMs) {
        return new Promise(resolve => {
            const cleanup = () => {
                this.device.removeListener('change', onChange);
                clearTimeout(timer);
            };
            const onChange = changes => {
                if (changes && changes[dp] === false) {
                    cleanup();
                    resolve();
                }
            };
            const timer = setTimeout(() => {
                cleanup();
                resolve();
            }, timeoutMs);
            this.device.on('change', onChange);
        });
    }

    async setTargetDoorState(value) {
        const {Characteristic} = this.hap;

        this.accessory.context.cachedTargetDoorState = value;

        const opToken = ++this.opToken;

        // Subscribe before writing so we don't miss the reset echo.
        const stopReset = this._waitForDpReset(this.dpStop, STOP_RESET_TIMEOUT_MS);

        // Send stop first so reversing direction mid-motion works; if the gate
        // is already idle, the stop is a no-op on the device side.
        await this._sendDps({[this.dpStop]: true});
        if (opToken !== this.opToken) return;

        // The stop DP holds at true for ~1s on the controller and then resets
        // to false. Sending the direction command before the device finishes
        // processing the stop causes some controllers to drop it, so wait for
        // the reset and then a short buffer.
        await stopReset;
        if (opToken !== this.opToken) return;
        await sleep(POST_RESET_DELAY_MS);
        if (opToken !== this.opToken) return;

        if (value === Characteristic.TargetDoorState.OPEN) {
            await this._sendDps({[this.dpOpen]: true});
        } else {
            await this._sendDps({[this.dpClose]: true});
        }
        if (opToken !== this.opToken) return;

        await sleep(CURRENT_STATE_DELAY_MS);
        if (opToken !== this.opToken) return;

        this.currentDoorState = value === Characteristic.TargetDoorState.OPEN
            ? Characteristic.CurrentDoorState.OPEN
            : Characteristic.CurrentDoorState.CLOSED;
        this.characteristicCurrentDoorState.updateValue(this.currentDoorState);
    }
}

module.exports = SimpleGarageDoorAccessory;
