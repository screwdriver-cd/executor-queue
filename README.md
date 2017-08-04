# Executor Queue
[![Version][npm-image]][npm-url] ![Downloads][downloads-image] [![Build Status][status-image]][status-url] [![Open Issues][issues-image]][issues-url] [![Dependency Status][daviddm-image]][daviddm-url] ![License][license-image]

> A generic executor plugin that routes builds to a specified executor

An executor is an engine that is capable of running a set of docker containers together.

i.e. Jenkins, Kubernetes, ECS, Mesos

The executor queue will allow jobs for the executor to be queued with resque.

## Usage

```bash
npm install screwdriver-executor-queue
```

### Interface

To be determined

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
