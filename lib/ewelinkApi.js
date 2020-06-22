let request = require('request-json');
let crypto = require('crypto');

module.exports = class EwelinkApi {

    /**
     * Create a new EwelinkApi
     * @param {*} log the logger instance to use for log messages
     * @param {*} config the plugin configuration
     */
    constructor(log, config) {
        this.log = log;
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
   * Generate a nonce for sending with API requests. 
   * 
   * @returns the base64 encoded nonce.
   */
  nonce() {
    return crypto.randomBytes(16).toString('base64');
  }

}