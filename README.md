# homebridge-ewelink-max

[![certified-hoobs-plugin](https://badgen.net/badge/HOOBS/Certified/yellow)](https://plugins.hoobs.org) [![hoobs-support](https://badgen.net/badge/HOOBS/Support/yellow)](https://support.hoobs.org)

Homebridge plugin to control Sonoff relays with OEM firmware. It uses the same API as the iOS app to communicate with your devices.

The platform will dynamically add/remove devices based on what is configured in your eWeLink account.

It has been tested with the [Sonoff basic](http://sonoff.itead.cc/en/products/sonoff/sonoff-basic) relays. I have performed testing with up to two relays associated to my account.

The plugin will only support one eWeLink account.

It is possible to continue to use the OEM functionality (eWeLink app, Google Home integration); this plugin requires no modification to the relay's firmware.

## Why max?

This is a fork of [homebridge-ewelink](https://github.com/gbro115/homebridge-ewelink), which is not being actively updated. There is another package named [homebridge-ewelin-plus](https://www.npmjs.com/package/homebridge-ewelink-plus) which has not been updated for 6 months at the time of writing. The name is inspired by Apple's naming convention.

This fork has the following notable changes / improvements:

* Supports login with phone number / email and password, which saves time from obtaining the authentication token with Charles once in a while.
* Supports sending heartbeats on the WebSocket connection, which greatly reduces the interval of reconnections, hence better stability.
* Supports obtaining the correct API / WebSocket API host automatically, so you don't need to obtain this with Charles.
* Supports groups to simulate accessories. Currently only 'blind' (WindowCovering) is supported.

## Shortcomings

The code is of suboptimal quality. It was a quick-and-dirty plugin; feel free to contribute & improve.

## Steps to install / configure

*Assuming that you've already downloaded the eWeLink app on your iOS device & have configured it:*

1) Install the plugin

```bash
sudo npm -g install homebridge-ewelink-max
```

2) Add to the platforms[] section of config.json.

  * `countryCode` - The country code of your eWeLink account without + prefix, see [list of country codes on Wikipedia](https://en.wikipedia.org/wiki/List_of_country_calling_codes)
  * `phoneNumber` - The login phone number of your eWeLink account, do not include this if you login with your email
  * `email` - The login email of your ewelink account, do not include this if you login with your phone number
  * `password` - Your ewelink account login password
  * `imei` - This can be any valid UUID, get one with an [online generator](https://www.famkruithof.net/uuid/uuidgen?numReq=1&typeReq=4&uppercaseReq=true)

3) Restart Homebridge

### Sample config.json

```json
{
    "bridge": {
        "name": "Homebridge",
        "username": "XX:XX:XX:XX:XX:XX",
        "port": 51826,
        "pin": "123-45-678"
    },

    "description": "Your description here",

    "accessories": [
    ],

    "platforms": [
        {
            "platform" : "eWeLink",
            "name" : "eWeLink",
            "countryCode" : "1",
            "phoneNumber" : "+12345678901",
            "password" : "your-login-password",
            "imei" : "01234567-89AB-CDEF-0123-456789ABCDEF"
        }
    ]
}
```

If you use email login, the platform section should look like this:

```json
        {
            "platform" : "eWeLink",
            "name" : "eWeLink",
            "countryCode" : "44",
            "email" : "your-email@example.com",
            "password" : "your-login-password",
            "imei" : "01234567-89AB-CDEF-0123-456789ABCDEF"
        }
```

### Groups

You can group channels of multi-switch models to simulate another accessory instead of having each switch separately.
Currently only 'blind' (WindowCovering) is supported.

#### Blind

*(Tested with Sonoff Dual)*
Simulate dual motor blinds, one to move up and other to move down, without start or end detector.
The duration of movement is calculed from the up/down time.
Handle realtime response when setting position other than *Open* or *Close*.
Also responds to events from API, so you can use Home or eWelink App and always have an up-to-date state.
The device is automatically reconfigured to turn off all options (power-on response, inching, etc) including disable interlock that is incompatible with the behaviour of this group.

*To improve: 4 channels models can only use 2 channels, others will be disabled.*

##### Group configuration:

* **type** : blind
* **deviceId** : Device ID from eWeLink app
* **relay_up**: Relay number for the up motor
* **relay_down**: Relay number for the down motor
* **time_up**: Total time in seconds to fully open blinds (from closed)
* **time_down**: Total time in seconds to completely close blinds (from open)
* **handle_api_changes**: In case you don't want group respond to eWeLink App changes. Default _true_.
* Please refer to [homebridge-sonoff-stateful-blind](https://github.com/manolab/homebridge-sonoff-stateful-blinds#readme) project for explanations of the last two options.

```json
    {
        "platform" : "eWeLink",
        "name" : "eWeLink",
        "email" : "your-email@example.com",
        "password" : "your-login-password",
        "imei" : "01234567-89AB-CDEF-0123-456789ABCDEF",
        "groups": [
            {
                "type": "blind",
                "deviceId": "1000654321",
                "relay_up": 1,
                "relay_down": 2,
                "time_up": 10,
                "time_down": 10,
                "time_botton_margin_up": 0,
                "time_botton_margin_down": 0,
                "handle_api_changes": true
            }
        ]
    }
```

## A note on login session

An authentication token is generated every time your device's app logs into the eWeLink service.

You can only have one authentication token per user account.

Therefore if you use the HomeKit app and eWeLink app at the same time, they will fight each other for the login session. They should both work individually. You can leave Homebridge running when using the eWeLink app.

### Use another login to avoid being logged off from the eWeLink app

1. Create another account
2. Then log in with the new account on another mobile device (you have to keep both accounts connected and with eWeLink on the screen).
3. Go to your eWeLink, select your Sonoff device and share it with the other account.
4. A popup should appear on the other mobile device, accept it.
5. Use the second account as your plugin login (and never use this account on eWeLink anymore to avoid being logged off).
6. Be happy and never get a "session expired" message again.

Each account is suitable for the plug-in, just make sure to use each once (one per mobile device / Homebridge).

## Troubleshooting

I've attempted to make the logging as useful as possible. If you have any suggestions, please open an issue on GitHub.

## Sample logging

```bash
[12/13/2017, 9:39:05 PM] [eWeLink] A total of [1] accessories were loaded from the local cache
[12/13/2017, 9:39:05 PM] [eWeLink] Requesting a list of devices from eWeLink HTTPS API at [https://us-api.coolkit.cc:8080]
[12/13/2017, 9:39:06 PM] [eWeLink] eWeLink HTTPS API reports that there are a total of [1] devices registered
[12/13/2017, 9:39:06 PM] [eWeLink] Evaluating if devices need to be removed...
[12/13/2017, 9:39:06 PM] [eWeLink] Verifying that all cached devices are still registered with the API. Devices that are no longer registered with the API will be removed.
[12/13/2017, 9:39:06 PM] [eWeLink] Device [Fan] is regeistered with API. Nothing to do.
[12/13/2017, 9:39:06 PM] [eWeLink] Evaluating if new devices need to be added...
[12/13/2017, 9:39:06 PM] [eWeLink] Device with ID [XXXXXXX] is already configured. Ensuring that the configuration is current.
[12/13/2017, 9:39:06 PM] [eWeLink] Updating recorded Characteristic.On for [Fan] to [false]. No request will be sent to the device.
[12/13/2017, 9:39:06 PM] [eWeLink] Setting power state to [off] for device [Fan]
[12/13/2017, 9:39:06 PM] [eWeLink] API key retrieved from web service is [XXXXXXX]
[12/13/2017, 9:39:06 PM] [eWeLink] Connecting to the WebSocket API at [wss://us-long.coolkit.cc:8080/api/ws]
[12/13/2017, 9:39:06 PM] [eWeLink] Sending login request [{"action":"userOnline","userAgent":"app","version":6,"nonce":"151321914688000","apkVesrion":"1.8","os":"ios","at":"XXXXXXX","apikey":"xxxxxxx","ts":"1513219146","model":"iPhone10,6","romVersion":"11.1.2","sequence":1513219146880}]
[12/13/2017, 9:39:06 PM] [eWeLink] WebSocket messge received:  {"error":0,"apikey":"xxxxxxx","config":{"hb":1,"hbInterval":145},"sequence":"1513219146880"}
```

*Hey Siri, turn on the fan*

```bash
[12/13/2017, 9:39:09 PM] [eWeLink] Setting power state to [on] for device [Fan]
[12/13/2017, 9:39:09 PM] [eWeLink] WebSocket messge received:  {"error":0,"deviceid":"XXXXXXX","apikey":"XXXXXXX","sequence":"1513219149620"}
[12/13/2017, 9:39:11 PM] [eWeLink] Setting power state to [off] for device [Fan]
[12/13/2017, 9:39:12 PM] [eWeLink] WebSocket messge received:  {"error":0,"deviceid":"XXXXXXX","apikey":"XXXXXXX","sequence":"1513219151735"}
```

The plugin will also listen for announcements via a persistent web socket. This allows you to control the device from the likes of Google Home & have Homebridge be kept up-to-date.

*Hey Google, turn on the fan*

```bash
[12/13/2017, 9:41:50 PM] [eWeLink] Update message received for device [XXXXXXX]
[12/13/2017, 9:41:50 PM] [eWeLink] Updating recorded Characteristic.On for [Fan] to [true]. No request will be sent to the device.
[12/13/2017, 9:41:50 PM] [eWeLink] Setting power state to [on] for device [Fan]
[12/13/2017, 9:41:50 PM] [eWeLink] WebSocket messge received:  {"error":0,"deviceid":"XXXXXXX","apikey":"XXXXXXX","sequence":"1513219310003"}
```

## Credits

<https://github.com/websockets/ws/wiki/Websocket-client-implementation-for-auto-reconnect>

<https://github.com/manolab/homebridge-sonoff-stateful-blinds>
