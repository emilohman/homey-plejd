const axios = require('axios');
const EventEmitter = require('events');

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

class PlejdApi extends EventEmitter {
  constructor(username, password) {
    super();

    this.username = username;
    this.password = password;

    this.sessionToken = '';
  }

  login() {
    logger('login()');
    const self = this;

    const instance = axios.create({
      baseURL: API_BASE_URL,
      headers: {
        'X-Parse-Application-Id': API_APP_ID,
        'Content-Type': 'application/json'
      }
    });

    logger('sending POST to ' + API_BASE_URL + API_LOGIN_URL);

    instance.post(
      API_LOGIN_URL,
      {
        'username': this.username,
        'password': this.password
      })
      .then((response) => {
        console.log('plejd-api: got session token response');
        self.sessionToken = response.data.sessionToken;
        logger('login token ' + self.sessionToken);
        self.emit('loggedIn');
      })
      .catch((error) => {
        if (error.response.status === 400) {
          console.log('error: server returned status 400. probably invalid credentials, please verify.');
        }
        else {
          console.log('error: unable to retrieve session token response: ' + error);
        }
        self.emit('loggedInError');
      });
  }

  getSites(callback) {
    logger('getSites()');
    const self = this;

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

    instance.post(API_SITE_LIST_URL)
      .then((response) => {
        console.log('plejd-api: got sites response');

        callback(response.data.result.map((x) => {
          return {
            title: x.site.title,
            id: x.site.siteId
          }
        }));
      })
      .catch((error) => {
        console.log('error: unable to retrieve the crypto key. error: ' + error + ' (code: ' + error.response.status + ')');
        return Promise.reject('unable to retrieve the crypto key. error: ' + error);
      });
  }

  getSite(siteId, callback) {
    logger('getSite()', siteId);
    const self = this;

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

    instance.post(API_SITE_DETAILS_URL, { siteId: siteId })
        .then((response) => {
          console.log('plejd-api: got sites details response');
          self.plejdData = response.data;

          callback(response.data[0]);
        })
        .catch((error) => {
          console.log('error: unable to retrieve the crypto key. error: ' + error + ' (code: ' + error.response.status + ')');
          return Promise.reject('unable to retrieve the crypto key. error: ' + error);
        });
  }

  getCryptoKey() {
    let site = this.plejdData.result[0];
    let cryptoKey = site.plejdMesh.cryptoKey;

    return cryptoKey;
  }

  getDevices() {
    let devices = [];

    let site = this.plejdData.result[0];

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
        dimmable = settings.dimCurve != 'NonDimmable';
      }

      const newDevice = {
        id: deviceNum,
        deviceId: deviceId,
        name: device.title,
        type: type,
        typeName: name,
        dimmable: dimmable
      };

      devices.push(newDevice);
    }

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
