'use strict';

/* eslint-disable no-underscore-dangle */

const chai = require('chai');
const { assert } = chai;
const mockery = require('mockery');
const sinon = require('sinon');
const testConfig = require('./data/fullConfig.json');
const testPipeline = require('./data/testPipeline.json');
const testJob = require('./data/testJob.json');

sinon.assert.expose(chai.assert, { prefix: '' });

describe('index test', () => {
    let Executor;
    let executor;
    let mockRequest;
    let requestOptions;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        Object.assign(testConfig, {
            pipeline: testPipeline,
            apiUri: 'http://localhost:3000',
            token: 'admintoken'
        });
        mockRequest = sinon.stub();
        mockery.registerMock('requestretry', mockRequest);

        /* eslint-disable global-require */
        Executor = require('../index');
        /* eslint-enable global-require */

        executor = new Executor({
            ecosystem: {
                queue: 'http://localhost'
            }
        });
        requestOptions = {
            headers: {
                Authorization: 'Bearer admintoken',
                'Content-Type': 'application/json'
            },
            json: true,
            body: testConfig,
            maxAttempts: 3,
            retryDelay: 5000,
            retryStrategy: executor.requestRetryStrategy
        };
    });

    afterEach(() => {
        mockery.deregisterAll();
        mockery.resetCache();
    });

    after(() => {
        mockery.disable();
    });

    describe('construction', () => {
        it('constructs the executor', () => {
            assert.instanceOf(executor, Executor);
        });

        it('sets the queue uri', () => {
            assert.instanceOf(executor, Executor);
            assert.strictEqual(executor.queueUri, 'http://localhost');
        });
    });

    describe('_startPeriodic', done => {
        it('Calls api to start periodic build', () => {
            mockRequest.yieldsAsync(null, { statusCode: 200 });
            const periodicConfig = { ...testConfig, username: 'admin', pipeline: { id: 123 }, job: { id: 777 } };

            const options = {
                ...requestOptions,
                url: 'http://localhost/v1/queue/message?type=periodic',
                method: 'POST',
                body: periodicConfig
            };

            return executor.startPeriodic(periodicConfig, err => {
                assert.calledWithArgs(mockRequest, periodicConfig, options);
                assert.isNull(err);
                done();
            });
        });
    });

    describe('_stopPeriodic', done => {
        it('Calls api to stop periodic build', () => {
            mockRequest.yieldsAsync(null, { statusCode: 200 });

            const options = {
                ...requestOptions,
                url: 'http://localhost/v1/queue/message?type=periodic',
                method: 'DELETE',
                body: testConfig
            };

            return executor.stopPeriodic(testConfig, err => {
                assert.calledWithArgs(mockRequest, testConfig, options);
                assert.isNull(err);
                done();
            });
        });
    });

    describe('_start', done => {
        it('Calls api to start build', () => {
            mockRequest.yieldsAsync(null, { statusCode: 200 });
            const startConfig = { ...testConfig, pipeline: testPipeline };

            Object.assign(requestOptions, {
                url: 'http://localhost/v1/queue/message',
                method: 'POST',
                body: startConfig
            });

            return executor.start(startConfig, err => {
                assert.calledWithArgs(mockRequest, startConfig, requestOptions);
                assert.isNull(err);
                done();
            });
        });
    });

    describe('_startFrozen', done => {
        it('Calls api to start frozen build', () => {
            mockRequest.yieldsAsync(null, { statusCode: 200 });

            Object.assign(requestOptions, {
                url: 'http://localhost/v1/queue/message?type=frozen',
                method: 'POST',
                body: testConfig
            });

            return executor.startFrozen(testConfig, err => {
                assert.calledWithArgs(mockRequest, testConfig, requestOptions);
                assert.isNull(err);
                done();
            });
        });
    });

    describe('_stopFrozen', done => {
        it('Calls api to stop frozen builds', () => {
            mockRequest.yieldsAsync(null, { statusCode: 200 });

            Object.assign(requestOptions, {
                url: 'http://localhost/v1/queue/message?type=frozen',
                method: 'DELETE',
                body: testConfig
            });

            return executor.stopFrozen(testConfig, err => {
                assert.calledWithArgs(mockRequest, testConfig, requestOptions);
                assert.isNull(err);
                done();
            });
        });
    });

    describe('_stop', done => {
        it('Calls api to stop a build', () => {
            mockRequest.yieldsAsync(null, { statusCode: 200 });
            const stopConfig = {
                annotations: testConfig.annotations,
                blockedBy: testConfig.blockedBy,
                freezeWindows: testConfig.freezeWindows,
                buildId: testConfig.buildId,
                buildClusterName: testConfig.buildClusterName,
                jobId: testConfig.jobId,
                token: testConfig.token,
                pipelineId: testConfig.pipelineId
            };

            Object.assign(requestOptions, {
                url: 'http://localhost/v1/queue/message',
                method: 'DELETE',
                body: stopConfig
            });

            executor.stop(stopConfig, err => {
                assert.calledWithArgs(mockRequest, stopConfig, requestOptions);
                assert.isNull(err);
                done();
            });
        });
    });

    describe('stats', done => {
        it('Calls api to get stats', () => {
            mockRequest.yieldsAsync(null, { statusCode: 200 });
            const statsConfig = {
                buildId: testConfig.buildId,
                jobId: testConfig.jobId,
                token: testConfig.token,
                pipelineId: testConfig.pipelineId
            };

            Object.assign(requestOptions, {
                url: 'http://localhost/v1/queue/message',
                method: 'GET'
            });

            return executor.stats(statsConfig, err => {
                assert.calledWithArgs(mockRequest, {}, requestOptions);
                assert.isNull(err);
                done();
            });
        });
    });

    describe('_stopTimer', done => {
        it('Calls api to stop timer', () => {
            mockRequest.yieldsAsync(null, { statusCode: 200 });
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const sandbox = sinon.sandbox.create({
                useFakeTimers: false
            });

            const timerConfig = {
                buildId: testConfig.buildId,
                jobId: testConfig.jobId,
                startTime: isoTime,
                job: testJob,
                pipeline: testPipeline,
                pipelineId: testPipeline.id
            };

            sandbox.useFakeTimers(dateNow);
            Object.assign(requestOptions, {
                url: 'http://localhost/v1/queue/message?type=timer',
                method: 'DELETE',
                body: timerConfig
            });

            return executor.stopTimer(timerConfig, err => {
                assert.calledWithArgs(mockRequest, timerConfig, requestOptions);
                assert.isNull(err);
                done();
                sandbox.restore();
            });
        });
    });

    describe('_startTimer', done => {
        it('Calls api to start timer', () => {
            mockRequest.yieldsAsync(null, { statusCode: 200 });
            const dateNow = Date.now();
            const isoTime = new Date(dateNow).toISOString();
            const sandbox = sinon.sandbox.create({
                useFakeTimers: false
            });

            const timerConfig = {
                buildId: testConfig.buildId,
                jobId: testConfig.jobId,
                startTime: isoTime,
                job: testJob,
                pipeline: testPipeline,
                pipelineId: testPipeline.id
            };

            sandbox.useFakeTimers(dateNow);
            Object.assign(requestOptions, {
                url: 'http://localhost/v1/queue/message?type=timer',
                method: 'POST',
                body: testConfig
            });

            return executor.startTimer(timerConfig, err => {
                assert.calledWithArgs(mockRequest, timerConfig, requestOptions);
                assert.isNull(err);
                done();
                sandbox.restore();
            });
        });
    });
});
