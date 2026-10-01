'use strict';

const Homey = require('homey');

// Ignore member reports this long after a command. Reports that arrive
// right after a command can still carry the old state.
const COMMAND_HOLD_MS = 1500;

// A Plejd room is addressed as one output. One BLE command dims all
// devices in the room at the same time, handled inside the Plejd mesh.
class PlejdRoomDevice extends Homey.Device {
  async onInit() {
    this.memberStates = {};
    this.lastCommandAt = 0;

    this.registerCapabilityListener('onoff', async (value) => {
      this._setAllMembers({ on: Boolean(value) });
      if (value) {
        await this.homey.app.turnOn(this.roomAddress);
      } else {
        await this.homey.app.turnOff(this.roomAddress);
      }
    });

    this.registerCapabilityListener('dim', async (value) => {
      if (value <= 0) {
        this._setAllMembers({ on: false });
        await this.homey.app.turnOff(this.roomAddress);
        this.setCapabilityValue('onoff', false).catch(this.error);
      } else {
        const level = Math.max(1, Math.round(value * 255));
        this._setAllMembers({ on: true, dim: level });
        await this.homey.app.turnOn(this.roomAddress, level);
        this.setCapabilityValue('onoff', true).catch(this.error);
      }
    });

    await this.homey.app.registerDevice(this);
  }

  get roomAddress() {
    return this.getData().plejdId;
  }

  // Optimistic update: all members get the commanded state at once
  _setAllMembers(change) {
    this.lastCommandAt = Date.now();
    const members = this.getStoreValue('members') || [];
    members.forEach((id) => {
      this.memberStates[id] = { ...this.memberStates[id], ...change };
    });
  }

  // State reported on the room address itself
  async setState(state) {
    await this.onMemberState({ ...state, id: this.roomAddress }, true);
  }

  // Room state: on if any member is on, dim = average of members that are on
  async onMemberState(state, isRoomAddress = false) {
    const members = this.getStoreValue('members') || [];
    if (!isRoomAddress && !members.includes(state.id)) {
      return;
    }
    if (state.state === null || state.state === undefined) {
      return;
    }
    if (Date.now() - this.lastCommandAt < COMMAND_HOLD_MS) {
      return;
    }

    const memberState = { on: Boolean(state.state), dim: state.dim };
    if (isRoomAddress) {
      members.forEach((id) => {
        this.memberStates[id] = memberState;
      });
    } else {
      this.memberStates[state.id] = memberState;
    }

    const onMembers = Object.values(this.memberStates).filter((m) => m.on);
    const anyOn = onMembers.length > 0;

    // Only write changed values, so the slider does not move without reason
    if (this.getCapabilityValue('onoff') !== anyOn) {
      this.setCapabilityValue('onoff', anyOn).catch(this.error);
    }
    if (anyOn) {
      const avg =
        onMembers.reduce((sum, m) => sum + (Number(m.dim) || 0), 0) /
        onMembers.length;
      const dim = Math.round(Math.max(0.01, Math.min(1, avg / 255)) * 100) / 100;
      if (this.getCapabilityValue('dim') !== dim) {
        this.setCapabilityValue('dim', dim).catch(this.error);
      }
    }
  }

  async onDeleted() {
    await this.homey.app.unregisterDevice(this);
  }
}

module.exports = PlejdRoomDevice;
