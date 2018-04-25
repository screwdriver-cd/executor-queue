'use strict';

const Executor = require('screwdriver-executor-base');
const Redis = require('ioredis');
const Resque = require('node-resque');
const schedule = require('node-schedule');
const fuses = require('circuit-fuses');
const req = require('request');
const Breaker = fuses.breaker;
const FuseBox = fuses.box;

class ExecutorQueue extends Executor {
    /**
     * Constructs a router for different Executor strategies.
     * @method constructor
     * @param  {Object}         config                      Object with executor and ecosystem
     * @param  {Object}         config.redisConnection      Connection details for redis
     * @param  {String}         [config.prefix]             Prefix for queue name
     * @param  {Object}         [config.breaker]            Optional breaker config
     */
    constructor(config = {}) {
        if (!config.redisConnection) {
            throw new Error('No redis connection passed in');
        }

        const breaker = Object.assign({}, config.breaker || {});

        super();

        this.prefix = config.prefix || '';
        this.buildQueue = `${this.prefix}builds`;
        this.buildConfigTable = `${this.prefix}buildConfigs`;
        this.periodicBuildTable = `${this.prefix}periodicBuilds`;

        const redisConnection = Object.assign({}, config.redisConnection, { pkg: 'ioredis' });

        this.redis = new Redis(
            redisConnection.port,
            redisConnection.host,
            redisConnection.options
        );

        // eslint-disable-next-line new-cap
        this.queue = new Resque.queue({ connection: redisConnection });
        this.queueBreaker = new Breaker((funcName, ...args) =>
            this.queue[funcName](...args), breaker);
        this.redisBreaker = new Breaker((funcName, ...args) =>
            // Use the queue's built-in connection to send redis commands instead of instantiating a new one
            this.redis[funcName](...args), breaker);

        this.fuseBox = new FuseBox();
        this.fuseBox.addFuse(this.queueBreaker);
        this.fuseBox.addFuse(this.redisBreaker);

        this.scheduler = new Resque.Scheduler({ connection: redisConnection });
    }

    /**
     * Starts new periodic builds in an executor
     * @method _periodicStart
     * @param {Object} config               Configuration
     * @param {Object} config.pipeline      Pipeline of the job
     * @param {Object} config.job           Job object to create periodic builds for
     * @param {Object} config.tokenGen      Function to generate JWT from username, scope and scmContext
     * @return {Promise}
     */
    async _periodicStart(config) {
        const pipeline = config.pipeline;
        const job = config.job;
        const tokenGen = config.tokenGen;

        await this.scheduler.connect();

        return this.scheduler.start()
            .then(() => {
                const scheduledJob = schedule.scheduleJob(job.annotations.buildPeriodically, async () => {
                    // we want to ensure that only one instance of this job is scheduled in our environment at once,
                    // no matter how many schedulers we have running
                    if (this.scheduler.master) {
                        pipeline.admin((user) => {
                            const jwt = tokenGen(user, {
                                isPR: job.isPR(),
                                jobId: job.id,
                                pipelineId: pipeline.id
                            }, pipeline.scmContext);

                            const options = {
                                url: '/events',
                                method: 'POST',
                                headers: {
                                    Authorization: `Bearer ${jwt}`,
                                    'Content-Type': 'application/json'
                                },
                                body: {
                                    pipelineId: pipeline.id,
                                    startFrom: job.name
                                }
                            };

                            req(options, (err, response) => {
                                if (err) {
                                    return Promise.reject(err);
                                }

                                return Promise.resolve(response);
                            });
                        });
                    }
                });

                await this.redisBreaker.runCommand('hset', this.periodicBuildTable,
                        job.id, scheduledJob);
            });
    }

    /**
     * Starts a new build in an executor
     * @async  _start
     * @param  {Object} config               Configuration
     * @param  {Object} [config.annotations] Optional key/value object
     * @param  {String} config.apiUri        Screwdriver's API
     * @param  {String} config.buildId       Unique ID for a build
     * @param  {String} config.container     Container for the build to run in
     * @param  {String} config.token         JWT to act on behalf of the build
     * @return {Promise}
     */
    async _start(config) {
        await this.connect();

        // Store the config in redis
        await this.redisBreaker.runCommand('hset', this.buildConfigTable,
            config.buildId, JSON.stringify(config));

        // Note: arguments to enqueue are [queue name, job name, array of args]
        return this.queueBreaker.runCommand('enqueue', this.buildQueue, 'start', [{
            buildId: config.buildId
        }]);
    }

    /**
     * Stop a running or finished build
     * @async  _stop
     * @param  {Object} config               Configuration
     * @param  {String} config.buildId       Unique ID for a build
     * @return {Promise}
     */
    async _stop(config) {
        await this.connect();

        const numDeleted = await this.queueBreaker.runCommand('del', this.buildQueue, 'start', [{
            buildId: config.buildId
        }]);

        if (numDeleted !== 0) {
            // Build hadn't been started, "start" event was removed from queue
            return this.redisBreaker.runCommand('hdel', this.buildConfigTable, config.buildId);
        }

        // "start" event has been processed, need worker to stop the executor
        return this.queueBreaker.runCommand('enqueue', this.buildQueue, 'stop', [{
            buildId: config.buildId
        }]);
    }

    /**
     * Connect to the queue if we haven't already
     * @method connect
     * @return {Promise}
     */
    connect() {
        if (this.queue.connection.connected) {
            return Promise.resolve();
        }

        return this.queueBreaker.runCommand('connect');
    }

    /**
     * Retrieve stats for the executor
     * @method stats
     * @param {Response} Object     Object containing stats for the executor
     */
    stats() {
        return this.queueBreaker.stats();
    }
}

module.exports = ExecutorQueue;
