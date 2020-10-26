'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const xor = require('buffer-xor');

const api = require('/lib/api');

const PLEJD_SERVICE = "31ba000160854726be45040c957391b5";
const DATA_UUID = "31ba000460854726be45040c957391b5";
const LAST_DATA_UUID = "31ba000560854726be45040c957391b5";
const AUTH_UUID = "31ba000960854726be45040c957391b5";
const PING_UUID = "31ba000a60854726be45040c957391b5";

class PlejdDriver extends Homey.Driver {

  async onInit() {
    this.log('Plejd driver has been inited');

    this.isPinging = false;
    this.isDisconnecting = false;
    this.isConnecting = false;
    this.isConnected = false;
    this.keepConnectionAlive = Homey.ManagerSettings.get('keepalive') || false;
    this.writeList = [];

    Homey.on("unload", async () => {
      if (this.keepConnectionAlive) {
        await this.disconnect();
      }
      return Promise.resolve(true);
    });

    if (this.getDevices().length > 0) {
      if (this.keepConnectionAlive) {
        await this.connect();
      }
    }

    Homey.ManagerSettings.on('set', async (key) => {
      if (key === 'keepalive') {
        let oldKeepAlive = this.keepConnectionAlive;

        this.keepConnectionAlive = Homey.ManagerSettings.get('keepalive');

        if (oldKeepAlive !== this.keepConnectionAlive) {
          if (this.keepConnectionAlive) {
            await this.connect();
          } else {
            await this.disconnect();
          }
         }
      }

      if (key === 'cryptokey') {
        if (this.keepConnectionAlive) {
          await this.reconnect();
        }
      }
    });
  }

  async reconnect() {
    await this.disconnect();

    setTimeout(async () => {
      const connectOk = await this.connect();

      if (!connectOk) {
        setTimeout(async () => {
          this.reconnect();
        }, 10000);
        return Promise.resolve(false);
      }
      return Promise.resolve(true);
    }, 500);

    return Promise.resolve(true);
  }

  async connect() {
    const self = this;

    this.log('Connecting...', this.isConnecting, this.isConnected);

    if (this.isConnecting || this.isConnected) {
      return Promise.resolve(false);
    }

    this.isConnecting = true;

    let cryptokey = Homey.ManagerSettings.get('cryptokey');

    if (cryptokey) {
      this.cryptokey = Buffer.from(cryptokey.replace(/-/g, ''), 'hex');
    } else {
      this.log('No cryptokey exists.');
      return Promise.resolve(false);
    }

    let meshUUID = Homey.ManagerSettings.get('plejd_mesh');

    let device;

    if (meshUUID) {
      this.log('Using saved mesh uuid', meshUUID);

      try {
        device = await Homey.ManagerBLE.find(meshUUID.replace(/\:/g, ''));
      } catch (error) {
        Homey.ManagerSettings.set('plejd_mesh', null);
        this.isConnecting = false;
        this.log(`error connecting: ${error}`);

        if (this.keepConnectionAlive) {
          return await this.reconnect();
        } else {
          return Promise.resolve(false);
        }
      }
    } else {
      let list = [];

      this.log('No saved mesh uuid found');
      this.log('discover');

      for (let retries = 0; retries < 10; retries++) {
        try {
          list = await Homey.ManagerBLE.discover([PLEJD_SERVICE]);
        } catch (error) {
          this.isConnecting = false;
          this.log(`error discovering: ${error}`);
          if (this.keepConnectionAlive) {
            return await this.reconnect();
          } else {
            return Promise.resolve(false);
          }
        }

        if (list.length === 0) {
          this.log('No plejd device found');
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
        this.log(d);
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
      Homey.ManagerSettings.set('plejd_mesh', device.uuid);
    }

    if (device.__peripheral) {
      device.__peripheral = null;
    }

    this.log('device connect');

    try {
      this.peripheral = await device.connect();
    } catch (error) {
      this.isConnecting = false;
      this.log(`error connecting to peripheral: ${error}`);
      if (this.keepConnectionAlive) {
        return await this.reconnect();
      } else {
        return Promise.resolve(false);
      }
    }

    this.address = this.reverseBuffer(Buffer.from(String(this.peripheral.address).replace(/\:/g, ''), 'hex'));

    this.log('discoverAllServicesAndCharacteristics');

    try {
      const sac = await this.peripheral.discoverAllServicesAndCharacteristics();
    } catch (error) {
      this.isConnecting = false;
      this.log(`error discoverAllServicesAndCharacteristics: ${error}`);
      if (this.keepConnectionAlive) {
        return await this.reconnect();
      } else {
        return Promise.resolve(false);
      }
    }

    this.log('getService');

    let service;

    try {
      service = await this.peripheral.getService(PLEJD_SERVICE);
    } catch (error) {
      this.isConnecting = false;
      this.log(`error getService: ${error}`);
      if (this.keepConnectionAlive) {
        return await this.reconnect();
      } else {
        return Promise.resolve(false);
      }
    }

    service.characteristics.forEach(function(characteristic) {
      if (DATA_UUID === characteristic.uuid) {
        self.dataCharacteristic = characteristic;
      } else if (LAST_DATA_UUID === characteristic.uuid) {
        self.lastDataCharacteristic = characteristic;
      } else if (AUTH_UUID === characteristic.uuid) {
        self.authCharacteristic = characteristic;
      } else if (PING_UUID === characteristic.uuid) {
        self.pingCharacteristic = characteristic;
      }
    });

    if (this.dataCharacteristic &&
          this.lastDataCharacteristic &&
          this.authCharacteristic &&
          this.pingCharacteristic) {

      try {
        await this.authenticate();
      } catch (error) {
        this.isConnecting = false;
        this.log(`error authenticating: ${error}`);
        if (this.keepConnectionAlive) {
          return await this.reconnect();
        } else {
          return Promise.resolve(false);
        }
      }

      this.isConnected = true;
      this.isConnecting = false;

      if (this.keepConnectionAlive) {
        this.startPing();
        await this.plejdWriteFromList();
      }

      this.log('Plejd is connected');

      return Promise.resolve(true);
    }

    this.log('Error connecting. Not all characteristics found.');
    if (this.keepConnectionAlive) {
      return await this.reconnect();
    } else {
      return Promise.resolve(false);
    }
  }

  async disconnect() {
    this.isDisconnecting = true;
    this.log('Plejd disconnecting');
    clearInterval(this.pingIndex);

    if (this.isConnected) {
      if (this.peripheral) {
        try {
          this.log('Plejd disconnecting peripheral');
          await this.peripheral.disconnect();
        } catch (error) {
          this.log(`error disconnecting: ${error}`);
        }
      }
    }

    this.isDisconnecting = false;
    this.isConnected = false;
    this.log('Plejd disconnected');

    this.plejdWriteFromList();

    return Promise.resolve(true);
  }

  async authenticate() {
    this.log('authenticate write');
    await this.authCharacteristic.write(Buffer.from([0]), false);
    this.log('authenticate read');
    var data = await this.authCharacteristic.read();

    var resp = this.plejdChalresp(this.cryptokey, data);

    this.log('authenticate write response');
    await this.authCharacteristic.write(resp, false);

    return Promise.resolve(true);
  }

  plejdChalresp(key, chal) {
    var intermediate = crypto.createHash('sha256').update(xor(key, chal)).digest();

    var part1 = intermediate.subarray(0, 16);
    var part2 = intermediate.subarray(16);

    return xor(part1, part2);
  }

  plejdEncDec(key, addr, data) {
    var buf = Buffer.concat([addr, addr, addr.subarray(0, 4)]);

    var cipher = crypto.createCipheriv("aes-128-ecb", key, '');
    cipher.setAutoPadding(false);

    var ct = cipher.update(buf).toString('hex');
    ct += cipher.final().toString('hex');
    ct = Buffer.from(ct, 'hex');

    var output = "";
    for (var i = 0, length = data.length; i < length; i++) {
      output += String.fromCharCode(data[i] ^ ct[i % 16]);
    }

    return Buffer.from(output, 'ascii');
  }

  async plejdWrite(data) {
    try {
      let self = this;

      if (this.isConnecting || this.isDisconnecting || this.isPinging) {
        this.log('Is connecting. Add to write list.');
        this.writeList.push(data);
        return Promise.resolve(true);
        return Promise.resolve(true);
      }

      if (!this.keepConnectionAlive) {
        await this.connect();

        if (!this.isConnected && Homey.ManagerSettings.get('plejd_mesh')) {
          Homey.ManagerSettings.set('plejd_mesh', null);
          this.log('Not connected. Resetting mesh and connect.');
          await this.connect();

          if (!this.isConnected) {
            return Promise.resolve(false);
          }
        }
      }

      this.log('Write to dataCharacteristic');
      await this.dataCharacteristic.write(this.plejdEncDec(this.cryptokey, this.address, data), false);

      await this.plejdWriteFromList();

      if (!this.keepConnectionAlive) {
        clearTimeout(this.disconnectIntervalIndex);
        this.disconnectIntervalIndex = setTimeout(async () => {
          await self.disconnect();
        }, 5000);
      }

      return Promise.resolve(true);
    } catch(error) {
      this.log(error);
      return Promise.resolve(false);
    }
  }

  async plejdWriteFromList() {
    if (this.writeList.length > 0) {
      if (!this.isConnected) {
        await this.connect();
      }

      let writeData;
      while ((writeData = this.writeList.shift()) !== undefined) {
        this.log('Write to dataCharacteristic from write list');
        await this.dataCharacteristic.write(this.plejdEncDec(this.cryptokey, this.address, writeData), false);
      }

      if (!this.keepConnectionAlive) {
        clearTimeout(this.disconnectIntervalIndex);
        this.disconnectIntervalIndex = setTimeout(async () => {
          await self.disconnect();
        }, 5000);
      }
    }

    return Promise.resolve(true);
  }

  async turnOn(id, brightness) {
    try {
      let payload;

      if (!brightness) {
        payload = Buffer.from((id).toString(16).padStart(2, '0') + '0110009701', 'hex');
      } else {
        brightness = brightness << 8 | brightness;
        payload = Buffer.from((id).toString(16).padStart(2, '0') + '0110009801' + (brightness).toString(16).padStart(4, '0'), 'hex');
      }

      await this.plejdWrite(payload);

      return Promise.resolve(true);
    } catch(error) {
      this.log(error);
      return Promise.resolve(false);
    }
  }

  async turnOff(id) {
    try {
      let payload = Buffer.from((id).toString(16).padStart(2, '0') + '0110009700', 'hex');

      await this.plejdWrite(payload);

      return Promise.resolve(true);
    } catch(error) {
      this.log(error);
      return Promise.resolve(false);
    }
  }

  async startPing() {
    clearInterval(this.pingIndex);
    this.pingIndex = setInterval(async () => {
      //this.log('pingInterval', self.isConnected);
      if (this.isConnected) {
        var pingOk = await this.plejdPing();

        this.log('ping', pingOk);
        if (pingOk === false) {
          this.log('ping not ok, reconnect.');
          if (this.keepConnectionAlive) {
            await this.reconnect();
          }
        } else {
          await this.plejdWriteFromList();
        }
      } else {
        if (this.keepConnectionAlive) {
          await this.reconnect();
        }
      }

      return Promise.resolve(true);
    }, 30000); // 30s

    return Promise.resolve(true);
  };

  async plejdPing() {
    try {
      this.isPinging = true;
      var ping = crypto.randomBytes(1);

      this.log('ping', ping);
      await this.pingCharacteristic.write(ping, false);
      var pong = await this.pingCharacteristic.read();

      this.log('pong', pong);
      this.isPinging = false;

      if(((ping[0] + 1) & 0xff) !== pong[0]) {
        return Promise.resolve(false);
      } else {
        return Promise.resolve(true);
      }
    } catch(error) {
      this.isPinging = false;
      this.log(`Ping error: ${error}`);
      return Promise.resolve(false);
    }
  };

  reverseBuffer(src) {
    var buffer = Buffer.allocUnsafe(src.length);

    for (var i = 0, j = src.length - 1; i <= j; ++i, --j) {
      buffer[i] = src[j];
      buffer[j] = src[i];
    }

    return buffer;
  }

  onPair(socket) {
    let self = this,
        plejdSites,
        plejdApi;

    socket.on('showView', async ( viewId, callback ) => {
      if (viewId === 'login') {
        self.log('Try login');

        let sessionToken = Homey.ManagerSettings.get('sessionToken');

        if (sessionToken) {
          plejdApi = new api.PlejdApi(null, null, sessionToken);

          self.log('Getting sites');

          plejdApi.getSites((err, sites) => {
            self.log('sites', sites);

            if (err) {
              Homey.ManagerSettings.set('sessionToken', null);
              callback();
            } else {
              plejdSites = sites;
              socket.nextView();
              callback();
            }
          });
        } else {
          callback();
        }
      }
   });

    socket.on('login', ( data, callback ) => {
      let username = data.username;
      let password = data.password;

      if (username) {
        username = username.toLowerCase();
      }

      plejdApi = new api.PlejdApi(username, password);

      plejdApi.once('loggedIn', (token) => {
        Homey.ManagerSettings.set('sessionToken', token);

        callback(null, true);
      });

      plejdApi.once('loggedInError', () => {
        callback(null, false);
      });

      plejdApi.login();
    });

    socket.on('getSites', ( data, callback ) => {
      self.log('Getting sites');
      if (plejdSites) {
        callback(null, plejdSites);
      } else {
        plejdApi.getSites((err, sites) => {
          self.log('sites', sites);

          callback( null, sites );
        });
      }
    });

    socket.on('saveSite', function( data, callback ) {
      plejdApi.getSite(data.site, function(_site) {
        self.log('Saving site: ' + data.site);

        callback( null );
      });
    });

    socket.on('list_devices', ( data, callback ) => {

      let devices = [];

      let cryptoKey = plejdApi.getCryptoKey();
      Homey.ManagerSettings.set('cryptokey', cryptoKey);

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

      callback( null, devices );

    });
  }

}

module.exports = PlejdDriver;
