'use strict';

const crypto = require('crypto');

const COMMAND_DIM_CHANGE = 0x00c8;
const COMMAND_DIM2_CHANGE = 0x0098;
const COMMAND_STATE_CHANGE = 0x0097;
const COMMAND_COLOR_TEMP_CHANGE_OR_MOTION = 0x0420;
const COMMAND_SCENE_TRIG = 0x0021;
const COMMAND_TIME_UPDATE = 0x001b;
const COMMAND_REMOTE_CLICK = 0x0016;
const COMMAND_TRM_TEMPERATURE_REGULATING_SETPOINT = 0x045c;
const COMMAND_TRM_OPERATING_MODE = 0x045f;
const COMMAND_TRM_PWM_DUTY = 0x0461;
const COMMAND_TRM_RESET_OPERATING_MODE = 0x047e;
const COVER_POSITION_PARSE_MAX = 0x7f;
const COLOR_TEMP_MIN_KELVIN = 2200;
const COLOR_TEMP_MAX_KELVIN = 4000;

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

  parseCommand(command) {}

  deviceOn(id, brightness) {
    let payload;

    if (brightness) {
      // eslint-disable-next-line operator-assignment, no-mixed-operators
      brightness = (brightness << 8) | brightness;
      payload = Buffer.from(
        `${id.toString(16).padStart(2, '0')}0110009801${brightness.toString(16).padStart(4, '0')}`,
        'hex',
      );
    } else {
      payload = Buffer.from(
        `${id.toString(16).padStart(2, '0')}0110009701`,
        'hex',
      );
    }

    return encodeDecode(this.cryptokey, this.address, payload);
  }

  deviceOff(id) {
    const payload = Buffer.from(
      `${id.toString(16).padStart(2, '0')}0110009700`,
      'hex',
    );

    return encodeDecode(this.cryptokey, this.address, payload);
  }

  thermostatSetTargetTemperature(id, temperature) {
    const target = Math.round(temperature * 10);
    const low = target & 0xff;
    const high = (target >> 8) & 0xff;
    const payload = Buffer.from(
      `${id.toString(16).padStart(2, '0')}0110045c${low.toString(16).padStart(2, '0')}${high.toString(16).padStart(2, '0')}`,
      'hex',
    );

    return encodeDecode(this.cryptokey, this.address, payload);
  }

  thermostatSetMode(id, mode) {
    const payload = Buffer.from(
      `${id.toString(16).padStart(2, '0')}0110045f${mode.toString(16).padStart(2, '0')}`,
      'hex',
    );

    return encodeDecode(this.cryptokey, this.address, payload);
  }

  deviceSetColorTemperature(id, normalizedTemperature) {
    const normalized = Math.max(0, Math.min(1, normalizedTemperature));
    // Homey light_temperature: 0 = cold (high Kelvin), 1 = warm (low Kelvin)
    const kelvin = Math.round(
      COLOR_TEMP_MAX_KELVIN -
        normalized * (COLOR_TEMP_MAX_KELVIN - COLOR_TEMP_MIN_KELVIN),
    );
    const payload = Buffer.from(
      `${id.toString(16).padStart(2, '0')}01100420030111${kelvin.toString(16).padStart(4, '0')}`,
      'hex',
    );

    return encodeDecode(this.cryptokey, this.address, payload);
  }

  coverSetPosition(id, normalizedPosition) {
    const position = Math.max(0, Math.min(1, normalizedPosition));
    const level = Math.round(position * 255) & 0xff;
    const levelHex = level.toString(16).padStart(2, '0');
    const payload = Buffer.from(
      `${id.toString(16).padStart(2, '0')}0110042003082701${levelHex}${levelHex}`,
      'hex',
    );

    return encodeDecode(this.cryptokey, this.address, payload);
  }

  stateGet(id) {
    return Buffer.from(id.toString(16).padStart(2, '0'), 'hex');
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

      messages.forEach((message) => {
        // this.logger.log(`stateParse: ${message.toString('hex')}`);

        const id = message.readUInt8(0);
        const state = Boolean(message.readUInt8(1));
        const dimFull = message.readUInt16LE(5);
        const dim = dimFull >> 8;
        const coverPosition =
          Math.round(
            ((dimFull & COVER_POSITION_PARSE_MAX) / COVER_POSITION_PARSE_MAX) *
              100,
          ) / 100;

        response.push({
          id,
          state,
          dim,
          dimFull,
          coverPosition,
        });
      });
    }

    return response;
  }

  notificationParse(data) {
    const decodedData = encodeDecode(this.cryptokey, this.address, data);

    this.logger.log(`notificationParse: ${decodedData.toString('hex')}`);

    let dim = 255;
    let state = null;
    let cmd = 'unknown';
    let color = null;
    let mode = null;
    let targetTemperature = null;
    let currentTemperature = null;
    let heating = null;
    let motion = null;
    let coverPosition = null;

    const id = decodedData.readUInt8(0);
    const command = decodedData.readUInt16BE(3);

    // 00011000162803dc0a

    if (command === COMMAND_TIME_UPDATE) {
      // this.logger.log(`Time message ${decodedData.toString('hex')}`);
      cmd = 'time';
    } else if (
      command === COMMAND_DIM_CHANGE ||
      command === COMMAND_DIM2_CHANGE
    ) {
      state = Boolean(decodedData.readUInt8(5));
      const dimFull = decodedData.readUInt16LE(6);
      dim = dimFull >> 8;
      coverPosition =
        Math.round(
          ((dimFull & COVER_POSITION_PARSE_MAX) / COVER_POSITION_PARSE_MAX) *
            100,
        ) / 100;

      if (decodedData.length >= 8) {
        const thermostatData = this.parseThermostatState(
          state,
          decodedData.readUInt8(6),
          decodedData.readUInt8(7),
          decodedData.length > 8 ? decodedData.readUInt8(8) : null,
        );
        mode = thermostatData.mode;
        targetTemperature = thermostatData.targetTemperature;
        currentTemperature = thermostatData.currentTemperature;
        heating = thermostatData.heating;
      }

      // this.logger.log(`DIM message ${decodedData.toString('hex')}`);
      this.logger.log(`DIM id: ${id} state: ${state} dim: ${dim}`);

      cmd = 'state';
    } else if (command === COMMAND_STATE_CHANGE) {
      state = Boolean(decodedData.readUInt8(5));

      this.logger.log(`STATE id: ${id} state: ${state}`);

      cmd = 'state';
    } else if (command === COMMAND_TRM_TEMPERATURE_REGULATING_SETPOINT) {
      cmd = 'thermostat';

      if (decodedData.length >= 12) {
        targetTemperature = decodedData.readUInt16LE(10) / 10;
      } else if (decodedData.length >= 7) {
        targetTemperature = decodedData.readUInt16LE(5) / 10;
      }

      this.logger.log(`TRM setpoint id: ${id} target: ${targetTemperature}`);
    } else if (command === COMMAND_TRM_OPERATING_MODE) {
      cmd = 'thermostat';

      if (decodedData.length >= 6) {
        mode = decodedData.readUInt8(5);
      }

      this.logger.log(`TRM mode id: ${id} mode: ${mode}`);
    } else if (
      command === COMMAND_TRM_PWM_DUTY ||
      command === COMMAND_TRM_RESET_OPERATING_MODE
    ) {
      cmd = 'thermostat';

      this.logger.log(`TRM command id: ${id} cmd: ${command.toString(16)}`);
    } else if (command === COMMAND_COLOR_TEMP_CHANGE_OR_MOTION) {
      if (decodedData.length < 6) {
        return null;
      }

      const updateMode = decodedData.readUInt8(6);

      if (updateMode === 1) {
        cmd = 'state';
        color = decodedData.readUInt16BE(8);

        this.logger.log(`Color temp id: ${id} color: ${color}`);
      } else if (updateMode === 3) {
        cmd = 'motion';
        motion = true;

        this.logger.log(`Motion id: ${id}`);
      } else {
        return null;
      }
    } else if (command === COMMAND_REMOTE_CLICK) {
      // this.logger.log(`Button message ${decodedData.toString('hex')}`);

      const buttonId = decodedData.readUInt8(5);
      const inputButton = decodedData.length > 7 ? decodedData.readUInt8(6) : 0;
      const data =
        decodedData.length > 8 ? decodedData.toString('hex', 7, 9) : '';
      cmd = 'state';

      // 00 01 10 00 16 0f 01 2d 0a

      this.logger.log(
        `Button id: ${buttonId} inputButton: ${inputButton} data: ${data}`,
      );

      return { cmd, id: buttonId, inputButton, data };
    } else if (command === COMMAND_SCENE_TRIG) {
      state = decodedData.readUInt8(5);
      cmd = 'scene';

      this.logger.log(
        'Scene triggered ' +
          id +
          ' ' +
          state +
          ' ' +
          decodedData.toString('hex'),
      );
    } else {
      this.logger.log(
        'Unknown command: ' + id + ' ' + decodedData.toString('hex'),
      );

      return null;
    }

    return {
      cmd,
      id,
      state,
      dim,
      color,
      mode,
      targetTemperature,
      currentTemperature,
      heating,
      motion,
      coverPosition,
    };
  }

  parseThermostatState(stateBit, payload0, payload1, payload2) {
    const stateRaw =
      ((stateBit & 0x01) << 16) | ((payload0 & 0xff) << 8) | (payload1 & 0xff);

    const mode = (stateRaw & 0x01c000) >> 14;
    const error = Boolean(stateRaw & 0x002000);
    const target = ((stateRaw & 0x001fc0) >> 6) - 10;
    const current = (stateRaw & 0x00003f) - 10;
    const heating =
      payload2 === null || payload2 === undefined
        ? null
        : Boolean(payload2 & 0x80);

    return {
      mode: error ? null : mode,
      targetTemperature: target,
      currentTemperature: current,
      heating,
    };
  }

  timeGet(id) {
    const payload = Buffer.from(
      `${id.toString(16).padStart(2, '0')}0102001b`,
      'hex',
    );

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
      if (
        (decodedData.toString('hex', 0, 1) === '01' ||
          decodedData.toString('hex', 3, 5) === '001b') &&
        decodedData.length > 5
      ) {
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
    const intermediate = crypto
      .createHash('sha256')
      .update(xor(this.cryptokey, data))
      .digest();

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
  CRYPTO_KEY_UUID: '31ba000860854726be45040c957391b5',
};
