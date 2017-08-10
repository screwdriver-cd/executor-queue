'use strict';

/* eslint-disable no-underscore-dangle */

const chai = require('chai');
const assert = chai.assert;
const mockery = require('mockery');
const sinon = require('sinon');
const testConnection = require('./data/testConnection.json');

sinon.assert.expose(chai.assert, { prefix: '' });

describe('index test', () => {
    let Executor;
    let executor;
    let resqueMock;
    let queueMock;
    let testJobConfig;

    before(() => {
        mockery.enable({
            useCleanCache: true,
            warnOnUnregistered: false
        });
    });

    beforeEach(() => {
        queueMock = {
            connect: sinon.stub().callsArgAsync(0),
            enqueue: sinon.stub().callsArgAsync(3)
        };
        resqueMock = {
            queue: sinon.stub().returns(queueMock)
        };

        mockery.registerMock('node-resque', resqueMock);

        /* eslint-disable global-require */
        Executor = require('../index');
        testJobConfig = require('./data/start.json');
        /* eslint-enable global-require */

        executor = new Executor({
            redisConnection: testConnection
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
            assert.ok(executor);
        });

        it('throws when not given a redis connection', () => {
            assert.throws(() => new Executor(), 'No redis connection passed in');
        });
    });

    describe('_start', () => {
        it('enqueues a build', () => executor.start({
            annotations: {
                'beta.screwdriver.cd/executor': 'screwdriver-executor-k8s'
            },
            buildId: 8609,
            container: 'node:4',
            apiUri: 'http://api.com',
            token: 'asdf'
        }).then(() => {
            assert.calledOnce(queueMock.connect);
            assert.calledWith(queueMock.enqueue, 'builds', 'start', [testJobConfig]);
        }));

        it('rejects if it can\'t establish a connection', () => {
            queueMock.connect = sinon.stub().callsArgWithAsync(0, new Error('couldn\'t connect'));

            return executor.start({
                annotations: {
                    'beta.screwdriver.cd/executor': 'screwdriver-executor-k8s'
                },
                buildId: 8609,
                container: 'node:4',
                apiUri: 'http://api.com',
                token: 'asdf'
            }).then(() => {
                assert.fail('Should not get here');
            }, (err) => {
                assert.ok(err);
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
