'use strict';

const Homey = require('homey');

const api = require('/lib/api');
const plejd = require('/lib/plejd');

class PlejdDriver extends Homey.Driver {

  async onInit() {
    this.log('Plejd driver has been inited');

    this.isDisconnecting = false;
    this.isConnecting = false;
    this.isConnected = false;
    this.writeList = [];
    this.plejdCommands = null;

    this.homey.on('unload', async () => {
      this.stopPollingState();

      await this.disconnect();

      clearInterval(this.syncTimeIndex);

      return Promise.resolve(true);
    });

    if (this.getDevices().length > 0) {
      await this.connect();
    }
  }

  async reconnect() {
    await this.disconnect();

    setTimeout(async () => {
      const connectOk = await this.connect();

      if (!connectOk) {
        setTimeout(async () => {
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

    if (this.isConnecting || this.isConnected) {
      return Promise.resolve(false);
    }

    this.log('Connecting...', this.isConnecting, this.isConnected);

    this.isConnecting = true;

    let cryptokey = this.homey.settings.get('cryptokey');

    if (!cryptokey) {
      this.log('No cryptokey exists.');
      return Promise.resolve(false);
    }

    let meshUUID = this.homey.settings.get('plejd_mesh');

    let device;

    if (meshUUID) {
      this.log('Using saved mesh uuid', meshUUID);

      try {
        device = await this.homey.ble.find(meshUUID.replace(/\:/g, ''));
      } catch (error) {
        this.homey.settings.set('plejd_mesh', null);
        this.isConnecting = false;
        this.log(`error connecting: ${error}`);

        return await this.reconnect();
      }
    } else {
      let list = [];

      this.log('No saved mesh uuid found');
      this.log('discover');

      for (let retries = 0; retries < 10; retries++) {
        try {
          list = await this.homey.ble.discover([plejd.PLEJD_SERVICE]);
        } catch (error) {
          this.isConnecting = false;
          this.error(`error discovering: ${error}`);
          return await this.reconnect();
        }

        if (list.length === 0) {
          this.error('No plejd device found');
        } else {
          break;
        }
      }

      if (list.length === 0) {
        this.isConnecting = false;
        return Promise.resolve(false);
      }

      for (let i = 0, length = list.length; i < length; i++) {
        let d = list[i];
        if (d.localName === 'P mesh') {
          device = d;
          break;
        }
      }

      if (!device) {
        this.isConnecting = false;
        return Promise.resolve(false);
      }

      this.log('Saving mesh uuid for later use', device.uuid);
      this.homey.settings.set('plejd_mesh', device.uuid);
    }

    if (device.__peripheral) {
      device.__peripheral = null;
    }

    this.log('device connect');

    try {
      this.peripheral = await device.connect();
    } catch (error) {
      this.isConnecting = false;
      this.homey.settings.set('plejd_mesh', null);
      this.error(`error connecting to peripheral: ${error}`);
      return await this.reconnect();
    }

    this.log('discoverAllServicesAndCharacteristics');

    try {
      const sac = await this.peripheral.discoverAllServicesAndCharacteristics();
    } catch (error) {
      this.isConnecting = false;
      this.homey.settings.set('plejd_mesh', null);
      this.log(`error discoverAllServicesAndCharacteristics: ${error}`);
      return await this.reconnect();
    }

    this.log('getService');

    let service;

    try {
      service = await this.peripheral.getService(plejd.PLEJD_SERVICE);
    } catch (error) {
      this.isConnecting = false;
      this.homey.settings.set('plejd_mesh', null);
      this.log(`error getService: ${error}`);
      return await this.reconnect();
    }

    service.characteristics.forEach(function(characteristic) {
      //self.log('Characteristic', characteristic);

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

    if (this.dataCharacteristic &&
          this.lastDataCharacteristic &&
          this.lightLevelCharacteristic &&
          this.authCharacteristic &&
          this.pingCharacteristic) {

      this.plejdCommands = new plejd.Commands(cryptokey, this.peripheral.address, this.homey.clock.getTimezone());

      try {
        await this.authenticate();
      } catch (error) {
        this.isConnecting = false;
        this.log(`error authenticating: ${error}`);
        return await this.reconnect();
      }

      this.isConnected = true;
      this.isConnecting = false;

      this.startPing();
      await this.plejdWriteFromList();

      await this.syncTime();
      this.syncTimeIndex = setInterval(async () => {
        await this.syncTime();
      }, 60000 * 60);

      this.startPollingState();

      this.log('Plejd is connected');

      return Promise.resolve(true);
    }

    this.log('Error connecting. Not all characteristics found.');
    return await this.reconnect();
  }

  async disconnect() {
    this.isDisconnecting = true;
    this.log('Plejd disconnecting');
    this.stopPollingState();
    clearInterval(this.pingIndex);

    if (this.peripheral) {
      try {
        this.log('Plejd disconnecting peripheral');
        await this.peripheral.disconnect();
      } catch (error) {
        this.error(`error disconnecting: ${error}`);
      }
    }

    this.isDisconnecting = false;
    this.isConnected = false;
    this.log('Plejd disconnected');

    return Promise.resolve(true);
  }

  async authenticate() {
    this.log('authenticating');
    //this.log('authenticate write');
    await this.authCharacteristic.write(this.plejdCommands.authenticateInitialize(), false);

    //this.log('authenticate read');
    var data = await this.authCharacteristic.read();

    //this.log('authenticate write response');
    await this.authCharacteristic.write(this.plejdCommands.authenticateChallengeResponse(data), false);

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

      //this.log('Write to dataCharacteristic');
      await this.dataCharacteristic.write(data, false);

      await this.plejdWriteFromList();

      return Promise.resolve(true);
    } catch(error) {
      this.error(error);
      return Promise.resolve(false);
    }
  }

  async plejdWriteFromList() {
    if (this.writeList.length > 0) {
      let writeData;
      while ((writeData = this.writeList.shift()) !== undefined) {
        this.log('Write to dataCharacteristic from write list');
        await this.dataCharacteristic.write(writeData, false);
      }
    }

    return Promise.resolve(true);
  }

  async startPollingState() {
    clearTimeout(this.pollingIndex);
    this.pollingIndex = setTimeout(async () => {
      for (const device of this.getDevices()) {
        const state = await this.getState(device.getData().plejdId);
        device.setState(state);
        this.sleep(200);
      }

      await this.startPollingState();
    }, 2000);
  }

  stopPollingState() {
    clearTimeout(this.pollingIndex);
  }

  sleep(ms) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
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

        states.forEach((state) => {
          if (state.id === id) {
            deviceState = state;
          }
        });

        return Promise.resolve(deviceState);

      } else {
        return Promise.resolve(false);
      }
    } catch(error) {
      this.error(error);
      return Promise.resolve(false);
    }
  }

  async turnOn(id, brightness) {
    //this.log('turfOn', id, brightness || '');
    if (this.plejdCommands) {
      return await this.plejdWrite(this.plejdCommands.deviceOn(id, brightness));
    }
  }

  async turnOff(id) {
    //this.log('turfOff', id);
    if (this.plejdCommands) {
      return await this.plejdWrite(this.plejdCommands.deviceOff(id));
    }
  }

  async startPing() {
    clearInterval(this.pingIndex);
    this.pingIndex = setInterval(async () => {
      if (this.isConnected) {
        var pingOk = await this.plejdPing();

        //this.log('ping', pingOk);
        if (pingOk === false) {
          this.log('ping not ok, reconnect.');
          await this.reconnect();
        }
      } else {
        await this.reconnect();
      }

      return Promise.resolve(true);
    }, 30000); // 30s

    return Promise.resolve(true);
  };

  async plejdPing() {
    try {
      var ping = this.plejdCommands.pingInitialize();

      //this.log('ping', ping);
      await this.pingCharacteristic.write(ping, false);
      var pong = await this.pingCharacteristic.read();

      //this.log('pong', pong);

      return Promise.resolve(this.plejdCommands.pingParsePong(ping, pong));
    } catch(error) {
      this.error(`Ping error: ${error}`);
      return Promise.resolve(false);
    }
  };

  onPair(session) {
    let self = this,
        plejdSites,
        plejdApi;

    session.setHandler('showView', async (viewId) => {
      if (viewId === 'login') {
        self.log('Try login');

        let sessionToken = this.homey.settings.get('sessionToken');

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
    });

    session.setHandler('login', async (data) => {
      let username = data.username;
      let password = data.password;

      if (username) {
        username = username.toLowerCase();
      }

      plejdApi = new api.PlejdApi(username, password);

      const token = await plejdApi.login();

      if (token) {
        this.homey.settings.set('sessionToken', token);
        return Promise.resolve(true);
      } else {
        return Promise.resolve(false);
      }
    });

    session.setHandler('getSites', async () => {
      self.log('Getting sites');
      if (plejdSites) {
        return plejdSites;
      } else {
        const sites = plejdApi.getSites();
        self.log('sites', sites);

        return sites;
      }
    });

    session.setHandler('saveSite', async (data) => {
      await plejdApi.getSite(data.site);
      self.log('Saving site: ' + data.site);

      return null;
    });

    session.setHandler('list_devices', async (data) => {
      let devices = [];

      let cryptoKey = plejdApi.getCryptoKey();
      this.homey.settings.set('cryptokey', cryptoKey);

      let plejdDevices = plejdApi.getDevices();

      plejdDevices.forEach(function(plejdDevice) {
        let capabilities = ['onoff'];

        if (plejdDevice.dimmable) {
          capabilities.push('dim');
        }

        devices.push({
          name: plejdDevice.name,
          data: {
            id: plejdDevice.deviceId,
            plejdId: plejdDevice.id,
            dimmable: plejdDevice.dimmable
          },
          capabilities: capabilities
        });
      });

      return devices;
    });
  }

}

module.exports = PlejdDriver;
