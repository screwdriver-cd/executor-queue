'use strict';

const Executor = require('screwdriver-executor-base');
const logger = require('screwdriver-logger');
const requestretry = require('requestretry');
const RETRY_LIMIT = 3;
const RETRY_DELAY = 5;

class ExecutorQueue extends Executor {
    constructor(config = {}) {
        super();
        this.requestRetryStrategy = (err, response) =>
            !!err || (response.statusCode !== 201 && response.statusCode !== 200);
        this.queueUri = config.ecosystem.queueUri;
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
        return this.api(config, {
            path: '/v1/queue/message?type=periodic',
            method: 'POST',
            body: config
        });
    }

    /**
     * Stops a previously scheduled periodic build in an executor
     * @async  _stopPeriodic
     * @param  {Object}  config        Configuration
     * @param  {Integer} config.jobId  ID of the job with periodic builds
     * @return {Promise}
     */
    async _stopPeriodic(config) {
        return this.api(config, {
            path: '/v1/queue/message?type=periodic',
            method: 'DELETE',
            body: config
        });
    }

    /**
     * Calls postBuildEvent() with job configuration
     * @async _startFrozen
     * @param {Object} config       Configuration
     * @return {Promise}
     */
    async _startFrozen(config) {
        return this.api(config, {
            path: '/v1/queue/message?type=frozen',
            method: 'POST',
            body: config
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
        return this.api(config, {
            path: '/v1/queue/message?type=frozen',
            method: 'DELETE',
            body: config
        });
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
        return this.api(config, {
            path: '/v1/queue/message?type=timer',
            method: 'POST',
            body: config
        });
    }

    /**
     * Removes start time info key from timeout queue
     * @method status
     * @param  {Object} config               Configuration
     * @param  {String} config.buildId       Unique ID for a build
     * @return {Promise}
     */
    async _stopTimer(config) {
        return this.api(config, {
            path: '/v1/queue/message?type=timer',
            method: 'DELETE',
            body: config
        });
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
        return this.api(config, {
            path: '/v1/queue/message',
            method: 'POST',
            body: config
        });
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
        return this.api(config, {
            path: '/v1/queue/message',
            method: 'POST',
            body: config
        });
    }

    /**
     * Retrieve stats for the executor
     * @method stats
     * @param {Response} Object     Object containing stats for the executor
     */
    stats(config) {
        return this.api(config, {
            path: '/v1/queue/stats',
            method: 'GET'
        });
    }

    /**
     * Makes api call to the url endpoint
     * @async api
     * @param {Object} options
     * @param {Object} config
     * @return Promise.resolve
     */
    async api(config, options) {
        const addionalOptions = {
            headers: {
                Authorization: `Bearer ${config.token}`,
                'Content-Type': 'application/json'
            },
            url: `${this.queueUri}${options.path}`,
            json: true,
            maxAttempts: RETRY_LIMIT,
            retryDelay: RETRY_DELAY * 1000, // in ms
            retryStrategy: this.requestRetryStrategy
        };

        Object.assign({}, addionalOptions, options);

        logger.info(`${options.method} ${options.path} for pipeline ` +
            `${config.pipelineId}:${config.jobId}`);

        return new Promise((resolve, reject) => {
            requestretry(options, (err, response) => {
                if (!err && response.statusCode === 200) {
                    return resolve(response);
                }
                if (response.statusCode !== 201) {
                    return reject(JSON.stringify(response.body));
                }

                return reject(err);
            });
        });
    }
}

module.exports = ExecutorQueue;
