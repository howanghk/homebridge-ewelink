const EventEmitter = require('events');

const EwelinkApi = require('./ewelinkApi');
const LanClient = require('./sonoffLanModeApi');
const WebSocketClient = require('./webSocketClient');

/**
 * Class that aims to be a single point of interaction between the platform and
 * APIs for getting and setting details about devices. 
 * 
 * This aims to act as an abstraction point so that the platform does not need to 
 * know if the LAN, HTTP or WebSockets APIs are being used. 
 */
module.exports = class ApiClient {

    /**
     * Create a new Api
     * @param {*} log the logger instance to use for log messages
     * @param {*} config the plugin configuration
     */
    constructor(log, config) {

        /* Set parameters to fields in this class */
        this.log = log;
        this.config = config;

        /* Configure the Ewelink API Client */
        log.debug("Initialising EwelinkApi");
        this.ewelinkApiClient = new EwelinkApi(log, config);
        this.ewelinkApiClient.addListener(() => {
            /* After a login event, if we have an existing websocket connection we need 
             * to close it and reconnect */
            if (this.wsc && this.wsc.isSocketOpen()) {
                this.wsc.instance.terminate();
                this.wsc.onclose();
                this.wsc.reconnect();
            }

            if (!this.wsc) {
                /* If the websocket client does not exist, load the host and 
                * initialise it 
                */
                this.ewelinkApiClient.getWebSocketHost()
                    .then((domain) => {
                        this.log.debug('WebSocket domain: %s', domain);
                        this._initWebSocketClient();
                    }).catch(() => {
                        this.log.error('Failed to load web socket host');
                    });
            }

            /* Pass on the login event to our listeners */
            this.eventEmitter.emit('login');
        });

        /* Configure the LAN client, if the feature is enabled  */
        if (config['experimentalLanClient']) {
            log.debug('Configuring LAN Client');
            this.lanClient = new LanClient(log);
            this.lanClient.start();
        }

        /* Add an event emmitter for login events */
        this.eventEmitter = new EventEmitter();

    }

    /**
     * Initialise the web socket client. 
     */
    _initWebSocketClient() {
        // We have our devices, now open a connection to the WebSocket API

        const url = 'wss://' + this.config['webSocketApi'] + ':8080/api/ws';
        this.log.info('Connecting to the WebSocket API at [%s]', url);

        this.wsc = new WebSocketClient(this.log, this.config);
        this.wsc.open(url);

        /* Configure listeners */
        this.wsc.onmessage = (message) => {

            // Heartbeat response can be safely ignored
            if (message == 'pong') {
                return;
            }

            this.log.debug('WebSocket messge received: %o', message);

            //TODO: Check IMPL

            if (message.action && (message.action === 'update' || message.action === 'sysmsg')) {
                /* Change in device state */
                this.eventEmitter.emit('state', message);
            }
        };
    }

    /**
     * Add a listener function to be called when a login event occurs
     * @param {function} funct the function to be called when events occur.
     */
    addLoginEventListener(funct) {
        this.eventEmitter.addListener('login', funct);
    }

    /**
     * Add a listener to be called when the state of a device changes. 
     * @param {function} funct the function to be called when events occur. 
     */
    addDeviceStateListener(funct) {
        this.eventEmitter.addListener('state', funct);
    }

    /**
     * Method to perform any additional configuration required before login can be performed. 
     * 
     * At present, this checks if there is a country code specified and resolves the correct 
     * region, updating the api host configuration. 
     */
    init() {

        return new Promise((resolve, reject) => {
            // Resolve region if countryCode is provided
            if (this.config['countryCode']) {

                this.ewelinkApiClient.getRegion()
                    .then(region => {

                        this.log.info('Region is: %s', region);

                        /* Update the API host */
                        let idx = this.config.apiHost.indexOf('-');
                        if (idx == -1) {
                            this.log.warning('Received region [%s]. However we cannot construct the new API host url.', region);

                        } else {
                            let newApiHost = region + this.config.apiHost.substring(idx);
                            if (this.config.apiHost != newApiHost) {
                                this.log.debug("Received region [%s], updating API host to [%s].", region, newApiHost);
                                this.config.apiHost = newApiHost;
                            }
                        }
                        resolve();

                    }).catch(err => {
                        this.log.error('Failed to get region: %s', err);
                        reject('Failed to get region information: ' + err);
                    })
            } else {
                resolve();
            }
        });
    }

    /**
     * Get the current status for an accessory device. 
     * @param {*} accessory 
     */
    async getDeviceStatus(accessory) {



        /* Extract out the deviceId */
        let deviceId = accessory.context.deviceId;

        if (accessory.context.switches > 1) {
            deviceId = deviceId.replace("CH" + accessory.context.channel, "");
        }

        let deviceStatus = undefined;

        if (this.config.experimentalLanClient && this.lanClient) {
            try {
                deviceStatus = await this.lanClient.getDeviceStatus(deviceId);

                //TODO: FINISH IMPLEMENTING
                // let localDevice = undefined;
                // if (accessory.context.lanClient && 
                //         accessory.context.lanClient.getLocalDevice) {
                //     /* Only get the local device state if there is a lan client and it
                //      * has the expected function. 
                //      * This latter check seems to be required when a device is partially
                //      * restored and homebridge tries to get the state before it is fully
                //      * set up. 
                //      */
                //     localDevice = accessory.context.lanClient.getLocalDevice();
                // }
                    
                // let status = undefined;
                // if (localDevice) {
                //     if (localDevice.data.type === 'plug') {
                //         status = accessory.context.lanClient.getSwitchStatus();
                //     } else if (localDevice.data.type === 'strip') {
                //         status = accessory.context.lanClient.getStripOutletStatus(
                //             accessory.context.channel);
                //     }
                // } 

            } catch (error) {
                //TODO: implement
                this.log.error('Error loading lan client: %s', error);
            }
        }

        if (deviceStatus === undefined) {
            if (this.config.experimentalWebSocketClient) {
                if (!(this.wsc && this.wsc.isSocketOpen && this.wsc.isSocketOpen())) {
                    accessory.reachable = false;
                    throw new Error('websocket not ready while obtaining status for your device');
                }

                deviceStatus = await this.wsc.getDeviceStatus(deviceId);
            } else {
                deviceStatus = await this.ewelinkApiClient.getDeviceStatus(deviceId);

                if (deviceStatus.online !== true) {
                    accessory.reachable = false;
                    this.log("Device [%s] was reported to be offline by the API", accessory.displayName);
                    throw new Error('API reported that [' + device.name + '] is not online');
                }
            }
        }

        return deviceStatus;

    }

    /**
     * Set the new status params for a device. 
     * @param {*} accessory the accessory to set the status for
     * @param {*} statusParams the new device status params
     */
    async updateDeviceStatus(accessory, statusParams) {

        /* Extract out the deviceId */
        let deviceId = accessory.context.deviceId;
        if (accessory.context.switches > 1) {
            deviceId = deviceId.replace("CH" + accessory.context.channel, "");
        }

        //TODO: Detect if we can update this type of device through the lan client also

        if (this.config.experimentalLanClient && this.lanClient) {
            //TODO: IMPLEMENT
            // let localDevice = undefined;
            //     if (accessory.context.lanClient && accessory.context.lanClient.getLocalDevice) {
            //         /* Try to get the local device state if a lan client exists */
            //         localDevice = accessory.context.lanClient.getLocalDevice();
            //     }
                
            //     if(localDevice && localDevice.data.type === 'plug') {
            //         /* We can do a local device call for this */
            //         accessory.context.lanClient.setSwitchStatus(
            //             accessory, value, callback);
            //     }
        } else {
            /* Websockets are the default option here, although there is an HTTP API 
             * too. */
            return this.wsc.updateDeviceStatus(deviceId, statusParams);
        }
    }

    /**
     * List the devices for the currently session. 
     * 
     * Currently this will only use the HTTP API. This information is not available via
     * web sockets, but could potentially also include devices that are in DIY mode via
     * the LAN client. 
     * (FUTURE ENHANCEMENT)
     * 
     * 
     * @returns a promise for the get request. The resolve result will be the device list 
     *          from the API. Any other error case will use the rejection call. 
     */
    listDevices() {

        /* TODO: Need to wrap this so we can peek at it before resolving, 
                 so we can set device keys in the lan client */

        return new Promise((resolve, reject) => {
            this.ewelinkApiClient.listDevices()
                .then(devices => {
                    /* Add the device keys to the lan client */
                    if (this.lanClient) {
                        devices.forEach(device => 
                            this.lanClient.addDeviceKey(device.deviceid, device.devicekey));
                    }

                    resolve(devices);
                }).catch(err => reject(err));
        });
    }

    /**
     * Login to the Ewelink API
     * 
     * @returns a promise. The resolve callback will be used when a valid 
     *          authentication token it returned by the API. The return type will be an 
     *          object with two fields, authenticationToken and apiKey. 
     *          The reject callback will be used for all error conditions. 
     */
    login() {
        return this.ewelinkApiClient.login();
    }
}