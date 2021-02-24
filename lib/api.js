const axios = require('axios');

API_APP_ID = 'zHtVqXt8k4yFyk2QGmgp48D9xZr2G94xWYnF4dak';
API_BASE_URL = 'https://cloud.plejd.com/parse/';
API_LOGIN_URL = 'login';
API_SITE_LIST_URL = 'functions/getSiteList';
API_SITE_DETAILS_URL = 'functions/getSiteById';

let debug = 'console';

const getLogger = () => {
  const consoleLogger = msg => console.log('plejd-api', msg);
  if (debug === 'console') {
    return consoleLogger;
  }
  return function() {};
};

const logger = getLogger();

class PlejdApi {
  constructor(username, password, sessionToken) {
    this.username = username;
    this.password = password;

    this.sessionToken = sessionToken;
  }

  async login() {
    logger('login()');

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'Content-Type': 'application/json'
      }
    });

    logger('sending POST to ' + API_BASE_URL + API_LOGIN_URL);

    try {
      const response = await instance.post(
        API_LOGIN_URL,
        {
          'username': this.username,
          'password': this.password
        });

      console.log('plejd-api: got session token response');
      this.sessionToken = response.data.sessionToken;
      logger('login token ' + this.sessionToken);
      return Promise.resolve(this.sessionToken);
    } catch(error) {
      if (error.response.status === 400) {
        console.log('error: server returned status 400. probably invalid credentials, please verify.');
      }
      else {
        console.log('error: unable to retrieve session token response: ' + error);
      }
      return Promise.resolve(false);
    }
  }

  async getSites() {
    logger('getSites()');

    logger('token: ' + this.sessionToken);

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': this.sessionToken,
        'Content-Type': 'application/json'
      }
    });

    logger('sending POST to ' + API_BASE_URL + API_SITE_LIST_URL);

    try {
      const response = await instance.post(API_SITE_LIST_URL);

      console.log('plejd-api: got sites response');

      return Promise.resolve(response.data.result.map((x) => {
        return {
          title: x.site.title,
          id: x.site.siteId
        }
      }));
    } catch (error) {
      console.log('error: unable to retrieve the crypto key. error: ' + error + ' (code: ' + error.response.status + ')');
      return Promise.resolve(false);
    }
  }

  async getSite(siteId) {
    logger('getSite()', siteId);

    logger('token: ' + this.sessionToken);

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'X-Parse-Session-Token': this.sessionToken,
        'Content-Type': 'application/json'
      }
    });

    logger('sending POST to ' + API_BASE_URL + API_SITE_DETAILS_URL);

    try {
      const response = await instance.post(API_SITE_DETAILS_URL, { siteId: siteId });
      console.log('plejd-api: got sites details response');
      this.plejdData = response.data;

      return Promise.resolve(response.data[0]);
    } catch (error) {
      console.log('error: unable to retrieve the crypto key. error: ' + error + ' (code: ' + error.response.status + ')');
      return Promise.reject('unable to retrieve the crypto key. error: ' + error);
    }
  }

  getCryptoKey() {
    let site = this.plejdData.result[0];

    return site.plejdMesh.cryptoKey;
  }

  getDevices() {
    let devices = [];
    let rooms = {};

    let site = this.plejdData.result[0];

    for (let i = 0; i < site.rooms.length; i++) {
      rooms[site.rooms[i].roomId] = site.rooms[i].title;
    }

    for (let i = 0; i < site.devices.length; i++) {
      const device = site.devices[i];
      const deviceId = device.deviceId;

      const settings = site.outputSettings.find(x => x.deviceParseId == device.objectId);
      let deviceNum = site.deviceAddress[deviceId];

      if (settings) {
        const outputs = site.outputAddress[deviceId];
        deviceNum = outputs[settings.output];
      }

      // check if device is dimmable
      const plejdDevice = site.plejdDevices.find(x => x.deviceId == deviceId);
      let { name, type, dimmable } = this._getDeviceType(plejdDevice.hardwareId);

      if (settings) {
        dimmable = settings.dimCurve !== 'NonDimmable';
      }

      let title = device.title;

      if (device.roomId && rooms[device.roomId]) {
        title = rooms[device.roomId] + ' ' + device.title;
      }

      const newDevice = {
        id: deviceNum,
        deviceId: deviceId,
        name: title,
        type: type,
        typeName: name,
        dimmable: dimmable
      };

      devices.push(newDevice);
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
    switch (parseInt(hardwareId)) {
      case 1:
      case 11:
        return { name: "DIM-01", type: 'light', dimmable: true };
      case 2:
        return { name: "DIM-02", type: 'light', dimmable: true };
      case 3:
        return { name: "CTR-01", type: 'light', dimmable: false };
      case 4:
        return { name: "GWY-01", type: 'sensor', dimmable: false };
      case 5:
        return { name: "LED-10", type: 'light', dimmable: true };
      case 6:
        return { name: "WPH-01", type: 'switch', dimmable: false };
      case 7:
        return { name: "REL-01", type: 'switch', dimmable: false };
      case 8:
      case 9:
        // Unknown
        return { name: "-unknown-", type: 'light', dimmable: false };
      case 10:
          return { name: "-unknown-", type: 'light', dimmable: false };
      case 12:
        // Unknown
        return { name: "-unknown-", type: 'light', dimmable: false };
      case 13:
        return { name: "Generic", type: 'light', dimmable: false };
      case 14:
      case 15:
      case 16:
        // Unknown
        return { name: "-unknown-", type: 'light', dimmable: false };
      case 17:
        return { name: "REL-01", type: 'switch', dimmable: false };
      case 18:
        return { name: "REL-02", type: 'switch', dimmable: false };
      case 19:
        // Unknown
        return { name: "-unknown-", type: 'light', dimmable: false };
      case 20:
        return { name: "SPR-01", type: 'switch', dimmable: false };
    }
  }
}

module.exports = { PlejdApi };
