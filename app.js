'use strict';

const Homey = require('homey');

class PlejdApp extends Homey.App {

  async onInit() {
    this.log('PlejdApp is running...');
    Homey.ManagerSettings.unset('username');
    Homey.ManagerSettings.unset('password');
  }
}

module.exports = PlejdApp;
