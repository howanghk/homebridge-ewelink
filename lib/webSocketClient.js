let WebSocket = require('ws');

module.exports = class WebSocketClient {

    /**
     * Create a new WebSocketClient
     * @param {*} log the logger instance to use for log messages
     */
    constructor(log) {

        this.log = log;

        this.number = 0; // Message number
        this.autoReconnectInterval = 5 * 1000; // ms
        this.pendingReconnect = false;
    }
    
    open(url) {
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
    }

    onmessage(data, flags, number) {
        // console.log("WebSocketClient: message", arguments);
    }

    onerror(e) {
        this.log.error("WebSocketClient: error", arguments);
    }

    onclose(e) {
        // console.log("WebSocketClient: closed", arguments);
    }

}