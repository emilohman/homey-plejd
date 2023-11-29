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
    this.writeQueue = [];

    this.homey.on('unload', async () => {
      this.log('Unloading app');
      this.stopPollingState();

      this.homey.clearInterval(this.syncTimeIndex);

      this.homey.clearTimeout(this.writeLoopIndex);

      await this.disconnect();
    });

    if (this.devicesList.length > 0) {
      await this.connect();
    }
  }

  async registerDevice(device) {
    if (this.devices[device.getData().plejdId]) {
      return;
    }

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

    if (this.devices[device.getData().plejdId]) {
      delete this.devices[device.getData().plejdId];
    }

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

        // if (!currentAdvertisement && this.devicesList.some(device => device.getData().id.toLowerCase() === advertisement.uuid.toLowerCase())) {
        if (!currentAdvertisement && advertisement.localName === 'P mesh') { // && !this.advertisementsNotWorking.some(uuid => uuid === advertisement.uuid)
          currentAdvertisement = advertisement;
        }

        this.log(advertisement.localName, advertisement.uuid, advertisement.rssi, this.devicesList.some(device => device.getData().id.toLowerCase() === advertisement.uuid.toLowerCase()));
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
      this.peripheral.once('disconnect', () => {
        this.log('Peripheral disconnected');
        this.reconnect();
      });
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
        { log: this.log, error: this.error },
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
        await this.runWriteLoop();

        await this.setAllDevicesAsAvailable();

        await this.startPing();
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

    this.dataCharacteristic = null;
    this.lastDataCharacteristic = null;
    this.authCharacteristic = null;
    this.pingCharacteristic = null;
    this.lightLevelCharacteristic = null;
    this.peripheral = null;

    try {
      await this.setAllDevicesAsUnavailable();
    } catch (error) {
      this.error(error);
    }

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
    return this.dataCharacteristic.write(data);
  }

  async getDevicesState() {
    this.homey.clearTimeout(this.getDeviceStateIndex);
    this.getDeviceStateIndex = this.homey.setTimeout(async () => {
      if (this.lightLevelCharacteristic && this.plejdCommands && this.isConnected) {
        try {
          await this.lightLevelCharacteristic.write(this.plejdCommands.stateGetAll());
        } catch (error) {
          this.log('Error while writing getDevicesState.');
          this.error(error);
        }
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
    this.log('turnOn', id, brightness || '');
    if (this.plejdCommands) {
      this.writeQueue.unshift({
        id,
        command: this.plejdCommands.deviceOn(id, brightness),
        shouldRetry: true,
      });
    }

    return Promise.resolve(false);
  }

  async turnOff(id) {
    this.log('turnOff', id);
    if (this.plejdCommands) {
      this.writeQueue.unshift({
        id,
        command: this.plejdCommands.deviceOff(id),
        shouldRetry: true,
      });
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

  async runWriteLoop() {
    this.homey.clearTimeout(this.writeLoopIndex);

    try {
      while (this.writeQueue.length > 0) {
        if (!this.isConnected) {
          return;
        }

        const queueItem = this.writeQueue.pop();

        this.writeQueue = this.writeQueue.filter(item => !(item.id === queueItem.id && item.command.equals(queueItem.command)));

        try {
          this.log('Writing', queueItem.id, this.writeQueue.length, queueItem.command.toString('hex'));
          await this.plejdWrite(queueItem.command);
        } catch (error) {
          if (queueItem.shouldRetry) {
            queueItem.retryCount = (queueItem.retryCount || 0) + 1;
            this.log(`Will retry command, count failed so far ${queueItem.retryCount} (${queueItem.id})`);
            if (queueItem.retryCount <= 5) {
              this.log(`Adding items back to queue id: ${queueItem.id}`);
              this.writeQueue.push(queueItem);

              break;
            } else {
              this.error(`Write queue: Exceed max retry count (${5}) for (${queueItem.id}).`);
            }
          }
        }
      }
    } catch (error) {
      this.error('write queue error', error);
    }

    this.writeLoopIndex = this.homey.setTimeout(async () => {
      await this.runWriteLoop();
    }, 400);
  }

}

module.exports = PlejdApp;
