This app allows you to control your Plejd devices directly from Homey, no extra gateway is needed.
It uses an unsupported method for communication using bluetooth.

Supported features:
- Toggle state on/off/dim
- Plejd buttons (single click only)
- Listen for Plejd scenes (can be used for double click, see below)
- Color temperature control (experimental)
- Thermostat TRM-01  (experimental)
- Motion sensor WMS-01 (experimental)
- Cover controller JAL-01 (experimental)

Scenes
Make sure you have your username and password saved in the Plejd app settings so that the app is able to fetch available scenes from your Plejd setup.

Double-click
Scenes can be used to create flows triggered by double-click.
- First, create a scene in the Plejd iOS/Android app and give it a name, e.g., for the button it will be used for (kitchen button 1). 
- To be able to save the scene, you must toggle a state in your Plejd mesh. You can either choose a device and state that you want to change or use a Plejd device, e.g., a SPR-01, that is dedicated to scenes and not used for anything else. 
- Once the scene is saved, you can connect it to a button that will trigger the scene on double-click. 
- Now, go to your Homey app, create a scene, choose the scene trigger card from this app, and select your Plejd scene from the list.

For support please use the official support topic on the forum below.