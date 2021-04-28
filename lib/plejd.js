'use strict';

const crypto = require('crypto');

const COMMAND_DIM_CHANGE = 0x00c8;
const COMMAND_DIM2_CHANGE = 0x0098;
const COMMAND_STATE_CHANGE = 0x0097;
// const COMMAND_SCENE_TRIG = 0x0021;
const COMMAND_TIME_UPDATE = 0x001b;

const BROADCAST_DEVICE_ID = 0x01;
// const REQUEST_NO_RESPONSE = 0x0110;
// const REQUEST_RESPONSE = 0x0102;
// const REQUEST_READ_VALUE = 0x0103;

function encodeDecode(key, addr, data) {
  const buf = Buffer.concat([addr, addr, addr.subarray(0, 4)]);

  const cipher = crypto.createCipheriv('aes-128-ecb', key, '');
  cipher.setAutoPadding(false);

  let ct = cipher.update(buf).toString('hex');
  ct += cipher.final().toString('hex');
  ct = Buffer.from(ct, 'hex');

  let output = '';
  for (let i = 0, { length } = data; i < length; i++) {
    output += String.fromCharCode(data[i] ^ ct[i % 16]);
  }

  return Buffer.from(output, 'ascii');
}

function xor(a, b) {
  const length = Math.max(a.length, b.length);
  const buffer = Buffer.allocUnsafe(length);

  for (let i = 0; i < length; ++i) {
    buffer[i] = a[i] ^ b[i];
  }

  return buffer;
}

function reverseBuffer(src) {
  const buffer = Buffer.allocUnsafe(src.length);

  for (let i = 0, j = src.length - 1; i <= j; ++i, --j) {
    buffer[i] = src[j];
    buffer[j] = src[i];
  }

  return buffer;
}
class PlejdCommands {

  constructor(cryptokey, address, tz, logger) {
    this.cryptokey = Buffer.from(cryptokey.replace(/-/g, ''), 'hex');
    this.address = reverseBuffer(Buffer.from(address.replace(/:/g, ''), 'hex'));
    this.logger = logger || console;
    // this.dateFormatter = Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium', timeZone: tz });
    // this.dateFormatterLondon = Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'Europe/London' });
  }

  parseCommand(command) {

  }

  deviceOn(id, brightness) {
    let payload;

    if (brightness) {
      // eslint-disable-next-line operator-assignment, no-mixed-operators
      brightness = brightness << 8 | brightness;
      payload = Buffer.from(`${(id).toString(16).padStart(2, '0')}0110009801${(brightness).toString(16).padStart(4, '0')}`, 'hex');
    } else {
      payload = Buffer.from(`${(id).toString(16).padStart(2, '0')}0110009701`, 'hex');
    }

    return encodeDecode(this.cryptokey, this.address, payload);
  }

  deviceOff(id) {
    const payload = Buffer.from(`${(id).toString(16).padStart(2, '0')}0110009700`, 'hex');

    return encodeDecode(this.cryptokey, this.address, payload);
  }

  stateGet(id) {
    return Buffer.from((id).toString(16).padStart(2, '0'), 'hex');
  }

  stateGetAll() {
    return Buffer.from('01', 'hex');
  }

  stateParse(data) {
    const response = [];
    if (data.length === 10 || data.length === 20) {
      const messages = [data.slice(0, 10)];

      if (data.length === 20) {
        messages.push(data.slice(10, 20));
      }

      messages.forEach(message => {
        // this.logger.log(`stateParse: ${message.toString('hex')}`);

        const id = message.readUInt8(0)
        const state = Boolean(message.readUInt8(1));
        const dim = message.readUInt16LE(5) >> 8;

        response.push({ id, state, dim });
      });
    }

    return response;
  }

  notificationParse(data) {
    const decodedData = encodeDecode(this.cryptokey, this.address, data);

    // this.logger.log(`notificationParse: ${decodedData.toString('hex')}`);

    let dim = 255;
    let state = null;
    let cmd = 'unknown';

    const id = decodedData.readUInt8(0);
    const command = decodedData.readUInt16BE(3);

    if (id === BROADCAST_DEVICE_ID || command === COMMAND_TIME_UPDATE) {
      // this.logger.log(`Time message ${decodedData.toString('hex')}`);

      cmd = 'time';
    } else if (command === COMMAND_DIM_CHANGE || command === COMMAND_DIM2_CHANGE) {
      state = Boolean(decodedData.readUInt8(5));
      dim = decodedData.readUInt16LE(6) >> 8;

      cmd = 'state';
    } else if (command === COMMAND_STATE_CHANGE) {
      state = Boolean(decodedData.readUInt8(5));

      cmd = 'state';
    } else {
      this.logger.log('Unknown command: ' + decodedData.toString('hex'));
    }

    return { cmd, id, state, dim }
  }

  timeGet(id) {
    const payload = Buffer.from(`${(id).toString(16).padStart(2, '0')}0102001b`, 'hex');

    return encodeDecode(this.cryptokey, this.address, payload);
  }

  timeSet() {
    const now = this._getUTCTime();

    const buffer = Buffer.alloc(10);
    buffer.write('000110001b', 0, 'hex');
    buffer.writeInt32LE(Math.trunc(now / 1000), 5);
    buffer.write('00', 9, 'hex');

    return encodeDecode(this.cryptokey, this.address, buffer);
  }

  timeParse(data) {
    const decodedData = encodeDecode(this.cryptokey, this.address, data);

    try {
      if (decodedData.toString('hex', 0, 1) === '01' || decodedData.toString('hex', 3, 5) === '001b') {
        const now = this._getUTCTime();
        const time = decodedData.readInt32LE(5) * 1000;

          let diff;
          if (now > time) {
            diff = now - time;
          } else {
            diff = time - now;
          }

        return { time, diff };
      }
    } catch (err) {
      this.logger.error('timeParse', decodedData, err);
    }

    return null;
  }

  authenticateInitialize() {
    return Buffer.from([0]);
  }

  authenticateChallengeResponse(data) {
    const intermediate = crypto.createHash('sha256').update(xor(this.cryptokey, data)).digest();

    const part1 = intermediate.subarray(0, 16);
    const part2 = intermediate.subarray(16);

    return xor(part1, part2);
  }

  pingInitialize() {
    return crypto.randomBytes(1);
  }

  pingParsePong(ping, pong) {
    const pingResult = ((ping[0] + 1) & 0xff) === pong[0];

    if (!pingResult) {
      this.logger.error('ping error', ping[0], pong[0]);
    }

    return pingResult;
  }

  _getUTCTime() {
    /*
    const date = new Date(this.dateFormatter.format(new Date()));
    const dateLondon = new Date(this.dateFormatterLondon.format(new Date()));

    console.log(new Date(), 'Homey');
    console.log(date, 'Homey - Sverige');
    console.log(dateLondon, 'Homey - London');
    console.log(new Date(date.getTime() - (date.getTimezoneOffset() * 60000)), 'Homey - Plejd');
    console.log(new Date(dateLondon.getTime() - (dateLondon.getTimezoneOffset() * 60000)), 'Homey - Plejd London');
    console.log(new Date(new Date().getTime() + 60 * 60 * 1000), 'Homey - Plejd "London time"');
    console.log(date.getTimezoneOffset(), 'offset');
    */

    return new Date(new Date().getTime() + 60 * 60 * 1000);
  }

}

module.exports = {
  Commands: PlejdCommands,
  PLEJD_SERVICE: '31ba000160854726be45040c957391b5',
  LIGHT_LEVEL_UUID: '31ba000360854726be45040c957391b5',
  DATA_UUID: '31ba000460854726be45040c957391b5',
  LAST_DATA_UUID: '31ba000560854726be45040c957391b5',
  AUTH_UUID: '31ba000960854726be45040c957391b5',
  PING_UUID: '31ba000a60854726be45040c957391b5',
};
