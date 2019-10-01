# Plejd

This App brings support for the Plejd devices.

## Q&amp;A

> **Q1**  Why can’t Homey connect to Plejd?

* _Check if the Plejd mesh is not connected to another bluetooth device. The  `Plejd`  app for example_

> **Q2**  Why is the Plejd devices displaying wrong states in Homey?

* _It’s because Homey can’t get the state from the Plejd device due to limitation in Homeys Bluetooth support. See https://github.com/athombv/homey-apps-sdk-issues/issues/81._

## Usage

Obtaining the crypto key and the device ids is a crucial step to get this
running, for this it is required to get the .site json file from the plejd app on android or iOS. Then enter them while adding devices to Homey.

### Steps for android:

1. Turn on USB debugging and connect the phone to a computer.
2. Extract a backup from the phone:
```
$ adb backup com.plejd.plejdapp
```
3. Unpack the backup:
```
$ dd if=backup.ab bs=1 skip=24 | python -c "import zlib,sys;sys.stdout.write(zlib.decompress(sys.stdin.read()))" | tar -xv
```
4. Recover the .site file:
```
$ cp apps/com.plejd.plejdapp/f/*/*.site site.json
```

### Steps for iOS:

1. Open a backup in iBackup viewer.
2. Select raw files, look for AppDomainGroup-group.com.plejd.consumer.light.
3. In AppDomainGroup-group.com.plejd.consumer.light/Documents there should be two folders.
4. The folder that isn't named ".config" contains the .site file.

### Gather cryto key and ids for devices

When the site.json file has been recovered the cryptokey and the output
addresses can be extracted:

1. Extract the cryptoKey:
```
$ cat site.json | jq '.PlejdMesh.CryptoKey' | sed 's/-//g'
```
2. Extract the outputAddresses:
```
$ cat site.json  | jq '.PlejdMesh.outputAdresses' | grep -v '\$type' | jq '.[][]'
```

Or just open site.json in your favorite editor and extract the crypto key and output addresses (IDs).
