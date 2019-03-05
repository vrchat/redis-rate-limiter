var _            = require('lodash');
var async        = require('async');
var supertest    = require('supertest');


var requests = function(server, count, url) {
    return _.times(count, function() {
        return function(next) {
            supertest(server).get(url).end(next);
        };
    });
};

var parallelRequests = function(server, count, url) {
    return function(next) {
        async.parallel(requests(server, count, url), next);
    };
};

var wait = function(millis) {
    return function(next) {
        setTimeout(next, millis);
    };
};

var okResponse = function(req, res, next) {
    res.writeHead(200);
    res.end('ok');
};

var withStatus = function(data, code) {
    var pretty = data.map(function(d) {
        return {
            url: d.req.path,
            statusCode: d.res.statusCode,
            body: d.res.body,
            text: d.res.text
        }
    });
    return _.filter(pretty, {statusCode: code});
};

module.exports = {
    requests: requests,
    parallelRequests: parallelRequests,
    wait: wait,
    okResponse: okResponse,
    withStatus: withStatus
};
