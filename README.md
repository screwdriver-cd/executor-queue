# Executor Queue
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> A generic executor plugin that routes builds through a queue

An engine that will trigger a user's compute process to start and stop.

The executor queue for Screwdriver will push new jobs into a redis queue which workers will pop from and handle further with other executors such as [executor-docker](https://github.com/screwdriver-cd/executor-docker) or [executor-k8s-vm](https://github.com/screwdriver-cd/executor-k8s-vm).

## Usage

```bash
npm install screwdriver-executor-queue
```

### Interface

It will initialize a connection to [Resque](https://github.com/resque/resque) with the provided connection details.

Configuration for any executors must be given directly to the [workers](https://github.com/screwdriver-cd/queue-worker) that read from the queue.

**Example executor yaml section:**
```
executor:
    plugin: queue
    options:
        redisConnection:
            host: "127.0.0.1"
            port: 9999
            password: "hunter2"
            database: 0
```

## Testing

```bash
npm test
```

## License

Code licensed under the BSD 3-Clause license. See LICENSE file for terms.

[npm-image]: https://img.shields.io/npm/v/screwdriver-executor-queue.svg
[npm-url]: https://npmjs.org/package/screwdriver-executor-queue
[downloads-image]: https://img.shields.io/npm/dt/screwdriver-executor-queue.svg
[license-image]: https://img.shields.io/npm/l/screwdriver-executor-queue.svg
[issues-image]: https://img.shields.io/github/issues/screwdriver-cd/executor-queue.svg
[issues-url]: https://github.com/screwdriver-cd/executor-queue/issues
[status-image]: https://cd.screwdriver.cd/pipelines/295/badge
[status-url]: https://cd.screwdriver.cd/pipelines/295
[daviddm-image]: https://david-dm.org/screwdriver-cd/executor-queue.svg?theme=shields.io
[daviddm-url]: https://david-dm.org/screwdriver-cd/executor-queue
