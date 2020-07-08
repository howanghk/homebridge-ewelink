const crypto = require('crypto');
const EventEmitter = require('events');
const mdns = require('multicast-dns')()
const request = require('request-json');

const Cache = require('./cache');



/**
 * Class for interacting with devices using the LAN API and 
 * multicast DNS. 
 * 
 * TODO: 
 * - Also needs a way to keep a handle on if a device supports LAN mode
 *   This is the current TODO
 * - Need some way of determining when a device goes away
 * 
 */
module.exports = class LanClient {



    /**
     * Create a new LanClient. 
     * @param {*} log the logger instance to use for log messages
     * @param {*} config the plugin configuration
     */
    constructor(log, config) {

        this.log = log;

        /**
         * Cache holding deviceId to an object holding the host & port 
         * for the device. 
         * 
         * This is set to cache, by default, to 3 minutes. 
         */
        this.deviceHostMap = new Cache(log, (180 * 1000));
        this.deviceHostMap.addCacheExpiryListener((deviceId) => {
            /* If we are told a device has been removed from the cache, 
             * send a notification that the device is offline.
             */

             const notification = {
                 action: 'sysmsg',
                 deviceid: deviceId,
                 params: {
                     online: false
                 }
             };

             this.eventEmitter.emit('state', notification);
        });

        /**
         * Cache for holding deviceId to an object holding 
         * the status information for a device. 
         * 
         * This is set to cache, by default, to 10 seconds
         */
        this.deviceStatusMap = new Cache(log, (10 * 1000));

        /**
         * Map of deviceId to their corresponding deviceKey.
         * This is required to allow decryption of DNS data to occur. 
         */
        this.deviceKeyMap = new Map();

        /* DNS timeout used when getting the status for a device (in milliseconds) */
        this.dnsTimeout = 3000;

        /* Parse the lan client configuration */
        this._parseConfig(config.experimentalLanClient);

        /* Add an event emmitter for events */
        this.eventEmitter = new EventEmitter();

        /* Startup the client background processes */
        setTimeout(() => this._start(), 10);

    }

    /**
     * The configuration for the LAN client can take two forms:
     * 1. a boolean true/false
     * 2. an object holding additional settings
     * 
     * We need to parse this configuration to set various configuration values. 
     * 
     * @param {*} config the lan client configuration to process. 
     */
    _parseConfig(config) {

        this.log.debug('Lan Client Configuration is a %s', typeof config);

        if ('object' === typeof config) {
            /* Is a configuration object, get some fields */
            this.logDnsResponses = (config.logDnsResponses === true);
        }
    }

    /**
     * Sends a DNS query to discover devices
     */
    _sendDnsQuery() {

        let questions = [
            {
                name: '_ewelink._tcp.local',
                type: 'SRV'
            }
        ];

        // Iterate through known devices and add them to the queries to get the SRV & A records
        const deviceIds = new Set(this.deviceHostMap.keys());

        this.log.debug('Device Key Map: %o', this.deviceKeyMap.keys());

        Array.from(this.deviceKeyMap.keys()).forEach(key => deviceIds.add(key));
        deviceIds.forEach(key => {
            const hostName = 'eWeLink_' + key + '.local';
            questions.push(
                {
                    name: hostName,
                    type: 'SRV'
                }
            );
            questions.push(
                {
                    name: hostName,
                    type: 'TXT'
                }
            );
        });
        
            

        mdns.query({
            questions: questions
        }, () => {
            if (this.logDnsResponses) {
                this.log.debug('Query sent for questions: %o', questions);
            }
        });
    }

    /**
     * Register internal listeners and make an initial query to attempt local discovery of the device. 
     */
    _start() {
        this.log.debug('Starting lan client');

        mdns.on('response', response => {
            /* Only want to process 'ewelink' responses */
            if (response.answers) {
                response.answers
                    .filter(value => value.name.startsWith('eWeLink_'))
                    .forEach(value => this.processDnsResponse(value, true));
            }
        });

        /* Send an initial DNS query, then repeat every 2 minutes (120 s) */
        this._sendDnsQuery();
        setInterval(() => this._sendDnsQuery(), (120 * 1000));
    }

    /**
     * Get a status object created from the caches. 
     * @param {string} deviceId the id of the device to get the status from
     * @param object holding the host and status if both are currently held 
     *               in the cache, otherwise undefined will be returned. 
     */
    _getCachedStatusForDevice(deviceId) {
        
        let status;
        
        /* Check if we have the details we need in the cache */
        let cachedDeviceStatus = this.deviceStatusMap.get(deviceId);
        let cachedDeviceHost = this.deviceHostMap.get(deviceId);

        if (cachedDeviceStatus && cachedDeviceHost) {
            /* Both values exist in the cache, build the object and return */
            status = {
                params: cachedDeviceStatus,
                host: cachedDeviceHost.host
            };

            this.log.debug('Returning cached item for device %s: %o', deviceId, status);
        } else {
            this.log.debug('Cache miss for device %s, cached items were: %s/%s', 
                deviceId, cachedDeviceStatus, cachedDeviceHost);
        }

        return status;
    }

    /**
     * Add a device key for a device to allow decryption to occur. 
     * @param {string} deviceId the id of the device. 
     * @param {string} deviceKey the key for the device. 
     */
    addDeviceKey(deviceId, deviceKey) {
        this.log.debug('Adding device key %s for device %s', deviceKey, deviceId);
        this.deviceKeyMap.set(deviceId, deviceKey);

        /* If a device key is being added, make another DNS query to update any
         * details we may have failed to decode */
        this._sendDnsQuery();
    }

    /**
     * Add a listener to be called when the state of a device changes. 
     * @param {function} funct the function to be called when events occur. 
     */
    addDeviceStateListener(funct) {
        this.eventEmitter.addListener('state', funct);
    }

    /**
     * Close internal listeners for DNS responses. 
     */
    close() {
        mdns.destroy();
    }

    /**
     * Process a single eWelink DNS response answer. 
     * 
     * @param {*} value the DNS response answer from the mdns client
     * @param {boolean} notify if true is supplied, this will trigger "sysmsg" device status events.
     * @returns the processed object
     */
    processDnsResponse(value, notify = false) {

        /* Get the deviceId from the device name */
        let deviceId = value.name.substr(8, 10);
        if (this.logDnsResponses) {
            this.log.debug('parsedDeviceId for name %s is %s. Record type %s', 
                value.name, deviceId, value.type);
        }


        let processedDeviceResponse;
        if (value.type === 'TXT') {
            /* TXT records contain the state for the device */

            if (this.logDnsResponses) {
                this.log.debug('DNS txt record for device %s is: %o',
                    deviceId, value);
            }

            processedDeviceResponse = Object.assign({}, value);

            let dataObject = {};

            value.data.forEach(dataValue => {
                // this.log.debug('Buffer string: %s', dataValue.toString('utf-8'))

                let bufferString = dataValue.toString('utf-8');
                let key = bufferString.substr(0, bufferString.indexOf('='));

                dataObject[key] = bufferString.substr(bufferString.indexOf('=') + 1);
            });

            processedDeviceResponse.data = dataObject;


            /* Turn this TXT record into something usable for the state */
            const stateData = this.extractDataFromDnsService(dataObject, 
                this.deviceKeyMap.get(dataObject.id));

            processedDeviceResponse.params = stateData;

            this.log.debug('State data for device %s is: %o', 
                deviceId, processedDeviceResponse.params);

            /* if we are to notify, check if we have a current status, and notify if it differs */
            if (notify) {
                const lastKnownState = this.deviceStatusMap.get(deviceId);

                if (!lastKnownState || lastKnownState !== stateData) {
                    this.log.debug('State has changed for device %s. Old state: %s, new state %s', 
                        deviceId, lastKnownState, stateData);

                    const notificationMessage = {
                        action: 'update',
                        deviceid: deviceId,
                        online: true,
                        params: stateData
                    };
                    notificationMessage.params.online = true;

                    this.log.debug('Notification message would be: %o', notificationMessage);
                    this.eventEmitter.emit('state', notificationMessage);
                }
            }

            /* Add to the cache */
            this.deviceStatusMap.set(deviceId, stateData);
        } else if (value.type === 'SRV') {
            /* A record contains the host details we need to invoke an API */
            if (this.logDnsResponses) {
                this.log.debug('DNS SRV answer: %o', value);
            }

            processedDeviceResponse = {
                host: {
                    host: value.data.target,
                    port: value.data.port
                },
                srv: value
            };

            this.log.debug('Host details for %s is: %o', deviceId, processedDeviceResponse);

            /* Add the host details to a cache */
            this.deviceHostMap.set(deviceId, processedDeviceResponse);
        } else if (this.logDnsResponses) {
            this.log.debug('Unhandled device DNS answer: %o', value);
        }

        return processedDeviceResponse;
    }

    /**
     * Get the status of a device. 
     * 
     * This comes from a combination of a few DNS responses.
     * 
     * @param {*} deviceId the id of the device to get the status for
     * @returns a promise. This will return the single device from the API call, 
     *          or throw an Error if it cannot be found. 
     */
    getDeviceStatus(deviceId) {

        return new Promise((resolve, reject) => {

            /* Check if we have the details we need in the cache */
            let status = this._getCachedStatusForDevice(deviceId);

            if (status) {
                /* Exists in the cache, return */
                this.log.debug('Returning cached result for device %s: %o', deviceId, status);

                resolve(status);

            } else {
                /* Need to lookup the information, but start the object with a host (if we have it cached) */
                this.log.debug('Looking up status for device %s', deviceId);
                status = {};

                let cachedDeviceHost = this.deviceHostMap.get(deviceId);
                if (cachedDeviceHost) {
                    status.host = cachedDeviceHost.host;
                }

                /* The device name that will be included in DNS responses, 
                 * we need to match the incoming reponses to this */
                const deviceName = 'eWeLink_' + deviceId + '._ewelink._tcp.local';
                this.log.debug('TEST LOG: %s', deviceName);

                /* Configure the MDNS client */
                const mdnsClient = require('multicast-dns')();

                /* We don't want to wait for long, so reject the promise after a period of time */
                const timerId = setTimeout(() => {
                    mdnsClient.destroy();

                    this.log.debug('DNS request timed out for %s, current status: %o', deviceId, status);

                    /* Check one last time to see if we have now got a cached value to return */
                    status = this._getCachedStatusForDevice(deviceId);
                    if (status) {
                        this.log.debug('DNS request timed out for device %s, but cached value now found.',
                            deviceId);
                        resolve(status);
                    } else {
                        reject('DNS request timed out for device ' + deviceId);
                    }
                }, this.dnsTimeout);

                /* Configure the listener we use to look for our responses and resolve the promise */
                mdnsClient.on('response', response => {
                    if (response.answers) {
                        response.answers
                            .filter(value => value.name === deviceName)
                            .forEach(value => {
                                if (this.logDnsResponses) {
                                    this.log.debug('DNS Response: %o', value);
                                }
            
                                if (value.type === 'TXT') {

                                    const txt = this.processDnsResponse(value);
                                    if (this.logDnsResponses) {
                                        this.log.debug('Processed TXT record for %s: %o', deviceId, txt);
                                    }
                                    status.params = txt.params;

                                } else if (value.type === 'SRV') {
                                    
                                    /* Store a value with the parsed out information we need to connect */
                                    const srv = this.processDnsResponse(value);
                                    if (this.logDnsResponses) {
                                        this.log.debug('Processed SRV record for %s: %o', deviceId, srv);
                                    }
                                    status.host = srv.host;
                                    
                                } else {
                                    this.log.debug('Unhandled device DNS answer: %o', value);
                                }

                                if (status.host && status.params) {
                                    /* Resolve the promise */
                                    resolve(status);
                                    /* Clean up */
                                    mdnsClient.destroy();
                                    clearTimeout(timerId);
                                }
                            });
                    }
                });

                /* Perform the DNS query */
                const questions = [
                    {
                        name: 'eWeLink_' + deviceId + '.local',
                        type: 'TXT'
                    },
                    {
                        name: 'eWeLink_' + deviceId + '.local',
                        type: 'SRV'
                    }
                ];
                mdnsClient.query({
                    questions: questions
                }, () => {
                    if (this.logDnsResponses) {
                        this.log.debug('DNS QUERY SENT: %o', questions);
                    }
                });
            }
        });
    }

    /**
     * Decrypt the supplied data. 
     * @param encryptedData the data to decrypt
     * @param apiKey the API key for the device the encrypted data is for
     * @param iv the initialisation vector associated with the encrypted message. 
     * @returns string containing the decrypted data
     */
    decrypt(encryptedData, apiKey, iv) {
        const cryptkey = crypto.createHash('md5')
            .update(Buffer.from(apiKey, 'utf8'))
            .digest();

        const ivBuffer = Buffer.from(iv, 'base64');

        const cipherText = Buffer.from(encryptedData, 'base64');


        const decipher = crypto.createDecipheriv('aes-128-cbc', cryptkey, ivBuffer);

        const plainText = Buffer.concat([
            decipher.update(cipherText),
            decipher.final(),
        ]);

        return plainText.toString('utf8');
    }

    /**
    * Encrypt the supplied data. 
    * @param plainText the data to encrypt
    * @param apiKey the API key for the device the encrypted data is for
    * @returns object containing the encrypted "data" and "iv" used for the encryption
    */
    encrypt(plainText, apiKey) {

        const cryptkey = crypto.createHash('md5')
            .update(Buffer.from(apiKey, 'utf8'))
            .digest();

        const iv = crypto.randomBytes(16);

        const encipher = crypto.createCipheriv('aes-128-cbc', cryptkey, iv);

        const cipherText = Buffer.concat([
            encipher.update(plainText),
            encipher.final(),
        ]);

        return {
            data: cipherText,
            iv: iv,
        };

    }

    /**
     * Extract the state data object from the MDNS service.
     *
     * @param service the service TXT record data from the mdns query
     * @param deviceKey optional parameter. If this service is marked as encrypted then this 
     *                  is required for part of the decryption, this is the decryption key.
     * @returns object containing the data
     */
    extractDataFromDnsService(
        service, deviceKey) {

        /* DNS TXT records has limitation on field lengths, as a result the 
         * data may be split into up to 4 fields. 
         * Need to join these up. */

        let data1 = service['data1'];
        if (service['data2']) {

            const data2 = service['data2'];
            data1 += data2;

            if (service['data3']) {

                const data3 = service['data3'];
                data1 += data3;

                if (service['data4']) {

                    const data4 = service['data4'];
                    data1 += data4;

                }
            }
        }

        /* Convert the string into a usable object. 
         * Depending on the device setup, this may need to be decrypted first */
        let data;
        if (service.encrypt) {
            /* If this is marked as encrypted, we need an API key to decrypt. 
            */
            if (deviceKey !== undefined) {
                /* Should be able to decrypt this data.
                 * Requires to get the IV from another field */
                const iv = service['iv'];

                data = this.decrypt(data1, deviceKey, iv);
            } else {
                this.log.error('Missing api_key for encrypted device %s', service.id);
            }

        } else {
            data = data1;
        }

        if (this.logDnsResponses) {
            this.log.debug('Data: %o', data);
        }


        /* Convert to a JSON object */
        return (data ? JSON.parse(data) : undefined);
    }

    /**
    * Method to perform an API call to the device. This handles aspects of wrapping
    * the supplied data object with the result of the payload information. 
    * This will always make http requests. 
    *  
    * @param {string} deviceId the id of the device. 
    * @param path the path to send the request to
    * @param data the data object containing the state to send to the device. The surrounding 
    *             payload fields are all handled by this method.
    */
    async doApiCall(deviceId, path, data) {

        const payload = {
            sequence: Date.now().toString(),
            selfApikey: '123',
            deviceid: deviceId,
            data: JSON.stringify(data),
            encrypt: false,
        };

        this.log.debug('Pre-encryption payload: %o', payload);

        const encryptionKey = this.deviceKeyMap.get(deviceId);
        if (encryptionKey) {
            /* if we have an API key, need to encrypt the data */
            payload.encrypt = true;

            const encryptionResult = this.encrypt(payload.data, encryptionKey);
            payload.data = encryptionResult.data.toString('base64');
            payload.iv = encryptionResult.iv.toString('base64');
        }

        /* Configure the connection host string */
        const localDeviceHost = this.deviceHostMap.get(deviceId);
        let connectionHost = 'http://' + localDeviceHost.host;
        if (localDeviceHost.port) {
            connectionHost += ':' + localDeviceHost.port;
        }

        let webClient = request.createClient(connectionHost);
        webClient.headers['Accept'] = 'application/json';
        webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
        webClient.headers['Accept-Language'] = 'en-gb';

        /* Return the promise for the request */
        this.log.debug('Sending call to path: %s', path);
        return webClient.post(path, payload);
    }

    /**
     * Set the new status params for a device. 
     * @param {*} accessory the accessory to set the status for
     * @param {*} statusParams the new device status params
     * 
     * @returns a promise returning the result of the update request. 
     *          If this device does not support a lan client, an "Unsupported" 
     *          error will be returned. 
     */
    updateDeviceStatus(accessory, statusParams) {


        return new Promise((resolve, reject) => {
            /* Based on the status supplied, work out the API to call */
            let path;
            if (statusParams.switch) {
                /* Single switch device */
                path = '/zeroconf/switch';
            } else if (statusParams.switches) {
                /* Multiple Switch Device */
                path = '/zeroconf/switches';
            }


            if (!path) {
                /* Could not determine the correct path, throw an unsupported error */
                reject("Unsupported");
            } else {
                /* Do a lan API call */
                doApiCall(accessory.context.deviceId, path, statusParams)
                    .then(result => {
                        /* Remove the cached device state */
                        this.deviceStatusMap.delete(accessory.context.deviceId);

                        /* Return the result */
                        resolve(result);
                    }).catch(err => reject(err));
            }
        });
        
    }
}