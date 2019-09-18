'use strict';

/* eslint-disable no-underscore-dangle */

const chai = require('chai');
const util = require('util');
const assert = chai.assert;
const mockery = require('mockery');
const sinon = require('sinon');
const testConnection = require('./data/testConnection.json');
const testConfig = require('./data/fullConfig.json');
const testPipeline = require('./data/testPipeline.json');
const testJob = require('./data/testJob.json');
const { buildId, jobId, blockedBy } = testConfig;
const partialTestConfig = {
    buildId,
    jobId,
    blockedBy
};
const partialTestConfigToString = Object.assign({}, partialTestConfig, {
    blockedBy: blockedBy.toString() });
const testAdmin = {
    username: 'admin'
};

const EventEmitter = require('events').EventEmitter;

sinon.assert.expose(chai.assert, { prefix: '' });

describe('index test', () => {
    let Executor;
    let executor;
    let multiWorker;
    let spyMultiWorker;
    let scheduler;
    let spyScheduler;
    let resqueMock;
    let queueMock;
    let redisMock;
    let redisConstructorMock;
    let cronMock;
    let freezeWindowsMock;
    let winstonMock;
    let reqMock;
    let pipelineMock;
    let buildMock;
    let pipelineFactoryMock;
    let fakeResponse;
    let fakeGetResponse;
    let userTokenGen;
    let testDelayedConfig;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        userTokenGen = sinon.stub().returns('admintoken');
        testDelayedConfig = {
            pipeline: testPipeline,
            job: testJob,
            apiUri: 'http://localhost',
            tokenGen: userTokenGen
        };
        multiWorker = function () {
            this.start = () => {};
            this.end = sinon.stub().resolves();
        };
        scheduler = function () {
            this.start = sinon.stub().resolves();
            this.connect = sinon.stub().resolves();
            this.end = sinon.stub().resolves();
        };
        util.inherits(multiWorker, EventEmitter);
        util.inherits(scheduler, EventEmitter);
        queueMock = {
            connect: sinon.stub().resolves(),
            enqueue: sinon.stub().resolves(),
            enqueueAt: sinon.stub().resolves(),
            del: sinon.stub().resolves(1),
            delDelayed: sinon.stub().resolves(1),
            connection: {
                connected: false
            }
        };
        resqueMock = {
            Queue: sinon.stub().returns(queueMock),
            MultiWorker: multiWorker,
            Scheduler: scheduler
        };
        spyMultiWorker = sinon.spy(resqueMock, 'MultiWorker');
        spyScheduler = sinon.spy(resqueMock, 'Scheduler');
        winstonMock = {
            info: sinon.stub(),
            error: sinon.stub()
        };
        redisMock = {
            hdel: sinon.stub().yieldsAsync(),
            hset: sinon.stub().yieldsAsync(),
            set: sinon.stub().yieldsAsync(),
            expire: sinon.stub().yieldsAsync()
        };
        redisConstructorMock = sinon.stub().returns(redisMock);
        cronMock = {
            transform: sinon.stub().returns('H H H H H'),
            next: sinon.stub().returns(1500000)
        };
        freezeWindowsMock = {
            timeOutOfWindows: (windows, date) => date
        };
        fakeGetResponse = {
            statusCode: 200,
            body: {
                id: '1763',
                state: 'ENABLED',
                archived: false
            }
        };
        fakeResponse = {
            statusCode: 201,
            body: {
                id: '12345'
            }
        };
        reqMock = sinon.stub();
        pipelineMock = {
            getFirstAdmin: sinon.stub().resolves(testAdmin)
        };
        pipelineFactoryMock = {
            get: sinon.stub().resolves(pipelineMock)
        };
        buildMock = {
            update: sinon.stub().resolves({
                id: buildId
            })
        };

        mockery.registerMock('node-resque', resqueMock);
        mockery.registerMock('ioredis', redisConstructorMock);
        mockery.registerMock('./lib/cron', cronMock);
        mockery.registerMock('./lib/freezeWindows', freezeWindowsMock);
        mockery.registerMock('winston', winstonMock);
        mockery.registerMock('requestretry', reqMock);

        /* eslint-disable global-require */
        Executor = require('../index');
        /* eslint-enable global-require */

        executor = new Executor({
            redisConnection: testConnection,
            breaker: {
                retry: {
                    retries: 1
                }
            },
            pipelineFactory: pipelineFactoryMock
        });
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

        it('constructs the multiWorker', () => {
            const expectedConfig = {
                connection: testConnection,
                queues: ['periodicBuilds', 'frozenBuilds'],
                minTaskProcessors: 1,
                maxTaskProcessors: 10,
                checkTimeout: 1000,
                maxEventLoopDelay: 10,
                toDisconnectProcessors: true
            };

            assert.calledWith(spyMultiWorker, sinon.match(expectedConfig), sinon.match.any);
        });

        it('constructs the scheduler', () => {
            const expectedConfig = {
                connection: testConnection
            };

            assert.calledWith(spyScheduler, sinon.match(expectedConfig));
        });

        it('constructs the executor when no breaker config is passed in', () => {
            executor = new Executor({
                redisConnection: testConnection,
                pipelineFactory: pipelineFactoryMock
            });

            assert.instanceOf(executor, Executor);
        });

        it('takes in a prefix', () => {
            executor = new Executor({
                redisConnection: testConnection,
                prefix: 'beta_',
                pipelineFactory: pipelineFactoryMock
            });

            assert.instanceOf(executor, Executor);
            assert.strictEqual(executor.prefix, 'beta_');
            assert.strictEqual(executor.buildQueue, 'beta_builds');
            assert.strictEqual(executor.buildConfigTable, 'beta_buildConfigs');
        });

        it('throws when not given a redis connection', () => {
            assert.throws(() => new Executor(), 'No redis connection passed in');
        });

        it('throws when not given a pipelineFactory', () => {
            assert.throws(() => new Executor({
                redisConnection: testConnection
            }));
        });
    });

    describe('_startPeriodic', () => {
        beforeEach(() => {
            reqMock.yieldsAsync(null, fakeResponse, fakeResponse.body);
        });
        it('rejects if it can\'t establish a connection', function () {
            queueMock.connect.rejects(new Error('couldn\'t connect'));

            return executor.startPeriodic(testDelayedConfig).then(() => {
                assert.fail('Should not get here');
            }, (err) => {
                assert.instanceOf(err, Error);
            });
        });

        it('doesn\'t call connect if there\'s already a connection', () => {
            queueMock.connection.connected = true;

            return executor.startPeriodic(testDelayedConfig).then(() => {
                assert.notCalled(queueMock.connect);
            });
        });

        it('enqueues a new delayed job in the queue', () =>
            executor.startPeriodic(testDelayedConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledWith(redisMock.hset, 'periodicBuildConfigs', testJob.id,
                    JSON.stringify(testDelayedConfig));
                assert.calledWith(cronMock.transform, '* * * * *', testJob.id);
                assert.calledWith(cronMock.next, 'H H H H H');
                assert.calledWith(queueMock.enqueueAt, 1500000, 'periodicBuilds', 'startDelayed', [{
                    jobId: testJob.id
                }]);
            }));

        it('do not enqueue the same delayed job in the queue', () => {
            const err = new Error('Job already enqueued at this time with same arguments');

            queueMock.enqueueAt = sinon.stub().rejects(err);

            return executor.startPeriodic(testDelayedConfig).then(() => {
                assert.calledWith(cronMock.next, 'H H H H H');
                assert.calledOnce(queueMock.enqueueAt);
            });
        });

        it('stops and reEnqueues an existing job if isUpdate flag is passed', () => {
            testDelayedConfig.isUpdate = true;

            return executor.startPeriodic(testDelayedConfig).then(() => {
                assert.calledTwice(queueMock.connect);
                assert.calledWith(redisMock.hset, 'periodicBuildConfigs', testJob.id,
                    JSON.stringify(testDelayedConfig));
                assert.calledWith(queueMock.enqueueAt, 1500000, 'periodicBuilds', 'startDelayed', [{
                    jobId: testJob.id
                }]);
                assert.calledWith(queueMock.delDelayed, 'periodicBuilds', 'startDelayed', [{
                    jobId: testJob.id
                }]);
                assert.calledWith(redisMock.hdel, 'periodicBuildConfigs', testJob.id);
            });
        });

        it('stops but does not reEnqueue an existing job if it is disabled', () => {
            testDelayedConfig.isUpdate = true;
            testDelayedConfig.job.state = 'DISABLED';
            testDelayedConfig.job.archived = false;

            return executor.startPeriodic(testDelayedConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.notCalled(redisMock.hset);
                assert.notCalled(queueMock.enqueueAt);
                assert.calledWith(queueMock.delDelayed, 'periodicBuilds', 'startDelayed', [{
                    jobId: testJob.id
                }]);
                assert.calledWith(redisMock.hdel, 'periodicBuildConfigs', testJob.id);
            });
        });

        it('stops but does not reEnqueue an existing job if it is archived', () => {
            testDelayedConfig.isUpdate = true;
            testDelayedConfig.job.state = 'ENABLED';
            testDelayedConfig.job.archived = true;

            return executor.startPeriodic(testDelayedConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.notCalled(redisMock.hset);
                assert.notCalled(queueMock.enqueueAt);
                assert.calledWith(queueMock.delDelayed, 'periodicBuilds', 'startDelayed', [{
                    jobId: testJob.id
                }]);
                assert.calledWith(redisMock.hdel, 'periodicBuildConfigs', testJob.id);
            });
        });

        it('trigger build and do not enqueue next job if archived', () => {
            testDelayedConfig.isUpdate = true;
            testDelayedConfig.job.state = 'ENABLED';
            testDelayedConfig.job.archived = true;
            testDelayedConfig.triggerBuild = true;

            const options = {
                url: 'http://localhost/v4/events',
                method: 'POST',
                headers: {
                    Authorization: 'Bearer admintoken',
                    'Content-Type': 'application/json'
                },
                json: true,
                body: {
                    causeMessage: 'Started by periodic build scheduler',
                    creator: { name: 'Screwdriver scheduler', username: 'sd:scheduler' },
                    pipelineId: testDelayedConfig.pipeline.id,
                    startFrom: testDelayedConfig.job.name
                },
                maxAttempts: 3,
                retryDelay: 5000,
                retryStrategy: executor.requestRetryStrategyPostEvent
            };

            return executor.startPeriodic(testDelayedConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.notCalled(redisMock.hset);
                assert.notCalled(queueMock.enqueueAt);
                assert.calledWith(queueMock.delDelayed, 'periodicBuilds', 'startDelayed', [{
                    jobId: testJob.id
                }]);
                assert.calledWith(redisMock.hdel, 'periodicBuildConfigs', testJob.id);
                assert.calledOnce(userTokenGen);
                assert.calledWith(reqMock, options);
            });
        });

        it('trigger build and enqueue next job', () => {
            testDelayedConfig.isUpdate = false;
            testDelayedConfig.job.state = 'ENABLED';
            testDelayedConfig.job.archived = false;
            testDelayedConfig.triggerBuild = true;

            const options = {
                url: 'http://localhost/v4/events',
                method: 'POST',
                headers: {
                    Authorization: 'Bearer admintoken',
                    'Content-Type': 'application/json'
                },
                json: true,
                body: {
                    causeMessage: 'Started by periodic build scheduler',
                    creator: { name: 'Screwdriver scheduler', username: 'sd:scheduler' },
                    pipelineId: testDelayedConfig.pipeline.id,
                    startFrom: testDelayedConfig.job.name
                },
                maxAttempts: 3,
                retryDelay: 5000,
                retryStrategy: executor.requestRetryStrategyPostEvent
            };

            return executor.startPeriodic(testDelayedConfig).then(() => {
                assert.notCalled(queueMock.delDelayed);
                assert.calledOnce(userTokenGen);
                assert.calledWith(reqMock, options);
                assert.calledOnce(queueMock.connect);
                assert.calledWith(redisMock.hset, 'periodicBuildConfigs', testJob.id,
                    JSON.stringify(testDelayedConfig));
                assert.calledWith(cronMock.transform, '* * * * *', testJob.id);
                assert.calledWith(cronMock.next, 'H H H H H');
                assert.calledWith(queueMock.enqueueAt, 1500000, 'periodicBuilds', 'startDelayed', [{
                    jobId: testJob.id
                }]);
            });
        });
    });

    describe('_start', () => {
        it('rejects if it can\'t establish a connection', () => {
            queueMock.connect.rejects(new Error('couldn\'t connect'));

            return executor.start(testConfig).then(() => {
                assert.fail('Should not get here');
            }, (err) => {
                assert.instanceOf(err, Error);
            });
        });

        it('enqueues a build and caches the config', () => {
            const dateNow = Date.now();
            const isoTime = (new Date(dateNow)).toISOString();
            const sandbox = sinon.sandbox.create({
                useFakeTimers: false
            });

            sandbox.useFakeTimers(dateNow);
            buildMock.stats = {};
            testConfig.build = buildMock;

            return executor.start(testConfig).then(() => {
                assert.calledTwice(queueMock.connect);
                assert.calledWith(redisMock.hset, 'buildConfigs', buildId,
                    JSON.stringify(testConfig));
                assert.calledWith(queueMock.enqueue, 'builds', 'start',
                    [partialTestConfigToString]);
                assert.calledOnce(buildMock.update);
                assert.equal(buildMock.stats.queueEnterTime, isoTime);
                sandbox.restore();
            });
        }
        );

        it('enqueues a build and caches the config', () => executor.start(testConfig).then(() => {
            assert.calledTwice(queueMock.connect);
            assert.calledWith(redisMock.hset, 'buildConfigs', buildId,
                JSON.stringify(testConfig));
            assert.calledWith(queueMock.enqueue, 'builds', 'start', [partialTestConfigToString]);
        }));

        it('doesn\'t call connect if there\'s already a connection', () => {
            queueMock.connection.connected = true;

            return executor.start(testConfig).then(() => {
                assert.notCalled(queueMock.connect);
                assert.calledWith(queueMock.enqueue, 'builds', 'start',
                    [partialTestConfigToString]);
            });
        });
    });

    describe('_startFrozen', () => {
        it('enqueues a delayed job if in freeze window', () => {
            mockery.resetCache();
            reqMock.yieldsAsync(null, fakeResponse, fakeResponse.body);

            const freezeWindowsMockB = {
                timeOutOfWindows: (windows, date) => {
                    date.setUTCMinutes(date.getUTCMinutes() + 1);

                    return date;
                }
            };

            mockery.deregisterMock('./lib/freezeWindows');
            mockery.registerMock('./lib/freezeWindows', freezeWindowsMockB);

            /* eslint-disable global-require */
            Executor = require('../index');
            /* eslint-enable global-require */

            executor = new Executor({
                redisConnection: testConnection,
                breaker: {
                    retry: {
                        retries: 1
                    }
                },
                pipelineFactory: pipelineFactoryMock
            });

            const dateNow = new Date();

            const sandbox = sinon.sandbox.create({
                useFakeTimers: false
            });

            sandbox.useFakeTimers(dateNow.getTime());

            const options = {
                json: true,
                method: 'PUT',
                uri: `http://api.com/v4/builds/${testConfig.buildId}`,
                body: {
                    status: 'FROZEN',
                    statusMessage: sinon.match('Blocked by freeze window, re-enqueued to ')
                },
                headers: {
                    Authorization: 'Bearer asdf',
                    'Content-Type': 'application/json'
                },
                maxAttempts: 3,
                retryDelay: 5000,
                retryStrategy: executor.requestRetryStrategy
            };

            return executor.start(testConfig).then(() => {
                assert.calledTwice(queueMock.connect);
                assert.calledWith(queueMock.delDelayed, 'frozenBuilds', 'startFrozen', [{
                    jobId
                }]);
                assert.calledWith(redisMock.hset, 'frozenBuildConfigs', jobId,
                    JSON.stringify(testConfig));
                assert.calledWith(queueMock.enqueueAt, dateNow.getTime() + 60000, 'frozenBuilds',
                    'startFrozen', [{
                        jobId
                    }]);
                assert.calledWith(reqMock, options);
                sandbox.restore();
            });
        });

        it('do not post event if job is disabled', () => {
            reqMock.onCall(0).yieldsAsync(null, fakeGetResponse, fakeGetResponse.body);
            reqMock.onCall(1).yieldsAsync(null, fakeResponse, fakeResponse.body);
            testDelayedConfig.frozenFlag = true;
            executor.userTokenGen = userTokenGen;

            const getOptions = {
                url: 'http://localhost/v4/jobs/1234',
                method: 'GET',
                headers: {
                    Authorization: 'Bearer admintoken'
                },
                maxAttempts: 3,
                retryDelay: 5000,
                retryStrategy: executor.requestRetryStrategy
            };

            const options = {
                url: 'http://localhost/v4/events',
                method: 'POST',
                headers: {
                    Authorization: 'Bearer admintoken',
                    'Content-Type': 'application/json'
                },
                json: true,
                body: {
                    causeMessage: 'Started by freeze window scheduler',
                    creator: { name: 'Screwdriver scheduler', username: 'sd:scheduler' },
                    pipelineId: testDelayedConfig.pipeline.id,
                    startFrom: testDelayedConfig.job.name
                },
                maxAttempts: 3,
                retryDelay: 5000,
                retryStrategy: executor.requestRetryStrategyPostEvent
            };

            return executor.startFrozen(testDelayedConfig).then(() => {
                assert.calledTwice(reqMock);
                assert.calledWith(reqMock.firstCall, getOptions);
                assert.calledWith(reqMock.secondCall, options);
            });
        });
    });

    describe('_stop', () => {
        it('rejects if it can\'t establish a connection', function () {
            queueMock.connect.rejects(new Error('couldn\'t connect'));

            return executor.stop(partialTestConfig).then(() => {
                assert.fail('Should not get here');
            }, (err) => {
                assert.instanceOf(err, Error);
            });
        });

        it('removes a start event from the queue and the cached buildconfig', () => {
            const deleteKey = `deleted_${jobId}_${buildId}`;
            const stopConfig = Object.assign({ started: false }, partialTestConfigToString);

            return executor.stop(partialTestConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledWith(queueMock.del, 'builds', 'start', [partialTestConfigToString]);
                assert.calledWith(redisMock.set, deleteKey, '');
                assert.calledWith(redisMock.expire, deleteKey, 1800);
                assert.calledWith(queueMock.enqueue, 'builds', 'stop', [stopConfig]);
            });
        });

        it('adds a stop event to the queue if no start events were removed', () => {
            queueMock.del.resolves(0);
            const stopConfig = Object.assign({ started: true }, partialTestConfigToString);

            return executor.stop(partialTestConfig).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledWith(queueMock.del, 'builds', 'start', [partialTestConfigToString]);
                assert.calledWith(queueMock.enqueue, 'builds', 'stop', [stopConfig]);
            });
        });

        it('adds a stop event to the queue if it has no blocked job', () => {
            queueMock.del.resolves(0);
            const partialTestConfigUndefined = Object.assign({}, partialTestConfig, {
                blockedBy: undefined });
            const stopConfig = Object.assign({ started: true }, partialTestConfigUndefined);

            return executor.stop(partialTestConfigUndefined).then(() => {
                assert.calledOnce(queueMock.connect);
                assert.calledWith(queueMock.del, 'builds', 'start', [partialTestConfigUndefined]);
                assert.calledWith(queueMock.enqueue, 'builds', 'stop', [stopConfig]);
            });
        });

        it('doesn\'t call connect if there\'s already a connection', () => {
            queueMock.connection.connected = true;

            return executor.stop(Object.assign({}, partialTestConfig, { annotations: {
                'beta.screwdriver.cd/executor': 'screwdriver-executor-k8s'
            } })).then(() => {
                assert.notCalled(queueMock.connect);
                assert.calledWith(queueMock.del, 'builds', 'start', [partialTestConfigToString]);
            });
        });
    });

    describe('stats', () => {
        it('returns the correct stats', () => {
            assert.deepEqual(executor.stats(), {
                requests: {
                    total: 0,
                    timeouts: 0,
                    success: 0,
                    failure: 0,
                    concurrent: 0,
                    averageTime: 0
                },
                breaker: {
                    isClosed: true
                }
            });
        });
    });
});
