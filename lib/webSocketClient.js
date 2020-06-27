const crypto = require('crypto');
const WebSocket = require('ws');
const WebSocketAsPromised = require('websocket-as-promised');

module.exports = class WebSocketClient {

    /**
     * Create a new WebSocketClient
     * @param {*} log the logger instance to use for log messages
     * @param {*} config the plugin configuration
     */
    constructor(log, config) {

        this.log = log;
        this.config = config;

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
            packMessage: data => {
                this.log.debug('packMessage message: %o', data);
                return JSON.stringify(data);
            },
            unpackMessage: data => {
                this.log.debug('unpackMessage message: %o', data);
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

        // this.instance = new WebSocket(this.url);
        // this.instance.on('open', () => {
        this.instance.onOpen.addListener(() => {
            this.onopen();
        });
    
        // this.instance.on('message', (data, flags) => {
        this.instance.onSend.addListener(data => {
            this.number++;
            this.onmessage(data, this.number);
        });
    
        // this.instance.on('close', (e) => {
        this.instance.onClose.addListener(e => {
            switch (e) {
                case 1000: // CLOSE_NORMAL
                    // console.log("WebSocket: closed");
                    break;
                default: // Abnormal closure
                    this.reconnect(e);
                    break;
            }
            platform.log("WebSocket was closed. Reason [%s]", e);
            
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
            switch (e.code) {
                case 'ECONNREFUSED':
                    this.reconnect(e);
                    break;
                default:
                    this.onerror(e);
                    break;
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

        this.isSocketOpen = true;

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
        let time_stamp = new Date() / 1000;
        let sequence = Math.floor(time_stamp * 1000);
        return "" + sequence;
    }

    /**
     * Generate a nonce for sending with API requests. 
     * 
     * @returns the base64 encoded nonce.
     */
    nonce() {
        return crypto.randomBytes(16).toString('base64');
    }

}