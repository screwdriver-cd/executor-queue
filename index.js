'use strict';

const Executor = require('screwdriver-executor-base');
const Resque = require('node-resque');
const Breaker = require('circuit-fuses').breaker;

class ExecutorQueue extends Executor {
    /**
     * Constructs a router for different Executor strategies.
     * @method constructor
     * @param  {Object}         config                      Object with executor and ecosystem
     * @param  {Object}         config.redisConnection      Connection details for redis
     * @param  {Object}         [config.breaker]            optional breaker config
     */
    constructor(config = {}) {
        if (!config.redisConnection) {
            throw new Error('No redis connection passed in');
        }

        const breaker = Object.assign({}, config.breaker || {});

        super();

        const redisConnection = Object.assign({}, config.redisConnection, { pkg: 'ioredis' });

        // eslint-disable-next-line new-cap
        this.queue = new Resque.queue({ connection: redisConnection });
        this.breaker = new Breaker((funcName, ...args) => this.queue[funcName](...args), breaker);
    }

    /**
     * Starts a new build in an executor
     * @method _start
     * @param {Object} config               Configuration
     * @param {Object} [config.annotations] Optional key/value object
     * @param {String} config.apiUri        Screwdriver's API
     * @param {String} config.buildId       Unique ID for a build
     * @param {String} config.container     Container for the build to run in
     * @param {String} config.token         JWT to act on behalf of the build
     * @return {Promise}
     */
    _start(config) {
        return this.breaker.runCommand('connect')
            // Note: arguments to enqueue are [queue name, job type, array of args]
            .then(() => this.breaker.runCommand('enqueue', 'builds', 'start', [config]));
    }

    /**
     * Stop a running or finished build
     * @method _stop
     * @param {Object} config               Configuration
     * @param {Object} [config.annotations] Optional key/value object
     * @param {String} config.buildId       Unique ID for a build
     * @return {Promise}
     */
    _stop(config) {
        return this.breaker.runCommand('connect')
            .then(() => this.breaker.runCommand('del', 'builds', 'start', [config]))
            .then((numDeleted) => {
                if (numDeleted !== 0) {
                    // Build hadn't been started, "start" event was removed from queue
                    return null;
                }

                // "start" event has been processed, need worker to stop the executor
                return this.breaker.runCommand('enqueue', 'builds', 'stop', [config]);
            });
    }

    /**
     * Retrieve stats for the executor
     * @method stats
     * @param {Response} Object     Object containing stats for the executor
     */
    stats() {
        return this.breaker.stats();
    }
}

module.exports = ExecutorQueue;
