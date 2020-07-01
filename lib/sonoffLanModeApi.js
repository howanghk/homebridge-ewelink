let request = require('request-json');
let crypto = require('crypto');

const mdns = require('multicast-dns')()


/**
 * Class for interacting with devices using the LAN API and 
 * multicast DNS. 
 * 
 * TODO: 
 * - Change so "get" requests use promises, return the decrypted device state.
 *   This means it can be used the same way as the WebSocket and HTTP clients. 
 * - Also needs a way to keep a handle on if a device supports LAN mode
 *   This is the current TODO
 */
module.exports = class LanClient {



    /**
     * Create a new LanClient. 
     * @param {*} log the logger instance to use for log messages
     */
    constructor(log) {

        this.log = log;

        /**
         * Map of deviceId to their last known DNS state. 
         * 
         * TODO: interval clearing this out after a TTL?
         */
        this.deviceMap = new Map();

        /**
         * Map of deviceId to their corresponding deviceKey.
         * This is required to allow decryption of DNS data to occur. 
         */
        this.deviceKeyMap = new Map();

    }

    /**
     * Add a device key for a device to allow decryption to occur. 
     * @param {string} deviceId the id of the device. 
     * @param {string} deviceKey the key for the device. 
     */
    addDeviceKey(deviceId, deviceKey) {
        this.log.debug('Adding device key %s for device %s', deviceKey, deviceId);
        this.deviceKeyMap.set(deviceId, deviceKey);
    }

    /**
     * Register internal listeners and make an initial query to attempt local discovery of the device. 
     */
    start() {
        this.log.debug('Starting lan client');

        mdns.on('response', response => this.processDnsResponse(response));

        /* Send the DNS queries every 5 minutes (300 s) */
        setInterval(() => this.sendDnsQuery(), (300 * 1000));
    }

    /**
     * Sends a DNS query to discover devices
     */
    sendDnsQuery() {

        let questions = [
            {
                name: '_ewelink._tcp.local',
                type: 'TXT'
            }
        ];

        //TODO: Iterate through known devices and add them to the queries
        //{
            //     name: 'eWeLink_' + this.device.deviceid + '.local',
            //     type: 'A'
            // },
            // {
            //     name: 'eWeLink_' + this.device.deviceid + '.local',
            //     type: 'SRV'
            // }

        mdns.query({
            questions: questions
        });
    }

    /**
     * Close internal listeners for DNS responses. 
     */
    close() {
        mdns.destroy();
    }

    /**
     * Process a DNS response and look for this device. 
     * 
     * TODO: this could call back to update homebridge with updated
     * device states
     * 
     * @param {*} response the DNS response from the mdns client
     */
    processDnsResponse(response) {

        //TODO: Need some way of determining when a device goes away

        /* find the item for the device */
        if (response.answers) {
            response.answers
                .filter(value => value.name.startsWith('eWeLink_'))
                // .filter(value => value.name === this.deviceName)
                .forEach(value => {
                    // this.log.debug('DNS Response: %o', response);

                    /* Get the deviceId from the device name */
                    let deviceId = value.name.substr(8, 10);
                    this.log.debug('parsedDeviceId for name %s is %s. Record type %s', value.name, deviceId, value.type);

                    let status = this.deviceMap.get(deviceId);
                    if (!status) {
                        /* Need to create the object to put in the map */
                        status = {};
                    }

                    /* TODO: Solve duplication with getDeviceStatus, possibly just look for SRV records
                     *        here, and use that to trigger a call to getDeviceStatus?
                     */ 
                    if (value.type === 'TXT') {
                        /* TXT records contain the state for the device */

                        // this.log.debug('got a matching response for device %s: %o',
                        //     this.device.deviceid, value)

                        const processedDeviceResponse = Object.assign({}, value);

                        let dataObject = {};

                        value.data.forEach(dataValue => {
                            // this.log.debug('Buffer string: %s', dataValue.toString('utf-8'))

                            let bufferString = dataValue.toString('utf-8');
                            let key = bufferString.substr(0, bufferString.indexOf('='));

                            dataObject[key] = bufferString.substr(bufferString.indexOf('=') + 1);
                        });

                        // this.log.debug('DNS txt record for device %s is: %o',
                        //     this.device.deviceid, dataObject);
                        processedDeviceResponse.data = dataObject;


                        /* Turn this TXT record into something usable for the state */
                        const stateData = this.extractDataFromDnsService(dataObject, 
                            this.deviceKeyMap.get(dataObject.id));
                        // this.log.debug('State data for device %s is: %o', this.device.deviceid, stateData);

                        status.params = stateData;
                        status.txt = processedDeviceResponse;

                        this.log.debug('LocalDevice state for %s is: %o', deviceId, status.params);
                    } else if (value.type === 'SRV') {
                        /* A record contains the host details we need to invoke an API */
                        this.log.debug('DNS SRV answer: %o', value);

                        status.host = {
                            host: value.data.target,
                            port: value.data.port
                        };
                        
                        status.srv = value;

                        this.log.debug('LocalDevice host for %s is: %o', deviceId, status.host);
                    } else {
                        this.log.debug('Unhandled device DNS answer: %o', value);
                    }

                    this.deviceMap.set(deviceId, status);
                });
        }

    }

    /**
     * Get the details of the local device state. 
     */
    getLocalDevice() {

        /* If anything requests information on the local device, then
         * kick off a new DNS query to ensure we are up to date 
         */
        this.sendDnsQuery();

        return this.localDevice;
    }

    /**
     * Get the status of a device. 
     * 
     * This comes from a combination of a few DNS responses.
     * 
     * @param {*} deviceId 
     * @param {*} deviceKey
     * @returns a promise. This will return the single device from the API call, 
     *          or throw an Error if it cannot be found. 
     */
    getDeviceStatus(deviceId, deviceKey) {

        return new Promise((resolve, reject) => {
            let deviceName = 'eWeLink_' + deviceId + '._ewelink._tcp.local';
            this.log.debug('TEST LOG: %s', deviceName);

            // const mdnsClient = multicastdns();
            const mdnsClient = require('multicast-dns')();
            let status = {};

            mdnsClient.on('response', response => {
                if (response.answers) {
                    response.answers
                        .filter(value => value.name === deviceName)
                        .forEach(value => {
                            this.log.debug('DNS Response: %o', response);
        
                            if (value.type === 'TXT') {
                                const processedDeviceResponse = Object.assign({}, value);

                                let dataObject = {};

                                value.data.forEach(dataValue => {
                                    // this.log.debug('Buffer string: %s', dataValue.toString('utf-8'))

                                    let bufferString = dataValue.toString('utf-8');
                                    let key = bufferString.substr(0, bufferString.indexOf('='));

                                    dataObject[key] = bufferString.substr(bufferString.indexOf('=') + 1);
                                });

                                // this.log.debug('DNS txt record for device %s is: %o',
                                //     this.device.deviceid, dataObject);
                                processedDeviceResponse.data = dataObject;


                                /* Turn this TXT record into something usable for the state */
                                const stateData = this.extractDataFromDnsService(dataObject, 
                                    this.deviceKeyMap.get(dataObject.id));
                                // this.log.debug('State data for device %s is: %o', this.device.deviceid, stateData);
                                status.params = stateData;

                                status.txt = processedDeviceResponse;
                            } else if (value.type === 'SRV') {
                                /* Store the whole SRV record */
                                status.srv = value;

                                /* Store a value with the parsed out information we need to connect */
                                status.host = {
                                    host: value.data.target,
                                    port: value.data.port
                                };

                            } else {
                                this.log.debug('Unhandled device DNS answer: %o', value);
                            }

                            if (status.srv && status.txt) {
                                resolve(status);
                                mdnsClient.destroy();
                            }
                        });
                }
            });

            mdnsClient.query({
                questions: [
                    {
                        name: '_ewelink._tcp.local',
                        type: 'TXT'
                    },
                    {
                        name: 'eWeLink_' + deviceId + '.local',
                        type: 'A'
                    },
                    {
                        name: 'eWeLink_' + deviceId + '.local',
                        type: 'SRV'
                    }
                ]
            }, () => this.log.debug('DNS QUERY SENT'));

            /* We don't want to wait for long, so reject the promise after a second */
            setTimeout(() => {
                mdnsClient.destroy();
                reject('DNS request timed out for device ' + deviceId);
            }, 1000);
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

        this.log.debug('Data: %o', data);


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


        this.log.debug('Pre-encryption payload: %s', JSON.stringify(payload));

        if (this.localDevice.data.encrypt) {
            /* if we have an API key, need to encrypt the data */
            payload.encrypt = true;

            const encryptionResult = this.encrypt(payload.data, this.deviceKeyMap.get(deviceId));
            payload.data = encryptionResult.data.toString('base64');
            payload.iv = encryptionResult.iv.toString('base64');
        }

        let connectionHost = 'http://' + this.localDeviceHost.host;
        if (this.localDeviceHost.port) {
            connectionHost += ':' + this.localDeviceHost.port;
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
     * 
     * @param accessory the accessory being updated
     * @param on boolean to indicate if the device should be sent an
     *           'on' (true) or 'off' (false) state.
     * @param callback the function to call after the update has been applied 
     */
    setSwitchStatus(accessory, on, callback) {

        this.log.debug('Lan mode setSwitchStatus for %s to %o', accessory.displayName, on);
  
        const data = {
            switch: (on ? 'on': 'off'),
        };
    
        this.doApiCall('/zeroconf/switch', data)
            .then(response => {
                // this.log.debug('Device response: %o', response);

                this.log.debug('Device response body: %o', response.body);

                if (response.body.error === 0) {
                    callback(null, on);
                } else {
                    callback('Error from the device API, code: ' + response.body.error);
                }

                
            })
            .catch(error => {
                this.log.error('Error updating device: %s', error);
                callback(error);
            })
    
    }
}