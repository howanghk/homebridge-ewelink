/* jshint -W030, -W069, esversion: 6 */
let WebSocket = require('ws');
let http = require('http');
let url = require('url');
const querystring = require('querystring');
let request = require('request-json');
let nonce = require('nonce')();
let crypto = require('crypto');

let wsc;
let isSocketOpen = false;
let sequence = 0;
let webClient = '';
let apiKey = 'UNCONFIGURED';
let authenticationToken = 'UNCONFIGURED';
let Accessory, Service, Characteristic, UUIDGen;

module.exports = function (homebridge) {
    console.log("homebridge API version: " + homebridge.version);

    // Accessory must be created from PlatformAccessory Constructor
    Accessory = homebridge.platformAccessory;

    // Service and Characteristic are from hap-nodejs
    Service = homebridge.hap.Service;
    Characteristic = homebridge.hap.Characteristic;
    UUIDGen = homebridge.hap.uuid;

    // For platform plugin to be considered as dynamic platform plugin,
    // registerPlatform(pluginName, platformName, constructor, dynamic), dynamic must be true
    homebridge.registerPlatform("homebridge-eWeLink", "eWeLink", eWeLink, true);

};

// Platform constructor
function eWeLink(log, config, api) {

    let platform = this;
    this.log = log;
    this.config = config;
    this.accessories = new Map();
    this.authenticationToken = config['authenticationToken'];
    this.devicesFromApi = new Map();

    // platform.log(JSON.stringify(config, null, " "));

    if (!config || (!config['authenticationToken'] && ((!config['phoneNumber'] && !config['email']) || !config['password'] || !config['imei']))) {
        log("Initialization skipped. Missing configuration data.");
        return;
    }

    if (!config['apiHost']) {
        config['apiHost'] = 'eu-api.coolkit.cc:8080';
    }
    if (!config['webSocketApi']) {
        config['webSocketApi'] = 'us-pconnect3.coolkit.cc';
    }

    platform.log("Intialising eWeLink");

    // Groups configuration
    this.groups = new Map();
    let configGroups = config['groups'] || null;
    if (configGroups) {
        if (Object.keys(configGroups).length > 0) {
            this.config.groups.forEach((group) => {
                this.groups.set(group.deviceId, group);
            });
        }
    }

    platform.log("Found %s group(s)", this.groups.size);

    if (api) {
        // Save the API object as plugin needs to register new accessory via this object
        this.api = api;

        // Listen to event "didFinishLaunching", this means homebridge already finished loading cached accessories.
        // Platform Plugin should only register new accessory that doesn't exist in homebridge after this event.
        // Or start discover new accessories.


        this.api.on('didFinishLaunching', function () {

            platform.log("A total of [%s] accessories were loaded from the local cache", platform.accessories.size);

            let afterLogin = function () {

                // Get a list of all devices from the API, and compare it to the list of cached devices.
                // New devices will be added, and devices that exist in the cache but not in the web list
                // will be removed from Homebridge.

                let url = 'https://' + this.config['apiHost'];

                platform.log("Requesting a list of devices from eWeLink HTTPS API at [%s]", url);

                this.webClient = request.createClient(url);

                this.webClient.headers['Authorization'] = 'Bearer ' + this.authenticationToken;
                this.webClient.get('/api/user/device?' + this.getArguments(), function (err, res, body) {

                    if (err) {
                        platform.log("An error was encountered while requesting a list of devices. Error was [%s]", err);
                        return;
                    } else if (!body) {
                        platform.log("An error was encountered while requesting a list of devices. No data in response.");
                        return;
                    } else if (body.hasOwnProperty('error') && body.error != 0) {
                        let response = JSON.stringify(body);
                        platform.log("An error was encountered while requesting a list of devices. Response was [%s]", response);
                        if (body.error === '401') {
                            platform.log("Verify that you have the correct authenticationToken specified in your configuration. The currently-configured token is [%s]", platform.authenticationToken);
                        }
                        return;
                    }

                    body = body.devicelist;

                    let size = Object.keys(body).length;
                    platform.log("eWeLink HTTPS API reports that there are a total of [%s] devices registered", size);

                    if (size === 0) {
                        platform.log("As there were no devices were found, all devices have been removed from the platform's cache. Please regiester your devices using the eWeLink app and restart HomeBridge");
                        platform.accessories.clear();
                        platform.api.unregisterPlatformAccessories("homebridge-eWeLink", "eWeLink", platform.accessories);
                        return;
                    }

                    let newDevicesToAdd = new Map();

                    body.forEach((device) => {
                        platform.apiKey = device.apikey;
                        // Skip Sonoff Bridge as it is not supported by this plugin
                        if (['RF_BRIDGE'].indexOf(platform.getDeviceTypeByUiid(device.uiid)) == -1) {
                            platform.devicesFromApi.set(device.deviceid, device);
                        }
                    });

                    // Now we compare the cached devices against the web list
                    platform.log("Evaluating if devices need to be removed...");

                    function checkIfDeviceIsStillRegistered(value, deviceId, map) {

                        let accessory = platform.accessories.get(deviceId);

                        // To handle grouped accessories
                        var realDeviceId = deviceId;

                        if (accessory.context.switches > 1) {
                            realDeviceId = deviceId.replace('CH' + accessory.context.channel, "");
                        }

                        if (platform.devicesFromApi.has(realDeviceId) && (accessory.context.switches <= 1 || accessory.context.channel <= accessory.context.switches)) {
                            if ((deviceId != realDeviceId) && platform.groups.has(realDeviceId)) {
                                platform.log('Device [%s], ID : [%s] is now grouped. It will be removed.', accessory.displayName, accessory.UUID);
                                platform.removeAccessory(accessory);
                            } else if ((deviceId == realDeviceId) && !platform.groups.has(realDeviceId)) {
                                platform.log('Device [%s], ID : [%s] is now splitted. It will be removed.', accessory.displayName, accessory.UUID);
                                platform.removeAccessory(accessory);
                            } else if (platform.getDeviceTypeByUiid(platform.devicesFromApi.get(realDeviceId).uiid) === 'FAN_LIGHT' && accessory.context.channel !== null) {
                                platform.log('Device [%s], ID : [%s] is now grouped as a fan. It will be removed.', accessory.displayName, accessory.UUID);
                                platform.removeAccessory(accessory);
                            } else {
                                platform.log('[%s] Device is registered with API. ID: (%s). Nothing to do.', accessory.displayName, accessory.UUID);
                            }
                        } else if (platform.devicesFromApi.has(realDeviceId) && platform.getDeviceTypeByUiid(platform.devicesFromApi.get(realDeviceId).uiid) === 'FAN_LIGHT') {
                            platform.log('[%s] Device is registered with API. ID: (%s). Nothing to do.', accessory.displayName, accessory.UUID);
                        } else {
                            platform.log('Device [%s], ID : [%s] was not present in the response from the API. It will be removed.', accessory.displayName, accessory.UUID);
                            platform.removeAccessory(accessory);
                        }
                    }

                    // If we have devices in our cache, check that they exist in the web response
                    if (platform.accessories.size > 0) {
                        platform.log("Verifying that all cached devices are still registered with the API. Devices that are no longer registered with the API will be removed.");
                        platform.accessories.forEach(checkIfDeviceIsStillRegistered);
                    }

                    platform.log("Evaluating if new devices need to be added...");

                    // Now we compare the cached devices against the web list
                    function checkIfDeviceIsAlreadyConfigured(value, deviceId, map) {

                        if (platform.accessories.has(deviceId)) {

                            platform.log('Device with ID [%s] is already configured. Ensuring that the configuration is current.', deviceId);

                            let accessory = platform.accessories.get(deviceId);
                            let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
                            let deviceType = platform.getDeviceTypeByUiid(deviceInformationFromWebApi.uiid);
                            let switchesAmount = platform.getDeviceChannelCount(deviceInformationFromWebApi);

                            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, deviceInformationFromWebApi.extra.extra.mac);
                            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, deviceInformationFromWebApi.productModel);
                            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, deviceInformationFromWebApi.extra.extra.model + ' (' + deviceInformationFromWebApi.uiid + ')');
                            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, deviceInformationFromWebApi.params.fwVersion);

                            if (switchesAmount > 1) {
                                if (platform.groups.has(deviceInformationFromWebApi.deviceid)) {
                                    let group = platform.groups.get(deviceInformationFromWebApi.deviceid);

                                    switch (group.type) {
                                        case 'blind':
                                            platform.log("Blind device has been set: " + deviceInformationFromWebApi.extra.extra.model + ' uiid: ' + deviceInformationFromWebApi.uiid);
                                            accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Name, deviceInformationFromWebApi.name);
                                            platform.updateBlindStateCharacteristic(deviceId, deviceInformationFromWebApi.params.switches);
                                            // Ensuring switches device config
                                            platform.initSwitchesConfig(accessory);
                                            break;
                                        default:
                                            platform.log('Group type error ! Device [%s], ID : [%s] will not be set', deviceInformationFromWebApi.name, deviceInformationFromWebApi.deviceid);
                                            break;
                                    }
                                } else if (deviceType === 'FAN_LIGHT') {
                                    platform.updateFanLightCharacteristic(deviceId, deviceInformationFromWebApi.params.switches[0].switch, platform.devicesFromApi.get(deviceId));
                                    platform.updateFanSpeedCharacteristic(deviceId, deviceInformationFromWebApi.params.switches[1].switch, deviceInformationFromWebApi.params.switches[2].switch, deviceInformationFromWebApi.params.switches[3].switch, platform.devicesFromApi.get(deviceId));
                                } else {
                                    platform.log(switchesAmount + " channels device has been set: " + deviceInformationFromWebApi.extra.extra.model + ' uiid: ' + deviceInformationFromWebApi.uiid);
                                    for (let i = 0; i !== switchesAmount; i++) {
                                        accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Name, deviceInformationFromWebApi.name + ' CH ' + (i + 1));
                                        platform.updatePowerStateCharacteristic(deviceId + 'CH' + (i + 1), deviceInformationFromWebApi.params.switches[i].switch, platform.devicesFromApi.get(deviceId));
                                    }
                                }
                            } else {
                                platform.log("Single channel device has been set: " + deviceInformationFromWebApi.extra.extra.model + ' uiid: ' + deviceInformationFromWebApi.uiid);
                                accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Name, deviceInformationFromWebApi.name);
                                platform.updatePowerStateCharacteristic(deviceId, deviceInformationFromWebApi.params.switch);
                            }

                            if (deviceInformationFromWebApi.extra.extra.model === "PSA-BHA-GL") {
                                platform.log("Thermostat device has been set: " + deviceInformationFromWebApi.extra.extra.model);
                                platform.updateCurrentTemperatureCharacteristic(deviceId, deviceInformationFromWebApi.params);
                            }

                        } else {
                            platform.log('Device with ID [%s] is not configured. Add accessory.', deviceId);

                            let deviceToAdd = platform.devicesFromApi.get(deviceId);
                            let switchesAmount = platform.getDeviceChannelCount(deviceToAdd);

                            let services = {};
                            services.switch = true;

                            if (deviceToAdd.extra.extra.model === "PSA-BHA-GL") {
                                services.thermostat = true;
                                services.temperature = true;
                                services.humidity = true;
                            } else {
                                services.switch = true;
                            }
                            if (switchesAmount > 1) {
                                if (platform.groups.has(deviceToAdd.deviceid)) {
                                    let group = platform.groups.get(deviceToAdd.deviceid);
                                    switch (group.type) {
                                        case 'blind':
                                            platform.log('Device [%s], ID : [%s] will be added as %s', deviceToAdd.name, deviceToAdd.deviceid, group.type);
                                            services.blind = true;
                                            services.switch = false;
                                            services.group = group;
                                            platform.addAccessory(deviceToAdd, null, services);
                                            break;
                                        default:
                                            platform.log('Group type error ! Device [%s], ID : [%s] will not be added', deviceToAdd.name, deviceToAdd.deviceid);
                                            break;
                                    }
                                } else if (deviceToAdd.extra.extra.model === "PSF-BFB-GL") {
                                    services.fan = true;
                                    services.switch = false;
                                    platform.log('Device [%s], ID : [%s] will be added as a fam', deviceToAdd.name, deviceToAdd.deviceid);
                                    platform.addAccessory(deviceToAdd, deviceToAdd.deviceid, services);
                                } else {
                                    for (let i = 0; i !== switchesAmount; i++) {
                                        platform.log('Device [%s], ID : [%s] will be added', deviceToAdd.name, deviceToAdd.deviceid + 'CH' + (i + 1));
                                        platform.addAccessory(deviceToAdd, deviceToAdd.deviceid + 'CH' + (i + 1), services);
                                    }
                                }
                            } else {
                                platform.log('Device [%s], ID : [%s] will be added', deviceToAdd.name, deviceToAdd.deviceid);
                                platform.addAccessory(deviceToAdd, null, services);
                            }
                        }
                    }

                    // Go through the web response to make sure that all the devices that are in the response do exist in the accessories map
                    if (platform.devicesFromApi.size > 0) {
                        platform.devicesFromApi.forEach(checkIfDeviceIsAlreadyConfigured);
                    }

                    platform.log("API key retrieved from web service is [%s]", platform.apiKey);

                    // We have our devices, now open a connection to the WebSocket API

                    let url = 'wss://' + platform.config['webSocketApi'] + ':8080/api/ws';

                    platform.log("Connecting to the WebSocket API at [%s]", url);

                    platform.wsc = new WebSocketClient();

                    platform.wsc.open(url);

                    platform.wsc.onmessage = function (message) {

                        // Heartbeat response can be safely ignored
                        if (message == 'pong') {
                            return;
                        }

                        platform.log("WebSocket messge received: ", message);

                        let json;
                        try {
                            json = JSON.parse(message);
                        } catch (e) {
                            return;
                        }

                        if (json.hasOwnProperty("action")) {

                            if (json.action === 'update') {

                                platform.log("Update message received for device [%s]", json.deviceid);
                                platform.log(json);

                                if (json.hasOwnProperty("params") && json.params.hasOwnProperty("switch")) {
                                    platform.updatePowerStateCharacteristic(json.deviceid, json.params.switch);
                                } else if (json.hasOwnProperty("params") && json.params.hasOwnProperty("switches") && Array.isArray(json.params.switches)) {
                                    if (platform.groups.has(json.deviceid)) {
                                        let group = platform.groups.get(json.deviceid);
                                        platform.log('---------------' + group);

                                        switch (group.type) {
                                            case 'blind':
                                                if (group.handle_api_changes) {
                                                    platform.updateBlindStateCharacteristic(json.deviceid, json.params.switches);
                                                } else {
                                                    platform.log('Setup to not respond to API. Device ID : [%s] will not be updated.', json.deviceid);
                                                }
                                                break;
                                            default:
                                                platform.log('Group type error ! Device ID : [%s] will not be updated.', json.deviceid);
                                                break;
                                        }
                                    } else if (platform.devicesFromApi.has(json.deviceid) && platform.getDeviceTypeByUiid(platform.devicesFromApi.get(json.deviceid).uiid) === 'FAN_LIGHT') {
                                        platform.updateFanLightCharacteristic(json.deviceid, json.params.switches[0].switch, platform.devicesFromApi.get(json.deviceid));
                                        platform.devicesFromApi.get(json.deviceid).params.switches = json.params.switches;
                                        platform.updateFanSpeedCharacteristic(json.deviceid, json.params.switches[1].switch, json.params.switches[2].switch, json.params.switches[3].switch, platform.devicesFromApi.get(json.deviceid));
                                    } else {
                                        json.params.switches.forEach(function (entry) {
                                            if (entry.hasOwnProperty('outlet') && entry.hasOwnProperty('switch')) {
                                                platform.updatePowerStateCharacteristic(json.deviceid + 'CH' + (entry.outlet + 1), entry.switch, platform.devicesFromApi.get(json.deviceid));
                                            }
                                        });
                                    }
                                }

                                if (json.hasOwnProperty("params") && (json.params.hasOwnProperty("currentTemperature") || json.params.hasOwnProperty("currentHumidity"))) {
                                    platform.updateCurrentTemperatureCharacteristic(json.deviceid, json.params);
                                }


                            }

                        } else if (json.hasOwnProperty('config') && json.config.hb && json.config.hbInterval) {
                            if (!platform.hbInterval) {
                                platform.hbInterval = setInterval(function () {
                                    platform.wsc.send('ping');
                                }, json.config.hbInterval * 1000);
                            }
                        }

                    };

                    platform.wsc.onopen = function (e) {

                        platform.isSocketOpen = true;

                        // We need to authenticate upon opening the connection

                        let time_stamp = new Date() / 1000;
                        let ts = Math.floor(time_stamp);

                        // Here's the eWeLink payload as discovered via Charles
                        let payload = {};
                        payload.action = "userOnline";
                        payload.userAgent = 'app';
                        payload.version = 6;
                        payload.nonce = '' + nonce();
                        payload.apkVesrion = "1.8";
                        payload.os = 'ios';
                        payload.at = config.authenticationToken;
                        payload.apikey = platform.apiKey;
                        payload.ts = '' + ts;
                        payload.model = 'iPhone10,6';
                        payload.romVersion = '11.1.2';
                        payload.sequence = platform.getSequence();

                        let string = JSON.stringify(payload);

                        platform.log('Sending login request [%s]', string);

                        platform.wsc.send(string);

                    };

                    platform.wsc.onclose = function (e) {
                        platform.log("WebSocket was closed. Reason [%s]", e);
                        platform.isSocketOpen = false;
                        if (platform.hbInterval) {
                            clearInterval(platform.hbInterval);
                            platform.hbInterval = null;
                        }
                    };

                }); // End WebSocket

            }; // End afterLogin

            // Resolve region if countryCode is provided
            if (this.config['countryCode']) {
                this.getRegion(this.config['countryCode'], function () {
                    this.login(afterLogin.bind(this));
                }.bind(this));
            } else {
                this.login(afterLogin.bind(this));
            }

        }.bind(this));
    }
}

// Function invoked when homebridge tries to restore cached accessory.
// We update the existing devices as part of didFinishLaunching(), as to avoid an additional call to the the HTTPS API.
eWeLink.prototype.configureAccessory = function (accessory) {

    let platform = this;

    // To avoid crash if platform config change
    if (!platform.log) {
        return;
    }

    platform.log(accessory.displayName, "Configure Accessory");

    let service;
    if (accessory.getService(Service.WindowCovering)) {
        service = accessory.getService(Service.WindowCovering);
        service.getCharacteristic(Characteristic.CurrentPosition)
            .on('get', function (callback) {
                platform.getCurrentPosition(accessory, callback);
            });
        service.getCharacteristic(Characteristic.PositionState)
            .on('get', function (callback) {
                platform.getPositionState(accessory, callback);
            });
        service.getCharacteristic(Characteristic.TargetPosition)
            .on('set', function (value, callback) {
                platform.setTargetPosition(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getTargetPosition(accessory, callback);
            });

        // Restore previous state
        let lastPosition = accessory.context.lastPosition;
        platform.log("[%s] Previous last Position stored: %s", accessory.displayName, lastPosition);
        if ((lastPosition === undefined) || (lastPosition < 0)) {
            lastPosition = 0;
            platform.log("[%s] No previous saved state. lastPosition set to default: %s", accessory.displayName, lastPosition);
        } else {
            platform.log("[%s] Previous saved state found. lastPosition set to: %s", accessory.displayName, lastPosition);
        }
        accessory.context.lastPosition = lastPosition;
        accessory.context.currentTargetPosition = lastPosition;
        accessory.context.currentPositionState = 2;

        // Updating config
        let group = platform.groups.get(accessory.context.deviceId);
        if (group) {
            accessory.context.switchUp = group.relay_up - 1;
            accessory.context.switchDown = group.relay_down - 1;
            accessory.context.durationUp = group.time_up;
            accessory.context.durationDown = group.time_down;
            accessory.context.durationBMU = group.time_botton_margin_up || 0;
            accessory.context.durationBMD = group.time_botton_margin_down || 0;
            accessory.context.fullOverdrive = (group.full_overdrive || 0) * 1000;
            accessory.context.percentDurationDown = (accessory.context.durationDown / 100) * 1000;
            accessory.context.percentDurationUp = (accessory.context.durationUp / 100) * 1000;
            accessory.context.handleApiChanges = group.handle_api_changes || true;
        }
    }
    if (accessory.getService(Service.Switch)) {

        accessory.getService(Service.Switch)
            .getCharacteristic(Characteristic.On)
            .on('set', function (value, callback) {
                platform.setPowerState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getPowerState(accessory, callback);
            });

    }
    if (accessory.getService(Service.Thermostat)) {
        service = accessory.getService(Service.Thermostat);

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .on('set', function (value, callback) {
                platform.setTemperatureState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getCurrentTemperature(accessory, callback);
            });
        service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('set', function (value, callback) {
                platform.setHumidityState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getCurrentHumidity(accessory, callback);
            });
    }
    if (accessory.getService(Service.TemperatureSensor)) {
        accessory.getService(Service.TemperatureSensor)
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('set', function (value, callback) {
                platform.setTemperatureState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getCurrentTemperature(accessory, callback);
            });
    }
    if (accessory.getService(Service.HumiditySensor)) {
        accessory.getService(Service.HumiditySensor)
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('set', function (value, callback) {
                platform.setHumidityState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getCurrentHumidity(accessory, callback);
            });
    }

    if (accessory.getService(Service.Fanv2)) {
        accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.On)
            .on("get", function (callback) {
                platform.getFanState(accessory, callback);
            })
            .on("set", function (value, callback) {
                platform.setFanState(accessory, value, callback);
            });

        // This is actually the fan speed instead of rotation speed but homekit fan does not support this
        accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.RotationSpeed)
            .setProps({
                minStep: 3
            })
            .on("get", function (callback) {
                platform.getFanSpeed(accessory, callback);
            })
            .on("set", function (value, callback) {
                platform.setFanSpeed(accessory, value, callback);
            });
    }

    if (accessory.getService(Service.Lightbulb)) {
        accessory.getService(Service.Lightbulb).getCharacteristic(Characteristic.On)
            .on("get", function (callback) {
                platform.getFanLightState(accessory, callback);
            })
            .on("set", function (value, callback) {
                platform.setFanLightState(accessory, value, callback);
            });

    }


    this.accessories.set(accessory.context.deviceId, accessory);

};

// Sample function to show how developer can add accessory dynamically from outside event
eWeLink.prototype.addAccessory = function (device, deviceId = null, services = {"switch": true}) {

    // Here we need to check if it is currently there
    if (this.accessories.get(deviceId ? deviceId : device.deviceid)) {
        this.log("Not adding [%s] as it already exists in the cache", deviceId ? deviceId : device.deviceid);
        return;
    }

    let platform = this;
    let channel = 0;

    if (device.type != 10) {
        this.log("A device with an unknown type was returned. It will be skipped.", device.type);
        return;
    }

    if (deviceId) {
        let id = deviceId.split("CH");
        channel = id[1];
    }

    let deviceName = device.name + (channel ? ' CH ' + channel : '');
    try {
        if (channel && device.tags && device.tags.ck_channel_name && device.tags.ck_channel_name[channel-1]) {
            deviceName = device.tags.ck_channel_name[channel-1];
        }
    } catch (e) {
        this.log("Problem device name : [%s]", e);
    }

    try {
        const status = channel && device.params.switches && device.params.switches[channel - 1] ? device.params.switches[channel - 1].switch : device.params.switch || "off";
        this.log("Found Accessory with Name : [%s], Manufacturer : [%s], Status : [%s], Is Online : [%s], API Key: [%s] ", deviceName, device.productModel, status, device.online, device.apikey);
    } catch (e) {
        this.log("Problem accessory Accessory with Name : [%s], Manufacturer : [%s], Error : [%s], Is Online : [%s], API Key: [%s] ", deviceName, device.productModel, e, device.online, device.apikey);
    }

    let switchesCount = this.getDeviceChannelCount(device);
    if (channel > switchesCount) {
        this.log("Can't add [%s], because device [%s] has only [%s] switches.", deviceName, device.productModel, switchesCount);
        return;
    }

    const accessory = new Accessory(deviceName, UUIDGen.generate((deviceId ? deviceId : device.deviceid).toString()));

    accessory.context.deviceId = deviceId ? deviceId : device.deviceid;
    accessory.context.apiKey = device.apikey;
    accessory.context.switches = 1;
    accessory.context.channel = channel;

    accessory.reachable = device.online === 'true';

    if (services.fan) {
        var fan = accessory.addService(Service.Fanv2, device.name);
        var light = accessory.addService(Service.Lightbulb, device.name + ' Light');
        light.getCharacteristic(Characteristic.On)
            .on("get", function (callback) {
                platform.getFanLightState(accessory, callback);
            })
            .on('set', function (value, callback) {
                platform.setFanLightState(accessory, value, callback);
            });


        fan.getCharacteristic(Characteristic.On)
            .on("get", function (callback) {
                platform.getFanState(accessory, callback);
            })
            .on("set", function (value, callback) {
                platform.setFanState(accessory, value, callback);
            });

        // This is actually the fan speed instead of rotation speed but homekit fan does not support this
        fan.getCharacteristic(Characteristic.RotationSpeed)
            .setProps({
                minStep: 3
            })
            .on("get", function (callback) {
                platform.getFanSpeed(accessory, callback);
            })
            .on("set", function (value, callback) {
                platform.setFanSpeed(accessory, value, callback);
            });
    }

    if (services.blind) {
        // platform.log("Services:", services);
        accessory.context.switchUp = services.group.relay_up - 1;
        accessory.context.switchDown = services.group.relay_down - 1;
        accessory.context.durationUp = services.group.time_up;
        accessory.context.durationDown = services.group.time_down;
        accessory.context.durationBMU = services.group.time_botton_margin_up || 0;
        accessory.context.durationBMD = services.group.time_botton_margin_down || 0;
        accessory.context.fullOverdrive = (services.group.full_overdrive || 0) * 1000;
        accessory.context.percentDurationDown = (accessory.context.durationDown / 100) * 1000;
        accessory.context.percentDurationUp = (accessory.context.durationUp / 100) * 1000;
        accessory.context.handleApiChanges = services.group.handle_api_changes || true;

        accessory.context.lastPosition = 100;           // Last know position, (0-100%)
        accessory.context.currentPositionState = 2;     // 2 = Stoped , 0=Moving Up , 1 Moving Down.
        accessory.context.currentTargetPosition = 100;    //  Target Position, (0-100%)

        // Ensuring switches device config
        platform.initSwitchesConfig(accessory);

        let service = accessory.addService(Service.WindowCovering, deviceName);
        service.getCharacteristic(Characteristic.CurrentPosition)
            .on('get', function (callback) {
                platform.getCurrentPosition(accessory, callback);
            });
        service.getCharacteristic(Characteristic.PositionState)
            .on('get', function (callback) {
                platform.getPositionState(accessory, callback);
            });
        service.getCharacteristic(Characteristic.TargetPosition)
            .on('get', function (callback) {
                platform.getTargetPosition(accessory, callback);
            })
            .on('set', function (value, callback) {
                platform.setTargetPosition(accessory, value, callback);
            });
    }
    if (services.switch) {
        accessory.addService(Service.Switch, deviceName)
            .getCharacteristic(Characteristic.On)
            .on('set', function (value, callback) {
                platform.setPowerState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getPowerState(accessory, callback);
            });
    }
    if (services.thermostat) {
        let service = accessory.addService(Service.Thermostat, deviceName);

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .on('set', function (value, callback) {
                platform.setTemperatureState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getCurrentTemperature(accessory, callback);
            });
        service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('set', function (value, callback) {
                platform.setHumidityState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getCurrentHumidity(accessory, callback);
            });
    }
    if (services.temperature) {
        accessory.addService(Service.TemperatureSensor, deviceName)
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('set', function (value, callback) {
                platform.setTemperatureState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getCurrentTemperature(accessory, callback);
            });
    }

    if (services.humidity) {
        accessory.addService(Service.HumiditySensor, deviceName)
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('set', function (value, callback) {
                platform.setHumidityState(accessory, value, callback);
            })
            .on('get', function (callback) {
                platform.getCurrentHumidity(accessory, callback);
            });
    }

    accessory.on('identify', function (paired, callback) {
        platform.log(accessory.displayName, "Identify not supported");
        callback();
    });

    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.SerialNumber, device.extra.extra.mac);
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Manufacturer, device.productModel);
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Model, device.extra.extra.model);
    accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.Identify, false);

    // Exception when some device is not ready to register
    try {
        accessory.getService(Service.AccessoryInformation).setCharacteristic(Characteristic.FirmwareRevision, device.params.fwVersion);
    } catch (e) {
        this.log("Error : [%s]", e);
    }

    let switchesAmount = platform.getDeviceChannelCount(device);
    if (switchesAmount > 1) {
        accessory.context.switches = switchesAmount;
    }

    this.accessories.set(device.deviceid, accessory);

    this.api.registerPlatformAccessories("homebridge-eWeLink",
        "eWeLink", [accessory]);

};

eWeLink.prototype.getSequence = function () {
    let time_stamp = new Date() / 1000;
    this.sequence = Math.floor(time_stamp * 1000);
    return this.sequence;
};

eWeLink.prototype.updatePowerStateCharacteristic = function (deviceId, state, device = null, channel = null) {

    // Used when we receive an update from an external source

    let platform = this;

    let isOn = false;

    let accessory = platform.accessories.get(deviceId);

    if (typeof accessory === 'undefined' && device) {
        platform.log("Adding accessory for deviceId [%s].", deviceId);
        platform.addAccessory(device, deviceId);
        accessory = platform.accessories.get(deviceId);
    }

    if (!accessory) {
        platform.log("Error updating non-exist accessory with deviceId [%s].", deviceId);
        return;
    }

    if (state === 'on') {
        isOn = true;
    }

    platform.log("Updating recorded Characteristic.On for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, isOn);

    let currentState = accessory.getService(Service.Switch).getCharacteristic(Characteristic.On).value;
    if (currentState !== isOn) {
        platform.log("Updating recorded Characteristic.On for [%s] from [%s] to [%s]. No request will be sent to the device.", accessory.displayName, currentState, isOn);
        accessory.getService(Service.Switch)
        .setCharacteristic(Characteristic.On, isOn);
    }
};

eWeLink.prototype.updateCurrentTemperatureCharacteristic = function (deviceId, state, device = null, channel = null) {

    // Used when we receive an update from an external source

    let platform = this;

    let accessory = platform.accessories.get(deviceId);
    //platform.log("deviceID:", deviceId);

    if (typeof accessory === 'undefined' && device) {
        platform.addAccessory(device, deviceId);
        accessory = platform.accessories.get(deviceId);
    }

    if (!accessory) {
        platform.log("Error updating non-exist accessory with deviceId [%s].", deviceId);
        return;
    }

    // platform.log(JSON.stringify(device,null,2));

    let currentTemperature = state.currentTemperature;
    let currentHumidity = state.currentHumidity;

    platform.log("Updating recorded Characteristic.CurrentTemperature for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, currentTemperature);
    platform.log("Updating recorded Characteristic.CurrentRelativeHuniditgy for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, currentHumidity);

    if (accessory.getService(Service.Thermostat)) {
        accessory.getService(Service.Thermostat)
            .setCharacteristic(Characteristic.CurrentTemperature, currentTemperature);
        accessory.getService(Service.Thermostat)
            .setCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity);
    }
    if (accessory.getService(Service.TemperatureSensor)) {
        accessory.getService(Service.TemperatureSensor)
            .setCharacteristic(Characteristic.CurrentTemperature, currentTemperature);
    }
    if (accessory.getService(Service.HumiditySensor)) {
        accessory.getService(Service.HumiditySensor)
            .setCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity);
    }

};

eWeLink.prototype.updateBlindStateCharacteristic = function (deviceId, switches, device = null) {

    // Used when we receive an update from an external source

    let platform = this;

    let accessory = platform.accessories.get(deviceId);

    if (typeof accessory === 'undefined' && device) {
        platform.log("Adding accessory for deviceId [%s].", deviceId);
        platform.addAccessory(device, deviceId);
        accessory = platform.accessories.get(deviceId);
    }

    if (!accessory) {
        platform.log("Error updating non-exist accessory with deviceId [%s].", deviceId);
        return;
    }

    let state = platform.getBlindState(switches, accessory);
    // platform.log("blindStae_debug:", state)
    // [0,0] = 0 => 2 Stopped
    // [0,1] = 1 => 1 Moving down
    // [1,0] = 2 => 0 Moving up
    // [1,1] = 3 => Error

    let stateString = ["Moving up", "Moving down", "Stopped", "Error!"];
    let service = accessory.getService(Service.WindowCovering);
    let actualPosition;

    // platform.log("accessory.context.currentPositionState:", accessory.context.currentPositionState);

    switch (state) {
        case 3:
            platform.log("[%s] ERROR : positionState: %s. Force stop!", accessory.displayName, state);
            actualPosition = platform.actualPosition(accessory);
            accessory.context.currentTargetPosition = actualPosition;
            accessory.context.targetTimestamp = Date.now() + 10;
            service.setCharacteristic(Characteristic.TargetPosition, actualPosition);
            break;
        case 2:
            if (accessory.context.currentPositionState == 2) {
                platform.log("[%s] received new positionState: %s (%s). Already stopped. Nothing to do.", accessory.displayName, state, stateString[state]);
                return;
            }
            actualPosition = platform.actualPosition(accessory);
            platform.log("[%s] received new positionState when moving: %s (%s). Targuet pos: %s", accessory.displayName, state, stateString[state], actualPosition);
            accessory.context.currentTargetPosition = actualPosition;
            accessory.context.targetTimestamp = Date.now() + 10;
            service.setCharacteristic(Characteristic.TargetPosition, actualPosition);
            break;
        case 1:
            if (accessory.context.currentPositionState == 1) {
                platform.log("[%s] received same positionState: %s (%s). Nothing to do.", accessory.displayName, state, stateString[state]);
                return;
            }
            if (accessory.context.currentTargetPosition == 0) {
                platform.log("[%s] received new positionState: %s (%s). Targuet pos is already 0. Stopping!", accessory.displayName, state, stateString[state]);
                platform.setFinalBlindsState(accessory);
            } else {
                platform.log("[%s] received new positionState: %s (%s). Targuet pos: 0", accessory.displayName, state, stateString[state]);
                service.setCharacteristic(Characteristic.TargetPosition, 0);
            }
            break;
        case 0:
            if (accessory.context.currentPositionState == 0) {
                platform.log("[%s] received same positionState: %s (%s). Nothing to do.", accessory.displayName, state, stateString[state]);
                return;
            }
            if (accessory.context.currentTargetPosition == 100) {
                platform.log("[%s] received new positionState: %s (%s). Targuet pos is already 100. Stopping!", accessory.displayName, state, stateString[state]);
                platform.setFinalBlindsState(accessory);
            } else {
                platform.log("[%s] received new positionState: %s (%s). Targuet pos: 100", accessory.displayName, state, stateString[state]);
                service.setCharacteristic(Characteristic.TargetPosition, 100);
            }
            break;
        default:
            platform.log('[%s] PositionState type error !', accessory.displayName);
            break;
    }
};

eWeLink.prototype.updateFanLightCharacteristic = function (deviceId, state, device = null) {

    // Used when we receive an update from an external source

    let platform = this;

    let isOn = false;

    let accessory = platform.accessories.get(deviceId);

    if (typeof accessory === 'undefined' && device) {
        platform.log("Adding accessory for deviceId [%s].", deviceId);
        platform.addAccessory(device, deviceId);
        accessory = platform.accessories.get(deviceId);
    }

    if (!accessory) {
        platform.log("Error updating non-exist accessory with deviceId [%s].", deviceId);
        return;
    }

    if (state === 'on') {
        isOn = true;
    }

    platform.log("Updating recorded Characteristic.On for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, isOn);

    accessory.getService(Service.Lightbulb)
        .setCharacteristic(Characteristic.On, isOn);

};

eWeLink.prototype.updateFanSpeedCharacteristic = function (deviceId, state1, state2, state3, device = null) {

    // Used when we receive an update from an external source

    let platform = this;

    let isOn = false;
    let speed = 0;

    let accessory = platform.accessories.get(deviceId);

    if (typeof accessory === 'undefined' && device) {
        platform.log("Adding accessory for deviceId [%s].", deviceId);
        platform.addAccessory(device, deviceId);
        accessory = platform.accessories.get(deviceId);
    }

    if (!accessory) {
        platform.log("Error updating non-exist accessory with deviceId [%s].", deviceId);
        return;
    }

    if (state1 === 'on' && state2 === 'off' && state3 === 'off') {
        isOn = true;
        speed = 33.0;
    } else if (state1 === 'on' && state2 === 'on' && state3 === 'off') {
        isOn = true;
        speed = 66.0;
    } else if (state1 === 'on' && state2 === 'off' && state3 === 'on') {
        isOn = true;
        speed = 100.0;
    }

    platform.log("Updating recorded Characteristic.On for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, isOn);
    platform.log("Updating recorded Characteristic.RotationSpeed for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, speed);

    accessory.getService(Service.Fanv2)
        .setCharacteristic(Characteristic.On, isOn);

    accessory.getService(Service.Fanv2)
        .setCharacteristic(Characteristic.RotationSpeed, speed);
};

eWeLink.prototype.getPowerState = function (accessory, callback) {
    let platform = this;

    if (!this.webClient) {
        callback('this.webClient not yet ready while obtaining power status for your device');
        accessory.reachable = false;
        return;
    }

    platform.log("Requesting power state for [%s]", accessory.displayName);

    this.webClient.get('/api/user/device?' + this.getArguments(), function (err, res, body) {

        if (err) {
            if ([503].indexOf(parseInt(res.statusCode)) !== -1) {
                // callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
                platform.log('Sonoff API 503 error');
                setTimeout(function() {
                    platform.getPowerState(accessory, callback);
                }, 1000);
            } else {
                platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Error was [%s]", err);
            }
            return;
        } else if (!body) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. No data in response.", err);
            return;
        } else if (body.hasOwnProperty('error') && body.error != 0) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
                platform.relogin();
            }
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            return;
        }

        body = body.devicelist;

        let size = Object.keys(body).length;

        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            accessory.reachable = false;
            return;
        }

        let deviceId = accessory.context.deviceId;

        if (accessory.context.switches > 1) {
            deviceId = deviceId.replace("CH" + accessory.context.channel, "");
        }

        let filteredResponse = body.filter(device => (device.deviceid === deviceId));

        if (filteredResponse.length === 1) {

            let device = filteredResponse[0];

            if (device.deviceid === deviceId) {

                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }

                if (accessory.context.switches > 1) {
                    if (device.params.switches[accessory.context.channel - 1].switch === 'on') {
                        accessory.reachable = true;
                        platform.log('API reported that [%s] CH %s is On', device.name, accessory.context.channel);
                        callback(null, 1);
                        return;
                    } else if (device.params.switches[accessory.context.channel - 1].switch === 'off') {
                        accessory.reachable = true;
                        platform.log('API reported that [%s] CH %s is Off', device.name, accessory.context.channel);
                        callback(null, 0);
                        return;
                    } else {
                        accessory.reachable = false;
                        platform.log('API reported an unknown status for device [%s]', accessory.displayName);
                        callback('API returned an unknown status for device ' + accessory.displayName);
                        return;
                    }

                } else {
                    if (device.params.switch === 'on') {
                        accessory.reachable = true;
                        platform.log('API reported that [%s] is On', device.name);
                        callback(null, 1);
                        return;
                    } else if (device.params.switch === 'off') {
                        accessory.reachable = true;
                        platform.log('API reported that [%s] is Off', device.name);
                        callback(null, 0);
                        return;
                    } else {
                        accessory.reachable = false;
                        platform.log('API reported an unknown status for device [%s]', accessory.displayName);
                        callback('API returned an unknown status for device ' + accessory.displayName);
                        return;
                    }

                }

            }

        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {

            // The device is no longer registered

            platform.log("Device [%s] did not exist in the response.", accessory.displayName);
            //platform.removeAccessory(accessory);

        }

    });

};

eWeLink.prototype.getFanLightState = function (accessory, callback) {
    let platform = this;

    if (!this.webClient) {
        callback('this.webClient not yet ready while obtaining power status for your device');
        accessory.reachable = false;
        return;
    }

    platform.log("Requesting fan light power state for [%s]", accessory.displayName);

    this.webClient.get('/api/user/device?' + this.getArguments(), function (err, res, body) {

        if (err) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Error was [%s]", err);
            return;
        } else if (!body) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. No data in response.", err);
            return;
        } else if (body.hasOwnProperty('error') && body.error != 0) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
                platform.relogin();
            }
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            return;
        }

        body = body.devicelist;

        let size = Object.keys(body).length;

        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            accessory.reachable = false;
            return;
        }

        let deviceId = accessory.context.deviceId;

        let filteredResponse = body.filter(device => (device.deviceid === deviceId));

        if (filteredResponse.length === 1) {

            let device = filteredResponse[0];

            if (device.deviceid === deviceId) {
                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }

                if (device.params.switches[0].switch === 'on') {
                    accessory.reachable = true;
                    platform.log('API reported that fan light %s is On', device.name);
                    callback(null, 1);
                    return;
                } else if (device.params.switches[0].switch === 'off') {
                    accessory.reachable = true;
                    platform.log('API reported that fan light %s is Off', device.name);
                    callback(null, 0);
                    return;
                } else {
                    accessory.reachable = false;
                    platform.log('API reported an unknown status for device [%s]', accessory.displayName);
                    callback('API returned an unknown status for device ' + accessory.displayName);
                    return;
                }
            }

        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {
            // The device is no longer registered
            // The device is no longer registered
            platform.log("Device [%s] did not exist in the response. It will be removed", accessory.displayName);
            platform.removeAccessory(accessory);
        }
    });
};

eWeLink.prototype.getFanState = function (accessory, callback) {
    let platform = this;

    if (!this.webClient) {
        callback('this.webClient not yet ready while obtaining power status for your device');
        accessory.reachable = false;
        return;
    }

    platform.log("Requesting fan state for [%s]", accessory.displayName);

    this.webClient.get('/api/user/device?' + this.getArguments(), function (err, res, body) {

        if (err) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Error was [%s]", err);
            return;
        } else if (!body) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. No data in response.", err);
            return;
        } else if (body.hasOwnProperty('error') && body.error != 0) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
                platform.relogin();
            }
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            return;
        }

        body = body.devicelist;

        let size = Object.keys(body).length;

        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            accessory.reachable = false;
            return;
        }

        let deviceId = accessory.context.deviceId;

        let filteredResponse = body.filter(device => (device.deviceid === deviceId));

        if (filteredResponse.length === 1) {

            let device = filteredResponse[0];

            if (device.deviceid === deviceId) {
                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }

                if (device.params.switches[1].switch === 'on') {
                    accessory.reachable = true;
                    platform.log('API reported that fan light %s is On', device.name);
                    callback(null, 1);
                    return;
                } else if (device.params.switches[1].switch === 'off') {
                    accessory.reachable = true;
                    platform.log('API reported that fan light %s is Off', device.name);
                    callback(null, 0);
                    return;
                } else {
                    accessory.reachable = false;
                    platform.log(device.params.switches);
                    platform.log('API reported an unknown status for device [%s] [%s]', accessory.displayName, device.params.switches[1].switch);
                    callback('API returned an unknown status for device ' + accessory.displayName);
                    return;
                }
            }

        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {
            // The device is no longer registered
            platform.log("Device [%s] did not exist in the response. It will be removed", accessory.displayName);
            platform.removeAccessory(accessory);
        }
    });
};

eWeLink.prototype.getFanSpeed = function (accessory, callback) {
    let platform = this;

    if (!this.webClient) {
        callback('this.webClient not yet ready while obtaining power status for your device');
        accessory.reachable = false;
        return;
    }

    platform.log("Requesting fan state for [%s]", accessory.displayName);

    this.webClient.get('/api/user/device?' + this.getArguments(), function (err, res, body) {

        if (err) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Error was [%s]", err);
            return;
        } else if (!body) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. No data in response.", err);
            return;
        } else if (body.hasOwnProperty('error') && body.error != 0) {
            platform.log("An error was encountered while requesting a list of devices while interrogating power status. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            if ([401, 402].indexOf(parseInt(body.error)) !== -1) {
                platform.relogin();
            }
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            return;
        }

        body = body.devicelist;

        let size = Object.keys(body).length;

        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            accessory.reachable = false;
            return;
        }

        let deviceId = accessory.context.deviceId;

        let filteredResponse = body.filter(device => (device.deviceid === deviceId));

        if (filteredResponse.length === 1) {

            let device = filteredResponse[0];

            if (device.deviceid === deviceId) {
                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }

                if (device.params.switches[1].switch === 'on' && device.params.switches[2].switch === 'off' && device.params.switches[3].switch === 'off') {
                    accessory.reachable = true;
                    platform.log('API reported that fan speed %s is %d', device.name, 33);
                    callback(null, 33);
                    return;
                } else if (device.params.switches[1].switch === 'on' && device.params.switches[2].switch === 'on' && device.params.switches[3].switch === 'off') {
                    accessory.reachable = true;
                    platform.log('API reported that fan speed %s is %d', device.name, 66);
                    callback(null, 66);
                    return;
                } else if (device.params.switches[1].switch === 'on' && device.params.switches[2].switch === 'off' && device.params.switches[3].switch === 'on') {
                    accessory.reachable = true;
                    platform.log('API reported that fan speed %s is %d', device.name, 100);
                    callback(null, 100);
                    return;
                } else {
                    accessory.reachable = false;
                    platform.log('API reported an unknown status for device [%s]', accessory.displayName);
                    callback('API returned an unknown status for device ' + accessory.displayName);
                    return;
                }
            }

        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {
            // The device is no longer registered
            platform.log("Device [%s] did not exist in the response. It will be removed", accessory.displayName);
            platform.removeAccessory(accessory);
        }
    });
};

eWeLink.prototype.getCurrentTemperature = function (accessory, callback) {
    let platform = this;

    platform.log("Requesting current temperature for [%s]", accessory.displayName);

    this.webClient.get('/api/user/device?' + this.getArguments(), function (err, res, body) {

        if (err) {
            platform.log("An error was encountered while requesting a list of devices while interrogating current temperature. Verify your configuration options. Error was [%s]", err);
            return;
        } else if (!body) {
            platform.log("An error was encountered while requesting a list of devices while interrogating current temperature. Verify your configuration options. No data in response.", err);
            return;
        } else if (body.hasOwnProperty('error') && body.error != 0) {
            platform.log("An error was encountered while requesting a list of devices while interrogating current temperature. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            callback('An error was encountered while requesting a list of devices to interrogate current temperature for your device');
            return;
        }

        body = body.devicelist;

        let size = Object.keys(body).length;

        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate current temperature for your device');
            accessory.reachable = false;
            return;
        }

        let deviceId = accessory.context.deviceId;

        let filteredResponse = body.filter(device => (device.deviceid === deviceId));

        if (filteredResponse.length === 1) {

            let device = filteredResponse[0];

            if (device.deviceid === deviceId) {

                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }

                let currentTemperature = device.params.currentTemperature;
                platform.log("getCurrentTemperature:", currentTemperature);

                if (accessory.getService(Service.Thermostat)) {
                    accessory.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentTemperature, currentTemperature);
                }
                if (accessory.getService(Service.TemperatureSensor)) {
                    accessory.getService(Service.TemperatureSensor).setCharacteristic(Characteristic.CurrentTemperature, currentTemperature);
                }
                accessory.reachable = true;
                callback(null, currentTemperature);

            }

        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {

            // The device is no longer registered

            platform.log("Device [%s] did not exist in the response. It will be removed", accessory.displayName);
            platform.removeAccessory(accessory);

        }

    });

};

eWeLink.prototype.getCurrentHumidity = function (accessory, callback) {
    let platform = this;

    platform.log("Requesting current humidity for [%s]", accessory.displayName);

    this.webClient.get('/api/user/device?' + this.getArguments(), function (err, res, body) {

        if (err) {
            platform.log("An error was encountered while requesting a list of devices while interrogating current humidity. Verify your configuration options. Error was [%s]", err);
            return;
        } else if (!body) {
            platform.log("An error was encountered while requesting a list of devices while interrogating current humidity. Verify your configuration options. No data in response.", err);
            return;
        } else if (body.hasOwnProperty('error') && body.error != 0) {
            platform.log("An error was encountered while requesting a list of devices while interrogating current humidity. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            callback('An error was encountered while requesting a list of devices to interrogate current humidity for your device');
            return;
        }

        body = body.devicelist;

        let size = Object.keys(body).length;

        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate current humidity for your device');
            accessory.reachable = false;
            return;
        }

        let deviceId = accessory.context.deviceId;

        let filteredResponse = body.filter(device => (device.deviceid === deviceId));

        if (filteredResponse.length === 1) {

            let device = filteredResponse[0];

            if (device.deviceid === deviceId) {

                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }

                let currentHumidity = device.params.currentHumidity;
                platform.log("getCurrentHumidity:", currentHumidity);

                if (accessory.getService(Service.Thermostat)) {
                    accessory.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity);
                }
                if (accessory.getService(Service.HumiditySensor)) {
                    accessory.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentRelativeHumidity, currentHumidity);
                }
                accessory.reachable = true;
                callback(null, currentHumidity);

            }

        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {

            // The device is no longer registered

            platform.log("Device [%s] did not exist in the response. It will be removed", accessory.displayName);
            platform.removeAccessory(accessory);

        }

    });

};

eWeLink.prototype.setTemperatureState = function (accessory, value, callback) {
    let platform = this;
    let deviceId = accessory.context.deviceId;
    let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
    platform.log("setting temperature: ", value);
    /*
    deviceInformationFromWebApi.params.currentHumidity = value;
    if(accessory.getService(Service.Thermostat)) {
        accessory.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentTemperature, value);
    } else if(accesory.getService(Service.TemperatureSensor)) {
        accessory.getService(Service.TemperatureSensor).setCharacteristic(Characteristic.CurrentTemperature, value);
    }
    */
    callback();
};

eWeLink.prototype.setHumidityState = function (accessory, value, callback) {
    let platform = this;
    let deviceId = accessory.context.deviceId;
    let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
    platform.log("setting humidity: ", value);
    /*
    deviceInformationFromWebApi.params.currentHumidity = value;
    if(accessory.getService(Service.Thermostat)) {
        accessory.getService(Service.Thermostat).setCharacteristic(Characteristic.CurrentRelativeHumidity, value);
    } else if(accesory.getService(Service.HumiditySensor)) {
        accessory.getService(Service.HumiditySensor).setCharacteristic(Characteristic.CurrentRelativeHumidity, value);
    }
    */
    callback();
};

eWeLink.prototype.sendWebSocketMessage = function (string, callback) {
    let platform = this;

    if (!platform.hasOwnProperty('delaySend')) {
        platform.delaySend = 0;
    }
    const delayOffset = 280;

    let sendOperation = function (string) {
        if (!platform.isSocketOpen) {
            // socket not open, retry later
            setTimeout(function () {
                sendOperation(string);
            }, delayOffset);
            return;
        }

        if (platform.wsc) {
            platform.wsc.send(string);
            //platform.log("WS message sent");
            callback();
        }

        if (platform.delaySend <= 0) {
            platform.delaySend = 0;
        } else {
            platform.delaySend -= delayOffset;
        }
    };

    if (!platform.isSocketOpen) {
        platform.log('Socket was closed. It will reconnect automatically');

        let interval;
        let waitToSend = function (string) {
            if (platform.isSocketOpen) {
                clearInterval(interval);
                sendOperation(string);
            } else {
                //platform.log('Connection not ready.....');
            }
        };
        interval = setInterval(waitToSend, 750, string);
    } else {
        setTimeout(sendOperation, platform.delaySend, string);
        platform.delaySend += delayOffset;
    }
};

eWeLink.prototype.setPowerState = function (accessory, isOn, callback) {
    let platform = this;
    let options = {};
    let deviceId = accessory.context.deviceId;
    options.protocolVersion = 13;

    let targetState = 'off';

    if (isOn) {
        targetState = 'on';
    }

    platform.log("Setting power state to [%s] for device [%s]", targetState, accessory.displayName);

    let payload = {};
    payload.action = 'update';
    payload.userAgent = 'app';
    payload.params = {};
    if (accessory.context.switches > 1) {
        deviceId = deviceId.replace("CH" + accessory.context.channel, "");
        let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
        payload.params.switches = deviceInformationFromWebApi.params.switches;
        payload.params.switches[accessory.context.channel - 1].switch = targetState;
    } else {
        payload.params.switch = targetState;
    }
    payload.apikey = '' + accessory.context.apiKey;
    payload.deviceid = '' + deviceId;

    payload.sequence = platform.getSequence();

    let string = JSON.stringify(payload);
    // platform.log( string );

    platform.sendWebSocketMessage(string, callback);
};


eWeLink.prototype.setFanLightState = function (accessory, isOn, callback) {
    let platform = this;
    let options = {};
    let deviceId = accessory.context.deviceId;
    options.protocolVersion = 13;

    let targetState = 'off';

    if (isOn) {
        targetState = 'on';
    }

    platform.log("Setting light state to [%s] for device [%s]", targetState, accessory.displayName);

    let payload = {};
    payload.action = 'update';
    payload.userAgent = 'app';
    payload.params = {};
    let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
    payload.params.switches = deviceInformationFromWebApi.params.switches;
    payload.params.switches[0].switch = targetState;

    payload.apikey = '' + accessory.context.apiKey;
    payload.deviceid = '' + deviceId;

    payload.sequence = platform.getSequence();

    let string = JSON.stringify(payload);
    // platform.log( string );

    platform.sendWebSocketMessage(string, callback);

};

eWeLink.prototype.setFanState = function (accessory, isOn, callback) {
    let platform = this;
    let options = {};
    let deviceId = accessory.context.deviceId;
    options.protocolVersion = 13;

    let targetState = 'off';

    if (isOn) {
        targetState = 'on';
    }

    platform.log("Setting fan state to [%s] for device [%s]", targetState, accessory.displayName);

    let payload = {};
    payload.action = 'update';
    payload.userAgent = 'app';
    payload.params = {};
    let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
    payload.params.switches = deviceInformationFromWebApi.params.switches;
    payload.params.switches[1].switch = targetState;
    payload.apikey = '' + accessory.context.apiKey;
    payload.deviceid = '' + deviceId;

    payload.sequence = platform.getSequence();

    let string = JSON.stringify(payload);
    // platform.log( string );

    platform.sendWebSocketMessage(string, callback);

};

eWeLink.prototype.setFanSpeed = function (accessory, value, callback) {
    let platform = this;
    let options = {};
    let deviceId = accessory.context.deviceId;
    options.protocolVersion = 13;


    platform.log("Setting fan state to [%s] for device [%s]", value, accessory.displayName);

    let payload = {};
    payload.action = 'update';
    payload.userAgent = 'app';
    payload.params = {};
    let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
    payload.params.switches = deviceInformationFromWebApi.params.switches;

    if (value < 33) {
        payload.params.switches[1].switch = 'off';
        payload.params.switches[2].switch = 'off';
        payload.params.switches[3].switch = 'off';
    } else if (value >=33 && value < 66) {
        payload.params.switches[1].switch = 'on';
        payload.params.switches[2].switch = 'off';
        payload.params.switches[3].switch = 'off';
    } else if (value >=66 && value < 99) {
        payload.params.switches[1].switch = 'on';
        payload.params.switches[2].switch = 'on';
        payload.params.switches[3].switch = 'off';
    } else if (value >= 99) {
        payload.params.switches[1].switch = 'on';
        payload.params.switches[2].switch = 'off';
        payload.params.switches[3].switch = 'on';
    }

    payload.apikey = '' + accessory.context.apiKey;
    payload.deviceid = '' + deviceId;

    payload.sequence = platform.getSequence();

    let string = JSON.stringify(payload);
    // platform.log( string );

    platform.sendWebSocketMessage(string, callback);
};

// Sample function to show how developer can remove accessory dynamically from outside event
eWeLink.prototype.removeAccessory = function (accessory) {

    this.log('Removing accessory [%s]', accessory.displayName);

    this.accessories.delete(accessory.context.deviceId);

    this.api.unregisterPlatformAccessories('homebridge-eWeLink',
        'eWeLink', [accessory]);
};

eWeLink.prototype.getSignature = function (string) {
    //let appSecret = "248,208,180,108,132,92,172,184,256,152,256,144,48,172,220,56,100,124,144,160,148,88,28,100,120,152,244,244,120,236,164,204";
    //let f = "ab!@#$ijklmcdefghBCWXYZ01234DEFGHnopqrstuvwxyzAIJKLMNOPQRSTUV56789%^&*()";
    //let decrypt = function(r){var n="";return r.split(',').forEach(function(r){var t=parseInt(r)>>2,e=f.charAt(t);n+=e}),n.trim()};
    let decryptedAppSecret = '6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM'; //decrypt(appSecret);
    return crypto.createHmac('sha256', decryptedAppSecret).update(string).digest('base64');
};

eWeLink.prototype.login = function (callback) {
    if (!this.config.phoneNumber && !this.config.email || !this.config.password || !this.config.imei) {
        this.log('phoneNumber / email / password / imei not found in config, skipping login');
        callback();
        return;
    }

    var data = {};
    if (this.config.phoneNumber) {
        data.phoneNumber = this.config.phoneNumber;
    } else if (this.config.email) {
        data.email = this.config.email;
    }
    data.password = this.config.password;
    data.version = '6';
    data.ts = '' + Math.floor(new Date().getTime() / 1000);
    data.nonce = '' + nonce();
    data.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
    data.imei = this.config.imei;
    data.os = 'iOS';
    data.model = 'iPhone10,6';
    data.romVersion = '11.1.2';
    data.appVersion = '3.5.3';

    let json = JSON.stringify(data);
    this.log('Sending login request with user credentials: %s', json);

    let sign = this.getSignature(json);
    this.log('Login signature: %s', sign);

    let webClient = request.createClient('https://' + this.config.apiHost);
    webClient.headers['Authorization'] = 'Sign ' + sign;
    webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
    webClient.post('/api/user/login', data, function (err, res, body) {
        if (err) {
            this.log("An error was encountered while logging in. Error was [%s]", err);
            callback();
            return;
        }

        // If we receive 301 error, switch to new region and try again
        if (body.hasOwnProperty('error') && body.error == 301 && body.hasOwnProperty('region')) {
            let idx = this.config.apiHost.indexOf('-');
            if (idx == -1) {
                this.log("Received new region [%s]. However we cannot construct the new API host url.", body.region);
                callback();
                return;
            }
            let newApiHost = body.region + this.config.apiHost.substring(idx);
            if (this.config.apiHost != newApiHost) {
                this.log("Received new region [%s], updating API host to [%s].", body.region, newApiHost);
                this.config.apiHost = newApiHost;
                this.login(callback);
                return;
            }
        }

        if (!body.at) {
            let response = JSON.stringify(body);
            this.log("Server did not response with an authentication token. Response was [%s]", response);
            callback();
            return;
        }

        this.log('Authentication token received [%s]', body.at);
        this.authenticationToken = body.at;
        this.config.authenticationToken = body.at;
        this.webClient = request.createClient('https://' + this.config['apiHost']);
        this.webClient.headers['Authorization'] = 'Bearer ' + body.at;

        this.getWebSocketHost(function () {
            callback(body.at);
        }.bind(this));
    }.bind(this));
};

eWeLink.prototype.getRegion = function (countryCode, callback) {
    var data = {};
    data.country_code = countryCode;
    data.version = '6';
    data.ts = '' + Math.floor(new Date().getTime() / 1000);
    data.nonce = '' + nonce();
    data.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
    data.imei = this.config.imei;
    data.os = 'iOS';
    data.model = 'iPhone10,6';
    data.romVersion = '11.1.2';
    data.appVersion = '3.5.3';

    let query = querystring.stringify(data);
    this.log('getRegion query: %s', query);

    let dataToSign = [];
    Object.keys(data).forEach(function (key) {
        dataToSign.push({key: key, value: data[key]});
    });
    dataToSign.sort(function (a, b) {
        return a.key < b.key ? -1 : 1;
    });
    dataToSign = dataToSign.map(function (kv) {
        return kv.key + "=" + kv.value;
    }).join('&');

    let sign = this.getSignature(dataToSign);
    this.log('getRegion signature: %s', sign);

    let webClient = request.createClient('https://api.coolkit.cc:8080');
    webClient.headers['Authorization'] = 'Sign ' + sign;
    webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
    webClient.get('/api/user/region?' + query, function (err, res, body) {
        if (err) {
            this.log("An error was encountered while getting region. Error was [%s]", err);
            callback();
            return;
        }

        if (!body.region) {
            let response = JSON.stringify(body);
            this.log("Server did not response with a region. Response was [%s]", response);
            callback();
            return;
        }

        let idx = this.config.apiHost.indexOf('-');
        if (idx == -1) {
            this.log("Received region [%s]. However we cannot construct the new API host url.", body.region);
            callback();
            return;
        }
        let newApiHost = body.region + this.config.apiHost.substring(idx);
        if (this.config.apiHost != newApiHost) {
            this.log("Received region [%s], updating API host to [%s].", body.region, newApiHost);
            this.config.apiHost = newApiHost;
        }
        callback(body.region);
    }.bind(this));
};

eWeLink.prototype.getWebSocketHost = function (callback) {
    var data = {};
    data.accept = 'mqtt,ws';
    data.version = '6';
    data.ts = '' + Math.floor(new Date().getTime() / 1000);
    data.nonce = '' + nonce();
    data.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
    data.imei = this.config.imei;
    data.os = 'iOS';
    data.model = 'iPhone10,6';
    data.romVersion = '11.1.2';
    data.appVersion = '3.5.3';

    let webClient = request.createClient('https://' + this.config.apiHost.replace('-api', '-disp'));
    webClient.headers['Authorization'] = 'Bearer ' + this.authenticationToken;
    webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
    webClient.post('/dispatch/app', data, function (err, res, body) {
        if (err) {
            this.log("An error was encountered while getting websocket host. Error was [%s]", err);
            callback();
            return;
        }

        if (!body.domain) {
            let response = JSON.stringify(body);
            this.log("Server did not response with a websocket host. Response was [%s]", response);
            callback();
            return;
        }

        this.log('WebSocket host received [%s]', body.domain);
        this.config['webSocketApi'] = body.domain;
        if (this.wsc) {
            this.wsc.url = 'wss://' + body.domain + ':8080/api/ws';
        }
        callback(body.domain);
    }.bind(this));
};

eWeLink.prototype.relogin = function (callback) {
    let platform = this;
    platform.login(function () {
        // Reconnect websocket
        if (platform.isSocketOpen) {
            platform.wsc.instance.terminate();
            platform.wsc.onclose();
            platform.wsc.reconnect();
        }
        callback && callback();
    });
};

eWeLink.prototype.getDeviceTypeByUiid = function (uiid) {
    const MAPPING = {
        1: "SOCKET",
        2: "SOCKET_2",
        3: "SOCKET_3",
        4: "SOCKET_4",
        5: "SOCKET_POWER",
        6: "SWITCH",
        7: "SWITCH_2",
        8: "SWITCH_3",
        9: "SWITCH_4",
        10: "OSPF",
        11: "CURTAIN",
        12: "EW-RE",
        13: "FIREPLACE",
        14: "SWITCH_CHANGE",
        15: "THERMOSTAT",
        16: "COLD_WARM_LED",
        17: "THREE_GEAR_FAN",
        18: "SENSORS_CENTER",
        19: "HUMIDIFIER",
        22: "RGB_BALL_LIGHT",
        23: "NEST_THERMOSTAT",
        24: "GSM_SOCKET",
        25: "AROMATHERAPY",
        26: "BJ_THERMOSTAT",
        27: "GSM_UNLIMIT_SOCKET",
        28: "RF_BRIDGE",
        29: "GSM_SOCKET_2",
        30: "GSM_SOCKET_3",
        31: "GSM_SOCKET_4",
        32: "POWER_DETECTION_SOCKET",
        33: "LIGHT_BELT",
        34: "FAN_LIGHT",
        35: "EZVIZ_CAMERA",
        36: "SINGLE_CHANNEL_DIMMER_SWITCH",
        38: "HOME_KIT_BRIDGE",
        40: "FUJIN_OPS",
        41: "CUN_YOU_DOOR",
        42: "SMART_BEDSIDE_AND_NEW_RGB_BALL_LIGHT",
        43: "",
        44: "",
        45: "DOWN_CEILING_LIGHT",
        46: "AIR_CLEANER",
        49: "MACHINE_BED",
        51: "COLD_WARM_DESK_LIGHT",
        52: "DOUBLE_COLOR_DEMO_LIGHT",
        53: "ELECTRIC_FAN_WITH_LAMP",
        55: "SWEEPING_ROBOT",
        56: "RGB_BALL_LIGHT_4",
        57: "MONOCHROMATIC_BALL_LIGHT",
        59: "MEARICAMERA",
        1001: "BLADELESS_FAN",
        1002: "NEW_HUMIDIFIER",
        1003: "WARM_AIR_BLOWER"
    };
    return MAPPING[uiid] || "";
};

eWeLink.prototype.getDeviceChannelCountByType = function (deviceType) {
    const DEVICE_CHANNEL_LENGTH = {
        SOCKET: 1,
        SWITCH_CHANGE: 1,
        GSM_UNLIMIT_SOCKET: 1,
        SWITCH: 1,
        THERMOSTAT: 1,
        SOCKET_POWER: 1,
        GSM_SOCKET: 1,
        POWER_DETECTION_SOCKET: 1,
        SOCKET_2: 2,
        GSM_SOCKET_2: 2,
        SWITCH_2: 2,
        SOCKET_3: 3,
        GSM_SOCKET_3: 3,
        SWITCH_3: 3,
        SOCKET_4: 4,
        GSM_SOCKET_4: 4,
        SWITCH_4: 4,
        CUN_YOU_DOOR: 4,
        FAN_LIGHT: 4
    };
    return DEVICE_CHANNEL_LENGTH[deviceType] || 0;
};

eWeLink.prototype.getDeviceChannelCount = function (device) {
    let deviceType = this.getDeviceTypeByUiid(device.uiid);
    this.log('Device type for %s is %s', device.uiid, deviceType);
    let channels = this.getDeviceChannelCountByType(deviceType);
    return channels;
};

//create arguments for later get request
eWeLink.prototype.getArguments = function () {
    let args = {};
    args.lang = 'en';
    args.apiKey = this.apiKey;
    args.getTags = '1';
    args.version = '6';
    args.ts = '' + Math.floor(new Date().getTime() / 1000);
    args.nounce = '' + nonce();
    args.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
    args.imei = this.config.imei;
    args.os = 'iOS';
    args.model = 'iPhone10,6';
    args.romVersion = '11.1.2';
    args.appVersion = '3.5.3';
    return querystring.stringify(args);
};

/* WEB SOCKET STUFF */

function WebSocketClient() {
    this.number = 0; // Message number
    this.autoReconnectInterval = 5 * 1000; // ms
    this.pendingReconnect = false;
}

WebSocketClient.prototype.open = function (url) {
    this.url = url;
    this.instance = new WebSocket(this.url);
    this.instance.on('open', () => {
        this.onopen();
    });

    this.instance.on('message', (data, flags) => {
        this.number++;
        this.onmessage(data, flags, this.number);
    });

    this.instance.on('close', (e) => {
        switch (e) {
            case 1000: // CLOSE_NORMAL
                // console.log("WebSocket: closed");
                break;
            default: // Abnormal closure
                this.reconnect(e);
                break;
        }
        this.onclose(e);
    });
    this.instance.on('error', (e) => {
        switch (e.code) {
            case 'ECONNREFUSED':
                this.reconnect(e);
                break;
            default:
                this.onerror(e);
                break;
        }
    });
};
WebSocketClient.prototype.send = function (data, option) {
    try {
        this.instance.send(data, option);
    } catch (e) {
        this.instance.emit('error', e);
    }
};
WebSocketClient.prototype.reconnect = function (e) {
    // console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`, e);

    if (this.pendingReconnect) return;
    this.pendingReconnect = true;

    this.instance.removeAllListeners();

    let platform = this;
    setTimeout(function () {
        platform.pendingReconnect = false;
        console.log("WebSocketClient: reconnecting...");
        platform.open(platform.url);
    }, this.autoReconnectInterval);
};
WebSocketClient.prototype.onopen = function (e) {
    // console.log("WebSocketClient: open", arguments);
};
WebSocketClient.prototype.onmessage = function (data, flags, number) {
    // console.log("WebSocketClient: message", arguments);
};
WebSocketClient.prototype.onerror = function (e) {
    console.log("WebSocketClient: error", arguments);
};
WebSocketClient.prototype.onclose = function (e) {
    // console.log("WebSocketClient: closed", arguments);
};

//////////////
// Blind Stuff
//////////////

eWeLink.prototype.getBlindState = function (switches, accessory) {

    let platform = this;
    // platform.log("Switches: %s", switches);
    var switch0 = 0;
    if (switches[accessory.context.switchUp].switch === 'on') {
        switch0 = 1;
    }

    var switch1 = 0;
    if (switches[accessory.context.switchDown].switch === 'on') {
        switch1 = 1;
    }

    let sum = (switch0 * 2) + switch1;

    // this.log("Sum: ", sum);
    // [0,0] = 0 => 2 Stopped
    // [0,1] = 1 => 1 Moving down
    // [1,0] = 2 => 0 Moving up
    // [1,1] = 3 => Error

    const MAPPING = {
        0: 2,
        1: 1,
        2: 0,
        3: 3
    };
    // this.log("Sum: %s => Blind State: %s", sum, MAPPING[sum]);
    return MAPPING[sum];
};
eWeLink.prototype.getCurrentPosition = function (accessory, callback) {
    let platform = this;
    let lastPosition = accessory.context.lastPosition;
    if (lastPosition === undefined) {
        lastPosition = 0;
    }
    platform.log("[%s] getCurrentPosition: %s", accessory.displayName, lastPosition);
    callback(null, lastPosition);
};

eWeLink.prototype.getPositionState = function (accessory, callback) {
    let platform = this;

    if (!platform.webClient) {
        callback('platform.webClient not yet ready while obtaining power status for your device');
        accessory.reachable = false;
        return;
    }

    platform.log("Requesting power state for [%s]", accessory.displayName);

    this.webClient.get('/api/user/device?' + this.getArguments(), function (err, res, body) {

        if (err) {
            platform.log("An error was encountered while requesting a list of devices while interrogating current temperature. Verify your configuration options. Error was [%s]", err);
            return;
        } else if (!body) {
            platform.log("An error was encountered while requesting a list of devices while interrogating current temperature. Verify your configuration options. No data in response.", err);
            return;
        } else if (body.hasOwnProperty('error') && body.error != 0) {
            platform.log("An error was encountered while requesting a list of devices while interrogating current temperature. Verify your configuration options. Response was [%s]", JSON.stringify(body));
            callback('An error was encountered while requesting a list of devices to interrogate current temperature for your device');
            return;
        }

        body = body.devicelist;

        let size = Object.keys(body).length;
        if (body.length < 1) {
            callback('An error was encountered while requesting a list of devices to interrogate power status for your device');
            accessory.reachable = false;
            return;
        }
        let deviceId = accessory.context.deviceId;
        if (accessory.context.switches > 1) {
            deviceId = deviceId.replace("CH" + accessory.context.channel, "");
        }
        let filteredResponse = body.filter(device => (device.deviceid === deviceId));
        if (filteredResponse.length === 1) {
            let device = filteredResponse[0];
            if (device.deviceid === deviceId) {
                if (device.online !== true) {
                    accessory.reachable = false;
                    platform.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    callback('API reported that [%s] is not online', device.name);
                    return;
                }
                let switchesAmount = platform.getDeviceChannelCount(device);
                for (let i = 0; i !== switchesAmount; i++) {
                    if (device.params.switches[i].switch === 'on') {
                        accessory.reachable = true;
                        platform.log('API reported that [%s] CH %s is On', device.name, i);
                    }
                }
                let blindState = platform.getBlindState(device.params.switches, accessory);
                platform.log("[%s] Requested CurrentPositionState: %s", accessory.displayName, blindState);
                // Handling error;
                if (blindState > 2) {
                    blindState = 2;
                    accessory.context.currentPositionState = 2;
                    platform.setFinalBlindsState(accessory);
                    platform.log("[%s] Error! Stopping!", accessory.displayName);
                }
                callback(null, blindState);
            }
        } else if (filteredResponse.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            platform.log("ERROR: The response contained more than one device with Device ID [%s]. Filtered response follows.", device.deviceid);
            platform.log(filteredResponse);
            callback("The response contained more than one device with Device ID " + device.deviceid);

        } else if (filteredResponse.length < 1) {
            // The device is no longer registered
            platform.log("Device [%s] did not exist in the response. It will be removed", accessory.displayName);
            platform.removeAccessory(accessory);
        }
    });
};

eWeLink.prototype.getTargetPosition = function (accessory, callback) {
    let platform = this;
    let currentTargetPosition = accessory.context.currentTargetPosition;
    platform.log("[%s] getTargetPosition: %s", accessory.displayName, currentTargetPosition);
    callback(null, currentTargetPosition);
};

eWeLink.prototype.setTargetPosition = function (accessory, pos, callback) {

    let platform = this;
    platform.log("[%s] Setting new target position to %s, was: %s", accessory.displayName, pos, accessory.context.currentTargetPosition);

    let timestamp = Date.now();

    if (accessory.context.currentPositionState != 2) {

        var diffPosition = Math.abs(pos - accessory.context.currentTargetPosition);
        var actualPosition;
        var diffTime;
        var diff;

        if (diffPosition == 0) {
            actualPosition = pos;
            diffTime = 0;
            diff = 0;
        } else {
            if (accessory.context.currentPositionState == 1) {
                diffPosition = accessory.context.currentTargetPosition - pos;
                diffTime = Math.round(accessory.context.percentDurationDown * diffPosition);
            } else {
                diffPosition = pos - accessory.context.currentTargetPosition;
                diffTime = Math.round(accessory.context.percentDurationUp * diffPosition);
            }
            diff = (accessory.context.targetTimestamp - timestamp) + diffTime;
            actualPosition = platform.actualPosition(accessory);

            // platform.log("diffPosition:", diffPosition);
            // platform.log("diffTime:", diffTime);
            // platform.log("actualPosition:", actualPosition);
            // platform.log("diff:", diff);

            if (diff > 0) {
                accessory.context.targetTimestamp += diffTime;
                if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
                accessory.context.currentTargetPosition = pos;
                platform.log("[%s] Blinds are moving. Current position: %s, new targuet: %s, adjusting target milliseconds: %s", accessory.displayName, actualPosition, pos, diffTime);
                callback();
                return false;
            }
            if (diff < 0) {
                platform.log("[%s] ==> Revert Blinds moving. Current pos: %s, new targuet: %s, new duration: %s", accessory.displayName, actualPosition, pos, Math.abs(diff));
                accessory.context.startTimestamp = timestamp;
                accessory.context.targetTimestamp = timestamp + Math.abs(diff);
                if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
                accessory.context.lastPosition = actualPosition;
                accessory.context.currentTargetPosition = pos;
                accessory.context.currentPositionState = accessory.context.currentPositionState == 0 ? 1 : 0;

                let payload = platform.prepareBlindSwitchesPayload(accessory);
                let string = JSON.stringify(payload);

                if (platform.isSocketOpen) {
                    platform.sendWebSocketMessage(string, function(){return;});
                    platform.log("[%s] Request sent for %s", accessory.displayName, accessory.context.currentPositionState == 1 ? "moving up" : "moving down");
                    let service = accessory.getService(Service.WindowCovering);
                    service.getCharacteristic(Characteristic.CurrentPosition).updateValue(accessory.context.lastPosition);
                    service.getCharacteristic(Characteristic.TargetPosition).updateValue(accessory.context.currentTargetPosition);
                    service.getCharacteristic(Characteristic.PositionState).updateValue(accessory.context.currentPositionState);
                } else {
                    platform.log('Socket was closed. It will reconnect automatically; please retry your command');
                    callback('Socket was closed. It will reconnect automatically; please retry your command');
                    return false;
                }
            }
            callback();
            return false;
        }
        callback();
        return false;
    }

    if (accessory.context.lastPosition == pos) {
        platform.log("[%s] Current position already matches target position. There is nothing to do.", accessory.displayName);
        callback();
        return true;
    }

    accessory.context.currentTargetPosition = pos;
    moveUp = (pos > accessory.context.lastPosition);

    var withoutmarginetimeUP;
    var withoutmarginetimeDOWN;
    var duration;
    withoutmarginetimeUP = accessory.context.durationUp - accessory.context.durationBMU;
    withoutmarginetimeDOWN = accessory.context.durationDown - accessory.context.durationBMD;

    if (moveUp) {
        if (accessory.context.lastPosition == 0) {
            duration = ((pos - accessory.context.lastPosition) / 100 * withoutmarginetimeUP) + accessory.context.durationBMU;
        } else {
            duration = (pos - accessory.context.lastPosition) / 100 * withoutmarginetimeUP;
        }
    } else {
        if (pos == 0) {
            duration = ((accessory.context.lastPosition - pos) / 100 * withoutmarginetimeDOWN) + accessory.context.durationBMD;
        } else {
            duration = (accessory.context.lastPosition - pos) / 100 * withoutmarginetimeDOWN;
        }
    }
    if (pos==0 || pos==100) duration += accessory.context.fullOverdrive;

    duration = Math.round(duration * 100) / 100;

    platform.log("[%s] %s, Duration: %s", accessory.displayName, moveUp ? "Moving up" : "Moving down", duration);

    accessory.context.startTimestamp = timestamp;
    accessory.context.targetTimestamp = timestamp + (duration * 1000);
    // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
    accessory.context.currentPositionState = (moveUp ? 0 : 1);
    accessory.getService(Service.WindowCovering).setCharacteristic(Characteristic.PositionState, (moveUp ? 0 : 1));

    let payload = platform.prepareBlindSwitchesPayload(accessory);
    let string = JSON.stringify(payload);

    if (platform.isSocketOpen) {

        setTimeout(function () {
            platform.sendWebSocketMessage(string, function(){return;});
            platform.log("[%s] Request sent for %s", accessory.displayName, moveUp ? "moving up" : "moving down");

            var interval = setInterval(function () {
                if (Date.now() >= accessory.context.targetTimestamp) {
                    platform.setFinalBlindsState(accessory);
                    clearInterval(interval);
                    return true;
                }
            }, 100);
            callback();
        }, 1);
    } else {
        platform.log('Socket was closed. It will reconnect automatically; please retry your command');
        callback('Socket was closed. It will reconnect automatically; please retry your command');
        return false;
    }
};

eWeLink.prototype.setFinalBlindsState = function (accessory) {

    let platform = this;
    accessory.context.currentPositionState = 2;
    let payload = platform.prepareBlindSwitchesPayload(accessory);
    let string = JSON.stringify(payload);

    if (platform.isSocketOpen) {

        setTimeout(function () {
            platform.sendWebSocketMessage(string, function(){return;});
            platform.log("[%s] Request sent to stop moving", accessory.displayName);
            accessory.context.currentPositionState = 2;

            let currentTargetPosition = accessory.context.currentTargetPosition;
            accessory.context.lastPosition = currentTargetPosition;
            let service = accessory.getService(Service.WindowCovering);
            // Using updateValue to avoid loop
            service.getCharacteristic(Characteristic.CurrentPosition).updateValue(currentTargetPosition);
            service.getCharacteristic(Characteristic.TargetPosition).updateValue(currentTargetPosition);
            service.setCharacteristic(Characteristic.PositionState, Characteristic.PositionState.STOPPED);

            platform.log("[%s] Successfully moved to target position: %s", accessory.displayName, currentTargetPosition);
            return true;
            // TODO Here we need to wait for the response to the socket
        }, 1);

    } else {
        platform.log('Socket was closed. It will reconnect automatically; please retry your command');
        return false;
    }
};

eWeLink.prototype.prepareBlindSwitchesPayload = function (accessory) {

    let platform = this;
    let payload = {};
    payload.action = 'update';
    payload.userAgent = 'app';
    payload.params = {};
    let deviceInformationFromWebApi = platform.devicesFromApi.get(accessory.context.deviceId);

    payload.params.switches = deviceInformationFromWebApi.params.switches;

    // [0,0] = 0 => 2 Stopped
    // [0,1] = 1 => 1 Moving down
    // [1,0] = 2 => 0 Moving up
    // [1,1] = 3 => should not happen...

    var switch0 = 'off';
    var switch1 = 'off';

    let state = accessory.context.currentPositionState;

    switch (state) {
        case 2:
            switch0 = 'off';
            switch1 = 'off';
            break;
        case 1:
            switch0 = 'off';
            switch1 = 'on';
            break;
        case 0:
            switch0 = 'on';
            switch1 = 'off';
            break;
        default:
            platform.log('[%s] PositionState type error !', accessory.displayName);
            break;
    }

    payload.params.switches[accessory.context.switchUp].switch = switch0;
    payload.params.switches[accessory.context.switchDown].switch = switch1;
    payload.apikey = '' + accessory.context.apiKey;
    payload.deviceid = '' + accessory.context.deviceId;
    payload.sequence = platform.getSequence();
    // platform.log("Payload genretad:", JSON.stringify(payload))
    return payload;
};

eWeLink.prototype.actualPosition = function (accessory) {
    let timestamp = Date.now();
    if (accessory.context.currentPositionState == 1) {
        return Math.round(accessory.context.lastPosition - ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationDown));
    } else if (accessory.context.currentPositionState == 0) {
        return Math.round(accessory.context.lastPosition + ((timestamp - accessory.context.startTimestamp) / accessory.context.percentDurationUp));
    } else {
        return accessory.context.lastPosition;
    }
};

eWeLink.prototype.initSwitchesConfig = function (accessory) {
    // This method is called from addAccessory() and checkIfDeviceIsAlreadyConfigured().
    // Don't called from configureAccessory() because we need to be connected to the socket.
    let platform = this;
    let payload = {};
    payload.action = 'update';
    payload.userAgent = 'app';
    payload.params = {
        "lock": 0,
        "zyx_clear_timers": false,
        "configure": [
            {"startup": "off", "outlet": 0},
            {"startup": "off", "outlet": 1},
            {"startup": "off", "outlet": 2},
            {"startup": "off", "outlet": 3}
        ],
        "pulses": [
            {"pulse": "off", "width": 1000, "outlet": 0},
            {"pulse": "off", "width": 1000, "outlet": 1},
            {"pulse": "off", "width": 1000, "outlet": 2},
            {"pulse": "off", "width": 1000, "outlet": 3}
        ],
        "switches": [
            {"switch": "off", "outlet": 0},
            {"switch": "off", "outlet": 1},
            {"switch": "off", "outlet": 2},
            {"switch": "off", "outlet": 3}
        ]
    };

    payload.apikey = '' + accessory.context.apiKey;
    payload.deviceid = '' + accessory.context.deviceId;
    payload.sequence = platform.getSequence();

    let string = JSON.stringify(payload);

    // Delaying execution to be sure Socket is open
    platform.log("[%s] Waiting 5 sec before sending init config request...", accessory.displayName);

    setTimeout(function () {
        if (platform.isSocketOpen) {

            setTimeout(function () {
                platform.wsc.send(string);
                platform.log("[%s] Request sent to configure switches", accessory.displayName);
                return true;
                // TODO Here we need to wait for the response to the socket
            }, 1);

        } else {
            platform.log("[%s] Socket was closed. Retrying is 5 sec...", accessory.displayName);
            setTimeout(function () {
                platform.initSwitchesConfig(accessory);
                platform.log("[%s] Request sent to configure switches", accessory.displayName);
                return false;
                // TODO Here we need to wait for the response to the socket
            }, 5000);
        }
    }, 5000);
};
