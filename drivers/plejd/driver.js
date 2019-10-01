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

    Homey.on("unload", async () => {
      await this.disconnect();
    });

    if (this.getDevices().length > 0) {
      await this.connect();
    }
  }

  async connect() {
    if (this.isConnecting || this.isConnected) {
      return Promise.resolve(false);
    }

    this.log('Connecting...');

    this.isConnecting = true;

    let settings = Homey.ManagerSettings.get('plejd_config');

    if (settings && settings.cryptokey) {
      this.cryptokey = Buffer.from(settings.cryptokey.replace(/-/g, ''), 'hex');
    } else {
      this.log('No cryptokey exists.');
      return Promise.resolve(false);
    }

    const self = this;
    let list = [];

    for (let retries = 0; retries < 10; retries++) {
      list = await Homey.ManagerBLE.discover([PLEJD_SERVICE]);

      if (list.length === 0) {
        this.log('No plejd device found');
      } else {
        break;
      }
    }

    if (list.length === 0) {
      return Promise.resolve(false);
    }

    const device = list[0];
    if (device.__peripheral) {
      device.__peripheral = null;
    }

    this.peripheral = await device.connect();

    this.address = this.reverseBuffer(Buffer.from(String(this.peripheral.address).replace(/\:/g, ''), 'hex'));

    const sac = await this.peripheral.discoverAllServicesAndCharacteristics();

    const service = await this.peripheral.getService(PLEJD_SERVICE);

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
      await this.authenticate();
      this.isConnected = true;
      this.isConnecting = false;
      this.startPing();
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
    await this.authCharacteristic.write(Buffer.from([0]), false);
    var data = await this.authCharacteristic.read();

    var resp = this.plejdChalresp(this.cryptokey, data);

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

  async plejdWrite(handle, data) {
    if (!handle) {
      throw new Error('No handle');
    }

    await handle.write(data, false);
  }

  async turnOn(id, brightness) {
    var payload;

    if (!brightness) {
      payload = Buffer.from((id).toString(16).padStart(2, '0') + '0110009701', 'hex');
    } else {
      brightness = brightness << 8 | brightness;
      payload = Buffer.from((id).toString(16).padStart(2, '0') + '0110009801' + (brightness).toString(16).padStart(4, '0'), 'hex');
    }

    await this.plejdWrite(this.dataCharacteristic, this.plejdEncDec(this.cryptokey, this.address, payload));
  }

  async turnOff(id) {
    var payload = Buffer.from((id).toString(16).padStart(2, '0') + '0110009700', 'hex');

    await this.plejdWrite(this.dataCharacteristic, this.plejdEncDec(this.cryptokey, this.address, payload));
  }

  async startPing() {
    var self = this;

    clearInterval(this.pingIndex);
    this.pingIndex = setInterval(async () => {
      if (self.isConnected) {
        var pingOk = await self.plejdPing()
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
    let pairingDevice = {
      id: '',
      name: '',
      cryptokey: ''
    };

    socket.on('getSettings', (data,callback) => {
      let settings = Homey.ManagerSettings.get('plejd_config');
      if (settings === undefined || settings === null) {
        settings = {
          cryptokey: ""
        }
      }

      callback(null, settings);
    });

    socket.on('saveSettings', (data, callback) => {
       Homey.ManagerSettings.set('plejd_config', data);
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
