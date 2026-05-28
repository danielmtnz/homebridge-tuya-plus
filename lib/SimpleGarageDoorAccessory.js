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

// Debounce window for incoming HomeKit toggles. setTargetDoorState waits
// this long after the most recent press before starting (or rescheduling) a
// stop+direction cycle, so a rapid burst of taps coalesces into one cycle
// on the final target instead of driving the gate back and forth.
const SETTLE_MS = 1000;

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
        this._reconcileOptionalServices();
        super._registerPlatformAccessory();
    }

    _reconcileOptionalServices() {
        const {Service} = this.hap;

        const partialOpenMs = parseInt(this.device.context.partialOpenMs, 10);
        const wantPartialOpen = Number.isFinite(partialOpenMs) && partialOpenMs > 0;
        const partialName = this.device.context.name + ' Partial Open';
        let partialSwitch = this.accessory.getServiceById(Service.Switch, 'partialOpen');
        if (wantPartialOpen) {
            if (partialSwitch) this._checkServiceName(partialSwitch, partialName);
            else this.accessory.addService(Service.Switch, partialName, 'partialOpen');
        } else if (partialSwitch) {
            this.accessory.removeService(partialSwitch);
        }
    }

    _registerCharacteristics() {
        this._reconcileOptionalServices();

        const {Service, Characteristic} = this.hap;
        const service = this.accessory.getService(Service.GarageDoorOpener);
        this._checkServiceName(service, this.device.context.name);

        this.dpOpen = this._getCustomDP(this.device.context.dpOpen) || '1';
        this.dpStop = this._getCustomDP(this.device.context.dpStop) || '2';
        this.dpClose = this._getCustomDP(this.device.context.dpClose) || '3';

        const partialOpenMs = parseInt(this.device.context.partialOpenMs, 10);
        this.partialOpenMs = Number.isFinite(partialOpenMs) && partialOpenMs > 0 ? partialOpenMs : 0;

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
        this.scheduleTimer = null;
        this.partialCloseTimer = null;
        this.partialOpenId = 0;
        this._currentChangePending = null;
        this._currentChangeResolve = null;

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

        const partialSwitch = this.accessory.getServiceById(Service.Switch, 'partialOpen');
        if (partialSwitch) {
            const onChar = partialSwitch.getCharacteristic(Characteristic.On)
                .updateValue(false)
                .onGet(() => false)
                .onSet(value => {
                    if (!value) return;
                    this._handlePartialOpen();
                    // Momentary press: flip the switch back off so the UI
                    // shows it as a button rather than a sticky toggle.
                    setImmediate(() => onChar.updateValue(false));
                });
            this.characteristicPartialOpen = onChar;
        }

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
        // Wake anyone waiting on a currentDoorState transition (e.g. the
        // partial-open flow waiting for the gate to reach OPEN).
        if (this._currentChangeResolve) {
            const resolve = this._currentChangeResolve;
            this._currentChangeResolve = null;
            this._currentChangePending = null;
            resolve();
        }
    }

    _waitForCurrentChange() {
        if (!this._currentChangePending) {
            this._currentChangePending = new Promise(resolve => {
                this._currentChangeResolve = resolve;
            });
        }
        return this._currentChangePending;
    }

    setTargetDoorState(value) {
        // Public path: a direct user toggle cancels any in-flight partial
        // close timer and supersedes any partial-open wait — once the user
        // takes manual control, the auto-close should not fire later.
        if (this.partialCloseTimer) {
            clearTimeout(this.partialCloseTimer);
            this.partialCloseTimer = null;
        }
        this.partialOpenId++;
        this._setTarget(value);
    }

    _setTarget(value) {
        this.accessory.context.cachedTargetDoorState = value;
        this.desiredTarget = value;
        // If a worker is already running it will pick up the new target at
        // its next decision point — no need to debounce again. Otherwise
        // (re)start the debounce so a burst of taps coalesces into one
        // cycle on the final target.
        if (this.worker) return;
        this._scheduleWorker();
    }

    // Drives the partial-open flow: trigger an OPEN through the normal queue,
    // wait until CurrentDoorState reaches OPEN (so the close timer is measured
    // from "fully open" rather than from press — otherwise a short partial
    // duration would land mid-cycle and the close would cancel the open), then
    // schedule a CLOSE after this.partialOpenMs.
    async _handlePartialOpen() {
        const {Characteristic} = this.hap;
        if (!this.partialOpenMs) return;

        if (this.partialCloseTimer) {
            clearTimeout(this.partialCloseTimer);
            this.partialCloseTimer = null;
        }
        const myId = ++this.partialOpenId;

        this._setTarget(Characteristic.TargetDoorState.OPEN);

        while (this.currentDoorState !== Characteristic.CurrentDoorState.OPEN) {
            await this._waitForCurrentChange();
            // A direct toggle or another partial press supersedes this flow.
            if (myId !== this.partialOpenId) return;
        }

        this.partialCloseTimer = setTimeout(() => {
            this.partialCloseTimer = null;
            if (myId !== this.partialOpenId) return;
            this._setTarget(Characteristic.TargetDoorState.CLOSED);
        }, this.partialOpenMs);
    }

    _scheduleWorker() {
        if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
        this.scheduleTimer = setTimeout(() => {
            this.scheduleTimer = null;
            this._spawnWorker();
        }, SETTLE_MS);
    }

    _spawnWorker() {
        if (this.worker) return;
        if (this._currentMatchesTarget(this.desiredTarget)) return;
        this.worker = this._runWorker().finally(() => {
            this.worker = null;
            // If the target shifted while the cycle was running and still
            // differs from where we landed, debounce again before the next
            // cycle so another spam burst coalesces.
            if (!this._currentMatchesTarget(this.desiredTarget)) {
                this._scheduleWorker();
            }
        });
    }

    // One stop + direction cycle. The worker re-reads this.desiredTarget at
    // each decision point so a toggle that lands during the cycle is honoured;
    // if the target has reverted to the current state, the direction is
    // skipped and the worker exits.
    async _runWorker() {
        const {Characteristic} = this.hap;
        if (this._currentMatchesTarget(this.desiredTarget)) return;

        await this._sendAndAwaitReset(this.dpStop, STOP_RESET_TIMEOUT_MS);
        await sleep(POST_RESET_DELAY_MS);

        if (this._currentMatchesTarget(this.desiredTarget)) return;

        const target = this.desiredTarget;
        const directionDp = target === Characteristic.TargetDoorState.OPEN
            ? this.dpOpen
            : this.dpClose;
        await this._sendAndAwaitReset(directionDp, DIRECTION_RESET_TIMEOUT_MS);
        // Belt-and-braces: the persistent change listener will already have
        // flipped this on the echo, but force-mirror in case the echo was
        // missed so the next loop check exits cleanly.
        this._setCurrentDoorState(target === Characteristic.TargetDoorState.OPEN
            ? Characteristic.CurrentDoorState.OPEN
            : Characteristic.CurrentDoorState.CLOSED);
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
