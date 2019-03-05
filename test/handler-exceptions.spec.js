var _            = require('lodash');
var async        = require('async');
var should       = require('should');
var redis        = require('redis');
var express      = require('express');
var supertest    = require('supertest');
var reset        = require('./reset');

describe('Handler Exceptions', function() {

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


});