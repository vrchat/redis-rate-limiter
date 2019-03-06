var _            = require('lodash');
var async        = require('async');
var should       = require('should');
var redis        = require('redis');
var express      = require('express');
var supertest    = require('supertest');
var reset        = require('./reset');
var handlerExceptions = require('../lib/handler-exceptions');
var helper       = require('./middleware-helper');

var requests = helper.requests;
var parallelRequests = helper.parallelRequests;
var wait = helper.wait;
var okResponse = helper.okResponse;
var withStatus = helper.withStatus


// we define our own error handler so that Express doesn't print it to stderr
function errorHandler(err, req, res, next) {
    res.status(500).send('Error!\n\n' + err.stack)
}

describe('Handler Exceptions', function() {

    this.slow(5000);
    this.timeout(5000);

    var client = null;

    before(function(done) {
        client = redis.createClient(6379, 'localhost', {enable_offline_queue: false});
        client.on('ready', done);
    });

    beforeEach(function(done) {
        reset.allkeys(client, done);
    });

    after(function() {
        client.quit();
    });

    describe('Counter', function() {
        var maxFails = 10;
        var server = null;

        function failableHandler(req, res, next) {
            if (req.query.fail) {
                throw new Error("whoops");
            }
            okResponse(req, res, next);
        }

        beforeEach(function (done) {
            server = express();
            var opts = {
                redis: client,
                rate: maxFails.toString() + '/minute',
                key: 'ip',
                logger: false
            };
            var rateLimitedHandler = handlerExceptions(opts, failableHandler);
            server.use(rateLimitedHandler);
            server.use(errorHandler);
            done();
        });

        var testSuccessFail = function (okCount, failCount, done) {
            var expectedFailCount = Math.min(failCount, maxFails);
            var expectedRateLimitedCount = Math.max(0, (failCount - maxFails));

            var okReqs = requests(server, okCount, '/test');
            var exceptionReqs = requests(server, failCount, '/test?fail=1');
            var reqs = okReqs.concat(exceptionReqs);

            // We do these in series to ensure that redis has time to do the incr and fetch,
            // so we get predictable results.
            async.series(reqs, function (err, data) {
                withStatus(data, 200).should.have.length(okCount);
                withStatus(data, 500).should.have.length(expectedFailCount);
                withStatus(data, 429).should.have.length(expectedRateLimitedCount);
                done();
            });
        };

        it('if no exceptions, passes', function (done) {
            var successCount = 20;
            var failCount = 0;

            testSuccessFail(successCount, failCount, done);
        });

        it('if exceptions under the limit, passes', function (done) {
            var successCount = 15;
            var failCount = 5;

            testSuccessFail(successCount, failCount, done);
        });

        it('if exceptions over the limit, begins rate limiting', function (done) {
            var successCount = 5;
            var failCount = 15;

            testSuccessFail(successCount, failCount, done);
        });

    });


    describe('Error matcher', function() {
       it('should rate limit only some exceptions', function(done) {
           var maxFails = 10;
           var server = express();

           function CustomError(message) {
               this.message = message;
           }
           CustomError.prototype = new Error();

           var errorMatcher = function (error) {
               return error instanceof CustomError;
           };

           function failChoiceHandler(req, res, next) {
               if (req.query.fail) {
                   var klass = req.query.fail;

                   if (klass === 'CustomError') {
                       throw new CustomError("boing");
                   } else {
                       throw new Error();
                   }
               }
               okResponse(req, res, next);
           }

           var opts = {
               redis: client,
               rate: maxFails.toString() + '/minute',
               key: 'ip',
               errorMatcher: errorMatcher,
               logger: false
           };

           var rateLimitedHandler = handlerExceptions(opts, failChoiceHandler);
           server.use(rateLimitedHandler);
           server.use(errorHandler);

           var okCount = 5;
           var unRateLimitedFailCount = 20;
           var rateLimitedFailCount = 15;

           var okReqs = requests(server, okCount, '/test');
           var unRateLimitedExceptionReqs = requests(server, unRateLimitedFailCount, '/test?fail=Error');
           var rateLimitedExceptionReqs = requests(server, rateLimitedFailCount, '/test?fail=CustomError');
           var reqs = okReqs.concat(unRateLimitedExceptionReqs).concat(rateLimitedExceptionReqs);

           // all of the rate-limited errors should 429 over maxFails
           var expectedRateLimitedCount = Math.max(0, rateLimitedFailCount - maxFails);
           // we expect 500 errors for all of the un-rate-limited errors, and the ones that are rate-limited, before
           // rate-limiting kicks in.
           var expectedFailCount = unRateLimitedFailCount +
               Math.max(0, rateLimitedFailCount - expectedRateLimitedCount);

           // We do these in series to ensure that redis has time to do the incr and fetch,
           // so we get predictable results.
           async.series(reqs, function (err, data) {
               withStatus(data, 200).should.have.length(okCount);
               withStatus(data, 500).should.have.length(expectedFailCount);
               withStatus(data, 429).should.have.length(expectedRateLimitedCount);
               done();
           });


       });

    });

    describe('Error message', function() {
        it('should show a custom error message', function(done) {
            var maxFails = 1;
            var server = express();

            var opts = {
                redis: client,
                rate: maxFails.toString() + '/minute',
                key: 'ip',
                errorMessage: "Oh noes",
                logger: false
            };

            function alwaysFailHandler(req, res, next) {
                throw new Error();
            }

            var rateLimitedHandler = handlerExceptions(opts, alwaysFailHandler);
            server.use(rateLimitedHandler);
            server.use(errorHandler);

            var reqs = requests(server, 2, '/test');

            async.series(reqs, function (err, data) {
                data.should.have.length(2);
                withStatus(data, 500).should.have.length(1);
                var rateLimitedResponses = withStatus(data, 429);
                rateLimitedResponses.should.have.length(1);
                rateLimitedResponses[0].text.should.eql(opts.errorMessage);
                done();
            });

        })
    });

    describe('Log only', function() {

        var logMessages = '';
        var logger = function (message) { logMessages += message + "\n"; };

        it('should log without rate limiting', function(done) {
            var maxFails = 1;
            var server = express();

            var opts = {
                redis: client,
                rate: maxFails.toString() + '/minute',
                key: 'ip',
                shouldRateLimit: false,
                logger: logger
            };

            function alwaysFailHandler(req, res, next) {
                throw new Error();
            }

            var rateLimitedHandler = handlerExceptions(opts, alwaysFailHandler);
            server.use(rateLimitedHandler);
            server.use(errorHandler);

            var reqs = requests(server, 2, '/test');

            async.series(reqs, function (err, data) {
                data.should.have.length(2);
                withStatus(data, 500).should.have.length(2);
                withStatus(data, 429).should.have.length(0);
                logMessages.should.containEql('Rate limit triggered');
                done();
            });

        })
    });

});