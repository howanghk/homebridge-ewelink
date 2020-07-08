const EventEmitter = require('events');

/**
 * A very basic object which acts as a cache. 
 * 
 * Items added to the cache will have a TTL applied to them automatically. 
 */
module.exports = class Cache {

    /**
     * Create a new Cache
     * @param {*} log the logger instance to use for log messages
     * @param {number} defaultCacheDuration the default cache duration (in milliseconds) to use 
     *                                      for items added to the cache. 
     */
    constructor(log, defaultCacheDuration = 500) {

        /* Set constructor params */
        this.log = log;
        this.defaultCacheDuration = defaultCacheDuration;

        /* Map we will use to hold the cache contents */
        this.cacheMap = new Map();

        /* Map of cache key to the timer for it's deletion. 
         * This will be used so that, when a cache key is inserted again, 
         * any previous timer will be cleared */
        this.timerMap = new Map();

        /* Add an event emmitter for events */
        this.eventEmitter = new EventEmitter();

    }

    /**
     * Add a listener to be called when a key is expired from the cache. 
     * @param {function} funct the function to be called when events occur. 
     *                         This will be supplied the deviceId as a parameter. 
     */
    addCacheExpiryListener(funct) {
        this.eventEmitter.addListener('expiry', funct);
    }

    /**
     * Get an item from the cache map.
     * @param {*} key the key to lookup the value for. 
     * @returns the value from the cache, or undefined if there is no value held. 
     */
    get(key) {
        return this.cacheMap.get(key);
    }

    /**
     * Get the keys that are currently held in the cache.
     * 
     * @returns an iterable of keys in the cache. 
     */
    keys() {
        this.cacheMap.keys();
    }

    /**
     * Add an item to the cache. 
     * 
     * This will be automatically removed from the cache after the cacheDuration. If a 
     * cache duration is not supplied, the default value of 500 will be used. 
     * 
     * @param {*} key the key to store the value against
     * @param {*} value the value to store. 
     * @param {number} cacheDuration (optional) the duration to cache the item for, in milliseconds. 
     */
    set(key, value, cacheDuration = this.defaultCacheDuration) {

        this._clearTimer(key);

        /* Add the item to the cache */
        this.cacheMap.set(key, value);

        /* Set a timer to remove the item from the cache.
         * This timerId is added to a map in case we need to cancel it early */
        const timerId = setTimeout(() => {
            /* Delete the item */
            let removed = this.cacheMap.delete(key);

            /* If the item was removed by this timer, send a notification event */
            if (removed) {
                this.eventEmitter.emit('expiry', key);
            }
        }, cacheDuration);

        this.timerMap.set(key, timerId);

    }

    /**
     * Delete an item from the cache.
     * @param {*} key the key for the item to remove from the cache
     */
    delete(key) {
        /* Remove the item from the cache */
        this.cacheMap.delete(key);

        /* Clear any timers for the item */
        this._clearTimer(key);
    }

    /**
     * Clear any timers that exist for a cache key. 
     * @param {*} key the cache key to clear the timers for. 
     */
    _clearTimer(key) {
        /* If there are any existing timers for the key, clear them */
        let existingTimerId = this.timerMap.get(key);
        if (existingTimerId) {
            clearTimeout(existingTimerId);
        }
    }

}