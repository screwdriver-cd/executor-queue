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

        const redisConnection = Object.assign(config.redisConnection, { pkg: 'ioredis' });

        // eslint-disable-next-line new-cap
        this.queue = new Resque.queue({ connection: redisConnection });

        // Note: arguments to enqueue are [queue name, job type, array of args]
        this.breaker = new Breaker(buildConfig => this.queue.connect((err) => {
            if (err) {
                throw err;
            }

            return this.queue.enqueue('builds', 'start', [buildConfig], (enqueueError) => {
                if (enqueueError) {
                    throw enqueueError;
                }
            });
        }));
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
        return this.breaker.runCommand(config);
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
