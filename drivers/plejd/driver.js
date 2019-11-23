'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const xor = require('buffer-xor')

const PLEJD_SERVICE = "31ba000160854726be45040c957391b5";
const DATA_UUID = "31ba000460854726be45040c957391b5";
const LAST_DATA_UUID = "31ba000560854726be45040c957391b5";
const AUTH_UUID = "31ba000960854726be45040c957391b5";
const PING_UUID = "31ba000a60854726be45040c957391b5";

class PlejdDriver extends Homey.Driver {

  async onInit() {
    this.log('Plejd driver has been inited');

    this.isConnecting = false;
    this.isConnected = false;
    this.keepConnectionAlive = false;
    this.writeList = [];

    Homey.on("unload", async () => {
      if (this.keepConnectionAlive) {
        await this.disconnect();
      }
    });

    if (this.getDevices().length > 0) {
      if (this.keepConnectionAlive) {
        await this.connect();
      }
    }

    Homey.ManagerSettings.on('set', (key) => {
      if (key === 'keepalive') {
        let oldKeepAlive = this.keepConnectionAlive;

        this.keepConnectionAlive = Homey.ManagerSettings.get('keepalive');

        if (oldKeepAlive !== this.keepConnectionAlive) {
          if (this.keepConnectionAlive) {
            this.connect();
          } else {
            this.disconnect();
          }
         }
      }

      if (key === 'cryptokey') {
        if (this.keepConnectionAlive) {
          this.disconnect();
          this.connect();
        }
      }
    });
  }

  async connect() {
    const self = this;

    this.log(this.isConnecting, this.isConnected);

    if (this.isConnecting || this.isConnected) {
      return Promise.resolve(false);
    }

    this.log('Connecting...');

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
        this.isConnecting = false;
        this.log(`error connecting: ${error}`);
        return Promise.resolve(false);
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
          return Promise.resolve(false);
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
      };

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
      return Promise.resolve(false);
    }

    this.address = this.reverseBuffer(Buffer.from(String(this.peripheral.address).replace(/\:/g, ''), 'hex'));

    this.log('discoverAllServicesAndCharacteristics');

    try {
      const sac = await this.peripheral.discoverAllServicesAndCharacteristics();
    } catch (error) {
      this.isConnecting = false;
      this.log(`error discoverAllServicesAndCharacteristics: ${error}`);
      return Promise.resolve(false);
    }

    this.log('getService');

    let service;

    try {
      service = await this.peripheral.getService(PLEJD_SERVICE);
    } catch (error) {
      this.isConnecting = false;
      this.log(`error getService: ${error}`);
      return Promise.resolve(false);
    }

    service.characteristics.forEach(function(characteristic) {
      if (DATA_UUID == characteristic.uuid) {
        self.dataCharacteristic = characteristic;
      } else if (LAST_DATA_UUID == characteristic.uuid) {
        self.lastDataCharacteristic = characteristic;
      } else if (AUTH_UUID == characteristic.uuid) {
        self.authCharacteristic = characteristic;
      } else if (PING_UUID == characteristic.uuid) {
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
        return Promise.resolve(false);
      }

      this.isConnected = true;
      this.isConnecting = false;

      if (this.keepConnectionAlive) {
        this.startPing();
      }

      this.log('Plejd is connected');
    }
  }

  async disconnect() {
    this.log('Plejd disconnecting');
    if (this.isConnected) {
      clearInterval(this.pingIndex);
      if (this.peripheral) {
        try {
          await this.peripheral.disconnect();
        } catch (error) {
          this.log(`error disconnecting: ${error}`);
          return Promise.resolve(false);
        }

        this.isConnected = false;
        this.log('Plejd disconnected');
      }
    } else {
      clearInterval(this.pingIndex);
      this.isConnected = false;
      this.log('Plejd disconnected');
    }
  }

  async authenticate() {
    this.log('authenticate write');
    await this.authCharacteristic.write(Buffer.from([0]), false);
    this.log('authenticate read');
    var data = await this.authCharacteristic.read();

    var resp = this.plejdChalresp(this.cryptokey, data);

    this.log('authenticate write response');
    await this.authCharacteristic.write(resp, false);
  }

  plejdChalresp(key, chal) {
    var intermediate = crypto.createHash('sha256').update(xor(key, chal)).digest();

    var part1 = intermediate.subarray(0, 16);
    var part2 = intermediate.subarray(16);

    var resp = xor(part1, part2);

    return resp;
  }

  plejdEncDec(key, addr, data) {
      var buf = Buffer.concat([addr, addr, addr.subarray(0, 4)]);

      var cipher = crypto.createCipheriv("aes-128-ecb", key, '')
      cipher.setAutoPadding(false)

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

      if (this.isConnecting) {
        this.writeList.push(data);
        return Promise.resolve(true);
      }

      if (!this.keepConnectionAlive) {
        await this.connect();
      }

      await this.dataCharacteristic.write(this.plejdEncDec(this.cryptokey, this.address, data), false);

      let writeData;
      while( (writeData = this.writeList.shift()) !== undefined ) {
        await this.dataCharacteristic.write(this.plejdEncDec(this.cryptokey, this.address, writeData), false);
      }

      if (!this.keepConnectionAlive) {
        clearTimeout(this.disconnectIntervalIndex);
        this.disconnectIntervalIndex = setTimeout(async () => {
          await self.disconnect();
        }, 5000);
      }
    } catch(error) {
      this.log(error);
    }
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
    } catch(error) {
      this.log(error);
    }
  }

  async turnOff(id) {
    let payload = Buffer.from((id).toString(16).padStart(2, '0') + '0110009700', 'hex');

    await this.plejdWrite(payload);
  }

  async startPing() {
    var self = this;

    clearInterval(this.pingIndex);
    this.pingIndex = setInterval(async () => {
      self.log('pingInterval', self.isConnected);
      if (self.isConnected) {
        var pingOk = await self.plejdPing()
        self.log('ping', pingOk);
        if (pingOk === false) {
          await self.disconnect();
          await self.connect();
        }
      } else {
        await self.disconnect();
        await self.connect();
      }
    }, 1000 * 3);
  };

  async plejdPing() {
    var ping = crypto.randomBytes(1);

    await this.pingCharacteristic.write(ping, false);
    var pong = await this.pingCharacteristic.read();

    this.log('pong', pong);

    if(((ping[0] + 1) & 0xff) !== pong[0]) {
      return Promise.resolve(false);
    } else {
      return Promise.resolve(true);
    }
  };

  reverseBuffer(src) {
    var buffer = Buffer.allocUnsafe(src.length)

    for (var i = 0, j = src.length - 1; i <= j; ++i, --j) {
      buffer[i] = src[j]
      buffer[j] = src[i]
    }

    return buffer
  }

  onPair(socket) {
    let self = this;

    let pairingDevice = {
      id: '',
      name: '',
      cryptokey: ''
    };

    socket.on('getSettings', (data,callback) => {
      let cryptokey = Homey.ManagerSettings.get('cryptokey');

      callback(null, cryptokey);
    });

    socket.on('saveSettings', (data, callback) => {
      Homey.ManagerSettings.set('cryptokey', data);
      callback(null, 'OK');
    });

    socket.on('save', function( data, callback ) {
      pairingDevice.id = data.id;
      pairingDevice.name = data.name;
      pairingDevice.cryptokey = data.cryptokey;

      callback( null, pairingDevice );
    });

    socket.on('getPairingDevice', function( data, callback ) {
      callback( null, pairingDevice );
    });
  }

}

module.exports = PlejdDriver;
