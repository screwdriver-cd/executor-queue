'use strict';

const Executor = require('screwdriver-executor-base');
const Resque = require('node-resque');
const Breaker = require('circuit-fuses');

class ExecutorQueue extends Executor {
    /**
     * Constructs a router for different Executor strategies.
     * @method constructor
     * @param  {Object}         config                      Object with executor and ecosystem
     * @param  {Object}         config.redisConnection      Connection details for redis
     */
    constructor(config = {}) {
        if (!config.redisConnection) {
            throw new Error('No redis connection passed in');
        }

        super();

        // eslint-disable-next-line new-cap
        this.queue = new Resque.queue({ connection: config.redisConnection });

        this.connected = false;
        this.queue.connect(() => {
            this.connected = true;
        });

        this.breaker = new Breaker(this.queue.enqueue);
    }

    /**
     * Verify that the redis connection is active
     * @method veryifyConnection
     * @return {Promise}
     */
    verifyConnection() {
        return new Promise((resolve, reject) => {
            if (this.connected) {
                return resolve();
            }

            return this.queue.connect((err) => {
                if (err) {
                    return reject(err);
                }

                this.connected = true;

                return resolve();
            });
        });
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
        // Note: arguments to enqueue are [queue name, job type, array of args]
        return this.verifyConnection()
            .then(() => this.breaker.runCommand('builds', 'start', [config]));
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
