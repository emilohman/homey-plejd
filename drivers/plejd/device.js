'use strict';

const Homey = require('homey');
// const tinycolor = require('tinycolor2');

const SETTING_DEVICE_CLASS = 'device_class';
const SETTING_DIMMABLE = 'dimmable';

class PlejdDevice extends Homey.Device {

  async onInit() {
    const { driver } = this;
    this.log(`Init plejd: ${this.getName()} id: ${this.getData().id} plejdId: ${this.getData().plejdId} hId: ${this.getStoreValue('hardwareId')} hName: ${this.getStoreValue('hardwareName')} traits: ${this.getStoreValue('traits')} total: ${driver.getDevices().length}`);

    this.receiveState = true;

    this.registerCapabilityListener('onoff', async (value) => {
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

    this.registerCapabilityListener('dim', async (value) => {
      // this.log(`Brightness is set to ${value}`);

      this.stopGettingState();
      let toggleResult;
      const brightness = parseInt(255 * value, 10);
      if (brightness === 0) {
        toggleResult = await this.homey.app.turnOff(this.getData().plejdId);

        await this.setCapabilityValue('onoff', false);
      } else {
        toggleResult = await this.homey.app.turnOn(this.getData().plejdId, brightness);

        await this.setCapabilityValue('onoff', true);
      }
      this.startGettingState();

      return toggleResult;
    });

    if (this.hasCapability('light_hue')) {
      this.removeCapability('light_hue');
    }

    if (this.hasCapability('light_saturation')) {
      this.removeCapability('light_saturation');
    }

    if (this.hasCapability('light_temperature')) {
      this.removeCapability('light_temperature');
    }

    if (this.hasCapability('light_mode')) {
      this.removeCapability('light_mode');
    }

    /*
    this.registerMultipleCapabilityListener(['light_temperature', 'light_hue', 'light_saturation'], async (capabilityValues, capabilityOptions) => {
      this.log('capabilityValues', capabilityValues);
      this.log('capabilityOptions', capabilityOptions);

      const { light_hue, light_saturation } = capabilityValues;

      const colorHex = tinycolor({
        h: light_hue * 360,
        s: light_saturation * 100,
        l: 50,
      }).toHex();

      this.log('colorHex', colorHex);
    }, 500);
    */

    await this.homey.app.registerDevice(this);
  }

  async setState(state) {
    if (state && this.receiveState) {
      // this.log('Device reveiving state', this.getData().plejdId, this.getData().dimmable, state);
      await this.setCapabilityValue('onoff', state.state);

      if (this.hasCapability('dim') && state.dim !== undefined) {
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

    this.log(`Adding device: ${this.getName()} (${this.getData().id}) ${this.getClass()}`);
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

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.some((key) => key === SETTING_DEVICE_CLASS)) {
      this.setClass(newSettings[SETTING_DEVICE_CLASS]);
    }

    if (changedKeys.some((key) => key === SETTING_DIMMABLE)) {
      const isDimmable = this.getCapabilities().includes('dim');
      const newValue = newSettings[SETTING_DIMMABLE];

      if (newValue && !isDimmable) {
        this.addCapability('dim');
      } else if (!newValue && isDimmable) {
        this.removeCapability('dim');
      }
    }
  }

}

module.exports = PlejdDevice;
