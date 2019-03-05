var _            = require('lodash');
var async        = require('async');
var should       = require('should');
var redis        = require('redis');
var express      = require('express');
var reset        = require('./reset');
var middleware   = require('../lib/middleware');
var helper       = require('./middleware-helper');

var requests = helper.requests;
var parallelRequests = helper.parallelRequests;
var wait = helper.wait;
var okResponse = helper.okResponse;
var withStatus = helper.withStatus;


describe('Middleware', function() {

  this.slow(5000);
  this.timeout(5000);

  var client  = null;
  var limiter = null;

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

  describe('IP throttling', function() {

    before(function() {
      limiter = middleware({
        redis: client,
        key: 'ip',
        rate: '10/second'
      });
    });

    it('passes through under the limit', function(done) {
      var server = express();
      server.use(limiter);
      server.use(okResponse);
      var reqs = requests(server, 9, '/test');
      async.parallel(reqs, function(err, data) {
        withStatus(data, 200).should.have.length(9);
        done();
      });
    });

    it('returns HTTP 429 over the limit', function(done) {
      var server = express();
      server.use(limiter);
      server.use(okResponse);
      var reqs = requests(server, 12, '/test');
      async.parallel(reqs, function(err, data) {
        withStatus(data, 200).should.have.length(10);
        withStatus(data, 429).should.have.length(2);
        done();
      });
    });

    it('works across several rate-limit windows', function(done) {
      var server = express();
      server.use(limiter);
      server.use(okResponse);
      async.series([
        parallelRequests(server, 9, '/test'),
        wait(1100),
        parallelRequests(server, 12, '/test'),
        wait(1100),
        parallelRequests(server, 9, '/test')
      ], function(err, data) {
        withStatus(data[0], 200).should.have.length(9);
        withStatus(data[2], 200).should.have.length(10);
        withStatus(data[2], 429).should.have.length(2);
        withStatus(data[4], 200).should.have.length(9);
        done();
      });
    });

  });

  describe('Custom key throttling', function() {

    before(function() {
      limiter = middleware({
        redis: client,
        key: function(req) { return req.query.user; },
        rate: '10/second'
      });
    });

    it('uses a different bucket for each custom key (user)', function(done) {
      var server = express();
      server.use(limiter);
      server.use(okResponse);
      var reqs = _.flatten([
        requests(server,  5, '/test?user=a'),
        requests(server, 12, '/test?user=b'),
        requests(server, 10, '/test?user=c')
      ]);
      async.parallel(reqs, function(err, data) {
        withStatus(data, 200).should.have.length(25);
        withStatus(data, 429).should.have.length(2);
        withStatus(data, 429)[0].url.should.eql('/test?user=b');
        withStatus(data, 429)[1].url.should.eql('/test?user=b');
        done();
      });
    });

  });

});