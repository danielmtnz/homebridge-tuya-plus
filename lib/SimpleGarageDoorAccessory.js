const BaseAccessory = require('./BaseAccessory');

// Delay between the stop command and the open/close command. Without it,
// some controllers drop the direction command because it arrives before
// they have finished processing the stop.
const STOP_TO_DIRECTION_DELAY_MS = 500;

// Window during which CurrentDoorState lags TargetDoorState so HomeKit's
// "Opening..."/"Closing..." caption is visible after a toggle. The device
// has no position feedback, so this is purely cosmetic. Measured from the
// HomeKit toggle, not from when the direction command is sent.
const CURRENT_STATE_DELAY_MS = 1500;

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

    setTargetDoorState(value) {
        const {Characteristic} = this.hap;

        this.accessory.context.cachedTargetDoorState = value;

        if (this.directionTimeout) clearTimeout(this.directionTimeout);
        if (this.currentStateTimeout) clearTimeout(this.currentStateTimeout);

        // Send stop first so reversing direction mid-motion works; if the gate
        // is already idle, the stop is a no-op on the device side.
        this.setMultiStateLegacyAsync({[this.dpStop]: true});

        this.directionTimeout = setTimeout(() => {
            this.directionTimeout = null;
            if (value === Characteristic.TargetDoorState.OPEN) {
                this.setMultiStateLegacyAsync({[this.dpOpen]: true});
            } else {
                this.setMultiStateLegacyAsync({[this.dpClose]: true});
            }
        }, STOP_TO_DIRECTION_DELAY_MS);

        this.currentStateTimeout = setTimeout(() => {
            this.currentStateTimeout = null;
            this.currentDoorState = value === Characteristic.TargetDoorState.OPEN
                ? Characteristic.CurrentDoorState.OPEN
                : Characteristic.CurrentDoorState.CLOSED;
            this.characteristicCurrentDoorState.updateValue(this.currentDoorState);
        }, CURRENT_STATE_DELAY_MS);
    }
}

module.exports = SimpleGarageDoorAccessory;
