let request = require('request-json');
let crypto = require('crypto');
const querystring = require('querystring');
const { resolve } = require('path');

/**
 * Class exposing methods to interact with Ewelink through their HTTP API.
 * 
 * TODO:
 * - Rate limiting
 * - response caching (may be the same thing)
 */
module.exports = class EwelinkApi {

    /**
     * Create a new EwelinkApi
     * @param {*} log the logger instance to use for log messages
     * @param {*} config the plugin configuration
     */
    constructor(log, config) {

        this.log = log;


        /* Validate & initialise configuration */
        if (!config ||
            (!config['authenticationToken'] &&
                ((!config['phoneNumber'] && !config['email']) ||
                    !config['password'] ||
                    !config['imei']))) {

            log.warn('Initialization skipped. Missing configuration data.');
            return;
        }

        if (!config['apiHost']) {
            config['apiHost'] = 'eu-api.coolkit.cc:8080';
        }
        if (!config['webSocketApi']) {
            config['webSocketApi'] = 'us-pconnect3.coolkit.cc';
        }

        this.config = config;

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
        obj.appid = 'oeVkj2lYFGnJu5XUtWisfW4utiN4u9Mq';
        obj.imei = this.config.imei;
        obj.os = 'iOS';
        obj.model = 'iPhone10,6';
        obj.romVersion = '11.1.2';
        obj.appVersion = '3.5.3';

        return obj;
    }

    /**
     * Create the arguments as a query string for a GET request
     */
    getArgumentQueryString() {

        let args = {
            lang: 'en',
            apiKey: this.apiKey,
            getTags: '1'
        };

        /* Add in the common values that are common accross all API requests */
        args = this.populateCommonApiRequestFields(args);

        return querystring.stringify(args);
    }

    /**
     * Generate a nonce for sending with API requests. 
     * 
     * @returns the base64 encoded nonce.
     */
    nonce() {
        return crypto.randomBytes(16).toString('base64');
    }

    /**
     * Generate an HMAC signature for the supplied data string. 
     * @param string the input string to get a signature for. 
     */
    getSignature(string) {
        //let appSecret = "248,208,180,108,132,92,172,184,256,152,256,144,48,172,220,56,100,124,144,160,148,88,28,100,120,152,244,244,120,236,164,204";
        //let f = "ab!@#$ijklmcdefghBCWXYZ01234DEFGHnopqrstuvwxyzAIJKLMNOPQRSTUV56789%^&*()";
        //let decrypt = function(r){var n="";return r.split(',').forEach(function(r){var t=parseInt(r)>>2,e=f.charAt(t);n+=e}),n.trim()};
        let decryptedAppSecret = '6Nz4n0xA8s8qdxQf2GqurZj2Fs55FUvM'; //decrypt(appSecret);
        return crypto.createHmac('sha256', decryptedAppSecret).update(string).digest('base64');
    }

    /**
     * Call the Ewelink API to list the devices.
     * 
     * This handles some of the error cases the plugin previously handled where 
     * the response wasn't an error, but some fields were missing. 
     * 
     * @returns a promise for the get request. The resolve result will be the device list 
     *          from the API. Any other error case will use the rejection call. 
     */
    async listDevices() {

        const url = 'https://' + this.config['apiHost'];

        this.log.debug('Requesting a list of devices from eWeLink HTTPS API at [%s]', url);

        
        let webClient = request.createClient(url);
        webClient.headers['Authorization'] = 'Bearer ' + this.authenticationToken;
        return await webClient.get('/api/user/device?' + this.getArgumentQueryString())
            .then(result => {

                if (!result.body) {

                    const message = 'An error was encountered while requesting a list of devices. No data in response.';

                    this.log.error(message);
                    throw new Error(message);
                } else if (result.body.error && result.body.error != 0) {
                    let response = JSON.stringify(result.body);
                    this.log.error('An error was encountered while requesting a list of devices. Response was [%s]', response);
                    if (result.body.error === '401') {
                        this.log.error('Verify that you have the correct authenticationToken specified in your configuration. The currently-configured token is [%s]', platform.authenticationToken);
                    }
                    throw new Error('API returned error response');
                } else {
                    this.log.debug('Returning device list: %o', result.body.devicelist);
                    return (result.body.devicelist);
                }

            }).catch(err => {
                this.log.error('An error was encountered while requesting a list of devices. Error was [%s]', err);
                
                throw new Error(err);
            });
    }

    /**
     * Get the status of a device. 
     * 
     * This comes from the listDevices API, and just filters to return the
     * details for a single device. 
     * 
     * @param {*} deviceId 
     * @returns a promise. This will return the single device from the API call, 
     *          or throw an Error if it cannot be found. 
     */
    async getDeviceStatus(deviceId) {

        const devices = await this.listDevices();

        let filteredDevices = devices.filter(device => (device.deviceid === deviceId));

        if (filteredDevices.length === 1) {
            this.log.debug('Got device: %s', filteredDevices[0]);
            return filteredDevices[0];
        } else if (filteredDevices.length > 1) {
            // More than one device matches our Device ID. This should not happen.
            this.log.error('ERROR: The response contained more than one device with Device ID [%s]. Filtered response: %o', 
                deviceId, filteredDevices);
                    
            throw new Error('The response contained more than one device with Device ID ' + deviceId);
            
        } else {
            /* Response did not contain the device ID, the device is no longer registered. */
            this.log.error('Device [%s] did not exist in the response.', deviceId);
            throw new Error('The response contained no devices with Device ID ' + deviceId);
        }

    }

    /**
     * Login to the Ewelink API
     * 
     * @returns a promise. The resolve callback will be used when a valid 
     *          authentication token it returned by the API. The return type will be an 
     *          object with two fields, authenticationToken and apiKey. 
     *          The reject callback will be used for all error conditions. 
     */
    async login() {

        /* Check the configuration is good */
        if (!this.config.phoneNumber && !this.config.email || !this.config.password || !this.config.imei) {
            const message = 'phoneNumber / email / password / imei not found in config, skipping login';
            this.log.error(message);
            throw new Error(message);
        } else {
            /* Configuration is good, try to make the API call */

            /* Setup the Object with the API request data */
            let data = {};
            if (this.config.phoneNumber) {
                data.phoneNumber = this.config.phoneNumber;
            } else if (this.config.email) {
                data.email = this.config.email;
            }
            data.password = this.config.password;

            /* Setup the fields which are common to all API calls */
            data = this.populateCommonApiRequestFields(data);


            const json = JSON.stringify(data);
            this.log.debug('Sending login request with user credentials: %s', json);

            let sign = this.getSignature(json);
            this.log.debug('Login signature: %s', sign);

            let webClient = request.createClient('https://' + this.config.apiHost);
            webClient.headers['Authorization'] = 'Sign ' + sign;
            webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
            await webClient.post('/api/user/login', data)
                .then(result => {

                    // If we receive 301 error, switch to new region and try again
                    if (result.body.error && result.body.error == 301 && result.body.region) {
                        let idx = this.config.apiHost.indexOf('-');
                        if (idx == -1) {
                            this.log.error('Received new region [%s]. However we cannot construct the new API host url.', body.region);
                            throw new Error('Received new region, however we cannot construct the new API host url.');
                        } else {
                            let newApiHost = result.body.region + this.config.apiHost.substring(idx);
                            if (this.config.apiHost != newApiHost) {
                                this.log('Received new region [%s], updating API host to [%s].', result.body.region, newApiHost);
                                this.config.apiHost = newApiHost;
                                this.login()
                                    .then(loginResult => {
                                        return loginResult
                                    }).catch(err => {
                                        throw new Error(err)
                                    });
                            }
                        }
                    } else if (!result.body.at) {
                        let response = JSON.stringify(result.body);
                        this.log.error('Server did not response with an authentication token. Response was [%s]', response);
                        throw new Error('Server did not response with an authentication token.')
                    } else {
                        /* Successful login and body looks as expected, return the authentication token (and set it locally) */
                        this.log.debug('Authentication token received [%s]', result.body.at);
                        this.log.debug('Login response body: %o', result.body);
                        this.authenticationToken = result.body.at;
                        this.config.authenticationToken = this.authenticationToken;
                        this.apiKey = result.body.user.apikey;
                        this.config.apiKey = this.apiKey;

                        let returnObject = {
                            authenticationToken: this.authenticationToken,
                            apiKey: this.apiKey
                        };

                        this.log.debug('Login returning: %o', returnObject);

                        return returnObject;
                    }


                }).catch(err => {
                    this.log.error('An error was encountered while logging in. Error was [%s]', err);
                    throw new Error('An error was encountered while logging in.');
                });

        }
    }

    /**
     * Get the correct API server region for the supplied country code.
     * 
     * @param {string} countryCode  the country code to get the API region for. 
     * @returns a promise. The resolve callback will be called with the region code. 
     *          Any error condition will call the reject callback with an error message. 
     */
    async getRegion(countryCode) {

        /* Set the arguments specific to this API call */
        var data = {
            country_code: countryCode
        };
        /* Set the arguments that apply to all API calls */
        data = this.populateCommonApiRequestFields(data);


        let query = querystring.stringify(data);
        this.log.debug('getRegion query: %s', query);

        /* Create a signature for the request */
        const dataToSign = Object.keys(data)
            .sort((a, b) => b.localeCompare(a))
            .map(key => key + '=' + data[key])
            .join('&');

        const signature = this.getSignature(dataToSign);
        this.log.debug('getRegion signature: %s', signature);

        
        let webClient = request.createClient('https://api.coolkit.cc:8080');
        webClient.headers['Authorization'] = 'Sign ' + signature;
        webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';

        return await webClient.get('/api/user/region?' + query)
            .then(result => {
                if (!result.body.region) {
                    let response = JSON.stringify(result.body);
                    this.log.error('Server did not response with a region. Response was [%s]', response);
                    throw new Error('Server did not response with a region.');
                } else {
                    this.log.debug('Got region: %s', result.body.region);
                    return result.body.region;
                }

            }).catch(err => {
                this.log.error('An error was encountered while getting region. Error was [%s]', err);
                throw new Error('An error was encountered while getting region.');
            });

    }

    /**
     * Get the correct websocket host for the current API session.
     * 
     * @returns a promise. The resolve callback will be called with the websocket host. 
     *          Any error condition will call the reject callback with an error message. 
     */
    async getWebSocketHost() {

        /* Set the request data that is specific to this API invocation */
        let data = {
            accept: 'mqtt,ws'
        };

        /* Set the arguments that apply to all API calls */
        data = this.populateCommonApiRequestFields(data);
        
        
        let webClient = request.createClient('https://' + this.config.apiHost.replace('-api', '-disp'));
        webClient.headers['Authorization'] = 'Bearer ' + this.authenticationToken;
        webClient.headers['Content-Type'] = 'application/json;charset=UTF-8';
        webClient.post('/dispatch/app', data)
            .then(result => {

                if (!result.body.domain) {
                    /* Response body did not contain the field we expected */
                    let response = JSON.stringify(body);
                    this.log.error('Server did not response with a websocket host. Response was [%s]', response);
                    throw new Error('Server did not response with a websocket host.');
                } else {
                    this.log.debug('WebSocket host received [%s]', result.body.domain);
                    this.config['webSocketApi'] = result.body.domain;
                    
                    return result.body.domain;
                }
            }).catch(err => {
                this.log.error('An error was encountered while getting websocket host. Error was [%s]', err);
                throw new Error('An error was encountered while getting websocket host.');
            });
    };

}
