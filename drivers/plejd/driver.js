'use strict';

const Homey = require('homey');

const api = require('../../lib/api');
const plejd = require('../../lib/plejd');

class PlejdDriver extends Homey.Driver {

  async onInit() {
    this.log('Plejd driver has been inited');

    this.isDisconnecting = false;
    this.isConnecting = false;
    this.isConnected = false;
    this.writeList = [];
    this.plejdCommands = null;

    this.homey.on('unload', async () => {
      this.log('Unloading app');
      this.stopPollingState();

      this.homey.clearInterval(this.syncTimeIndex);

      await this.disconnect();
    });

    if (this.getDevices().length > 0) {
      await this.connect();
    }
  }

  async reconnect() {
    this.log('Reconnecting');
    await this.disconnect();

    this.homey.setTimeout(async () => {
      this.log('Start reconnecting');
      const connectOk = await this.connect();

      if (!connectOk) {
        this.homey.setTimeout(async () => {
          this.reconnect();
        }, 30000);
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    }, 500);

    return Promise.resolve(true);
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

        return this.reconnect();
      }
    } else {
      let advertisements = [];

      this.log('No saved mesh uuid found');
      this.log('discover');

      for (let retries = 0; retries < 10; retries++) {
        try {
          advertisements = await this.homey.ble.discover([plejd.PLEJD_SERVICE], 10000);
        } catch (error) {
          this.isConnecting = false;
          this.error(`error discovering: ${error}`);
          return this.reconnect();
        }

        if (advertisements.length === 0) {
          this.error('No plejd device found');
        } else {
          break;
        }
      }

      if (advertisements.length === 0) {
        this.isConnecting = false;
        return Promise.resolve(false);
      }

      for (let i = 0, { length } = advertisements; i < length; i++) {
        const advertisement = advertisements[i];
        if (advertisement.localName === 'P mesh') {
          currentAdvertisement = advertisement;
          break;
        }
      }

      advertisements = null;

      if (!currentAdvertisement) {
        this.isConnecting = false;
        return Promise.resolve(false);
      }

      this.log('Saving mesh uuid for later use', currentAdvertisement.uuid);
      this.homey.settings.set('plejd_mesh', currentAdvertisement.uuid);
    }

    if (currentAdvertisement.__peripheral) {
      currentAdvertisement.__peripheral = null;
    }

    this.log('device connect');

    try {
      this.peripheral = await currentAdvertisement.connect();
    } catch (error) {
      this.isConnecting = false;
      this.homey.settings.set('plejd_mesh', null);
      this.error(`error connecting to peripheral: ${error}`);
      return this.reconnect();
    }

    this.log('getService');

    let service;

    try {
      service = await this.peripheral.getService(plejd.PLEJD_SERVICE);
    } catch (error) {
      this.isConnecting = false;
      this.homey.settings.set('plejd_mesh', null);
      this.error(`error getService: ${error}`);
      return this.reconnect();
    }

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

    service = null;

    if (this.dataCharacteristic
          && this.lastDataCharacteristic
          && this.lightLevelCharacteristic
          && this.authCharacteristic
          && this.pingCharacteristic) {
      this.plejdCommands = new plejd.Commands(
        cryptokey,
        this.peripheral.address,
          null,
          { log: this.log, error: this.error }
        // this.homey.clock.getTimezone(),
      );

      try {
        await this.authenticate();
      } catch (error) {
        this.isConnecting = false;
        this.error(`error authenticating: ${error}`);
        return this.reconnect();
      }

      this.isConnected = true;
      this.isConnecting = false;

      this.startPing();
      await this.plejdWriteFromList();

      await this.syncTime();
      /*
      await this.syncTime();
      this.syncTimeIndex = this.homey.setInterval(async () => {
        await this.syncTime();
      }, 60000 * 60);
      */
      this.startPollingState();

      this.log('Plejd is connected');

      return Promise.resolve(true);
    }

    this.log('Error connecting. Not all characteristics found.');
    return this.reconnect();
  }

  async disconnect() {
    this.isDisconnecting = true;
    this.log('Plejd disconnecting');
    this.stopPollingState();
    this.homey.clearInterval(this.pingIndex);

    if (this.peripheral) {
      try {
        // this.log('Plejd disconnecting peripheral');
        await this.peripheral.disconnect();
      } catch (error) {
        this.error(`error disconnecting: ${error}`);
      }
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
    await this.authCharacteristic.write(this.plejdCommands.authenticateInitialize(), false);

    // this.log('authenticate read');
    const data = await this.authCharacteristic.read();

    // this.log('authenticate write response');
    await this.authCharacteristic.write(
      this.plejdCommands.authenticateChallengeResponse(data), false,
    );

    this.log('authenticating done');

    return Promise.resolve(true);
  }

  async syncTime() {
    const devices = this.getDevices();

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
      await this.dataCharacteristic.write(data, false);

      await this.plejdWriteFromList();

      return Promise.resolve(true);
    } catch (error) {
      this.error(error);
      return Promise.resolve(false);
    }
  }

  async plejdWriteFromList() {
    if (this.writeList.length > 0) {
      let writeData;
      // eslint-disable-next-line no-cond-assign
      while ((writeData = this.writeList.shift()) !== undefined) {
        this.log('Write to dataCharacteristic from write list');
        await this.dataCharacteristic.write(writeData, false);
      }
    }

    return Promise.resolve(true);
  }

  async startPollingState() {
    this.stopPollingState();
    const devices = this.getDevices();

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
        await this.lightLevelCharacteristic.write(this.plejdCommands.stateGet(id), false);

        const stateResponse = await this.lightLevelCharacteristic.read();

        // this.log('got state', stateResponse.toString('hex'));

        const states = this.plejdCommands.stateParse(stateResponse);
        let deviceState = null;

        // this.log('getState write', states);

        states.forEach(state => {
          if (state.id === id) {
            deviceState = state;
          }
        });

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
      if (this.isConnected) {
        const pingOk = await this.plejdPing();

        // this.log('ping', pingOk);
        if (pingOk === false) {
          this.log('ping not ok, reconnect.');
          await this.reconnect();
        }
      } else {
        this.log('ping not connected, reconnect.');
        await this.reconnect();
      }

      return Promise.resolve(true);
    }, 30000); // 30s

    return Promise.resolve(true);
  }

  async plejdPing() {
    try {
      const ping = this.plejdCommands.pingInitialize();

      // this.log('ping', ping);
      await this.pingCharacteristic.write(ping, false);
      const pong = await this.pingCharacteristic.read();

      // this.log('pong', pong);

      return Promise.resolve(this.plejdCommands.pingParsePong(ping, pong));
    } catch (error) {
      this.error(`Ping error: ${error}`);
      return Promise.resolve(false);
    }
  }

  onPair(session) {
    const self = this;
    let plejdSites;
    let plejdApi;

    session.setHandler('showView', async viewId => {
      if (viewId === 'login') {
        self.log('Try login');

        const sessionToken = this.homey.settings.get('sessionToken');

        if (sessionToken) {
          plejdApi = new api.PlejdApi(null, null, sessionToken);

          self.log('Getting sites');

          const sites = await plejdApi.getSites();

          self.log('sites', sites);

          if (sites) {
            plejdSites = sites;
            await session.nextView();
          } else {
            this.homey.settings.set('sessionToken', null);
            return Promise.resolve(true);
          }
        } else {
          return Promise.resolve(true);
        }
      }

      return Promise.resolve(true);
    });

    session.setHandler('login', async data => {
      let { username } = data;
      const { password } = data;

      if (username) {
        username = username.toLowerCase();
      }

      plejdApi = new api.PlejdApi(username, password);

      const token = await plejdApi.login();

      if (token) {
        this.homey.settings.set('sessionToken', token);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    });

    session.setHandler('getSites', async () => {
      self.log('Getting sites');
      if (plejdSites) {
        return plejdSites;
      }
      const sites = plejdApi.getSites();
      self.log('sites', sites);

      return sites;
    });

    session.setHandler('saveSite', async data => {
      await plejdApi.getSite(data.site);
      self.log(`Saving site: ${data.site}`);

      return null;
    });

    session.setHandler('list_devices', async () => {
      const devices = [];

      const cryptoKey = plejdApi.getCryptoKey();
      this.homey.settings.set('cryptokey', cryptoKey);

      const plejdDevices = plejdApi.getDevices();

      plejdDevices.forEach(plejdDevice => {
        const capabilities = ['onoff'];

        if (plejdDevice.dimmable) {
          capabilities.push('dim');
        }

        devices.push({
          name: plejdDevice.name,
          data: {
            id: plejdDevice.deviceId,
            plejdId: plejdDevice.id,
            dimmable: plejdDevice.dimmable,
          },
          capabilities,
        });
      });

      return devices;
    });
  }

}

module.exports = PlejdDriver;
