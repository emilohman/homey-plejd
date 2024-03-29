'use strict';

const axios = require('axios');

const API_APP_ID = 'zHtVqXt8k4yFyk2QGmgp48D9xZr2G94xWYnF4dak';
const API_BASE_URL = 'https://cloud.plejd.com/parse/';
const API_LOGIN_URL = 'login';
const API_SITE_LIST_URL = 'functions/getSiteList';
const API_SITE_DETAILS_URL = 'functions/getSiteById';

const TRAITS = {
  NO_LOAD: 0,
  NON_DIMMABLE: 9,
  DIMMABLE: 11,
};

let logger;

class PlejdApi {

  constructor(username, password, sessionToken, log) {
    this.username = username;
    this.password = password;

    this.sessionToken = sessionToken;

    logger = log;
  }

  async login() {
    logger('login()');

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'Content-Type': 'application/json',
      },
    });

    logger(`sending POST to ${API_BASE_URL}${API_LOGIN_URL}`);

    try {
      const response = await instance.post(
        API_LOGIN_URL,
        {
          username: this.username,
          password: this.password,
        },
      );

      logger('plejd-api: got session token response');
      this.sessionToken = response.data.sessionToken;
      // logger(`login token ${this.sessionToken}`);
      return Promise.resolve(this.sessionToken);
    } catch (error) {
      if (error.response.status === 400) {
        logger('error: server returned status 400. probably invalid credentials, please verify.');
      } else {
        logger(`error: unable to retrieve session token response: ${error}`);
      }
      return Promise.resolve(false);
    }
  }

  async getSites() {
    logger('getSites()');

    // logger(`token: ${this.sessionToken}`);

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': this.sessionToken,
        'Content-Type': 'application/json',
      },
    });

    logger(`sending POST to ${API_BASE_URL}${API_SITE_LIST_URL}`);

    try {
      const response = await instance.post(API_SITE_LIST_URL);

      logger('plejd-api: got sites response');

      return Promise.resolve(response.data.result.map(x => {
        return {
          title: x.site.title,
          id: x.site.siteId,
        };
      }));
    } catch (error) {
      logger(`error: unable to retrieve the crypto key. error: ${error} (code: ${error.response.status})`);
      return Promise.resolve(false);
    }
  }

  async getSite(siteId) {
    logger('getSite()', siteId);

    // logger(`token: ${this.sessionToken}`);

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': this.sessionToken,
        'Content-Type': 'application/json',
      },
    });

    logger(`sending POST to ${API_BASE_URL}${API_SITE_DETAILS_URL}`);

    try {
      const response = await instance.post(API_SITE_DETAILS_URL, { siteId });
      logger('plejd-api: got sites details response');
      this.plejdData = response.data;

      return Promise.resolve(response.data[0]);
    } catch (error) {
      logger(`error: unable to retrieve the crypto key. error: ${error} (code: ${error.response.status})`);
      return Promise.reject(new Error(`unable to retrieve the crypto key. error: ${error}`));
    }
  }

  getCryptoKey() {
    const site = this.plejdData.result[0];

    return site.plejdMesh.cryptoKey;
  }

  getDevices(filterType) {
    let devices = [];
    const rooms = {};

    const site = this.plejdData.result[0];

    for (let i = 0; i < site.rooms.length; i++) {
      rooms[site.rooms[i].roomId] = site.rooms[i].title;
    }

    for (let i = 0; i < site.devices.length; i++) {
      const device = site.devices[i];
      const { deviceId } = device;

      const settings = site.outputSettings.find(x => x.deviceParseId === device.objectId);
      let deviceNum = site.deviceAddress[deviceId];

      if (settings) {
        const outputs = site.outputAddress[deviceId];
        deviceNum = outputs[settings.output];
      }

      // check if device is dimmable
      const plejdDevice = site.plejdDevices.find(x => x.deviceId === deviceId);
      // eslint-disable-next-line prefer-const
      let { name, type, dimmable } = this._getDeviceType(plejdDevice.hardwareId);

      if (settings) {
        // dimmable = device.traits === TRAITS.DIMMABLE;
      }

      let { title } = device;

      if (device.roomId && rooms[device.roomId]) {
        title = `${rooms[device.roomId]} ${device.title}`;
      }

      const newDevice = {
        id: deviceNum,
        deviceId,
        name: title,
        type,
        hardwareName: name,
        hardwareId: plejdDevice.hardwareId,
        traits: device.traits,
        dimmable,
      };

      if (filterType === type) {
        devices.push(newDevice);
      } else if (filterType === undefined && (type === 'light' || type === 'socket')) {
        devices.push(newDevice);
      }
    }

    devices = devices.sort((a, b) => {
      if (a.name < b.name) {
        return -1;
      }

      if (a.name > b.name) {
        return 1;
      }

      return 0;
    });

    return devices;
  }

  _getDeviceType(hardwareId) {
    switch (parseInt(hardwareId, 10)) {
      case 1:
      case 11:
      case 14:
        return { name: 'DIM-01', type: 'light', dimmable: true };
      case 2:
      case 15:
        return { name: 'DIM-02', type: 'light', dimmable: true };
      case 3:
        return { name: 'CTR-01', type: 'light', dimmable: false };
      case 4:
        return { name: 'GWY-01', type: 'sensor', dimmable: false };
      case 5:
        return { name: 'LED-10', type: 'light', dimmable: true };
      case 6:
        return { name: 'WPH-01', type: 'button', dimmable: false };
      case 7:
        return { name: 'REL-01', type: 'socket', dimmable: false };
      case 8:
        return { name: 'SPR-01', type: 'socket', dimmable: false };
      case 9:
        // Unknown
        return { name: '-unknown-', type: 'light', dimmable: true };
      case 10:
        return { name: 'WRT-01', type: 'button', dimmable: false };
      case 12:
        // Unknown
        return { name: 'DAL-01', type: 'light', dimmable: true };
      case 13:
        return { name: 'Generic', type: 'light', dimmable: true };
      case 16:
        // Unknown
        return { name: '-unknown-', type: 'light', dimmable: true };
      case 17:
        return { name: 'REL-01', type: 'socket', dimmable: false };
      case 18:
        return { name: 'REL-02', type: 'socket', dimmable: false };
      case 19:
        // Unknown
        return { name: '-unknown-', type: 'light', dimmable: true };
      case 20:
        return { name: 'SPR-01', type: 'socket', dimmable: false };
      case 36:
        return { name: 'LED-75', type: 'light', dimmable: true };
      default:
        return { name: '-unknown-', type: 'light', dimmable: true };
    }
  }

}

module.exports = { PlejdApi };
