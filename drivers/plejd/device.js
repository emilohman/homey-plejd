'use strict';

const Homey = require('homey');

class PlejdDevice extends Homey.Device {

  async onInit() {
    const { driver } = this;
    this.log(`Plejd Device (${this.getName()}) initialized`);
    this.log('id: ', this.getData().id);
    this.log('plejdId: ', this.getData().plejdId);
    this.log('count: ', driver.getDevices().length);

    this.receiveState = true;

    this.registerCapabilityListener('onoff', async value => {
      // this.log(`Power is set to: ${value} for id ${this.getData().plejdId}`);

      this.stopGettingState();
      let toggleResult;
      if (value) {
        toggleResult = await driver.turnOn(this.getData().plejdId);
      } else {
        toggleResult = await driver.turnOff(this.getData().plejdId);
      }
      this.startGettingState();

      return toggleResult;
    });

    if (this.getData().dimmable) {
      this.registerCapabilityListener('dim', async value => {
        // this.log(`Brightness is set to ${value}`);

        this.stopGettingState();
        let toggleResult;
        const brightness = parseInt(255 * value, 10);
        if (brightness === 0) {
          toggleResult = await driver.turnOff(this.getData().plejdId);
        } else {
          toggleResult = await driver.turnOn(this.getData().plejdId, brightness);
        }
        this.startGettingState();

        return toggleResult;
      });
    }
  }

  async setState(state) {
    if (state && this.receiveState) {
      // this.log('Device reveiving state', this.getData().plejdId, state);
      await this.setCapabilityValue('onoff', state.state);
      await this.setCapabilityValue('dim', state.dim / 255);
    }
  }

  stopGettingState() {
    this.receiveState = false;
    this.homey.clearTimeout(this.gettingStateIndex);
  }

  startGettingState() {
    this.homey.clearTimeout(this.gettingStateIndex);
    this.gettingStateIndex = this.homey.setTimeout(() => {
      this.receiveState = true;
    }, 5000);
  }

  async onAdded() {
    const driver = this.getDriver();

    this.log(`Adding device: ${this.getName()} (${this.getData().id})`);
    this.log('count ', driver.getDevices().length);

    if (driver.getDevices().length === 1) {
      await driver.connect();
    }

    return Promise.resolve(true);
  }

  async onDeleted() {
    const driver = this.getDriver();

    this.log(`device deleted: ${this.getName()}`);
    this.log('count ', driver.getDevices().length);

    this.stopGettingState();

    if (driver.getDevices().length === 0) {
      await driver.disconnect();
    }

    return Promise.resolve(true);
  }

}

module.exports = PlejdDevice;
