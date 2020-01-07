Unofficial app for Plejd devices.

Q&A

Q1:  Why can’t Homey connect to Plejd?
- Check if the Plejd mesh is not connected to another bluetooth device. The Plejd mobile app for example.

Q2:  Why is the Plejd devices displaying wrong states in Homey?
- It’s because Homey can’t get the state from the Plejd device due to limitation in Homeys Bluetooth support. See https://github.com/athombv/homey-apps-sdk-issues/issues/81._

Q3: Why does it take so long to turn my lights on/off?
- Try enable keepalive setting in the apps settings. It keeps the connection alive and makes state changes much faster. The downside is that Plejd only support one connection at a time. Turning this setting on will prevent you from using the official Plejd mobile app.
