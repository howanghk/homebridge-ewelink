let request = require('request-json');
let crypto = require('crypto');

const mdns = require('multicast-dns')()


module.exports = class LanClient {



    /**
     * 
     * @param {*} device 
     * @param {*} log the logger instance to use for log messages
     */
    constructor(device, log) {

        this.device = device;
        this.log = log;

        this.deviceName = 'eWeLink_' + device.deviceid + '._ewelink._tcp.local';

    }

    start() {
        mdns.on('response', response => this.processDnsResponse(response));

        /* Send the initial query */
        mdns.query({
            questions: [
                {
                    name: '_ewelink._tcp.local',
                    // type: 'PTR'
                    // name: 'MacBook.local',
                    type: 'TXT'
                }
            ]
        });
    }


    processDnsResponse(response) {

        /* find the item for the device */
        if (response.answers) {
            response.answers
                .filter(value => value.name === this.deviceName && value.type === 'TXT')
                .forEach(value => {
                    this.log.debug('got a matching response for device %s: %o',
                        this.device.deviceid, value)

                    let dataObject = {};

                    value.data.forEach(dataValue => {
                        this.log.debug('Buffer string: %s', dataValue.toString('utf-8'))

                        let bufferString = dataValue.toString('utf-8');
                        let key = bufferString.substr(0, bufferString.indexOf('='));

                        dataObject[key] = bufferString.substr(bufferString.indexOf('=') + 1);
                    });

                    this.log.debug('DNS txt record for device %s is: %o',
                        this.device.deviceid, dataObject);

                    
                    /* Turn this TXT record into something usable for the state */
                    const stateData = this.extractDataFromDnsService(dataObject, this.device.devicekey);
                    this.log.debug('State data for device %s is: %o', this.device.deviceid, stateData);
                });

        }
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

    };

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
                this.log.error('Missing api_key for encrypted device %s', service.name);
            }

        } else {
            data = data1;
        }

        this.log.debug('Data: %o', data);


        /* Convert to a JSON object */
        return (data ? JSON.parse(data) : undefined);
    };

    /**
    * Method to perform an API call to the device. This handles aspects of wrapping
    * the supplied data object with the result of the payload information. 
    * This will always make http requests. 
    * @param log the logger instance to use for log messages
    * @param host the host to send the request to
    * @param port the port to send the request to. 
    * @param path the path to send the request to
    * @param deviceId the device identifier
    * @param data the data object containing the state to send to the device. The surrounding 
    *             payload fields are all handled by this method.
    * @param apiKey the device API key. This optional parameter should only be supplied when
    *               performing an operation against a device which is not in DIY mode and so
    *               requires encrypted payloads to be sent. 
    */
    async doApiCall(log, host, port, path, deviceId, data, apiKey) {

        const payload = {
            sequence: Date.now().toString(),
            selfApikey: '123',
            deviceid: deviceId,
            data: JSON.stringify(data),
            encrypt: false,
        };


        log.debug('Pre-encryption payload: %s', JSON.stringify(payload));

        if (apiKey) {
            /* if we have an API key, need to encrypt the data */
            payload.encrypt = true;

            const encryptionResult = encrypt(payload.data, apiKey);
            payload.data = encryptionResult.data.toString('base64');
            payload.iv = encryptionResult.iv.toString('base64');
        }

        let connectionHost = 'http://' + host;
        if (port) {
            connectionHost += ':' + port;
        }

        let webClient = request.createClient(connectionHost);
        webClient.headers['Accept'] = 'application/json';
        webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
        webClient.headers['Accept-Language'] = 'en-gb';

        /* Return the promise for the request */
        return webClient.post(path, payload);
    }



}