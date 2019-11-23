'use strict';

const Homey = require('homey');

class PlejdDevice extends Homey.Device {

  onInit() {
    const driver = this.getDriver();
    this.log('Plejd Device (' + this.getName() + ') initialized');
    this.log('id: ', this.getData().id);
    this.log('plejdId: ', this.getData().plejdId);
    this.log('count ', driver.getDevices().length);

    this.registerCapabilityListener("onoff", async value => {
      this.log(`Power is set to: ${value} for id ${this.getData().plejdId}`);
      if (value) {
        await driver.turnOn(parseInt(this.getData().plejdId));
      } else {
        await driver.turnOff(parseInt(this.getData().plejdId));
      }

      return Promise.resolve(true);
    });

    this.registerCapabilityListener("dim", async value => {
      this.log(`Brightness is set to ${value}`);

      const brightness = parseInt(255 * value);
      if (brightness == 0) {
        await driver.turnOff(this.getData().plejdId);
      } else {
        await driver.turnOn(this.getData().plejdId, brightness);
      }

      return Promise.resolve(true);
    });
  }

  async onAdded() {
    const driver = this.getDriver();

    this.log('Adding device: ' + this.getName() + ' (' + this.getData().id + ')');
    this.log('count ', driver.getDevices().length);

    if (driver.getDevices().length === 1) {
      if (driver.keepConnectionAlive) {
        await driver.connect();
      }
    }
  }

  async onDeleted() {
    const driver = this.getDriver();

    this.log('device deleted: ' + this.getName());
    this.log('count ', driver.getDevices().length);

    if (driver.getDevices().length === 0) {
      if (driver.keepConnectionAlive) {
        await driver.disconnect();
      }
    }
  }

}

module.exports = PlejdDevice;
