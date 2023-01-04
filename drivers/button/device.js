'use strict';

const Homey = require('homey');

class PlejdButtonDevice extends Homey.Device {

  async onInit() {
    const { driver } = this;
    this.log(`Init button: ${this.getName()} id: ${this.getData().id} plejdId: ${this.getData().plejdId} hId: ${this.getStoreValue('hardwareId')} hName: ${this.getStoreValue('hardwareName')} total: ${driver.getDevices().length}`);

    this.flowTriggerButtonPressed = this.homey.flow.getDeviceTriggerCard('button_pressed');
    this.flowTriggerButtonPressed2 = this.homey.flow.getDeviceTriggerCard('button_pressed2');
    this.flowTriggerButtonPressed2.registerRunListener(async (args, state) => {
      return parseInt(args.button, 10) === state.inputButton;
    });

    await this.homey.app.registerDevice(this);
  }

  async setState(state) {
    if (state) {
      if (!this.throttleClicks || this.lastButton !== state.inputButton) {
        this.lastButton = state.inputButton;

        state.inputButton++;

        this.log('click', state.inputButton);

        this.flowTriggerButtonPressed.trigger(this, { button: state.inputButton }).then(this.log).catch(this.error);

        this.flowTriggerButtonPressed2.trigger(this, null, state).then(this.log).catch(this.error);

        this.homey.clearTimeout(this.throttleClicks);
        this.throttleClicks = this.homey.setTimeout(() => {
          this.throttleClicks = null;
        }, 1000);
      }
    }
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

    return Promise.resolve(true);
  }

}

module.exports = PlejdButtonDevice;
