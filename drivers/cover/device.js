'use strict';

const Homey = require('homey');

class PlejdCoverDevice extends Homey.Device {
  async onInit() {
    const { driver } = this;
    const initMessage =
      `Init cover: ${this.getName()} id: ${this.getData().id} ` +
      `plejdId: ${this.getData().plejdId} hId: ${this.getStoreValue('hardwareId')} ` +
      `hName: ${this.getStoreValue('hardwareName')} total: ${driver.getDevices().length}`;
    this.log(initMessage);

    this.receiveState = true;

    this.registerCapabilityListener('windowcoverings_set', async (value) => {
      this.stopGettingState();
      const result = await this.homey.app.setCoverPosition(
        this.getData().plejdId,
        value,
      );
      this.startGettingState();

      return result;
    });

    await this.homey.app.registerDevice(this);
  }

  async setState(state) {
    if (!state || !this.receiveState) {
      return Promise.resolve(true);
    }

    if (state.coverPosition !== null && state.coverPosition !== undefined) {
      const normalizedPosition = Math.max(0, Math.min(1, state.coverPosition));
      await this.setCapabilityValue('windowcoverings_set', normalizedPosition);
    }

    return Promise.resolve(true);
  }

  stopGettingState() {
    this.receiveState = false;
    this.homey.clearTimeout(this.gettingStateIndex);
  }

  startGettingState() {
    this.homey.clearTimeout(this.gettingStateIndex);
    this.gettingStateIndex = this.homey.setTimeout(() => {
      this.receiveState = true;
    }, 2000);
  }

  async onAdded() {
    const { driver } = this;

    this.log(`Adding cover device: ${this.getName()} (${this.getData().id})`);
    this.log('count ', driver.getDevices().length);

    await this.homey.app.registerDevice(this);

    return Promise.resolve(true);
  }

  async onDeleted() {
    const { driver } = this;

    this.log(`cover device deleted: ${this.getName()}`);
    this.log('count ', driver.getDevices().length);

    await this.homey.app.unregisterDevice(this);

    this.stopGettingState();

    return Promise.resolve(true);
  }
}

module.exports = PlejdCoverDevice;
