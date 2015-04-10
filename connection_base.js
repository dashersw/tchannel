// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

var inherits = require('util').inherits;
var EventEmitter = require('events').EventEmitter;

var errors = require('./errors');
var OutgoingResponse = require('./outgoing_response');

var DEFAULT_OUTGOING_REQ_TIMEOUT = 2000;

var TChannelServerOp = require('./server_op');
var TChannelClientOp = require('./client_op');

function TChannelConnectionBase(channel, direction, remoteAddr) {
    var self = this;
    EventEmitter.call(self);
    self.channel = channel;
    self.options = self.channel.options;
    self.logger = channel.logger;
    self.random = channel.random;
    self.timers = channel.timers;
    self.direction = direction;
    self.remoteAddr = remoteAddr;
    self.timer = null;
    self.remoteName = null; // filled in by identify message

    // TODO: factor out an operation collection abstraction
    self.inOps = Object.create(null);
    self.outOps = Object.create(null);
    self.pending = {
        in: 0,
        out: 0
    };

    self.lastTimeoutTime = 0;
    self.closing = false;

    self.startTimeoutTimer();
    self.tracer = self.channel.tracer;
}
inherits(TChannelConnectionBase, EventEmitter);

TChannelConnectionBase.prototype.close = function close(callback) {
    var self = this;
    self.resetAll(errors.SocketClosedError({reason: 'local close'}));
    callback();
};

// timeout check runs every timeoutCheckInterval +/- some random fuzz. Range is from
//   base - fuzz/2 to base + fuzz/2
TChannelConnectionBase.prototype.getTimeoutDelay = function getTimeoutDelay() {
    var self = this;
    var base = self.options.timeoutCheckInterval;
    var fuzz = self.options.timeoutFuzz;
    return base + Math.round(Math.floor(self.random() * fuzz) - (fuzz / 2));
};

TChannelConnectionBase.prototype.startTimeoutTimer = function startTimeoutTimer() {
    var self = this;
    self.timer = self.timers.setTimeout(function onChannelTimeout() {
        // TODO: worth it to clear the fired self.timer objcet?
        self.onTimeoutCheck();
    }, self.getTimeoutDelay());
};

TChannelConnectionBase.prototype.clearTimeoutTimer = function clearTimeoutTimer() {
    var self = this;
    if (self.timer) {
        self.timers.clearTimeout(self.timer);
        self.timer = null;
    }
};

// If the connection has some success and some timeouts, we should probably leave it up,
// but if everything is timing out, then we should kill the connection.
TChannelConnectionBase.prototype.onTimeoutCheck = function onTimeoutCheck() {
    var self = this;
    if (self.closing) {
        return;
    }
    if (self.lastTimeoutTime) {
        self.emit('timedOut');
    } else {
        self.checkOutOpsForTimeout(self.outOps);
        self.checkInOpsForTimeout(self.inOps);
        self.startTimeoutTimer();
    }
};

TChannelConnectionBase.prototype.checkInOpsForTimeout = function checkInOpsForTimeout(ops) {
    var self = this;
    var opKeys = Object.keys(ops);
    var now = self.timers.now();

    for (var i = 0; i < opKeys.length; i++) {
        var id = opKeys[i];
        var op = ops[id];

        if (op === undefined) {
            continue;
        }

        var duration = now - op.start;
        if (duration > op.req.ttl) {
            delete ops[id];
            self.pending.in--;
        }
    }
};

TChannelConnectionBase.prototype.checkOutOpsForTimeout = function checkOutOpsForTimeout(ops) {
    var self = this;
    var opKeys = Object.keys(ops);
    var now = self.timers.now();
    for (var i = 0; i < opKeys.length ; i++) {
        var id = opKeys[i];
        var op = ops[id];
        if (op.timedOut) {
            delete ops[id];
            self.pending.out--;
            self.logger.warn('lingering timed-out outgoing operation');
            continue;
        }
        if (op === undefined) {
            // TODO: why not null and empty string too? I mean I guess false
            // and 0 might be a thing, but really why not just !op?
            self.logger.warn('unexpected undefined operation', {
                id: id,
                op: op
            });
            continue;
        }
        var duration = now - op.start;
        if (duration > op.req.ttl) {
            delete ops[id];
            self.pending.out--;
            self.onReqTimeout(op);
        }
    }
};

TChannelConnectionBase.prototype.onReqTimeout = function onReqTimeout(op) {
    var self = this;
    op.timedOut = true;
    op.req.emit('error', errors.TimeoutError({
        id: op.req.id,
        start: op.start,
        elapsed: self.timers.now() - op.start,
        timeout: op.req.ttl
    }));

    // TODO: why don't we pop the op?
    self.lastTimeoutTime = self.timers.now();
};

// this connection is completely broken, and is going away
// In addition to erroring out all of the pending work, we reset the state in case anybody
// stumbles across this object in a core dump.
TChannelConnectionBase.prototype.resetAll = function resetAll(err) {
    var self = this;

    self.clearTimeoutTimer();

    if (self.closing) return;
    self.closing = true;

    var inOpKeys = Object.keys(self.inOps);
    var outOpKeys = Object.keys(self.outOps);

    if (!err) {
        err = new Error('unknown connection reset'); // TODO typed error
    }

    var isError = err.type !== 'tchannel.socket-closed';
    self.logger[isError ? 'warn' : 'info']('resetting connection', {
        error: err,
        remoteName: self.remoteName,
        localName: self.channel.hostPort,
        numInOps: inOpKeys.length,
        numOutOps: outOpKeys.length,
        inPending: self.pending.in,
        outPending: self.pending.out
    });

    if (isError) {
        self.emit('error', err);
    }

    // requests that we've received we can delete, but these reqs may have started their
    //   own outgoing work, which is hard to cancel. By setting this.closing, we make sure
    //   that once they do finish that their callback will swallow the response.
    inOpKeys.forEach(function eachInOp(id) {
        // TODO: we could support an op.cancel opt-in callback
        delete self.inOps[id];
        // TODO report or handle or log errors or something
    });

    // for all outgoing requests, forward the triggering error to the user callback
    outOpKeys.forEach(function eachOutOp(id) {
        var op = self.outOps[id];
        delete self.outOps[id];
        // TODO: shared mutable object... use Object.create(err)?
        op.req.emit('error', err);
    });

    self.pending.in = 0;
    self.pending.out = 0;
};

TChannelConnectionBase.prototype.popOutOp = function popOutOp(id) {
    var self = this;
    var op = self.outOps[id];
    if (!op) {
        // TODO else case. We should warn about an incoming response for an
        // operation we did not send out.  This could be because of a timeout
        // or could be because of a confused / corrupted server.
        return;
    }
    delete self.outOps[id];
    self.pending.out--;
    return op;
};

// create a request
TChannelConnectionBase.prototype.request = function connBaseRequest(options) {
    var self = this;
    if (!options) options = {};

    // TODO: use this to protect against >4Mi outstanding messages edge case
    // (e.g. zombie operation bug, incredible throughput, or simply very long
    // timeout
    // if (self.outOps[id]) {
    //  throw new Error('duplicate frame id in flight'); // TODO typed error
    // }
    // TODO: provide some sort of channel default for "service"
    // TODO: generate tracing if empty?
    // TODO: refactor callers
    options.checksumType = options.checksum;

    // TODO: better default, support for dynamic
    options.ttl = options.timeout || DEFAULT_OUTGOING_REQ_TIMEOUT;
    options.tracer = self.tracer;
    var req = self.buildOutgoingRequest(options);
    var id = req.id;
    self.outOps[id] = new TChannelClientOp(req, self.timers.now());
    self.pending.out++;
    return req;
};

TChannelConnectionBase.prototype.handleCallRequest = function handleCallRequest(req) {
    var self = this;
    req.remoteAddr = self.remoteName;
    var id = req.id;
    self.pending.in++;
    var op = self.inOps[id] = new TChannelServerOp(self, self.timers.now(), req);
    var done = false;
    req.on('error', onReqError);
    process.nextTick(runHandler);

    if (req.span) {
        req.span.endpoint.serviceName = self.channel.serviceName;
    }

    function onReqError(err) {
        if (!op.res) buildResponse();
        if (err.type === 'tchannel.timeout-error') {
            op.res.sendError('Timeout', err.message);
        } else {
            var errName = err.name || err.constructor.name;
            op.res.sendError('UnexpectedError', errName + ': ' + err.message);
        }
    }

    function runHandler() {
        self.channel.handler.handleRequest(req, buildResponse);
    }

    function handleSpanFromRes(span) {
        self.emit('span', span);
    }

    function buildResponse(options) {
        if (op.res && op.res.state !== OutgoingResponse.States.Initial) {
            throw errors.ResponseAlreadyStarted({
                state: op.res.state
            });
        }
        op.res = self.buildOutgoingResponse(req, options);
        op.res.on('finish', opDone);
        op.res.on('errored', opDone);
        op.res.on('span', handleSpanFromRes);
        return op.res;
    }

    function opDone() {
        if (done) return;
        done = true;
        if (self.inOps[id] !== op) {
            self.logger.warn('mismatched opDone callback', {
                hostPort: self.channel.hostPort,
                opId: id
            });
            return;
        }
        delete self.inOps[id];
        self.pending.in--;
    }
};

module.exports = TChannelConnectionBase;
