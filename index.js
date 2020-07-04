/* jshint -W030, -W069, esversion: 6 */
let WebSocket = require('ws');
let http = require('http');
let url = require('url');
const querystring = require('querystring');
let request = require('request-json');

let ApiClient = require('./lib/api');

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
    this.devicesFromApi = new Map();

    /* Configure the API Client */
    platform.log("Initialising API");

    this.apiClient = new ApiClient(log, config);
    this.apiClient.init();

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

                platform.apiClient.listDevices()
                    .then(body => {
                        
                        let size = Object.keys(body).length;
                        platform.log("eWeLink HTTPS API reports that there are a total of [%s] devices registered", size);

                        if (size === 0) {
                            platform.log("As there were no devices were found, all devices have been removed from the platform's cache. Please regiester your devices using the eWeLink app and restart HomeBridge");
                            platform.api.unregisterPlatformAccessories("homebridge-eWeLink", "eWeLink", Array.from(platform.accessories.values()));
                            platform.accessories.clear();
                            return;
                        }

                        body.forEach((device) => {
                            // Skip Sonoff Bridge as it is not supported by this plugin
                            if (['RF_BRIDGE'].indexOf(platform.getDeviceTypeByUiid(device.uiid)) == -1) {
                                platform.devicesFromApi.set(device.deviceid, device);
                            }
                        });

                        // Now we compare the cached devices against the web list
                        platform.log("Evaluating if devices need to be removed...");

                        // If we have devices in our cache, check that they exist in the web response
                        if (platform.accessories.size > 0) {
                            platform.log("Verifying that all cached devices are still registered with the API. Devices that are no longer registered with the API will be removed.");
                            platform.accessories.forEach((value, deviceId, map) => {
                                platform.checkIfDeviceIsStillRegistered(platform, deviceId);
                            });
                        }

                        platform.log("Evaluating if new devices need to be added...");

                        // Now we compare the cached devices against the web list
                        // Go through the web response to make sure that all the devices that are in the response do exist in the accessories map
                        if (platform.devicesFromApi.size > 0) {
                            platform.devicesFromApi.forEach((value, deviceId, map) => {
                                platform.checkIfDeviceIsAlreadyConfigured(platform, deviceId);
                            });
                        }

                        /* Add a listener for device status updates which come in */
                        platform.apiClient.addDeviceStateListener(json => {

                            if (json.action === 'update') {

                                platform.log("Update message received for device [%s]", json.deviceid);

                                if (json.params && json.params.switch) {
                                    platform.updatePowerStateCharacteristic(json.deviceid, json.params.switch);
                                } else if (json.params && json.params.switches && Array.isArray(json.params.switches)) {
                                    if (platform.groups.has(json.deviceid)) {
                                        let group = platform.groups.get(json.deviceid);
                                        platform.log('---------------' + group);

                                        if (group.type === 'blind') {
                                            
                                            if (group.handle_api_changes) {
                                                platform.updateBlindStateCharacteristic(json.deviceid, json.params.switches);
                                            } else {
                                                platform.log('Setup to not respond to API. Device ID : [%s] will not be updated.', json.deviceid);
                                            }
                                        } else {
                                            platform.log('Group type error ! Device ID : [%s] will not be updated.', json.deviceid);
                                        }
                                    } else if (platform.devicesFromApi.has(json.deviceid) && 
                                            (platform.getDeviceTypeByUiid(platform.devicesFromApi.get(json.deviceid).uiid) === 'FAN_LIGHT' || 
                                                json.deviceid === platform.config.fakeFan)) {
                                        platform.updateFanLightCharacteristic(json.deviceid, json.params.switches[0].switch, platform.devicesFromApi.get(json.deviceid));
                                        platform.devicesFromApi.get(json.deviceid).params.switches = json.params.switches;
                                        platform.updateFanSpeedCharacteristic(json.deviceid, json.params.switches[1].switch, json.params.switches[2].switch, json.params.switches[3].switch, platform.devicesFromApi.get(json.deviceid));
                                    } else {
                                        json.params.switches.forEach(function (entry) {
                                            if (entry.outlet && entry.switch) {
                                                platform.updatePowerStateCharacteristic(json.deviceid + 'CH' + (entry.outlet + 1), entry.switch, platform.devicesFromApi.get(json.deviceid));
                                            }
                                        });
                                    }
                                }

                                if (json.params && (json.params.currentTemperature || json.params.currentHumidity)) {
                                    platform.updateCurrentTemperatureCharacteristic(json.deviceid, json.params);
                                }


                            } else if (json.action === 'sysmsg') {
                                /* System message, this is how we will be told about device online statuses */
                                platform.log('Updated status for device %s, online: %s', json.deviceid, json.params.online);

                                /* Update the reachable state */
                                let accessory = platform.accessories.get(json.deviceid);
                                if (accessory) {
                                    platform.log('Updating state for accessory %s to %s', accessory.displayName, json.params.online);
                                    accessory.reachable = json.params.online;
                                } else {
                                    platform.log('Could not find accessory for device id %s', json.deviceid);
                                }

                            }
                        });

                    }).catch(err => {
                        platform.log('Error getting device list: %s', err);
                    });
            }; // End afterLogin

            this.apiClient.login()
                .then(() => afterLogin())
                .catch(error => this.log('Failed to login: %s', error));

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
            accessory.context.fullOverdrive = group.full_overdrive || 0;
            accessory.context.percentDurationDown = (accessory.context.durationDown / 100) * 1000;
            accessory.context.percentDurationUp = (accessory.context.durationUp / 100) * 1000;
            accessory.context.handleApiChanges = group.handle_api_changes || true;
        }
    }
    if (accessory.getService(Service.Switch)) {

        accessory.getService(Service.Switch)
            .getCharacteristic(Characteristic.On)
            .on('set', function (value, callback) {
                /* Do a web call */
                platform.setPowerState(accessory, value, callback);
            })
            .on('get', function (callback) {
                /* Try the API */
                platform.getSwitchState(accessory, callback);
            });

    }
    if (accessory.getService(Service.Thermostat)) {
        service = accessory.getService(Service.Thermostat);

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', function (callback) {
                platform.getCurrentTemperature(accessory, callback);
            });
        service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('get', function (callback) {
                platform.getCurrentHumidity(accessory, callback);
            });
    }
    if (accessory.getService(Service.TemperatureSensor)) {
        accessory.getService(Service.TemperatureSensor)
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', function (callback) {
                platform.getCurrentTemperature(accessory, callback);
            });
    }
    if (accessory.getService(Service.HumiditySensor)) {
        accessory.getService(Service.HumiditySensor)
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('get', function (callback) {
                platform.getCurrentHumidity(accessory, callback);
            });
    }

    if (accessory.getService(Service.Fanv2)) {
        accessory.getService(Service.Fanv2).getCharacteristic(Characteristic.Active)
            .on("get", function (callback) {
                /*  A fan is like a multi-switch device that we only care about a specific switch for, 
                 * kind of like the micro. But in this case it looks like switch 0 is for the light, 
                 * and switch 1 for the fan. Switches 2 & 3 are used to control the speed. 
                 */
                platform.getSwitchState(accessory, callback, 1);
            });
            /* Don't need a set for this characteristic, we will update this when setting
             * the speed to zero */

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
                /*  A fan is like a multi-switch device that we only care about a specific switch for, 
                 * kind of like the micro. But in this case it looks like switch 0 is for the light, 
                 and switch 1 for the fan. Switches 2 & 3 are used to control the speed. 
                 */
                platform.getSwitchState(accessory, callback, 0);
            })
            .on("set", function (value, callback) {
                platform.setFanLightState(accessory, value, callback);
            });

    }

    /* Log the services this accessory has */
    this.log.debug('Services for accessory (configureAccessory) %s:', accessory.context.deviceId);
    accessory.services.forEach(singleService => this.log.debug(
        '%s has service %s', accessory.context.deviceId, singleService))
    
    /* Add the configured accessory */
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
        this.log("Found Accessory with Name : [%s], Manufacturer : [%s], Status : [%s], Is Online : [%s]", deviceName, device.productModel, status, device.online);
    } catch (e) {
        this.log("Problem accessory Accessory with Name : [%s], Manufacturer : [%s], Error : [%s], Is Online : [%s]", deviceName, device.productModel, e, device.online);
    }

    let switchesCount = this.getDeviceChannelCount(device);
    if (channel > switchesCount) {
        this.log("Can't add [%s], because device [%s] has only [%s] switches.", deviceName, device.productModel, switchesCount);
        return;
    }

    const accessory = new Accessory(deviceName, UUIDGen.generate((deviceId ? deviceId : device.deviceid).toString()));

    accessory.context.deviceId = deviceId ? deviceId : device.deviceid;
    accessory.context.switches = 1;
    accessory.context.channel = channel;

    accessory.reachable = device.online === 'true';

    if (services.fan) {
        var fan = accessory.addService(Service.Fanv2, device.name);
        var light = accessory.addService(Service.Lightbulb, device.name + ' Light');
        light.getCharacteristic(Characteristic.On)
            .on("get", function (callback) {
                /*  A fan is like a multi-switch device that we only care about a specific switch for, 
                 * kind of like the micro. But in this case it looks like switch 0 is for the light, 
                 and switch 1 for the fan. Switches 2 & 3 are used to control the speed. 
                 */
                platform.getSwitchState(accessory, callback, 0);
            })
            .on('set', function (value, callback) {
                platform.setFanLightState(accessory, value, callback);
            });


        fan.getCharacteristic(Characteristic.Active)
            .on("get", function (callback) {
                /*  A fan is like a multi-switch device that we only care about a specific switch for, 
                 * kind of like the micro. But in this case it looks like switch 0 is for the light, 
                 and switch 1 for the fan. Switches 2 & 3 are used to control the speed. 
                 */
                platform.getSwitchState(accessory, callback, 1);
            });
            /* Don't need a set for this characteristic, we will update this when setting
             * the speed to zero */

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
        accessory.context.fullOverdrive = services.group.full_overdrive || 0;
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
                /* Do a web call */
                platform.setPowerState(accessory, value, callback);
            })
            .on('get', function (callback) {
                /* Try the API */
                platform.getSwitchState(accessory, callback);
            });
    }
    if (services.thermostat) {
        let service = accessory.addService(Service.Thermostat, deviceName);

        service.getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', function (callback) {
                platform.getCurrentTemperature(accessory, callback);
            });
        service.getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('get', function (callback) {
                platform.getCurrentHumidity(accessory, callback);
            });
    }
    if (services.temperature) {
        accessory.addService(Service.TemperatureSensor, deviceName)
            .getCharacteristic(Characteristic.CurrentTemperature)
            .on('get', function (callback) {
                platform.getCurrentTemperature(accessory, callback);
            });
    }

    if (services.humidity) {
        accessory.addService(Service.HumiditySensor, deviceName)
            .getCharacteristic(Characteristic.CurrentRelativeHumidity)
            .on('get', function (callback) {
                platform.getCurrentHumidity(accessory, callback);
            });
    }

    accessory.on('identify', function (paired, callback) {
        platform.log(accessory.displayName, "Identify not supported");
	try {
            callback();
	} catch (e) { }
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

    this.log.debug('Services for accessory (addAccessory) %s:', accessory.context.deviceId);
    accessory.services.forEach(singleService => this.log.debug(
        '%s has service %s', accessory.context.deviceId, singleService))

    this.accessories.set(deviceId ? deviceId : device.deviceid, accessory);

    this.api.registerPlatformAccessories("homebridge-eWeLink",
        "eWeLink", [accessory]);

};

eWeLink.prototype.checkIfDeviceIsAlreadyConfigured = function (platform, deviceId) {

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
            } else if (deviceType === 'FAN_LIGHT' || deviceId === platform.config.fakeFan) {
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
            } else if (deviceToAdd.extra.extra.model === "PSF-BFB-GL" || 
                        deviceToAdd.deviceid === platform.config.fakeFan) {

                /* Device is a fan. The fakeFan option here allows the configuration for the plugin to define another 4 switch 
                 * device to be interpreted as a fan. In my testing case, a Sonoff USB Micro is used */
                
                services.fan = true;
                services.switch = false;
                platform.log('Device [%s], ID : [%s] will be added as a fan', deviceToAdd.name, deviceToAdd.deviceid);
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
};

eWeLink.prototype.checkIfDeviceIsStillRegistered = function(platform, deviceId) {

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

    // if (typeof accessory === 'undefined' && device) {
    //     platform.log("Adding accessory for deviceId [%s].", deviceId);
    //     platform.addAccessory(device, deviceId);
    //     accessory = platform.accessories.get(deviceId);
    // }

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

    let isOn = Characteristic.Active.INACTIVE;
    let speed = 0;

    let accessory = platform.accessories.get(deviceId);

    // if (typeof accessory === 'undefined' && device) {
    //     platform.log("Adding accessory for deviceId [%s].", deviceId);
    //     platform.addAccessory(device, deviceId);
    //     accessory = platform.accessories.get(deviceId);
    // }

    if (!accessory) {
        platform.log("Error updating non-exist accessory with deviceId [%s].", deviceId);
        return;
    }

    if (state1 === 'on' && state2 === 'off' && state3 === 'off') {
        isOn = Characteristic.Active.ACTIVE;
        speed = 33.0;
    } else if (state1 === 'on' && state2 === 'on' && state3 === 'off') {
        isOn = Characteristic.Active.ACTIVE;
        speed = 66.0;
    } else if (state1 === 'on' && state2 === 'off' && state3 === 'on') {
        isOn = Characteristic.Active.ACTIVE;
        speed = 100.0;
    }

    platform.log("Updating recorded Characteristic.On for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, isOn);
    platform.log("Updating recorded Characteristic.RotationSpeed for [%s] to [%s]. No request will be sent to the device.", accessory.displayName, speed);

    accessory.getService(Service.Fanv2)
        .setCharacteristic(Characteristic.Active, isOn);

    accessory.getService(Service.Fanv2)
        .setCharacteristic(Characteristic.RotationSpeed, speed);
};

/**
 * Method to process a device switch state response. 
 * 
 * @param accesory the accessory the power state request was made for
 * @param deviceState the device state that was returned by the API. The "params" and "deviceid" fields are 
 *                      consistent in the two responses. Other fields may vary or be missing. 
 * @param callback the callback function to be called when the state is processed. This takes two arguments, 
 *                 the error message and the value. 
 * @param switchNumber optional parameter for specifying a specific switch number to use. If this is not 
 *                      specified, the default behaviour of looking for switch number information from the 
 *                      context will be used. 
 */
eWeLink.prototype.processSwitchState = function(accessory, deviceState, callback, switchNumber) {

    if (switchNumber || accessory.context.switches > 1) {

        if (switchNumber === undefined) {
            /* Set the switch number to the index based on the accessory */
            switchNumber = accessory.context.channel - 1;
        }

        if (deviceState.params.switches[switchNumber].switch === 'on') {
            accessory.reachable = true;
            this.log('API reported that [%s] CH %s is On', accessory.displayName, switchNumber + 1);
            callback(null, 1);
            return;
        } else if (deviceState.params.switches[switchNumber].switch === 'off') {
            accessory.reachable = true;
            this.log('API reported that [%s] CH %s is Off', accessory.displayName, switchNumber + 1);
            callback(null, 0);
            return;
        } else {
            accessory.reachable = false;
            this.log('API reported an unknown status for device [%s](%s)', accessory.displayName, accessory.context.deviceId);
            callback('API returned an unknown status for device ' + accessory.displayName);
            return;
        }

    } else {
        if (deviceState.params.switch === 'on') {
            accessory.reachable = true;
            this.log('API reported that [%s] is On', accessory.displayName);
            callback(null, 1);
            return;
        } else if (deviceState.params.switch === 'off') {
            accessory.reachable = true;
            this.log('API reported that [%s] is Off', accessory.displayName);
            callback(null, 0);
            return;
        } else {
            accessory.reachable = false;
            this.log('API reported an unknown status for device [%s](%s)', accessory.displayName, accessory.context.deviceId);
            callback('API returned an unknown status for device ' + accessory.displayName);
            return;
        }

    }

}

/**
 * Method to get the state of a device switch. 
 * 
 * @param accesory the accessory the power state request was made for
 * @param callback the callback function to be called when the state is processed. This takes two arguments, 
 *                 the error message and the value. 
 * @param switchNumber optional parameter for specifying a specific switch number to use. If this is not 
 *                      specified, the default behaviour of looking for switch number information from the 
 *                      context will be used. 
 */
eWeLink.prototype.getSwitchState = function (accessory, callback, switchNumber) {

    this.apiClient.getDeviceStatus(accessory)
        .then(device => this.processSwitchState(accessory, device, callback, switchNumber))
        .catch(err => {
            //TODO: CONSIDER
            accessory.reachable = false;
            callback(err);
        });
}

eWeLink.prototype.getFanSpeed = function (accessory, callback) {
    let platform = this;

    platform.log("Requesting fan state for [%s]", accessory.displayName);

    this.apiClient.getDeviceStatus(accessory)
        .then(device => {

            let fanSpeed;
            if (device.params.switches[1].switch === 'off') {
                /* Fan isn't spinning */
                fanSpeed = 0;
            } else {

                /* Switch 1 is on, depending on what other switches are on we can work out the 
                 * speed. */
                if (device.params.switches[2].switch === 'off' && device.params.switches[3].switch === 'off') {
                    fanSpeed = 33;
                } else if (device.params.switches[2].switch === 'on' && device.params.switches[3].switch === 'off') {
                    fanSpeed = 66;
                } else if (device.params.switches[2].switch === 'off' && device.params.switches[3].switch === 'on') {
                    fanSpeed = 100;
                }
            } 

            accessory.reachable = true;
            platform.log('API reported that fan speed %s is %d', accessory.displayName, fanSpeed);
            callback(null, fanSpeed);
        }).catch(err => {
            //TODO: CONSIDER
            accessory.reachable = false;
            platform.log('Error getFanSpeed: %s', err);
            callback('Failed to load device status: ' + err)
        });
       
}

//TODO: This needs tested by someone with this type of device
eWeLink.prototype.getCurrentTemperature = function (accessory, callback) {
    let platform = this;

    platform.log("Requesting current temperature for [%s]", accessory.displayName);

    let deviceId = accessory.context.deviceId;

    platform.apiClient.getDeviceStatus(deviceId)
        .then(device => {

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

        }).catch(err => {
            //TODO: CONSIDER
            accessory.reachable = false;
            callback('Failed to get device status: ' + err)
        });

}

eWeLink.prototype.getCurrentHumidity = function (accessory, callback) {
    let platform = this;

    platform.log("Requesting current humidity for [%s]", accessory.displayName);

    let deviceId = accessory.context.deviceId;

    this.apiClient.getDeviceStatus(deviceId)
        .then(device => {

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
        }).catch(err => {
            //TODO: CONSIDER
            accessory.reachable = false;
            callback('Failed to get device state: ' + err)
        });

};

eWeLink.prototype.setPowerState = function (accessory, isOn, callback) {
    let platform = this;

    let deviceId = accessory.context.deviceId;

    let targetState = 'off';

    if (isOn) {
        targetState = 'on';
    }

    platform.log("Setting power state to [%s] for device [%s]", targetState, accessory.displayName);

    let payload = {};
    payload.params = {};
    if (accessory.context.switches > 1) {
        deviceId = deviceId.replace("CH" + accessory.context.channel, "");
        let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
        payload.params.switches = deviceInformationFromWebApi.params.switches;
        payload.params.switches[accessory.context.channel - 1].switch = targetState;
    } else {
        payload.params.switch = targetState;
    }

    platform.apiClient.updateDeviceStatus(accessory, payload.params)
        .then(result => {
            platform.log('setPowerState result: %o', result);
            callback(null, isOn);
        }).catch(err => {
            platform.log('setPowerState error: %o', err);
            callback(err);
        });
};


eWeLink.prototype.setFanLightState = function (accessory, isOn, callback) {

    let platform = this;
    let deviceId = accessory.context.deviceId;

    let targetState = 'off';

    if (isOn) {
        targetState = 'on';
    }

    platform.log("Setting light state to [%s] for device [%s]", targetState, accessory.displayName);

    let payload = {};
    payload.params = {};
    let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
    payload.params.switches = deviceInformationFromWebApi.params.switches;
    payload.params.switches[0].switch = targetState;

    platform.apiClient.updateDeviceStatus(accessory, payload.params)
        .then(result => {
            platform.log('setFanLightState result: %o', result);
            callback(null, isOn);
        }).catch(err => {
            platform.log('setFanLightState error: %o', err);
            callback(err);
        });


};

eWeLink.prototype.setFanSpeed = function (accessory, value, callback) {

    let platform = this;
    let deviceId = accessory.context.deviceId;

    platform.log("Setting fan speed to [%s] for device [%s]", value, accessory.displayName);

    let payload = {};
    payload.params = {};
    let deviceInformationFromWebApi = platform.devicesFromApi.get(deviceId);
    payload.params.switches = deviceInformationFromWebApi.params.switches;

    /* This type of device uses switches to handle differnt notches of speed. 
     * Store the rounded value so we can call the callback */
    let setValue;
    if (value < 33) {
        payload.params.switches[1].switch = 'off';
        payload.params.switches[2].switch = 'off';
        payload.params.switches[3].switch = 'off';

        setValue = 0;
    } else if (value >=33 && value < 66) {
        payload.params.switches[1].switch = 'on';
        payload.params.switches[2].switch = 'off';
        payload.params.switches[3].switch = 'off';

        setValue = 33;
    } else if (value >=66 && value < 99) {
        payload.params.switches[1].switch = 'on';
        payload.params.switches[2].switch = 'on';
        payload.params.switches[3].switch = 'off';

        setValue = 66;
    } else if (value >= 99) {
        payload.params.switches[1].switch = 'on';
        payload.params.switches[2].switch = 'off';
        payload.params.switches[3].switch = 'on';

        setValue = 100;
    }

    platform.apiClient.updateDeviceStatus(accessory, payload.params)
        .then(result => {
            platform.log('setFanSpeed result: %o', result);

            /* Update the active characteristic too */
            platform.log('Setting acive state: %s', 
                (payload.params.switches[1].switch === 'on') ? 
                    Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);
            accessory.getService(Service.Fanv2)
                .setCharacteristic(Characteristic.Active, 
                    (payload.params.switches[1].switch === 'on') ? 
                        Characteristic.Active.ACTIVE : Characteristic.Active.INACTIVE);

            /* callback with the speed we set */
            callback(null, setValue);
        }).catch(err => {
            platform.log('setFanSpeed error: %o', err);
            callback(err);
        });
};

// Sample function to show how developer can remove accessory dynamically from outside event
eWeLink.prototype.removeAccessory = function (accessory) {

    this.log('Removing accessory [%s]', accessory.displayName);

    this.accessories.delete(accessory.context.deviceId);

    this.api.unregisterPlatformAccessories('homebridge-eWeLink',
        'eWeLink', [accessory]);
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
        77: "MICRO",
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
        MICRO: 4,
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

//////////////
// Blind Stuff
//////////////

eWeLink.prototype.getBlindState = function (switches, accessory) {

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

    platform.log("Requesting power state for [%s]", accessory.displayName);

    let deviceId = accessory.context.deviceId;
    if (accessory.context.switches > 1) {
        deviceId = deviceId.replace("CH" + accessory.context.channel, "");
    }

    this.apiClient.getDeviceStatus(deviceId)
        .then(device => {

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
        }).catch(err => {
            //TODO: CONSIDER
            accessory.reachable = false;
            callback('Failed to get device state: ' + err);
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
                // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
                accessory.context.currentTargetPosition = pos;
                platform.log("[%s] Blinds are moving. Current position: %s, new targuet: %s, adjusting target milliseconds: %s", accessory.displayName, actualPosition, pos, diffTime);
                callback();
                return false;
            }
            if (diff < 0) {
                platform.log("[%s] ==> Revert Blinds moving. Current pos: %s, new targuet: %s, new duration: %s", accessory.displayName, actualPosition, pos, Math.abs(diff));
                accessory.context.startTimestamp = timestamp;
                accessory.context.targetTimestamp = timestamp + Math.abs(diff);
                // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
                accessory.context.lastPosition = actualPosition;
                accessory.context.currentTargetPosition = pos;
                accessory.context.currentPositionState = accessory.context.currentPositionState == 0 ? 1 : 0;

                let payload = platform.prepareBlindSwitchesPayload(accessory);

                platform.apiClient.updateDeviceStatus(accessory, payload.params)
                platform.log("[%s] Request sent for %s", accessory.displayName, accessory.context.currentPositionState == 1 ? "moving up" : "moving down");
                let service = accessory.getService(Service.WindowCovering);
                service.getCharacteristic(Characteristic.CurrentPosition).updateValue(accessory.context.lastPosition);
                service.getCharacteristic(Characteristic.TargetPosition).updateValue(accessory.context.currentTargetPosition);
                service.getCharacteristic(Characteristic.PositionState).updateValue(accessory.context.currentPositionState);
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
    let moveUp = (pos > accessory.context.lastPosition);

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
		if (pos==0 || pos==100) platform.log("[%s] add overdive: %s", accessory.displayName, accessory.context.fullOverdrive);

    duration = Math.round(duration * 100) / 100;

    platform.log("[%s] %s, Duration: %s", accessory.displayName, moveUp ? "Moving up" : "Moving down", duration);

    accessory.context.startTimestamp = timestamp;
    accessory.context.targetTimestamp = timestamp + (duration * 1000);
    // if (pos==0 || pos==100) accessory.context.targetTimestamp += accessory.context.fullOverdrive;
    accessory.context.currentPositionState = (moveUp ? 0 : 1);
    accessory.getService(Service.WindowCovering).setCharacteristic(Characteristic.PositionState, (moveUp ? 0 : 1));

    let payload = platform.prepareBlindSwitchesPayload(accessory);

    setTimeout(function () {

        platform.apiClient.updateDeviceStatus(accessory, payload.params)
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
};

eWeLink.prototype.setFinalBlindsState = function (accessory) {

    let platform = this;
    accessory.context.currentPositionState = 2;
    let payload = platform.prepareBlindSwitchesPayload(accessory);

    setTimeout(function () {

        platform.apiClient.updateDeviceStatus(accessory, payload.params)
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
};

eWeLink.prototype.prepareBlindSwitchesPayload = function (accessory) {

    let platform = this;
    let payload = {};
    
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
    let payload = {
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

    // Delaying execution to be sure Socket is open
    platform.log("[%s] Waiting 5 sec before sending init config request...", accessory.displayName);
    setTimeout(() => {
        platform.apiClient.updateDeviceStatus(accessory.context.deviceId, payload);
    }, 5000);
};