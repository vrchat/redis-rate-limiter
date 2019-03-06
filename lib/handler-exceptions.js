var assert  = require('assert');
var options = require('./options');

/**
 * Given an Express handler, return a handler that responds with a 429 HTTP Error if they cause too many exceptions.
 */

var defaultHandlerExceptionsOpts = {
    errorMatcher: function alwaysTrue () { return true; },
    errorMessage: "Too Many Errors",
    shouldRateLimit: true,
    logger: console.log
};

var validators = {
    errorMatcher: function(f) {
        assert(typeof(f) === 'function', 'Invalid error matcher: ' + f);
    },
    errorMessage: function(s) {
        assert(typeof(s) === 'string', 'Invalid error message: ' + s);
    },
    shouldRateLimit: function(b) {
        assert(typeof(b) === 'boolean', 'Invalid shouldRateLimit: ' + b);
    },
    logger: function(o) {
        assert((typeof(o) === 'function') || (o === false), 'Invalid logger: ' + o)
    }
};

function handlerExceptionsOptsCanonical(opts) {
    // special case: logger = false means a no-op
    if (opts['logger'] === false) {
        opts['logger'] = function noop () {};
    }

    var canonicalOpts = {};
    for (var key in defaultHandlerExceptionsOpts) {
        if (defaultHandlerExceptionsOpts.hasOwnProperty(key)) {
            if (opts.hasOwnProperty(key) && opts[key] != null) {
                if (key in validators) {
                    validators[key](opts[key]);
                }
                canonicalOpts[key] = opts[key];
            } else {
                canonicalOpts[key] = defaultHandlerExceptionsOpts[key]
            }
        }
    }
    return canonicalOpts;
}

function merge(obj1, obj2) {
    var merged = {};
    [obj1, obj2].forEach(function(obj) {
        for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
                merged[key] = obj[key];
            }
        }
    });
    return merged;
}

// partition options into those that are appropriate for ./options.js, validate them separately,
// then merge back together
function validateOptions(opts) {
    const rateLimiterOpts = {};
    const handlerExceptionsOpts = {};
    for (var key in opts) {
        if (opts.hasOwnProperty(key)) {
            if (defaultHandlerExceptionsOpts.hasOwnProperty(key)) {
                handlerExceptionsOpts[key] = opts[key];
            } else {
                rateLimiterOpts[key] = opts[key];
            }
        }
    }

    return merge(
        options.canonical(rateLimiterOpts),
        handlerExceptionsOptsCanonical(handlerExceptionsOpts)
    );
}

// Transforms a handler into an exception-rate-limited handler
module.exports = function(opts, handler) {
    // Make sure all the args are good
    opts = validateOptions(opts);
    assert.equal(typeof handler, 'function', 'Invalid handler: ' + handler);

    // Return the new handler
    return function(request, response, next) {
        var key = opts.key(request);
        var realKey = 'ratelimit:{' + key + '}';

        // Tally an error in redis. This is similar to rate-limiter.js
        var incrementErrors = function (callback) {
            var tempKey = 'ratelimittemp:{' + key + '}';
            opts.redis.multi()
                .setex(tempKey, opts.window(), 0)
                .renamenx(tempKey, realKey)
                .incr(realKey)
                .ttl(realKey)
                .exec(function (redisError, results) {
                    if (redisError) {
                        console.error("redis error in incr: " + redisError.constructor.name + ": " + redisError.message);
                    } else {
                        var ttlResult = parseInt(results[3], 10);
                        if (ttlResult === -1) {  // automatically recover from possible race condition
                            opts.redis.expire(realKey, opts.window());
                        }
                    }
                    callback();
                });
        };

        // Execute the original handler, but if it throws an exception we want to count, tally that in Redis
        function callHandler() {
            try {
                handler.call(this, request, response, next);
            } catch (error) {
                if (opts.errorMatcher(error)) {
                    incrementErrors(function() { next(error); });
                } else {
                    next(error);
                }
            }
        }

        // If we recently had too many exceptions, respond with a rate limit HTTP error
        opts.redis.get(realKey, function (redisError, results) {
            if (redisError) {
                console.error("redis error in get: " + redisError.constructor.name + ": " + redisError.message);
                next();
            } else {
                var current = results == null ? 0 : parseInt(results, 10);
                if (current >= opts.limit()) {
                    opts.logger("Rate limit triggered due to exceptions: " + key + " = " + current);
                    if (opts.shouldRateLimit) {
                        response.status(429);
                        response.send(opts.errorMessage);
                        return response.end();
                    }
                }
                callHandler();
            }
        });

    }
};

