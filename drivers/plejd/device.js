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

    this.registerCapabilityListener("onoff", async value => {
      // this.log(`Power is set to: ${value} for id ${this.getData().plejdId}`);

      this.stopGettingState();
      let toggleResult;
      if (value) {
        toggleResult = await this.homey.app.turnOn(this.getData().plejdId);
      } else {
        toggleResult = await this.homey.app.turnOff(this.getData().plejdId);
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
          toggleResult = await this.homey.app.turnOff(this.getData().plejdId);
        } else {
          toggleResult = await this.homey.app.turnOn(this.getData().plejdId, brightness);
        }
        this.startGettingState();

        return toggleResult;
      });
    }

    await this.homey.app.registerDevice(this);
  }

  async setState(state) {
    if (state && this.receiveState) {
      // this.log('Device reveiving state', this.getData().plejdId, this.getData().dimmable, state);
      await this.setCapabilityValue('onoff', state.state);

      if (this.getData().dimmable) {
        await this.setCapabilityValue('dim', state.dim / 255);
      }
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

    this.log(`Adding device: ${this.getName()} (${this.getData().id})`);
    this.log('count ', driver.getDevices().length);

    await this.homey.app.registerDevice(this);

    return Promise.resolve(true);
  }

  async onDeleted() {
    const { driver } = this;

    this.log(`device deleted: ${this.getName()}`);
    this.log('count ', driver.getDevices().length);

    await this.homey.app.unregisterDevice(this);

    this.stopGettingState();

    return Promise.resolve(true);
  }

}

module.exports = PlejdDevice;
