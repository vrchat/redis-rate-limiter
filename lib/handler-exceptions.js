var assert  = require('assert');
var options = require('./options');

/**
 * Given an Express handler, return a handler that responds with a 429 HTTP Error if they cause too many exceptions.
 *
 * This uses the optional errorMatcher function to decide if it should throw an error. If that is not supplied,
 * it will rate-limit on all exceptions.
 *
 * Sample use:
 *
 * const redisRateLimiter = require('redis-rate-limiter');
 *
 * const opts = {
 *    redis: redisClient,
 *    rate: '10/hour',
 *    key: req => `${req.path}:${req.forwarded_ip}`,
 * },
 * const errorMatcher = e => e instanceOf MyCustomError;
 * const myRateLimitedHandler = redisRateLimiter.handlerExceptions(opts, myHandler, errorMatcher, "Stop Doing That");
 */

// Transforms a handler into an exception-rate-limited handler
module.exports = function(opts, handler, errorMatcher, errorMessage) {

    // Make sure all the args are good
    opts = options.canonical(opts);
    assert.equal(typeof handler, 'function', 'Invalid handler: ' + handler);
    if (!errorMatcher) {
        errorMatcher = function () { return true; } ;
    } else {
        assert.equal(typeof errorMatcher, 'function', 'Invalid error matcher: ' + errorMatcher);
    }
    if (!errorMessage) {
        errorMessage = "Too Many Errors";
    }

    // Return the new handler
    return function(request, response, next) {
        var key = opts.key(request);
        var realKey = 'ratelimit:{' + key + '}';

        // Tally an error in redis. This is similar to rate-limiter.js
        var incrementErrors = function () {
            var tempKey = 'ratelimittemp:{' + key + '}';
            opts.redis.multi()
                .setex(tempKey, opts.window(), 0)
                .renamenx(tempKey, realKey)
                .incr(realKey)
                .ttl(realKey)
                .exec(function (redisError, results) {
                    if (redisError) {
                        next(redisError);
                    } else {
                        var ttlResult = results[3];
                        if (ttlResult === -1) {  // automatically recover from possible race condition
                            opts.redis.expire(realKey, opts.window());
                        } else {
                            next(request, response);
                        }
                    }
                });
        };

        // Execute the original handler, but if it throws an exception, tally that in Redis
        function callHandler() {
            try {
                handler.call(this, request, response, next);
            } catch (error) {
                if (errorMatcher(error)) {
                    incrementErrors();
                } else {
                    next(error);
                }
            }
        }

        // If we recently had too many exceptions, respond with a rate limit HTTP error
        opts.redis.get(realKey, function (redisError, results) {
            if (redisError) {
                next(redisError);
            } else {
                var current = results[0];
                if (current > opts.limit()) {
                    response.writeHead(429);
                    response.send(errorMessage);
                    response.end();
                } else {
                    callHandler();
                }
            }
        });

    }
};

