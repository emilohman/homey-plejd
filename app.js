'use strict';

const Homey = require('homey');

class PlejdApp extends Homey.App {

  async onInit() {
    this.log('PlejdApp is running...');
  }
}

module.exports = PlejdApp;
