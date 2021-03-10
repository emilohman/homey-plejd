'use strict';

const Homey = require('homey');

class PlejdApp extends Homey.App {

  async onInit() {
    this.log('PlejdApp is running...');
    this.homey.settings.unset('username');
    this.homey.settings.unset('password');
    this.homey.settings.unset('keepalive');
  }

}

module.exports = PlejdApp;
