const crypto = require('crypto');
const WebSocket = require('ws');
const WebSocketAsPromised = require('websocket-as-promised');

/**
 * Class exposing methods to interact with Ewelink through their websocket API.
 * 
 * TODO:
 * - Rate limiting
 */
module.exports = class WebSocketClient {

    /**
     * Create a new WebSocketClient
     * @param {*} log the logger instance to use for log messages
     * @param {*} config the plugin configuration
     */
    constructor(log, config) {

        this.log = log;
        this.config = config;

        /* Map we will use as a cache to prevent spamming the websocket API.
         * The cache duration is in milliseconds. */
        this.deviceStatusMap = new Map();
        this.cacheDuration = 500;

        this.number = 0; // Message number
        this.autoReconnectInterval = 5 * 1000; // ms
        this.pendingReconnect = false;

        this.socketOpen = false;
    }

    isSocketOpen() {
        return this.socketOpen;
    }
    
    open(url) {
        this.url = url;

        this.instance = new WebSocketAsPromised(this.url, {
            /* Need to configure this to use the 'ws' module
             * for the websocket interaction
             */
            createWebSocket: socketUrl => new WebSocket(socketUrl),
            extractMessageData: event => event, // <- this is important
            /* API requests and responses use a "sequence" field we can use
             * attach the requestId to this field. 
             */
            attachRequestId: (data, requestId) => Object.assign({sequence: requestId}, data),
            extractRequestId: data => data && data.sequence,

            /* Need to specify how JSON is serialized */
            packMessage: data => JSON.stringify(data),
            unpackMessage: data => {
                this.log.debug('unpackMessage: %s', data);
                if (data === 'pong') {
                    /* Heartbeat response, just return as-is */
                    return data;
                } else {
                    /* Convert into an object */
                    return JSON.parse(data);
                }
            }
        });
        this.instance.open();

        this.instance.onOpen.addListener(() => {
            this.onopen();
        });
    
        this.instance.onUnpackedMessage.addListener(data => {
            this.number++;
            this.onmessage(data, this.number);
        });
    
        this.instance.onClose.addListener(e => {
            if (e === 1000) {
                // CLOSE_NORMAL
                // console.log("WebSocket: closed");
            } else {
                // Abnormal closure
                this.reconnect(e);
            }
            this.log("WebSocket was closed. Reason [%s]", e);
            
            /* Close the 'ping' timer */
            this.socketOpen = false;
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = null;
            }

            this.onclose(e);
        });
        // this.instance.on('error', (e) => {
        this.instance.onError.addListener(e => {
            if (e.code === 'ECONNREFUSED') {
                this.reconnect(e);
            } else {
                this.onerror(e);
            }
        });
    }

    send(data, option) {
        try {
            this.instance.send(data, option);
        } catch (e) {
            this.instance.emit('error', e);
        }
    }

    reconnect(e) {
        // console.log(`WebSocketClient: retry in ${this.autoReconnectInterval}ms`, e);
    
        if (this.pendingReconnect) return;
        this.pendingReconnect = true;
    
        this.instance.removeAllListeners();
    
        let platform = this;
        setTimeout(() => {
            platform.pendingReconnect = false;
            platform.log.info("WebSocketClient: reconnecting...");
            platform.open(platform.url);
        }, this.autoReconnectInterval);
    }

    onopen(e) {
        // console.log("WebSocketClient: open", arguments);

        this.socketOpen = true;

        // We need to authenticate upon opening the connection

        // Here's the eWeLink payload as discovered via Charles
        let payload = {};
        payload.action = "userOnline";
        payload.userAgent = 'app';
        payload.apkVesrion = "1.8";
        payload.at = this.config.authenticationToken;
        payload.apikey = this.config.apiKey;
        payload.sequence = this.getSequence();

        payload = this.populateCommonApiRequestFields(payload);

        let string = JSON.stringify(payload);

        this.log.debug('Sending login request [%s]', string);

        // this.send(string);
        this.instance.sendRequest(payload, {
            requestId: this.getSequence()
        }).then(response => {
            this.log.debug('Login websocket response: %o', response);

            /* There is some configuration values we should look at */
            if (response.config) {
                this.hbInterval = response.config.hbInterval;

                if (response.config.hb && response.config.hbInterval) {
                    /* Configure a 'ping' poll to keep alive the connection.
                     * API docs say to add 7 to this and use as the interval.
                    */
                    this.pingInterval = setInterval(() => {
                        this.instance.send('ping');
                    }, (response.config.hbInterval + 7) * 1000);
                }
            } 

        }).catch(err => {
            this.log.error('Login websocket request failed: %s', err);
        });

        
    }

    /**
     * Helper method to set the common values all implementations or BaseApiRequest are
     * expected to include before being sent with API requests. 
     * @param obj the object to populate the fields in
     * @returns the updated object. 
     */
    populateCommonApiRequestFields(obj) {

        obj.version = '6';
        obj.ts = '' + Math.floor(new Date().getTime() / 1000);
        obj.nonce = this.nonce();
        // obj.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
        // obj.imei = this.config.imei;
        obj.os = 'iOS';
        obj.model = 'iPhone10,6';
        obj.romVersion = '11.1.2';
        // obj.appVersion = '3.5.3';

        return obj;
    }

    onmessage(data, number) {
        // console.log("WebSocketClient: message", arguments);
    }

    onerror(e) {
        this.log.error("WebSocketClient: error", arguments);
    }

    onclose(e) {
        // console.log("WebSocketClient: closed", arguments);
    }


    /**
     * Get the next sequence number for a websocket request.
     * 
     * @returns the sequence number
     */
    getSequence() {
        // let time_stamp = new Date() / 1000;
        // let sequence = Math.floor(time_stamp * 1000);
        // return "" + sequence;
        return "" + Date.now();
    }

    /**
     * Generate a nonce for sending with API requests. 
     * 
     * @returns the base64 encoded nonce.
     */
    nonce() {
        return crypto.randomBytes(16).toString('base64');
    }

    async getDeviceStatus(deviceId) {

        let cachedDeviceStatus = this.deviceStatusMap.get(deviceId);

        if (cachedDeviceStatus) {
            this.log.debug('Returning cached status for device %s: %o', 
                deviceId, cachedDeviceStatus);
            
            return cachedDeviceStatus;
        } else {
            this.log.debug('Making request for status for device %s', 
                deviceId);

            let payload = {
                action: 'query',
                apikey: this.config.apiKey,
                deviceid: deviceId,
                userAgent: 'app',
                params: []
            };

            /* Extra undocumented params */
            payload.at = this.config.authenticationToken;
            payload = this.populateCommonApiRequestFields(payload);

            /* Introduce a small pause to prevent spamming the websocket */
            // await this.sleep(200);

            //TODO: Need to add something to stop multiple requests for the same device

            //TODO: Add storing details in the cache here
            return this.instance.sendRequest(payload, {
                requestId: this.getSequence()
            });//.then(result => {
            //     /* Add to the cache */
            //     this.deviceStatusMap.set(deviceId, result);

            //     /* Set a timer to remove the item from the cache */
            //     setInterval(() => {
            //         this.deviceStatusMap.delete(deviceId);
            //     }, this.cacheDuration);
            // });
        }
    }

    async updateDeviceStatus(deviceId, params) {

        /* Documentation says action value should be 'action:update', this is
         * incorrect, should just be 'update'
         */
        let payload = {
            action: 'update',
            apikey: this.config.apiKey,
            deviceid: deviceId,
            userAgent: 'app',
            params: params
        };

        /* Extra undocumented params */
        payload.at = this.config.authenticationToken;
        payload = this.populateCommonApiRequestFields(payload);

        return this.instance.sendRequest(payload, {
            requestId: this.getSequence()
        });

    }

    /**
     * Helper method that can be used to "wait" for a period of time. 
     * 
     * Callers can do something like this to introduce a 1s delay in their execution. 
     * "await sleep(1000);"
     * 
     * See: https://stackoverflow.com/a/41957152/230449
     * 
     * @param {number} ms the number of millseconds to sleep for. 
     * @returns a promise that will be resolved after the supplied duration has passed. 
     */
    sleep(ms) {
        return new Promise((resolve) => {
          setTimeout(resolve, ms);
        });
    } 

}