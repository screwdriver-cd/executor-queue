'use strict';

const Executor = require('screwdriver-executor-base');
const logger = require('screwdriver-logger');
const Redis = require('ioredis');
const Resque = require('node-resque');
const fuses = require('circuit-fuses');
const requestretry = require('requestretry');
const hoek = require('hoek');
const cron = require('./lib/cron');
const timeOutOfWindows = require('./lib/freezeWindows').timeOutOfWindows;
const Breaker = fuses.breaker;
const FuseBox = fuses.box;
const EXPIRE_TIME = 1800; // 30 mins
const RETRY_LIMIT = 3;
const RETRY_DELAY = 5;
const DEFAULT_BUILD_TIMEOUT = 90;

class ExecutorQueue extends Executor {
    /**
     * Constructs a router for different Executor strategies.
     * @method constructor
     * @param  {Object}         config                      Object with executor and ecosystem
     * @param  {Object}         config.redisConnection      Connection details for redis
     * @param  {Object}         config.pipelineFactory      Pipeline Factory instance
     * @param  {String}         [config.prefix]             Prefix for queue name
     * @param  {Object}         [config.breaker]            Optional breaker config
     */
    constructor(config = {}) {
        if (!config.redisConnection) {
            throw new Error('No redis connection passed in');
        }
        if (!config.pipelineFactory) {
            throw new Error('No PipelineFactory instance passed in');
        }

        const breaker = Object.assign({}, config.breaker || {});

        super();

        this.prefix = config.prefix || '';
        this.buildQueue = `${this.prefix}builds`;
        this.periodicBuildQueue = `${this.prefix}periodicBuilds`;
        this.frozenBuildQueue = `${this.prefix}frozenBuilds`;
        this.buildConfigTable = `${this.prefix}buildConfigs`;
        this.periodicBuildTable = `${this.prefix}periodicBuildConfigs`;
        this.frozenBuildTable = `${this.prefix}frozenBuildConfigs`;
        this.tokenGen = null;
        this.userTokenGen = null;
        this.pipelineFactory = config.pipelineFactory;
        this.timeoutQueue = `${this.prefix}timeoutConfigs`;

        const redisConnection = Object.assign({}, config.redisConnection, { pkg: 'ioredis' });

        this.redis = new Redis(
            redisConnection.port,
            redisConnection.host,
            redisConnection.options
        );

        // eslint-disable-next-line new-cap
        this.queue = new Resque.Queue({ connection: redisConnection });
        this.queueBreaker = new Breaker((funcName, ...args) => {
            const callback = args.pop();

            this.queue[funcName](...args)
                .then((...results) => callback(null, ...results))
                .catch(callback);
        }, breaker);
        this.redisBreaker = new Breaker((funcName, ...args) =>
            // Use the queue's built-in connection to send redis commands instead of instantiating a new one
            this.redis[funcName](...args), breaker);
        this.requestRetryStrategy = (err, response) =>
            !!err || (response.statusCode !== 201 && response.statusCode !== 200);
        this.requestRetryStrategyPostEvent = (err, response) =>
            !!err || (response.statusCode !== 201 && response.statusCode !== 200
                && response.statusCode !== 404); // postEvent can return 404 if no job to start
        this.fuseBox = new FuseBox();
        this.fuseBox.addFuse(this.queueBreaker);
        this.fuseBox.addFuse(this.redisBreaker);

        const retryOptions = {
            plugins: ['Retry'],
            pluginOptions: {
                Retry: {
                    retryLimit: RETRY_LIMIT,
                    retryDelay: RETRY_DELAY
                }
            }
        };
        // Jobs object to register the worker with
        const jobs = {
            startDelayed: Object.assign({
                perform: async (jobConfig) => {
                    try {
                        const fullConfig = await this.redisBreaker
                            .runCommand('hget', this.periodicBuildTable, jobConfig.jobId);

                        return await this.startPeriodic(
                            Object.assign(JSON.parse(fullConfig), { triggerBuild: true }));
                    } catch (err) {
                        logger.error('err in startDelayed job: ', err);
                        throw err;
                    }
                }
            }, retryOptions),
            startFrozen: Object.assign({
                perform: async (jobConfig) => {
                    try {
                        const fullConfig = await this.redisBreaker
                            .runCommand('hget', this.frozenBuildTable, jobConfig.jobId);

                        return await this.startFrozen(JSON.parse(fullConfig));
                    } catch (err) {
                        logger.error('err in startFrozen job: ', err);
                        throw err;
                    }
                }
            }, retryOptions)
        };

        // eslint-disable-next-line new-cap
        this.multiWorker = new Resque.MultiWorker({
            connection: redisConnection,
            queues: [this.periodicBuildQueue, this.frozenBuildQueue],
            minTaskProcessors: 1,
            maxTaskProcessors: 10,
            checkTimeout: 1000,
            maxEventLoopDelay: 10,
            toDisconnectProcessors: true
        }, jobs);
        // eslint-disable-next-line new-cap
        this.scheduler = new Resque.Scheduler({ connection: redisConnection });

        this.multiWorker.on('start', workerId =>
            logger.info(`worker[${workerId}] started`));
        this.multiWorker.on('end', workerId =>
            logger.info(`worker[${workerId}] ended`));
        this.multiWorker.on('cleaning_worker', (workerId, worker, pid) =>
            logger.info(`cleaning old worker ${worker} pid ${pid}`));
        this.multiWorker.on('job', (workerId, queue, job) =>
            logger.info(`worker[${workerId}] working job ${queue} ${JSON.stringify(job)}`));
        this.multiWorker.on('reEnqueue', (workerId, queue, job, plugin) =>
            // eslint-disable-next-line max-len
            logger.info(`worker[${workerId}] reEnqueue job (${plugin}) ${queue} ${JSON.stringify(job)}`));
        this.multiWorker.on('success', (workerId, queue, job, result) =>
            // eslint-disable-next-line max-len
            logger.info(`worker[${workerId}] job success ${queue} ${JSON.stringify(job)} >> ${result}`));
        this.multiWorker.on('failure', (workerId, queue, job, failure) =>
            // eslint-disable-next-line max-len
            logger.info(`worker[${workerId}] job failure ${queue} ${JSON.stringify(job)} >> ${failure}`));
        this.multiWorker.on('error', (workerId, queue, job, error) =>
            logger.error(`worker[${workerId}] error ${queue} ${JSON.stringify(job)} >> ${error}`));

        // multiWorker emitters
        this.multiWorker.on('internalError', error =>
            logger.error(error));

        this.scheduler.on('start', () =>
            logger.info('scheduler started'));
        this.scheduler.on('end', () =>
            logger.info('scheduler ended'));
        this.scheduler.on('master', state =>
            logger.info(`scheduler became master ${state}`));
        this.scheduler.on('error', error =>
            logger.info(`scheduler error >> ${error}`));
        this.scheduler.on('workingTimestamp', timestamp =>
            logger.info(`scheduler working timestamp ${timestamp}`));
        this.scheduler.on('transferredJob', (timestamp, job) =>
            logger.info(`scheduler enqueuing job timestamp  >>  ${JSON.stringify(job)}`));

        this.multiWorker.start();
        this.scheduler.connect().then(() => this.scheduler.start());
    }

    /**
     * Cleanup any reladed processing
     */
    async cleanUp() {
        try {
            await this.multiWorker.end();
            await this.scheduler.end();
            await this.queue.end();
        } catch (err) {
            logger.error(`failed to end executor queue: ${err}`);
        }
    }

    /**
     * Posts a new build event to the API
     * @method postBuildEvent
     * @param {Object} config           Configuration
     * @param {Number} [config.eventId] Optional Parent event ID (optional)
     * @param {Number} config.buildId   Freezed build id
     * @param {Object} config.pipeline  Pipeline of the job
     * @param {Object} config.job       Job object to create periodic builds for
     * @param {String} config.apiUri    Base URL of the Screwdriver API
     * @return {Promise}
     */
    async postBuildEvent({ pipeline, job, apiUri, eventId, buildId, causeMessage }) {
        const pipelineInstance = await this.pipelineFactory.get(pipeline.id);
        const admin = await pipelineInstance.getFirstAdmin();
        const jwt = this.userTokenGen(admin.username, {}, pipeline.scmContext);

        logger.info(`POST event for pipeline ${pipeline.id}:${job.name}` +
            `using user ${admin.username}`);
        const options = {
            url: `${apiUri}/v4/events`,
            method: 'POST',
            headers: {
                Authorization: `Bearer ${jwt}`,
                'Content-Type': 'application/json'
            },
            json: true,
            body: {
                pipelineId: pipeline.id,
                startFrom: job.name,
                creator: {
                    name: 'Screwdriver scheduler',
                    username: 'sd:scheduler'
                },
                causeMessage: causeMessage || 'Automatically started by scheduler'
            },
            maxAttempts: RETRY_LIMIT,
            retryDelay: RETRY_DELAY * 1000, // in ms
            retryStrategy: this.requestRetryStrategyPostEvent
        };

        if (eventId) {
            options.body.parentEventId = eventId;
        }

        if (buildId) {
            options.body.buildId = buildId;
        }

        return new Promise((resolve, reject) => {
            requestretry(options, (err, response) => {
                if (!err && response.statusCode === 201) {
                    return resolve(response);
                }
                if (response.statusCode !== 201) {
                    return reject(JSON.stringify(response.body));
                }

                return reject(err);
            });
        });
    }

    async updateBuildStatus({ buildId, status, statusMessage, token, apiUri }) {
        const options = {
            json: true,
            method: 'PUT',
            uri: `${apiUri}/v4/builds/${buildId}`,
            body: {
                status,
                statusMessage
            },
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            maxAttempts: RETRY_LIMIT,
            retryDelay: RETRY_DELAY * 1000, // in ms
            retryStrategy: this.requestRetryStrategy
        };

        return new Promise((resolve, reject) => {
            requestretry(options, (err, response) => {
                if (!err && response.statusCode === 200) {
                    return resolve(response);
                }

                if (response.statusCode !== 200) {
                    return reject(JSON.stringify(response.body));
                }

                return reject(err);
            });
        });
    }

    /**
     * Starts a new periodic build in an executor
     * @method _startPeriodic
     * @param {Object}   config              Configuration
     * @param {Object}   config.pipeline     Pipeline of the job
     * @param {Object}   config.job          Job object to create periodic builds for
     * @param {String}   config.apiUri       Base URL of the Screwdriver API
     * @param {Function} config.tokenGen     Function to generate JWT from username, scope and scmContext
     * @param {Boolean}  config.isUpdate     Boolean to determine if updating existing periodic build
     * @param {Boolean}  config.triggerBuild Flag to post new build event
     * @return {Promise}
     */
    async _startPeriodic(config) {
        const { pipeline, job, tokenGen, isUpdate, triggerBuild } = config;
        // eslint-disable-next-line max-len
        const buildCron = hoek.reach(job, 'permutations>0>annotations>screwdriver.cd/buildPeriodically',
            { separator: '>' });

        // Save tokenGen to current executor object so we can access it in postBuildEvent
        if (!this.userTokenGen) {
            this.userTokenGen = tokenGen;
        }

        if (isUpdate) {
            // eslint-disable-next-line no-underscore-dangle
            await this._stopPeriodic({ jobId: job.id });
        }

        if (triggerBuild) {
            config.causeMessage = 'Started by periodic build scheduler';

            // Even if post event failed for this event after retry, we should still enqueue the next event
            try {
                await this.postBuildEvent(config);
            } catch (err) {
                logger.error('periodic builds: failed to post build event for job'
                    + `${job.id} in pipeline ${pipeline.id}: ${err}`);
            }
        }

        if (buildCron && job.state === 'ENABLED' && !job.archived) {
            await this.connect();

            const next = cron.next(cron.transform(buildCron, job.id));

            // Store the config in redis
            await this.redisBreaker.runCommand('hset', this.periodicBuildTable,
                job.id, JSON.stringify(Object.assign(config, {
                    isUpdate: false,
                    triggerBuild: false
                })));

            // Note: arguments to enqueueAt are [timestamp, queue name, job name, array of args]
            let shouldRetry = false;

            try {
                await this.queue.enqueueAt(next, this.periodicBuildQueue,
                    'startDelayed', [{ jobId: job.id }]);
            } catch (err) {
                // Error thrown by node-resque if there is duplicate: https://github.com/taskrabbit/node-resque/blob/master/lib/queue.js#L65
                // eslint-disable-next-line max-len
                if (err && err.message !== 'Job already enqueued at this time with same arguments') {
                    shouldRetry = true;
                }
            }
            if (!shouldRetry) {
                return Promise.resolve();
            }
            try {
                await this.queueBreaker.runCommand('enqueueAt', next,
                    this.periodicBuildQueue, 'startDelayed', [{ jobId: job.id }]);
            } catch (err) {
                logger.error(`failed to add to delayed queue for job ${job.id}: ${err}`);
            }
        }

        return Promise.resolve();
    }

    /**
     * Stops a previously scheduled periodic build in an executor
     * @async  _stopPeriodic
     * @param  {Object}  config        Configuration
     * @param  {Integer} config.jobId  ID of the job with periodic builds
     * @return {Promise}
     */
    async _stopPeriodic(config) {
        await this.connect();

        await this.queueBreaker.runCommand('delDelayed', this.periodicBuildQueue, 'startDelayed', [{
            jobId: config.jobId
        }]);

        return this.redisBreaker.runCommand('hdel', this.periodicBuildTable, config.jobId);
    }

    /**
     * Calls postBuildEvent() with job configuration
     * @async _startFrozen
     * @param {Object} config       Configuration
     * @return {Promise}
     */
    async _startFrozen(config) {
        const newConfig = {
            job: {
                name: config.jobName
            },
            causeMessage: 'Started by freeze window scheduler'
        };

        if (config.jobState === 'DISABLED' || config.jobArchived === true) {
            logger.error(`job ${config.jobName} is disabled or archived`);

            return Promise.resolve();
        }

        Object.assign(newConfig, config);

        return this.postBuildEvent(newConfig)
            .catch((err) => {
                logger.error('frozen builds: failed to post build event for job'
                    + `${config.jobId}:${config.pipeline.id} ${err}`);

                return Promise.resolve();
            });
    }

    /**
     * Stops a previously enqueued frozen build in an executor
     * @async  stopFrozen
     * @param  {Object}  config        Configuration
     * @param  {Integer} config.jobId  ID of the job with frozen builds
     * @return {Promise}
     */
    async _stopFrozen(config) {
        await this.connect();

        await this.queueBreaker.runCommand('delDelayed', this.frozenBuildQueue, 'startFrozen', [{
            jobId: config.jobId
        }]);

        return this.redisBreaker.runCommand('hdel', this.frozenBuildTable, config.jobId);
    }

    /**
     * Adds start time of a build to timeout queue
     * @method status
     * @param  {Object} config               Configuration
     * @param  {String} config.buildId       Unique ID for a build
     * @param  {String} config.startTime     Start time fo build
     * @param  {String} config.buildStatus     Status of build
     * @return {Promise}
     */
    async _startTimer(config) {
        try {
            await this.connect();
            const {
                buildId,
                jobId,
                buildStatus,
                startTime
            } = config;

            if (buildStatus === 'RUNNING') {
                const buildTimeout = hoek.reach(config, 'annotations>screwdriver.cd/timeout',
                    { separator: '>' });
                const timeout = parseInt(buildTimeout || DEFAULT_BUILD_TIMEOUT, 10);

                const data = await this.redisBreaker.runCommand('hget', this.timeoutQueue, buildId);

                if (data) {
                    return Promise.resolve();
                }

                return await this.redisBreaker.runCommand('hset', this.timeoutQueue, buildId,
                    JSON.stringify({
                        jobId,
                        startTime,
                        timeout
                    }));
            }

            return Promise.resolve();
        } catch (err) {
            logger.error(`Error occurred while saving to timeout queue ${err}`);

            return Promise.resolve();
        }
    }

    /**
     * Removes start time info key from timeout queue
     * @method status
     * @param  {Object} config               Configuration
     * @param  {String} config.buildId       Unique ID for a build
     * @return {Promise}
     */
    async _stopTimer(config) {
        try {
            await this.connect();

            const data = await this.redisBreaker.runCommand('hget', this.timeoutQueue,
                config.buildId);

            if (!data) {
                return Promise.resolve();
            }

            return await this.redisBreaker.runCommand('hdel', this.timeoutQueue, config.buildId);
        } catch (err) {
            logger.error(`Error occurred while removing from timeout queue ${err}`);

            return Promise.resolve();
        }
    }

    /**
     * Starts a new build in an executor
     * @async  _start
     * @param  {Object} config               Configuration
     * @param  {Object} [config.annotations] Optional key/value object
     * @param  {Number} [config.eventId]     Optional eventID that this build belongs to
     * @param  {String} config.build         Build object
     * @param  {Array}  config.blockedBy     Array of job IDs that this job is blocked by. Always blockedby itself
     * @param  {String} config.causeMessage  Reason the event is run
     * @param  {Array}  config.freezeWindows Array of cron expressions that this job cannot run during
     * @param  {String} config.apiUri        Screwdriver's API
     * @param  {String} config.jobId         JobID that this build belongs to
     * @param  {String} config.jobName       Name of job that this build belongs to
     * @param  {String} config.jobState      ENABLED/DISABLED
     * @param  {String} config.jobArchived   Boolean value of whether job is archived
     * @param  {String} config.buildId       Unique ID for a build
     * @param  {Object} config.pipeline      Pipeline of the job
     * @param  {Fn}     config.tokenGen      Function to generate JWT from username, scope and scmContext
     * @param  {String} config.container     Container for the build to run in
     * @param  {String} config.token         JWT to act on behalf of the build
     * @return {Promise}
     */
    async _start(config) {
        await this.connect();
        const {
            build,
            buildId,
            causeMessage,
            jobId,
            jobState,
            jobArchived,
            blockedBy,
            freezeWindows,
            token,
            apiUri
        } = config;
        const forceStart = /\[(force start)\]/.test(causeMessage);

        if (!this.tokenGen) {
            this.tokenGen = config.tokenGen;
        }

        delete config.build;
        delete config.causeMessage;

        // eslint-disable-next-line no-underscore-dangle
        await this._stopFrozen({
            jobId
        });

        // Skip if job is disabled or archived
        if (jobState === 'DISABLED' || jobArchived === true) {
            return Promise.resolve();
        }

        const currentTime = new Date();
        const origTime = new Date(currentTime.getTime());

        timeOutOfWindows(freezeWindows, currentTime);

        let enq;

        // Check freeze window
        if (currentTime.getTime() > origTime.getTime() && !forceStart) {
            await this.updateBuildStatus({
                buildId,
                token,
                apiUri,
                status: 'FROZEN',
                statusMessage: `Blocked by freeze window, re-enqueued to ${currentTime}`
            }).catch((err) => {
                logger.error(`failed to update build status for build ${buildId}: ${err}`);

                return Promise.resolve();
            });

            // Remove old job from queue to collapse builds
            await this.queueBreaker.runCommand('delDelayed', this.frozenBuildQueue,
                'startFrozen', [{
                    jobId
                }]);

            await this.redisBreaker.runCommand('hset', this.frozenBuildTable,
                jobId, JSON.stringify(config));

            // Add new job back to queue
            enq = await this.queueBreaker.runCommand('enqueueAt', currentTime.getTime(),
                this.frozenBuildQueue, 'startFrozen', [{
                    jobId
                }]
            );
        } else {
            // set the start time in the queue
            Object.assign(config, { enqueueTime: new Date() });
            // Store the config in redis
            await this.redisBreaker.runCommand('hset', this.buildConfigTable,
                buildId, JSON.stringify(config));

            // Note: arguments to enqueue are [queue name, job name, array of args]
            enq = await this.queueBreaker.runCommand('enqueue', this.buildQueue, 'start', [{
                buildId,
                jobId,
                blockedBy: blockedBy.toString()
            }]);
        }

        // for backward compatibility
        if (build && build.stats) {
            // need to reassign so the field can be dirty
            build.stats = hoek.merge(build.stats, { queueEnterTime: (new Date()).toISOString() });
            await build.update();
        }

        return enq;
    }

    /**
     * Stop a running or finished build
     * @async  _stop
     * @param  {Object} config               Configuration
     * @param  {Array}  config.blockedBy     Array of job IDs that this job is blocked by. Always blockedby itself
     * @param  {String} config.buildId       Unique ID for a build
     * @param  {String} config.jobId         JobID that this build belongs to
     * @return {Promise}
     */
    async _stop(config) {
        await this.connect();

        const { buildId, jobId } = config; // in case config contains something else

        let blockedBy;

        if (config.blockedBy !== undefined) {
            blockedBy = config.blockedBy.toString();
        }

        const numDeleted = await this.queueBreaker.runCommand('del', this.buildQueue, 'start', [{
            buildId,
            jobId,
            blockedBy
        }]);
        const deleteKey = `deleted_${jobId}_${buildId}`;
        let started = true;

        // This is to prevent the case where a build is aborted while still in buildQueue
        // The job might be picked up by the worker, so it's not deleted from buildQueue here
        // Immediately after, the job gets put back to the queue, so it's always inside buildQueue
        // This key will be cleaned up automatically or when it's picked up by the worker
        await this.redisBreaker.runCommand('set', deleteKey, '');
        await this.redisBreaker.runCommand('expire', deleteKey, EXPIRE_TIME);

        if (numDeleted !== 0) { // build hasn't started
            started = false;
        }

        return this.queueBreaker.runCommand('enqueue', this.buildQueue, 'stop', [{
            buildId,
            jobId,
            blockedBy,
            started // call executor.stop if the job already started
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
