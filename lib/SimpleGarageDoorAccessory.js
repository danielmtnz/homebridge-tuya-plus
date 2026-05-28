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

// Fallback for the direction DP echo when the device misses one.
const DIRECTION_RESET_TIMEOUT_MS = 3000;

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

        // The device exposes no status DPs, so the only "memory" of where the
        // gate is comes from the last HomeKit-triggered change, persisted via
        // the homebridge accessory context.
        if (this.accessory.context.cachedTargetDoorState !== Characteristic.TargetDoorState.OPEN &&
            this.accessory.context.cachedTargetDoorState !== Characteristic.TargetDoorState.CLOSED) {
            this.accessory.context.cachedTargetDoorState = Characteristic.TargetDoorState.OPEN;
        }
        const initialTarget = this.accessory.context.cachedTargetDoorState;
        this.currentDoorState = initialTarget === Characteristic.TargetDoorState.OPEN
            ? Characteristic.CurrentDoorState.OPEN
            : Characteristic.CurrentDoorState.CLOSED;
        this.desiredTarget = initialTarget;
        this.worker = null;

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

        // CurrentDoorState follows the device's own pacing — it flips to OPEN
        // when the open DP transitions back to false, and to CLOSED when the
        // close DP transitions back to false. That reset echo is the closest
        // thing to position feedback we have.
        this.device.on('change', changes => this._onDeviceChange(changes));
    }

    _onDeviceChange(changes) {
        const {Characteristic} = this.hap;
        if (!changes) return;
        if (changes[this.dpOpen] === false) {
            this._setCurrentDoorState(Characteristic.CurrentDoorState.OPEN);
        } else if (changes[this.dpClose] === false) {
            this._setCurrentDoorState(Characteristic.CurrentDoorState.CLOSED);
        }
    }

    _setCurrentDoorState(state) {
        if (this.currentDoorState === state) return;
        this.currentDoorState = state;
        this.characteristicCurrentDoorState.updateValue(state);
    }

    setTargetDoorState(value) {
        this.accessory.context.cachedTargetDoorState = value;
        this.desiredTarget = value;
        this._ensureWorker();
    }

    _ensureWorker() {
        if (this.worker) return;
        this.worker = this._runWorker().finally(() => { this.worker = null; });
    }

    // A single worker drives the gate towards this.desiredTarget. Each
    // setTargetDoorState call only updates the target and (re)spawns this
    // worker if none is running, so spamming the HomeKit toggle just shifts
    // the destination instead of stacking commands. After each step the
    // worker re-reads this.desiredTarget — if the user has reverted to the
    // current state, the loop falls through with no direction sent.
    async _runWorker() {
        const {Characteristic} = this.hap;
        while (true) {
            if (this._currentMatchesTarget(this.desiredTarget)) return;

            await this._sendAndAwaitReset(this.dpStop, STOP_RESET_TIMEOUT_MS);
            await sleep(POST_RESET_DELAY_MS);

            if (this._currentMatchesTarget(this.desiredTarget)) return;

            const target = this.desiredTarget;
            const directionDp = target === Characteristic.TargetDoorState.OPEN
                ? this.dpOpen
                : this.dpClose;
            await this._sendAndAwaitReset(directionDp, DIRECTION_RESET_TIMEOUT_MS);
            // On the happy path the persistent change listener has already
            // flipped CurrentDoorState by now. Force-mirror the target as a
            // belt-and-braces so a missed direction echo doesn't leave the
            // worker stuck looping.
            this._setCurrentDoorState(target === Characteristic.TargetDoorState.OPEN
                ? Characteristic.CurrentDoorState.OPEN
                : Characteristic.CurrentDoorState.CLOSED);
        }
    }

    _currentMatchesTarget(target) {
        const {Characteristic} = this.hap;
        if (target === Characteristic.TargetDoorState.OPEN) {
            return this.currentDoorState === Characteristic.CurrentDoorState.OPEN;
        }
        return this.currentDoorState === Characteristic.CurrentDoorState.CLOSED;
    }

    // Writes the DP and resolves when the device echoes it back to false
    // (signalling the action completed) or the timeout fires.
    async _sendAndAwaitReset(dp, timeoutMs) {
        const wait = this._waitForDpReset(dp, timeoutMs);
        this.setMultiStateLegacyAsync({[dp]: true});
        await wait;
    }

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
}

module.exports = SimpleGarageDoorAccessory;
