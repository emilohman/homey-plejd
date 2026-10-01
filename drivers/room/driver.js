'use strict';

const Homey = require('homey');
const api = require('../../lib/api');

class PlejdRoomDriver extends Homey.Driver {
  async onInit() {
    this.log('Plejd room driver has been inited');
  }

  onPair(session) {
    const self = this;
    let plejdSites;
    let plejdApi;

    session.setHandler('showView', async (viewId) => {
      if (viewId === 'login') {
        const sessionToken = this.homey.settings.get('sessionToken');
        if (sessionToken) {
          plejdApi = new api.PlejdApi(null, null, sessionToken, self.log);
          const sites = await plejdApi.getSites();
          if (sites) {
            plejdSites = sites;
            await session.nextView();
          } else {
            this.homey.settings.set('sessionToken', null);
          }
        }
      }
      return Promise.resolve(true);
    });

    session.setHandler('login', async (data) => {
      let { username } = data;
      const { password } = data;
      if (username) {
        username = username.toLowerCase();
      }
      plejdApi = new api.PlejdApi(username, password, null, self.log);
      const token = await plejdApi.login();
      if (token) {
        this.homey.settings.set('username', username);
        this.homey.settings.set('password', password);
        this.homey.settings.set('sessionToken', token);
        return Promise.resolve(true);
      }
      return Promise.resolve(false);
    });

    session.setHandler('getSites', async () => {
      if (plejdSites) {
        return plejdSites;
      }
      return plejdApi.getSites();
    });

    session.setHandler('saveSite', async (data) => {
      await plejdApi.getSite(data.site);
      self.log(`Saving site: ${data.site}`);
      return null;
    });

    session.setHandler('list_devices', async () => {
      const cryptoKey = plejdApi.getCryptoKey();
      this.homey.settings.set('cryptokey', cryptoKey);

      const rooms = plejdApi.getRooms();
      self.log('Rooms found', JSON.stringify(rooms));

      return rooms.map((room) => ({
        name: room.title,
        data: {
          id: `room-${room.roomId}`,
          plejdId: room.address,
        },
        store: {
          members: room.members,
        },
      }));
    });
  }
}

module.exports = PlejdRoomDriver;
