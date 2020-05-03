'use strict;'

const { PassThrough } = require('stream');
const HttpError = require('http-errors');
const pino = require('pino');
const cors = require('fastify-cors');
const jwt = require('fastify-jwt');
const eik = require('@eik/core');

const config = require('./config');
const utils = require('./utils');

const EikService = class EikService {
    constructor({
        customSink,
    } = {}) {
        const logger = pino({
            level: config.get('log.level'),
            name: config.get('name'),
        });

        let sink;
        if (customSink) {
            sink = customSink;
        } else if (config.get('sink.type') === 'mem') {
            logger.info(`Server is running with a in memory sink. Uploaded files will be lost on restart!`);
            sink = new eik.sink.MEM();
        } else {
            logger.info(`Server is running with the file system sink. Uploaded files will be stored under "${config.get('sink.path')}"`);
            sink = new eik.sink.FS();
        }

        // Transform organization config
        const organizations = config.get('organization.hostnames').map((hostname) => {
            return [hostname, config.get('organization.name')];
        });

        this._versionsGet = new eik.http.VersionsGet({ organizations, sink, logger });
        this._aliasPost = new eik.http.AliasPost({ organizations, sink, logger });
        this._aliasDel = new eik.http.AliasDel({ organizations, sink, logger });
        this._aliasGet = new eik.http.AliasGet({ organizations, sink, logger });
        this._aliasPut = new eik.http.AliasPut({ organizations, sink, logger });
        this._authPost = new eik.http.AuthPost({ organizations, logger, authKey: config.get('basicAuth.key') });
        this._pkgLog = new eik.http.PkgLog({ organizations, sink, logger });
        this._pkgGet = new eik.http.PkgGet({ organizations, sink, logger });
        this._pkgPut = new eik.http.PkgPut({ organizations, sink, logger });
        this._mapGet = new eik.http.MapGet({ organizations, sink, logger });
        this._mapPut = new eik.http.MapPut({ organizations, sink, logger });

        const mergeStreams = (...streams) => {
            const str = new PassThrough({ objectMode: true });

            // Avoid hitting the max listeners limit when multiple
            // streams is piped into the same stream.
            str.on('pipe', () => {
                str.setMaxListeners(str.getMaxListeners() + 1);
            });

            str.on('unpipe', () => {
                str.setMaxListeners(str.getMaxListeners() - 1);
            });

            for (const stm of streams) {
                stm.on('error', err => {
                    logger.error(err);
                });
                stm.pipe(str);
            }
            return str;
        };

        // pipe metrics
        const metrics = mergeStreams(
            this._versionsGet.metrics,
            this._aliasPost.metrics,
            this._aliasDel.metrics,
            this._aliasGet.metrics,
            this._aliasPut.metrics,
            this._authPost.metrics,
            this._pkgLog.metrics,
            this._pkgGet.metrics,
            this._pkgPut.metrics,
            this._mapGet.metrics,
            this._mapPut.metrics,
        );

        metrics.on('error', err => {
            logger.error(err);
        });

        this.metrics = metrics;
        this.config = config;
        this.logger = logger;

        // Print warnings

        if (config.get('basicAuth.type') === 'key' && config.get('basicAuth.key') === config.default('basicAuth.key')) {
            logger.warn('Server is running with default basic authorization key configured! For security purposes, it is highly recommended to set a custom value!')
        }

        if (config.get('jwt.secret') === config.default('jwt.secret')) {
            logger.warn('Server is running with default jwt secret configured! For security purposes, it is highly recommended to set a custom value!')
        }

        // Print info

        const hosts = config.get('organization.hostnames').join(', ');
        logger.info(`Files for "${hosts}" will be stored in the "${config.get('organization.name')}" organization space`);
    }

    api() {
        return (app, options, done) => {
            if (!app.initialConfig.ignoreTrailingSlash) {
                this.logger.warn('Fastify is configured with "ignoreTrailingSlash" set to "false". Its adviced to set "ignoreTrailingSlash" to "true"');
            }

            app.register(cors);

            // Authentication
            app.register(jwt, {
                secret: config.get('jwt.secret'),
                messages: {
                    badRequestErrorMessage: 'Autorization header is malformatted. Format is "Authorization: Bearer [token]"',
                    noAuthorizationInHeaderMessage: 'Autorization header is missing!',
                    authorizationTokenExpiredMessage: 'Authorization token expired',
                    authorizationTokenInvalid: 'Authorization token is invalid'
                }
            });

            app.decorate('authenticate', async (request, reply) => {
                try {
                  await request.jwtVerify()
                } catch (error) {
                  reply.send(error)
                }
            });

            const authOptions = {
                preValidation: [app.authenticate]
            }

            // Handle multipart upload
            const _multipart = Symbol('multipart');

            function setMultipart(req, cb) {
                req[_multipart] = true;
                cb();
            }
            app.addContentTypeParser('multipart', setMultipart);

            // Error handling
            app.setErrorHandler((error, request, reply) => {
                this.logger.debug('Error occured during request. Error is available on trace log level.');
                this.logger.trace(error);

                if (error.statusCode) {
                    reply.send(error);
                    return;
                }
                reply.send(new HttpError.InternalServerError());
            });


            //
            // Authentication
            //

            // curl -X POST -i -F key=foo http://localhost:4001/auth/login

            app.post(`/${eik.prop.base_auth}/login`, async (request, reply) => {
                const outgoing = await this._authPost.handler(
                    request.req,
                );

                // Workaround due to .jwt.sign() being able to only
                // deal with object literals for some reason :/
                const body = JSON.parse(JSON.stringify(outgoing.body));

                const token = app.jwt.sign(body, {
                    expiresIn: '7d',
                });

                reply.header('cache-control', outgoing.cacheControl);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send({ token });
            });


            //
            // Packages
            //

            // Get public package - scoped
            // curl -X GET http://localhost:4001/pkg/@cuz/fuzz/8.4.1/main/index.js
            app.get(`/${eik.prop.base_pkg}/@:scope/:name/:version/*`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._pkgGet.handler(
                    request.req,
                    params.type,
                    params.name,
                    params.version,
                    params.extras,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Get public package - non-scoped
            // curl -X GET http://localhost:4001/pkg/fuzz/8.4.1/main/index.js
            app.get(`/${eik.prop.base_pkg}/:name/:version/*`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._pkgGet.handler(
                    request.req,
                    params.type,
                    params.name,
                    params.version,
                    params.extras,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Get package overview - scoped
            // curl -X GET http://localhost:4001/pkg/@cuz/fuzz/8.4.1/
            app.get(
                `/${eik.prop.base_pkg}/@:scope/:name/:version`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._pkgLog.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.header('etag', outgoing.etag);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.stream);
                },
            );

            // Get package overview - non-scoped
            // curl -X GET http://localhost:4001/pkg/fuzz/8.4.1/
            app.get(
                `/${eik.prop.base_pkg}/:name/:version`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._pkgLog.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.header('etag', outgoing.etag);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.stream);
                },
            );

            // Get package versions - scoped
            // curl -X GET http://localhost:4001/pkg/@cuz/fuzz/
            app.get(`/${eik.prop.base_pkg}/@:scope/:name`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._versionsGet.handler(
                    request.req,
                    params.type,
                    params.name,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Get package versions - non-scoped
            // curl -X GET http://localhost:4001/pkg/fuzz/
            app.get(`/${eik.prop.base_pkg}/:name`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._versionsGet.handler(
                    request.req,
                    params.type,
                    params.name,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Put package - scoped
            // curl -X PUT -i -F filedata=@archive.tgz http://localhost:4001/pkg/@cuz/fuzz/8.4.1/
            app.put(
                `/${eik.prop.base_pkg}/@:scope/:name/:version`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._pkgPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // Put package - non-scoped
            // curl -X PUT -i -F filedata=@archive.tgz http://localhost:4001/pkg/fuzz/8.4.1/
            app.put(
                `/${eik.prop.base_pkg}/:name/:version`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._pkgPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );


            //
            // NPM Packages
            //

            // Get public NPM package - scoped
            // curl -X GET http://localhost:4001/npm/@cuz/fuzz/8.4.1/main/index.js
            app.get(`/${eik.prop.base_npm}/@:scope/:name/:version/*`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._pkgGet.handler(
                    request.req,
                    params.type,
                    params.name,
                    params.version,
                    params.extras,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Get public NPM package - non-scoped
            // curl -X GET http://localhost:4001/npm/fuzz/8.4.1/main/index.js
            app.get(`/${eik.prop.base_npm}/:name/:version/*`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._pkgGet.handler(
                    request.req,
                    params.type,
                    params.name,
                    params.version,
                    params.extras,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Get NPM package overview - scoped
            // curl -X GET http://localhost:4001/npm/@cuz/fuzz/8.4.1/
            app.get(
                `/${eik.prop.base_npm}/@:scope/:name/:version`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._pkgLog.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.header('etag', outgoing.etag);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.stream);
                },
            );

            // Get NPM package overview - non-scoped
            // curl -X GET http://localhost:4001/npm/fuzz/8.4.1/
            app.get(
                `/${eik.prop.base_npm}/:name/:version`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._pkgLog.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.header('etag', outgoing.etag);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.stream);
                },
            );

            // Get NPM package versions - scoped
            // curl -X GET http://localhost:4001/npm/@cuz/fuzz/
            app.get(`/${eik.prop.base_npm}/@:scope/:name`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._versionsGet.handler(
                    request.req,
                    params.type,
                    params.name,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Get NPM package versions - non-scoped
            // curl -X GET http://localhost:4001/npm/fuzz/
            app.get(`/${eik.prop.base_npm}/:name`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._versionsGet.handler(
                    request.req,
                    params.type,
                    params.name,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Put NPM package - scoped
            // curl -X PUT -i -F filedata=@archive.tgz http://localhost:4001/npm/@cuz/fuzz/8.4.1/
            app.put(
                `/${eik.prop.base_npm}/@:scope/:name/:version`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._pkgPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // Put NPM package - non-scoped
            // curl -X PUT -i -F filedata=@archive.tgz http://localhost:4001/npm/fuzz/8.4.1/
            app.put(
                `/${eik.prop.base_npm}/:name/:version`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._pkgPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );


            //
            // Import Maps
            //

            // Get map - scoped
            // curl -X GET http://localhost:4001/map/@cuz/buzz/4.2.2
            app.get(
                `/${eik.prop.base_map}/@:scope/:name/:version`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._mapGet.handler(
                        request.req,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.header('etag', outgoing.etag);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.stream);
                },
            );

            // Get map - non-scoped
            // curl -X GET http://localhost:4001/map/buzz/4.2.2
            app.get(
                `/${eik.prop.base_map}/:name/:version`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._mapGet.handler(
                        request.req,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.header('etag', outgoing.etag);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.stream);
                },
            );

            // Get map versions - scoped
            // curl -X GET http://localhost:4001/map/@cuz/buzz
            app.get(`/${eik.prop.base_map}/@:scope/:name`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._versionsGet.handler(
                    request.req,
                    eik.prop.base_map,
                    params.name,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Get map versions - non-scoped
            // curl -X GET http://localhost:4001/map/buzz
            app.get(`/${eik.prop.base_map}/:name`, async (request, reply) => {
                const params = utils.sanitizeParameters(request.raw.url);
                const outgoing = await this._versionsGet.handler(
                    request.req,
                    eik.prop.base_map,
                    params.name,
                );
                reply.header('cache-control', outgoing.cacheControl);
                reply.header('etag', outgoing.etag);
                reply.type(outgoing.mimeType);
                reply.code(outgoing.statusCode);
                reply.send(outgoing.stream);
            });

            // Put map - scoped
            // curl -X PUT -i -F map=@import-map.json http://localhost:4001/map/@cuz/buzz/4.2.2
            app.put(
                `/${eik.prop.base_map}/@:scope/:name/:version`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._mapPut.handler(
                        request.req,
                        request.user,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // Put map - non-scoped
            // curl -X PUT -i -F map=@import-map.json http://localhost:4001/map/buzz/4.2.2
            app.put(
                `/${eik.prop.base_map}/:name/:version`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._mapPut.handler(
                        request.req,
                        request.user,
                        params.name,
                        params.version,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            //
            // Alias Packages
            //

            // curl -X GET -L http://localhost:4001/pkg/@cuz/fuzz/v8

            app.get(
                `/${eik.prop.base_pkg}/@:scope/:name/v:alias`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X GET -L http://localhost:4001/pkg/fuzz/v8

            app.get(
                `/${eik.prop.base_pkg}/:name/v:alias`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X GET -L http://localhost:4001/pkg/@cuz/fuzz/v8/main/index.js

            app.get(
                `/${eik.prop.base_pkg}/@:scope/:name/v:alias/*`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                        params.extras,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X GET -L http://localhost:4001/pkg/fuzz/v8/main/index.js

            app.get(
                `/${eik.prop.base_pkg}/:name/v:alias/*`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                        params.extras,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X PUT -i -F version=8.4.1 http://localhost:4001/pkg/@cuz/fuzz/v8

            app.put(
                `/${eik.prop.base_pkg}/@:scope/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X PUT -i -F version=8.4.1 http://localhost:4001/pkg/fuzz/v8

            app.put(
                `/${eik.prop.base_pkg}/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X POST -i -F version=8.4.1 http://localhost:4001/pkg/@cuz/lit-html/v8

            app.post(
                `/${eik.prop.base_pkg}/@:scope/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPost.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X POST -i -F version=8.4.1 http://localhost:4001/pkg/lit-html/v8

            app.post(
                `/${eik.prop.base_pkg}/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPost.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X DELETE http://localhost:4001/pkg/@cuz/fuzz/v8

            app.delete(
                `/${eik.prop.base_pkg}/@:scope/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasDel.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.body);
                },
            );

            // curl -X DELETE http://localhost:4001/pkg/fuzz/v8

            app.delete(
                `/${eik.prop.base_pkg}/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasDel.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.body);
                },
            );


            //
            // Alias NPM Packages
            //

            // curl -X GET -L http://localhost:4001/npm/@cuz/fuzz/v8

            app.get(
                `/${eik.prop.base_npm}/@:scope/:name/v:alias`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X GET -L http://localhost:4001/npm/fuzz/v8

            app.get(
                `/${eik.prop.base_npm}/:name/v:alias`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X GET -L http://localhost:4001/npm/@cuz/fuzz/v8/main/index.js

            app.get(
                `/${eik.prop.base_npm}/@:scope/:name/v:alias/*`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                        params.extras,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X GET -L http://localhost:4001/npm/fuzz/v8/main/index.js

            app.get(
                `/${eik.prop.base_npm}/:name/v:alias/*`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                        params.extras,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X PUT -i -F version=8.4.1 http://localhost:4001/npm/@cuz/fuzz/v8

            app.put(
                `/${eik.prop.base_npm}/@:scope/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X PUT -i -F version=8.4.1 http://localhost:4001/npm/fuzz/v8

            app.put(
                `/${eik.prop.base_npm}/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X POST -i -F version=8.4.1 http://localhost:4001/npm/@cuz/lit-html/v8

            app.post(
                `/${eik.prop.base_npm}/@:scope/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPost.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X POST -i -F version=8.4.1 http://localhost:4001/npm/lit-html/v8

            app.post(
                `/${eik.prop.base_npm}/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPost.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X DELETE http://localhost:4001/npm/@cuz/fuzz/v8

            app.delete(
                `/${eik.prop.base_npm}/@:scope/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasDel.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.body);
                },
            );

            // curl -X DELETE http://localhost:4001/npm/fuzz/v8

            app.delete(
                `/${eik.prop.base_npm}/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasDel.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.body);
                },
            );


            //
            // Alias Import Maps
            //

            // curl -X GET -L http://localhost:4001/map/@cuz/buzz/v4

            app.get(
                `/${eik.prop.base_map}/@:scope/:name/v:alias`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X GET -L http://localhost:4001/map/buzz/v4

            app.get(
                `/${eik.prop.base_map}/:name/v:alias`,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasGet.handler(
                        request.req,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X PUT -i -F version=4.2.2 http://localhost:4001/map/@cuz/buzz/v4

            app.put(
                `/${eik.prop.base_map}/@:scope/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X PUT -i -F version=4.2.2 http://localhost:4001/map/buzz/v4

            app.put(
                `/${eik.prop.base_map}/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPut.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X POST -i -F version=4.4.2 http://localhost:4001/map/@cuz/buzz/v4

            app.post(
                `/${eik.prop.base_map}/@:scope/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPost.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X POST -i -F version=4.4.2 http://localhost:4001/map/buzz/v4

            app.post(
                `/${eik.prop.base_map}/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasPost.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.redirect(outgoing.location);
                },
            );

            // curl -X DELETE http://localhost:4001/map/@cuz/buzz/v4

            app.delete(
                `/${eik.prop.base_map}/@:scope/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasDel.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.body);
                },
            );

            // curl -X DELETE http://localhost:4001/map/buzz/v4

            app.delete(
                `/${eik.prop.base_map}/:name/v:alias`,
                authOptions,
                async (request, reply) => {
                    const params = utils.sanitizeParameters(request.raw.url);
                    const outgoing = await this._aliasDel.handler(
                        request.req,
                        request.user,
                        params.type,
                        params.name,
                        params.alias,
                    );
                    reply.header('cache-control', outgoing.cacheControl);
                    reply.type(outgoing.mimeType);
                    reply.code(outgoing.statusCode);
                    reply.send(outgoing.body);
                },
            );

            done();
        }
    }
};
module.exports = EikService;