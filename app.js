'use strict';

const Homey = require('homey');
const { Log } = require('homey-log');

const plejd = require('./lib/plejd');

class PlejdApp extends Homey.App {

  async onInit() {
    this.homeyLog = new Log({ homey: this.homey });

    this.log('PlejdApp is running...');

    this.homey.settings.unset('username');
    this.homey.settings.unset('password');
    this.homey.settings.unset('keepalive');

    this.devices = {};
    this.devicesList = [];
    this.isDisconnecting = false;
    this.isConnecting = false;
    this.isConnected = false;
    this.doReconnectDelay = false;
    this.writeList = [];
    this.plejdCommands = null;
    this.advertisementsNotWorking = [];
    this.pingErrorCount = 0;

    this.homey.on('unload', async () => {
      this.log('Unloading app');
      this.stopPollingState();

      this.homey.clearInterval(this.syncTimeIndex);

      await this.disconnect();
    });

    if (this.devicesList.length > 0) {
      await this.connect();
    }
  }


  async registerDevice(device) {
    this.devicesList.push(device);
    this.devices[device.getData().plejdId] = device;

    if (!this.isConnected) {
      device.setUnavailable('Connecting to Plejd BLE mesh');
    }

    if (this.devicesList.length === 1) {
      await this.connect();
    }

    await this.getDevicesState();
  }

  async unregisterDevice(device) {
    this.devicesList = this.devices.filter(current => current.getData().plejdId !== device.getData().plejdId);
    delete this.devices[device.getData().plejdId];

    if (this.devicesList.length === 0) {
      await this.disconnect();
    }
  }

  async setAllDevicesAsAvailable() {
    for (let i = 0, length = this.devicesList.length; i < length; i++) {
      if (this.devicesList[i] && this.devicesList[i].setAvailable !== undefined) {
        try {
          await this.devicesList[i].setAvailable();
        } catch (error) {
          this.error(error);
        }
      }
    }
  }

  async setAllDevicesAsUnavailable() {
    for (let i = 0, length = this.devicesList.length; i < length; i++) {
      if (this.devicesList[i] && this.devicesList[i].setUnavailable !== undefined) {
        try {
          await this.devicesList[i].setUnavailable('Connecting to Plejd BLE mesh');
        } catch (error) {
          this.error(error);
        }
      }
    }
  }

  async reconnect() {
    this.log('Start reconnecting');

    if (!this.isDisconnecting) {
      await this.disconnect();
    }

    // return
    return new Promise(resolve => {
      this.log('Reconnecting in', this.doReconnectDelay ? '30s' : '10s');
      setTimeout(async () => {
        this.doReconnectDelay = true;
        await this.connect();
        resolve();
      }, this.doReconnectDelay ? 30000 : 10000);
    });
  }

  async connect() {
    const self = this;

    this.log('Connect', this.isConnecting, this.isConnected);

    if (this.isConnecting || this.isConnected) {
      return Promise.resolve(false);
    }

    this.isConnecting = true;

    const cryptokey = this.homey.settings.get('cryptokey');

    if (!cryptokey) {
      this.log('No cryptokey exists.');
      return Promise.resolve(false);
    }

    const meshUUID = this.homey.settings.get('plejd_mesh');

    let currentAdvertisement;

    if (meshUUID) {
      this.log('Using saved mesh uuid', meshUUID);

      try {
        currentAdvertisement = await this.homey.ble.find(meshUUID.replace(/:/g, ''));
      } catch (error) {
        this.homey.settings.set('plejd_mesh', null);
        this.isConnecting = false;
        this.error(`error connecting: ${error}`);
        this.advertisementsNotWorking.push(meshUUID);

        return this.reconnect();
      }
    } else {
      let advertisements = [];

      this.log('No saved mesh uuid found');
      this.log('discover');

      for (let retries = 0; retries < 10; retries++) {
        let timeout = 15000;

        if (retries > 0) {
          timeout = 30000;
        }

        try {
          advertisements = await this.homey.ble.discover();
        } catch (error) {
          this.isConnecting = false;
          this.error(`error discovering: ${error}`);
          return this.reconnect();
        }

        if (advertisements.length === 0) {
          this.error('No plejd device found');
          await this.sleep(5000);
        } else {
          break;
        }
      }

      if (advertisements.length === 0) {
        this.isConnecting = false;
        this.error('error finding Plejd devices after 10 retries');

        return this.reconnect();
      }

      const sortedAdvertisements = advertisements.sort((a, b) => b.rssi - a.rssi)

      for (let i = 0, { length } = sortedAdvertisements; i < length; i++) {
        const advertisement = sortedAdvertisements[i];

        if (advertisement.localName) {
          this.log(advertisement.localName, advertisement.uuid, advertisement.rssi, this.advertisementsNotWorking.some(uuid => uuid === advertisement.uuid));
        }

        if (!currentAdvertisement && advertisement.localName === 'P mesh') { // && !this.advertisementsNotWorking.some(uuid => uuid === advertisement.uuid)
          currentAdvertisement = advertisement;
        }
      }

      advertisements = null;

      if (!currentAdvertisement) {
        this.isConnecting = false;
        this.error('error finding Plejd mesh');

        this.advertisementsNotWorking = [];
        return this.reconnect();
      }

      this.log('Saving mesh uuid for later use', currentAdvertisement.uuid);
      this.homey.settings.set('plejd_mesh', currentAdvertisement.uuid);
    }

    this.log('device connect');

    try {
      this.peripheral = await currentAdvertisement.connect();
    } catch (error) {
      this.isConnecting = false;
      this.homey.settings.set('plejd_mesh', null);
      this.error(`error connecting to peripheral: ${error}`);

      this.advertisementsNotWorking.push(currentAdvertisement.uuid);
      return this.reconnect();
    }

    this.log('getService');

    let service;

    try {
      service = await this.peripheral.getService(plejd.PLEJD_SERVICE);
    } catch (error) {
      this.error(`error getService: ${error}`);
      this.isConnecting = false;
      this.homey.settings.set('plejd_mesh', null);
      this.advertisementsNotWorking.push(currentAdvertisement.uuid);
      return this.reconnect();
    }

    try {
      const characteristics = await service.discoverCharacteristics();
      characteristics.forEach(characteristic => {
        // self.log('Characteristic', characteristic.uuid);

        if (plejd.DATA_UUID === characteristic.uuid) {
          self.dataCharacteristic = characteristic;
        } else if (plejd.LAST_DATA_UUID === characteristic.uuid) {
          self.lastDataCharacteristic = characteristic;
        } else if (plejd.AUTH_UUID === characteristic.uuid) {
          self.authCharacteristic = characteristic;
        } else if (plejd.PING_UUID === characteristic.uuid) {
          self.pingCharacteristic = characteristic;
        } else if (plejd.LIGHT_LEVEL_UUID === characteristic.uuid) {
          self.lightLevelCharacteristic = characteristic;
        }
      });
    } catch (error) {
      this.error(`error discoverCharacteristics: ${error}`);
      this.isConnecting = false;
      this.homey.settings.set('plejd_mesh', null);
      this.advertisementsNotWorking.push(currentAdvertisement.uuid);
      return this.reconnect();
    }

    service = null;

    if (this.dataCharacteristic
        && this.lastDataCharacteristic
        && this.lightLevelCharacteristic
        && this.authCharacteristic
        && this.pingCharacteristic) {
      this.plejdCommands = new plejd.Commands(
          cryptokey,
          this.peripheral.address,
          null, // this.homey.clock.getTimezone(),
          { log: this.log, error: this.error }
      );

      try {
        await this.authenticate();
      } catch (error) {
        this.isConnecting = false;
        this.error(`error authenticating: ${error}`);
        this.homey.settings.set('plejd_mesh', null);
        this.advertisementsNotWorking.push(currentAdvertisement.uuid);
        return this.reconnect();
      }

      this.isConnected = true;
      this.isConnecting = false;

      try {
        await this.setAllDevicesAsAvailable();

        await this.startPing();
        await this.plejdWriteFromList();
      } catch (error) {
        this.error(`error when connected: ${error}`);
        this.isConnecting = false;
        this.homey.settings.set('plejd_mesh', null);
        this.advertisementsNotWorking.push(currentAdvertisement.uuid);
        return this.reconnect();
      }

      // await this.syncTime();
      /*
      await this.syncTime();
      this.syncTimeIndex = this.homey.setInterval(async () => {
        await this.syncTime();
      }, 60000 * 60);
      */

      try {
        if (this.lastDataCharacteristic.subscribeToNotifications !== undefined) {
          this.log('startSubscribe');
          await this.startSubscribe();
        } else {
          this.log('startPollingState');
          await this.startPollingState();
        }
      } catch (error) {
        this.error(`error startSubscribe: ${error}`);
        this.isConnecting = false;
        this.homey.settings.set('plejd_mesh', null);
        this.advertisementsNotWorking.push(currentAdvertisement.uuid);
        return this.reconnect();
      }

      this.log('Plejd is connected');

      return Promise.resolve(true);
    }

    this.log('Error connecting. Not all characteristics found.');
    this.homey.settings.set('plejd_mesh', null);
    this.advertisementsNotWorking.push(currentAdvertisement.uuid);
    return this.reconnect();
  }

  async disconnect() {
    this.isDisconnecting = true;
    this.stopPollingState();
    this.homey.clearInterval(this.pingIndex);

    if (this.peripheral && this.peripheral.isConnected) {
      try {
        // this.log('Plejd disconnecting peripheral');
        await this.peripheral.disconnect();
      } catch (error) {
        this.error(`error disconnecting: ${error}`);
      }
    }

    await this.setAllDevicesAsUnavailable();

    this.isDisconnecting = false;
    this.isConnecting = false;
    this.isConnected = false;
    this.log('Plejd disconnected');

    return Promise.resolve(true);
  }

  async authenticate() {
    this.log('authenticating');
    // this.log('authenticate write');
    await this.authCharacteristic.write(this.plejdCommands.authenticateInitialize());

    // this.log('authenticate read');
    const data = await this.authCharacteristic.read();

    // this.log('authenticate write response');
    await this.authCharacteristic.write(this.plejdCommands.authenticateChallengeResponse(data));

    this.log('authenticating done');

    return Promise.resolve(true);
  }

  async syncTime() {
    const devices = this.devicesList;

    this.log('Sync time');

    if (devices.length) {
      await this.plejdWrite(this.plejdCommands.timeGet(devices[0].getData().plejdId));

      const data = await this.dataCharacteristic.read();

      const time = this.plejdCommands.timeParse(data);

      if (time) {
        if (time.diff > 60000) {
          this.log('Setting new time', time.diff / 1000, new Date(time.time));
          await this.plejdWrite(this.plejdCommands.timeSet());
        }
      } else {
        this.error('Sync time error');
      }
    }
  }

  async plejdWrite(data) {
    try {
      if (this.isConnecting || this.isDisconnecting) {
        this.log('Is connecting. Add to write list.');
        this.writeList.push(data);
        return Promise.resolve(true);
      }

      // this.log('Write to dataCharacteristic');
      await this.dataCharacteristic.write(data);

      await this.plejdWriteFromList();

      return Promise.resolve(true);
    } catch (error) {
      this.log('Error while writing. Add write to list and reconnect.');
      this.writeList.push(data);
      this.error(error);
      return this.reconnect();
    }
  }

  async plejdWriteFromList() {
    if (this.writeList.length > 0) {
      let writeData;
      // eslint-disable-next-line no-cond-assign
      while ((writeData = this.writeList.shift()) !== undefined) {
        this.log('Write to dataCharacteristic from write list');

        try {
          await this.dataCharacteristic.write(writeData);
        } catch (error) {
          this.error('Error writing from list', writeData, error);
        }
      }
    }

    return Promise.resolve(true);
  }

  async getDevicesState() {
    this.homey.clearTimeout(this.getDeviceStateIndex);
    this.getDeviceStateIndex = this.homey.setTimeout(async () => {
      if (this.lightLevelCharacteristic && this.plejdCommands) {
        await this.lightLevelCharacteristic.write(this.plejdCommands.stateGetAll());
      }
    }, 500);
  }

  async startSubscribe() {
    await this.lastDataCharacteristic.subscribeToNotifications(async data => {
      try {
        const state = this.plejdCommands.notificationParse(data);

        // this.log(`lastData subscribe: ${JSON.stringify(state)}`);

        if (state && state.cmd === 'state') {
          const device = this.devices[state.id];

          if (device) {
            await device.setState(state);
          }
        }
      } catch (error) {
        this.error(`lastData error: ${error}`);
      }
    });

    await this.lightLevelCharacteristic.subscribeToNotifications(async data => {
      try {
        const states = this.plejdCommands.stateParse(data);

        for (let i = 0, length = states.length; i < length; i++) {
          const state = states[i];
          const device = this.devices[state.id];

          this.log(`lightLevel subscribe: ${JSON.stringify(state)}`);

          if (device) {
            await device.setState(state);
          }
        }
      } catch (error) {
        this.error(`lightLevel error: ${error}`);
      }
    });

    await this.getDevicesState();
  }

  async startPollingState() {
    this.stopPollingState();
    const devices = this.devicesList;

    for (const device of devices) {
      const state = await this.getState(device.getData().plejdId);
      // this.log(`State ${device.getData().plejdId} ${JSON.stringify(state)}`);
      await device.setState(state);
      await this.sleep(200);
    }

    this.pollingIndex = this.homey.setTimeout(async () => {
      await this.startPollingState();
    }, 10000);

    return Promise.resolve(true);
  }

  stopPollingState() {
    this.homey.clearTimeout(this.pollingIndex);
  }

  sleep(ms) {
    return new Promise(resolve => {
      this.homey.setTimeout(resolve, ms);
    });
  }

  async getState(id) {
    try {
      // this.log('getState', id);

      if (this.lightLevelCharacteristic) {
        await this.lightLevelCharacteristic.write(this.plejdCommands.stateGet(id));

        const stateResponse = await this.lightLevelCharacteristic.read();

        // this.log('got state', stateResponse.toString('hex'));

        const states = this.plejdCommands.stateParse(stateResponse);
        let deviceState = null;

        states.forEach(state => {
          if (state.id === id) {
            deviceState = state;
          }
        });

        // this.log(`getState: ${JSON.stringify(deviceState)}`);

        return Promise.resolve(deviceState);
      }
      return Promise.resolve(false);
    } catch (error) {
      this.error(error);
      return Promise.resolve(false);
    }
  }

  async turnOn(id, brightness) {
    // this.log('turfOn', id, brightness || '');
    if (this.plejdCommands) {
      return this.plejdWrite(this.plejdCommands.deviceOn(id, brightness));
    }

    return Promise.resolve(false);
  }

  async turnOff(id) {
    // this.log('turfOff', id);
    if (this.plejdCommands) {
      return this.plejdWrite(this.plejdCommands.deviceOff(id));
    }

    return Promise.resolve(false);
  }

  async startPing() {
    this.homey.clearInterval(this.pingIndex);
    this.pingIndex = this.homey.setInterval(async () => {
      const pingOk = await this.plejdPing();

      // this.log('ping', pingOk);
      if (pingOk === false) {
        this.pingErrorCount++;
        this.log('ping not ok', this.pingErrorCount);

        if (this.pingErrorCount > 5) {
          this.log('ping not ok, reconnect.');
          this.pingErrorCount = 0;

          this.homey.settings.set('plejd_mesh', null);
          await this.reconnect();
        }
      }
    }, 300000); // -30s- 5m
  }

  async plejdPing() {
    try {
      const ping = this.plejdCommands.pingInitialize();

      // this.log('ping', ping);
      await this.pingCharacteristic.write(ping);
      const pong = await this.pingCharacteristic.read();

      // this.log('pong', pong);

      return Promise.resolve(this.plejdCommands.pingParsePong(ping, pong));
    } catch (error) {
      this.error(`Ping error: ${error}`);
      return Promise.resolve(false);
    }
  }
}

module.exports = PlejdApp;
