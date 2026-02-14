'use strict';

const Homey = require('homey');

class PlejdMotionDevice extends Homey.Device {

  async onInit() {
    const { driver } = this;
    const initMessage = `Init motion: ${this.getName()} id: ${this.getData().id} `
      + `plejdId: ${this.getData().plejdId} hId: ${this.getStoreValue('hardwareId')} `
      + `hName: ${this.getStoreValue('hardwareName')} total: ${driver.getDevices().length}`;
    this.log(initMessage);

    await this.setCapabilityValue('alarm_motion', false);

    await this.homey.app.registerDevice(this);
  }

  async setState(state) {
    if (!state || !state.motion) {
      return Promise.resolve(true);
    }

    await this.setCapabilityValue('alarm_motion', true);

    this.homey.clearTimeout(this.motionTimeout);
    this.motionTimeout = this.homey.setTimeout(async () => {
      try {
        await this.setCapabilityValue('alarm_motion', false);
      } catch (error) {
        this.error(error);
      }
    }, 75000);

    return Promise.resolve(true);
  }

  async onAdded() {
    const { driver } = this;

    this.log(`Adding motion sensor: ${this.getName()} (${this.getData().id})`);
    this.log('count ', driver.getDevices().length);

    await this.homey.app.registerDevice(this);

    return Promise.resolve(true);
  }

  async onDeleted() {
    const { driver } = this;

    this.log(`motion sensor deleted: ${this.getName()}`);
    this.log('count ', driver.getDevices().length);

    await this.homey.app.unregisterDevice(this);

    this.homey.clearTimeout(this.motionTimeout);

    return Promise.resolve(true);
  }

}

module.exports = PlejdMotionDevice;
