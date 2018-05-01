'use strict';

const { assert } = require('chai');
const transformCron = require('../../lib/transformCron.js');
const hash = require('string-hash');

const evaluateHash = (jobId, min, max) => (hash(jobId) % ((max + 1) - min)) + min;

describe('transformCron', () => {
    const jobId = '123';

    // Evaluate the hashes for the default minutes and hours field
    const minutesHash = evaluateHash(jobId, 0, 59);
    const hoursHash = evaluateHash(jobId, 0, 23);

    it('should throw if the cron expession does not have 5 fields', () => {
        let cron;
        // 6 fields

        cron = '1 2 3 4 5 6';
        assert.throws(() => transformCron.transform(cron, jobId),
            Error, '1 2 3 4 5 6 does not have exactly 5 fields');

        // 4 fields
        cron = '1 2 3 4';
        assert.throws(() => transformCron.transform(cron, jobId),
            Error, '1 2 3 4 does not have exactly 5 fields');
    });

    it('should transform a cron expression with valid H symbol(s)', () => {
        let cron;

        // H * * * *
        cron = 'H * * * *';
        assert.deepEqual(transformCron.transform(cron, jobId), `${minutesHash} * * * *`);

        // * H/2 * * *
        cron = '* H/2 * * *';
        assert.deepEqual(transformCron.transform(cron, jobId),
            `${minutesHash} ${hoursHash}/2 * * *`);

        // * H(0-5) * * *
        cron = '* H(0-5) * * *';
        assert.deepEqual(transformCron.transform(cron, jobId),
            `${minutesHash} ${evaluateHash(jobId, 0, 5)} * * *`);
    });

    it('should throw if the cron expression has an invalid range value', () => {
        const cron = '* H(99-100) * * *';

        assert.throws(() => transformCron.transform(cron, jobId),
            Error, 'H(99-100) has an invalid range, expected range 0-23');
    });
});
