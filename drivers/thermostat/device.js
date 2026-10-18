'use strict';

const Homey = require('homey');

class PlejdThermostatDevice extends Homey.Device {
  async onInit() {
    const { driver } = this;
    const initMessage =
      `Init thermostat: ${this.getName()} id: ${this.getData().id} ` +
      `plejdId: ${this.getData().plejdId} hId: ${this.getStoreValue('hardwareId')} ` +
      `hName: ${this.getStoreValue('hardwareName')} traits: ${this.getStoreValue('traits')} ` +
      `total: ${driver.getDevices().length}`;
    this.log(initMessage);

    this.receiveState = true;

    // Devices paired before this change lack measure_power – add it.
    if (!this.hasCapability('measure_power')) {
      await this.addCapability('measure_power');
    }

    this.registerCapabilityListener('target_temperature', async (value) => {
      this.stopGettingState();
      const result = await this.homey.app.thermostatSetTargetTemperature(
        this.getData().plejdId,
        value,
      );
      this.startGettingState();

      return result;
    });

    this.registerCapabilityListener('onoff', async (value) => {
      this.stopGettingState();
      const result = await this.homey.app.thermostatSetMode(
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

    if (
      state.targetTemperature !== null &&
      state.targetTemperature !== undefined
    ) {
      await this.setCapabilityValue(
        'target_temperature',
        state.targetTemperature,
      );
    }

    if (
      state.currentTemperature !== null &&
      state.currentTemperature !== undefined
    ) {
      await this.setCapabilityValue(
        'measure_temperature',
        state.currentTemperature,
      );
    }

    if (state.heating !== null && state.heating !== undefined) {
      this.log(`heating: ${state.heating} mode: ${state.mode}`);
      this.heating = Boolean(state.heating);
    }
    if (state.mode === 0) {
      this.heating = false; // thermostat is switched off
    }
    if (this.heating !== undefined) {
      await this.updatePower();
    }

    if (state.mode !== null && state.mode !== undefined) {
      await this.setCapabilityValue('onoff', state.mode !== 0);
    } else if (state.heating !== null && state.heating !== undefined) {
      await this.setCapabilityValue('onoff', Boolean(state.heating));
    }

    return Promise.resolve(true);
  }

  async updatePower(heaterPower = this.getSetting('heater_power')) {
    const watts = Number(heaterPower) || 0;
    const power = this.heating ? watts : 0;
    if (this.getCapabilityValue('measure_power') !== power) {
      await this.setCapabilityValue('measure_power', power);
    }
  }

  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('heater_power')) {
      await this.updatePower(newSettings.heater_power);
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
    }, 2000);
  }

  async onAdded() {
    const { driver } = this;

    this.log(`Adding thermostat: ${this.getName()} (${this.getData().id})`);
    this.log('count ', driver.getDevices().length);

    await this.homey.app.registerDevice(this);

    return Promise.resolve(true);
  }

  async onDeleted() {
    const { driver } = this;

    this.log(`thermostat deleted: ${this.getName()}`);
    this.log('count ', driver.getDevices().length);

    await this.homey.app.unregisterDevice(this);

    this.stopGettingState();

    return Promise.resolve(true);
  }
}

module.exports = PlejdThermostatDevice;
