/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ({

/***/ "./node_modules/@networked-aframe/minijanus/minijanus.js":
/*!***************************************************************!*\
  !*** ./node_modules/@networked-aframe/minijanus/minijanus.js ***!
  \***************************************************************/
/***/ ((module) => {

/**
 * Represents a handle to a single Janus plugin on a Janus session. Each WebRTC connection to the Janus server will be
 * associated with a single handle. Once attached to the server, this handle will be given a unique ID which should be
 * used to associate it with future signalling messages.
 *
 * See https://janus.conf.meetecho.com/docs/rest.html#handles.
 **/
function JanusPluginHandle(session) {
  this.session = session;
  this.id = undefined;
}

/** Attaches this handle to the Janus server and sets its ID. **/
JanusPluginHandle.prototype.attach = function(plugin, loop_index) {
  var payload = { plugin: plugin, loop_index: loop_index, "force-bundle": true, "force-rtcp-mux": true };
  return this.session.send("attach", payload).then(resp => {
    this.id = resp.data.id;
    return resp;
  });
};

/** Detaches this handle. **/
JanusPluginHandle.prototype.detach = function() {
  return this.send("detach");
};

/** Registers a callback to be fired upon the reception of any incoming Janus signals for this plugin handle with the
 * `janus` attribute equal to `ev`.
 **/
JanusPluginHandle.prototype.on = function(ev, callback) {
  return this.session.on(ev, signal => {
    if (signal.sender == this.id) {
      callback(signal);
    }
  });
};

/**
 * Sends a signal associated with this handle. Signals should be JSON-serializable objects. Returns a promise that will
 * be resolved or rejected when a response to this signal is received, or when no response is received within the
 * session timeout.
 **/
JanusPluginHandle.prototype.send = function(type, signal) {
  return this.session.send(type, Object.assign({ handle_id: this.id }, signal));
};

/** Sends a plugin-specific message associated with this handle. **/
JanusPluginHandle.prototype.sendMessage = function(body) {
  return this.send("message", { body: body });
};

/** Sends a JSEP offer or answer associated with this handle. **/
JanusPluginHandle.prototype.sendJsep = function(jsep) {
  return this.send("message", { body: {}, jsep: jsep });
};

/** Sends an ICE trickle candidate associated with this handle. **/
JanusPluginHandle.prototype.sendTrickle = function(candidate) {
  return this.send("trickle", { candidate: candidate });
};

/**
 * Represents a Janus session -- a Janus context from within which you can open multiple handles and connections. Once
 * created, this session will be given a unique ID which should be used to associate it with future signalling messages.
 *
 * See https://janus.conf.meetecho.com/docs/rest.html#sessions.
 **/
function JanusSession(output, options) {
  this.output = output;
  this.id = undefined;
  this.nextTxId = 0;
  this.txns = {};
  this.eventHandlers = {};
  this.options = Object.assign({
    verbose: false,
    timeoutMs: 10000,
    keepaliveMs: 30000
  }, options);
}

/** Creates this session on the Janus server and sets its ID. **/
JanusSession.prototype.create = function() {
  return this.send("create").then(resp => {
    this.id = resp.data.id;
    return resp;
  });
};

/**
 * Destroys this session. Note that upon destruction, Janus will also close the signalling transport (if applicable) and
 * any open WebRTC connections.
 **/
JanusSession.prototype.destroy = function() {
  return this.send("destroy").then((resp) => {
    this.dispose();
    return resp;
  });
};

/**
 * Disposes of this session in a way such that no further incoming signalling messages will be processed.
 * Outstanding transactions will be rejected.
 **/
JanusSession.prototype.dispose = function() {
  this._killKeepalive();
  this.eventHandlers = {};
  for (var txId in this.txns) {
    if (this.txns.hasOwnProperty(txId)) {
      var txn = this.txns[txId];
      clearTimeout(txn.timeout);
      txn.reject(new Error("Janus session was disposed."));
      delete this.txns[txId];
    }
  }
};

/**
 * Whether this signal represents an error, and the associated promise (if any) should be rejected.
 * Users should override this to handle any custom plugin-specific error conventions.
 **/
JanusSession.prototype.isError = function(signal) {
  return signal.janus === "error";
};

/** Registers a callback to be fired upon the reception of any incoming Janus signals for this session with the
 * `janus` attribute equal to `ev`.
 **/
JanusSession.prototype.on = function(ev, callback) {
  var handlers = this.eventHandlers[ev];
  if (handlers == null) {
    handlers = this.eventHandlers[ev] = [];
  }
  handlers.push(callback);
};

/**
 * Callback for receiving JSON signalling messages pertinent to this session. If the signals are responses to previously
 * sent signals, the promises for the outgoing signals will be resolved or rejected appropriately with this signal as an
 * argument.
 *
 * External callers should call this function every time a new signal arrives on the transport; for example, in a
 * WebSocket's `message` event, or when a new datum shows up in an HTTP long-polling response.
 **/
JanusSession.prototype.receive = function(signal) {
  if (this.options.verbose) {
    this._logIncoming(signal);
  }
  if (signal.session_id != this.id) {
    console.warn("Incorrect session ID received in Janus signalling message: was " + signal.session_id + ", expected " + this.id + ".");
  }

  var responseType = signal.janus;
  var handlers = this.eventHandlers[responseType];
  if (handlers != null) {
    for (var i = 0; i < handlers.length; i++) {
      handlers[i](signal);
    }
  }

  if (signal.transaction != null) {
    var txn = this.txns[signal.transaction];
    if (txn == null) {
      // this is a response to a transaction that wasn't caused via JanusSession.send, or a plugin replied twice to a
      // single request, or the session was disposed, or something else that isn't under our purview; that's fine
      return;
    }

    if (responseType === "ack" && txn.type == "message") {
      // this is an ack of an asynchronously-processed plugin request, we should wait to resolve the promise until the
      // actual response comes in
      return;
    }

    clearTimeout(txn.timeout);

    delete this.txns[signal.transaction];
    (this.isError(signal) ? txn.reject : txn.resolve)(signal);
  }
};

/**
 * Sends a signal associated with this session, beginning a new transaction. Returns a promise that will be resolved or
 * rejected when a response is received in the same transaction, or when no response is received within the session
 * timeout.
 **/
JanusSession.prototype.send = function(type, signal) {
  signal = Object.assign({ transaction: (this.nextTxId++).toString() }, signal);
  return new Promise((resolve, reject) => {
    var timeout = null;
    if (this.options.timeoutMs) {
      timeout = setTimeout(() => {
        delete this.txns[signal.transaction];
        reject(new Error("Signalling transaction with txid " + signal.transaction + " timed out."));
      }, this.options.timeoutMs);
    }
    this.txns[signal.transaction] = { resolve: resolve, reject: reject, timeout: timeout, type: type };
    this._transmit(type, signal);
  });
};

JanusSession.prototype._transmit = function(type, signal) {
  signal = Object.assign({ janus: type }, signal);

  if (this.id != null) { // this.id is undefined in the special case when we're sending the session create message
    signal = Object.assign({ session_id: this.id }, signal);
  }

  if (this.options.verbose) {
    this._logOutgoing(signal);
  }

  this.output(JSON.stringify(signal));
  this._resetKeepalive();
};

JanusSession.prototype._logOutgoing = function(signal) {
  var kind = signal.janus;
  if (kind === "message" && signal.jsep) {
    kind = signal.jsep.type;
  }
  var message = "> Outgoing Janus " + (kind || "signal") + " (#" + signal.transaction + "): ";
  console.debug("%c" + message, "color: #040", signal);
};

JanusSession.prototype._logIncoming = function(signal) {
  var kind = signal.janus;
  var message = signal.transaction ?
      "< Incoming Janus " + (kind || "signal") + " (#" + signal.transaction + "): " :
      "< Incoming Janus " + (kind || "signal") + ": ";
  console.debug("%c" + message, "color: #004", signal);
};

JanusSession.prototype._sendKeepalive = function() {
  return this.send("keepalive");
};

JanusSession.prototype._killKeepalive = function() {
  clearTimeout(this.keepaliveTimeout);
};

JanusSession.prototype._resetKeepalive = function() {
  this._killKeepalive();
  if (this.options.keepaliveMs) {
    this.keepaliveTimeout = setTimeout(() => {
      this._sendKeepalive().catch(e => console.error("Error received from keepalive: ", e));
    }, this.options.keepaliveMs);
  }
};

module.exports = {
  JanusPluginHandle,
  JanusSession
};


/***/ }),

/***/ "./src/index.js":
/*!**********************!*\
  !*** ./src/index.js ***!
  \**********************/
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {

function _typeof(o) { "@babel/helpers - typeof"; return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) { return typeof o; } : function (o) { return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o; }, _typeof(o); }
function _slicedToArray(arr, i) { return _arrayWithHoles(arr) || _iterableToArrayLimit(arr, i) || _unsupportedIterableToArray(arr, i) || _nonIterableRest(); }
function _nonIterableRest() { throw new TypeError("Invalid attempt to destructure non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); }
function _iterableToArrayLimit(r, l) { var t = null == r ? null : "undefined" != typeof Symbol && r[Symbol.iterator] || r["@@iterator"]; if (null != t) { var e, n, i, u, a = [], f = !0, o = !1; try { if (i = (t = t.call(r)).next, 0 === l) { if (Object(t) !== t) return; f = !1; } else for (; !(f = (e = i.call(t)).done) && (a.push(e.value), a.length !== l); f = !0); } catch (r) { o = !0, n = r; } finally { try { if (!f && null != t["return"] && (u = t["return"](), Object(u) !== u)) return; } finally { if (o) throw n; } } return a; } }
function _arrayWithHoles(arr) { if (Array.isArray(arr)) return arr; }
function _createForOfIteratorHelper(o, allowArrayLike) { var it = typeof Symbol !== "undefined" && o[Symbol.iterator] || o["@@iterator"]; if (!it) { if (Array.isArray(o) || (it = _unsupportedIterableToArray(o)) || allowArrayLike && o && typeof o.length === "number") { if (it) o = it; var i = 0; var F = function F() {}; return { s: F, n: function n() { if (i >= o.length) return { done: true }; return { done: false, value: o[i++] }; }, e: function e(_e) { throw _e; }, f: F }; } throw new TypeError("Invalid attempt to iterate non-iterable instance.\nIn order to be iterable, non-array objects must have a [Symbol.iterator]() method."); } var normalCompletion = true, didErr = false, err; return { s: function s() { it = it.call(o); }, n: function n() { var step = it.next(); normalCompletion = step.done; return step; }, e: function e(_e2) { didErr = true; err = _e2; }, f: function f() { try { if (!normalCompletion && it["return"] != null) it["return"](); } finally { if (didErr) throw err; } } }; }
function _unsupportedIterableToArray(o, minLen) { if (!o) return; if (typeof o === "string") return _arrayLikeToArray(o, minLen); var n = Object.prototype.toString.call(o).slice(8, -1); if (n === "Object" && o.constructor) n = o.constructor.name; if (n === "Map" || n === "Set") return Array.from(o); if (n === "Arguments" || /^(?:Ui|I)nt(?:8|16|32)(?:Clamped)?Array$/.test(n)) return _arrayLikeToArray(o, minLen); }
function _arrayLikeToArray(arr, len) { if (len == null || len > arr.length) len = arr.length; for (var i = 0, arr2 = new Array(len); i < len; i++) arr2[i] = arr[i]; return arr2; }
function _regeneratorRuntime() { "use strict"; /*! regenerator-runtime -- Copyright (c) 2014-present, Facebook, Inc. -- license (MIT): https://github.com/facebook/regenerator/blob/main/LICENSE */ _regeneratorRuntime = function _regeneratorRuntime() { return e; }; var t, e = {}, r = Object.prototype, n = r.hasOwnProperty, o = Object.defineProperty || function (t, e, r) { t[e] = r.value; }, i = "function" == typeof Symbol ? Symbol : {}, a = i.iterator || "@@iterator", c = i.asyncIterator || "@@asyncIterator", u = i.toStringTag || "@@toStringTag"; function define(t, e, r) { return Object.defineProperty(t, e, { value: r, enumerable: !0, configurable: !0, writable: !0 }), t[e]; } try { define({}, ""); } catch (t) { define = function define(t, e, r) { return t[e] = r; }; } function wrap(t, e, r, n) { var i = e && e.prototype instanceof Generator ? e : Generator, a = Object.create(i.prototype), c = new Context(n || []); return o(a, "_invoke", { value: makeInvokeMethod(t, r, c) }), a; } function tryCatch(t, e, r) { try { return { type: "normal", arg: t.call(e, r) }; } catch (t) { return { type: "throw", arg: t }; } } e.wrap = wrap; var h = "suspendedStart", l = "suspendedYield", f = "executing", s = "completed", y = {}; function Generator() {} function GeneratorFunction() {} function GeneratorFunctionPrototype() {} var p = {}; define(p, a, function () { return this; }); var d = Object.getPrototypeOf, v = d && d(d(values([]))); v && v !== r && n.call(v, a) && (p = v); var g = GeneratorFunctionPrototype.prototype = Generator.prototype = Object.create(p); function defineIteratorMethods(t) { ["next", "throw", "return"].forEach(function (e) { define(t, e, function (t) { return this._invoke(e, t); }); }); } function AsyncIterator(t, e) { function invoke(r, o, i, a) { var c = tryCatch(t[r], t, o); if ("throw" !== c.type) { var u = c.arg, h = u.value; return h && "object" == _typeof(h) && n.call(h, "__await") ? e.resolve(h.__await).then(function (t) { invoke("next", t, i, a); }, function (t) { invoke("throw", t, i, a); }) : e.resolve(h).then(function (t) { u.value = t, i(u); }, function (t) { return invoke("throw", t, i, a); }); } a(c.arg); } var r; o(this, "_invoke", { value: function value(t, n) { function callInvokeWithMethodAndArg() { return new e(function (e, r) { invoke(t, n, e, r); }); } return r = r ? r.then(callInvokeWithMethodAndArg, callInvokeWithMethodAndArg) : callInvokeWithMethodAndArg(); } }); } function makeInvokeMethod(e, r, n) { var o = h; return function (i, a) { if (o === f) throw new Error("Generator is already running"); if (o === s) { if ("throw" === i) throw a; return { value: t, done: !0 }; } for (n.method = i, n.arg = a;;) { var c = n.delegate; if (c) { var u = maybeInvokeDelegate(c, n); if (u) { if (u === y) continue; return u; } } if ("next" === n.method) n.sent = n._sent = n.arg;else if ("throw" === n.method) { if (o === h) throw o = s, n.arg; n.dispatchException(n.arg); } else "return" === n.method && n.abrupt("return", n.arg); o = f; var p = tryCatch(e, r, n); if ("normal" === p.type) { if (o = n.done ? s : l, p.arg === y) continue; return { value: p.arg, done: n.done }; } "throw" === p.type && (o = s, n.method = "throw", n.arg = p.arg); } }; } function maybeInvokeDelegate(e, r) { var n = r.method, o = e.iterator[n]; if (o === t) return r.delegate = null, "throw" === n && e.iterator["return"] && (r.method = "return", r.arg = t, maybeInvokeDelegate(e, r), "throw" === r.method) || "return" !== n && (r.method = "throw", r.arg = new TypeError("The iterator does not provide a '" + n + "' method")), y; var i = tryCatch(o, e.iterator, r.arg); if ("throw" === i.type) return r.method = "throw", r.arg = i.arg, r.delegate = null, y; var a = i.arg; return a ? a.done ? (r[e.resultName] = a.value, r.next = e.nextLoc, "return" !== r.method && (r.method = "next", r.arg = t), r.delegate = null, y) : a : (r.method = "throw", r.arg = new TypeError("iterator result is not an object"), r.delegate = null, y); } function pushTryEntry(t) { var e = { tryLoc: t[0] }; 1 in t && (e.catchLoc = t[1]), 2 in t && (e.finallyLoc = t[2], e.afterLoc = t[3]), this.tryEntries.push(e); } function resetTryEntry(t) { var e = t.completion || {}; e.type = "normal", delete e.arg, t.completion = e; } function Context(t) { this.tryEntries = [{ tryLoc: "root" }], t.forEach(pushTryEntry, this), this.reset(!0); } function values(e) { if (e || "" === e) { var r = e[a]; if (r) return r.call(e); if ("function" == typeof e.next) return e; if (!isNaN(e.length)) { var o = -1, i = function next() { for (; ++o < e.length;) if (n.call(e, o)) return next.value = e[o], next.done = !1, next; return next.value = t, next.done = !0, next; }; return i.next = i; } } throw new TypeError(_typeof(e) + " is not iterable"); } return GeneratorFunction.prototype = GeneratorFunctionPrototype, o(g, "constructor", { value: GeneratorFunctionPrototype, configurable: !0 }), o(GeneratorFunctionPrototype, "constructor", { value: GeneratorFunction, configurable: !0 }), GeneratorFunction.displayName = define(GeneratorFunctionPrototype, u, "GeneratorFunction"), e.isGeneratorFunction = function (t) { var e = "function" == typeof t && t.constructor; return !!e && (e === GeneratorFunction || "GeneratorFunction" === (e.displayName || e.name)); }, e.mark = function (t) { return Object.setPrototypeOf ? Object.setPrototypeOf(t, GeneratorFunctionPrototype) : (t.__proto__ = GeneratorFunctionPrototype, define(t, u, "GeneratorFunction")), t.prototype = Object.create(g), t; }, e.awrap = function (t) { return { __await: t }; }, defineIteratorMethods(AsyncIterator.prototype), define(AsyncIterator.prototype, c, function () { return this; }), e.AsyncIterator = AsyncIterator, e.async = function (t, r, n, o, i) { void 0 === i && (i = Promise); var a = new AsyncIterator(wrap(t, r, n, o), i); return e.isGeneratorFunction(r) ? a : a.next().then(function (t) { return t.done ? t.value : a.next(); }); }, defineIteratorMethods(g), define(g, u, "Generator"), define(g, a, function () { return this; }), define(g, "toString", function () { return "[object Generator]"; }), e.keys = function (t) { var e = Object(t), r = []; for (var n in e) r.push(n); return r.reverse(), function next() { for (; r.length;) { var t = r.pop(); if (t in e) return next.value = t, next.done = !1, next; } return next.done = !0, next; }; }, e.values = values, Context.prototype = { constructor: Context, reset: function reset(e) { if (this.prev = 0, this.next = 0, this.sent = this._sent = t, this.done = !1, this.delegate = null, this.method = "next", this.arg = t, this.tryEntries.forEach(resetTryEntry), !e) for (var r in this) "t" === r.charAt(0) && n.call(this, r) && !isNaN(+r.slice(1)) && (this[r] = t); }, stop: function stop() { this.done = !0; var t = this.tryEntries[0].completion; if ("throw" === t.type) throw t.arg; return this.rval; }, dispatchException: function dispatchException(e) { if (this.done) throw e; var r = this; function handle(n, o) { return a.type = "throw", a.arg = e, r.next = n, o && (r.method = "next", r.arg = t), !!o; } for (var o = this.tryEntries.length - 1; o >= 0; --o) { var i = this.tryEntries[o], a = i.completion; if ("root" === i.tryLoc) return handle("end"); if (i.tryLoc <= this.prev) { var c = n.call(i, "catchLoc"), u = n.call(i, "finallyLoc"); if (c && u) { if (this.prev < i.catchLoc) return handle(i.catchLoc, !0); if (this.prev < i.finallyLoc) return handle(i.finallyLoc); } else if (c) { if (this.prev < i.catchLoc) return handle(i.catchLoc, !0); } else { if (!u) throw new Error("try statement without catch or finally"); if (this.prev < i.finallyLoc) return handle(i.finallyLoc); } } } }, abrupt: function abrupt(t, e) { for (var r = this.tryEntries.length - 1; r >= 0; --r) { var o = this.tryEntries[r]; if (o.tryLoc <= this.prev && n.call(o, "finallyLoc") && this.prev < o.finallyLoc) { var i = o; break; } } i && ("break" === t || "continue" === t) && i.tryLoc <= e && e <= i.finallyLoc && (i = null); var a = i ? i.completion : {}; return a.type = t, a.arg = e, i ? (this.method = "next", this.next = i.finallyLoc, y) : this.complete(a); }, complete: function complete(t, e) { if ("throw" === t.type) throw t.arg; return "break" === t.type || "continue" === t.type ? this.next = t.arg : "return" === t.type ? (this.rval = this.arg = t.arg, this.method = "return", this.next = "end") : "normal" === t.type && e && (this.next = e), y; }, finish: function finish(t) { for (var e = this.tryEntries.length - 1; e >= 0; --e) { var r = this.tryEntries[e]; if (r.finallyLoc === t) return this.complete(r.completion, r.afterLoc), resetTryEntry(r), y; } }, "catch": function _catch(t) { for (var e = this.tryEntries.length - 1; e >= 0; --e) { var r = this.tryEntries[e]; if (r.tryLoc === t) { var n = r.completion; if ("throw" === n.type) { var o = n.arg; resetTryEntry(r); } return o; } } throw new Error("illegal catch attempt"); }, delegateYield: function delegateYield(e, r, n) { return this.delegate = { iterator: values(e), resultName: r, nextLoc: n }, "next" === this.method && (this.arg = t), y; } }, e; }
function asyncGeneratorStep(gen, resolve, reject, _next, _throw, key, arg) { try { var info = gen[key](arg); var value = info.value; } catch (error) { reject(error); return; } if (info.done) { resolve(value); } else { Promise.resolve(value).then(_next, _throw); } }
function _asyncToGenerator(fn) { return function () { var self = this, args = arguments; return new Promise(function (resolve, reject) { var gen = fn.apply(self, args); function _next(value) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "next", value); } function _throw(err) { asyncGeneratorStep(gen, resolve, reject, _next, _throw, "throw", err); } _next(undefined); }); }; }
function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }
function _defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor); } }
function _createClass(Constructor, protoProps, staticProps) { if (protoProps) _defineProperties(Constructor.prototype, protoProps); if (staticProps) _defineProperties(Constructor, staticProps); Object.defineProperty(Constructor, "prototype", { writable: false }); return Constructor; }
function _toPropertyKey(t) { var i = _toPrimitive(t, "string"); return "symbol" == _typeof(i) ? i : String(i); }
function _toPrimitive(t, r) { if ("object" != _typeof(t) || !t) return t; var e = t[Symbol.toPrimitive]; if (void 0 !== e) { var i = e.call(t, r || "default"); if ("object" != _typeof(i)) return i; throw new TypeError("@@toPrimitive must return a primitive value."); } return ("string" === r ? String : Number)(t); }
/* global NAF */
var mj = __webpack_require__(/*! @networked-aframe/minijanus */ "./node_modules/@networked-aframe/minijanus/minijanus.js");
mj.JanusSession.prototype.sendOriginal = mj.JanusSession.prototype.send;
mj.JanusSession.prototype.send = function (type, signal) {
  return this.sendOriginal(type, signal)["catch"](function (e) {
    if (e.message && e.message.indexOf("timed out") > -1) {
      console.error("web socket timed out");
      NAF.connection.adapter.reconnect();
    } else {
      throw e;
    }
  });
};
var sdpUtils = __webpack_require__(/*! sdp */ "./node_modules/sdp/sdp.js");
var debug = __webpack_require__(/*! debug */ "./node_modules/debug/src/browser.js")("naf-janus-adapter:debug");
var warn = __webpack_require__(/*! debug */ "./node_modules/debug/src/browser.js")("naf-janus-adapter:warn");
var error = __webpack_require__(/*! debug */ "./node_modules/debug/src/browser.js")("naf-janus-adapter:error");
var isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
var SUBSCRIBE_TIMEOUT_MS = 15000;
var AVAILABLE_OCCUPANTS_THRESHOLD = 5;
var MAX_SUBSCRIBE_DELAY = 5000;
function randomDelay(min, max) {
  return new Promise(function (resolve) {
    var delay = Math.random() * (max - min) + min;
    setTimeout(resolve, delay);
  });
}
function debounce(fn) {
  var curr = Promise.resolve();
  return function () {
    var _this = this;
    var args = Array.prototype.slice.call(arguments);
    curr = curr.then(function (_) {
      return fn.apply(_this, args);
    });
  };
}
function randomUint() {
  return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
}
function untilDataChannelOpen(dataChannel) {
  return new Promise(function (resolve, reject) {
    if (dataChannel.readyState === "open") {
      resolve();
    } else {
      var resolver, rejector;
      var clear = function clear() {
        dataChannel.removeEventListener("open", resolver);
        dataChannel.removeEventListener("error", rejector);
      };
      resolver = function resolver() {
        clear();
        resolve();
      };
      rejector = function rejector() {
        clear();
        reject();
      };
      dataChannel.addEventListener("open", resolver);
      dataChannel.addEventListener("error", rejector);
    }
  });
}
var isH264VideoSupported = function () {
  var video = document.createElement("video");
  return video.canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== "";
}();
var OPUS_PARAMETERS = {
  // indicates that we want to enable DTX to elide silence packets
  usedtx: 1,
  // indicates that we prefer to receive mono audio (important for voip profile)
  stereo: 0,
  // indicates that we prefer to send mono audio (important for voip profile)
  "sprop-stereo": 0
};
var DEFAULT_PEER_CONNECTION_CONFIG = {
  iceServers: [{
    urls: "stun:stun1.l.google.com:19302"
  }, {
    urls: "stun:stun2.l.google.com:19302"
  }]
};
var WS_NORMAL_CLOSURE = 1000;
var JanusAdapter = /*#__PURE__*/function () {
  function JanusAdapter() {
    _classCallCheck(this, JanusAdapter);
    this.room = null;
    // We expect the consumer to set a client id before connecting.
    this.clientId = null;
    this.joinToken = null;
    this.serverUrl = null;
    this.webRtcOptions = {};
    this.peerConnectionConfig = null;
    this.ws = null;
    this.session = null;
    this.reliableTransport = "datachannel";
    this.unreliableTransport = "datachannel";

    // In the event the server restarts and all clients lose connection, reconnect with
    // some random jitter added to prevent simultaneous reconnection requests.
    this.initialReconnectionDelay = 1000 * Math.random();
    this.reconnectionDelay = this.initialReconnectionDelay;
    this.reconnectionTimeout = null;
    this.maxReconnectionAttempts = 10;
    this.reconnectionAttempts = 0;
    this.publisher = null;
    this.occupantIds = [];
    this.occupants = {};
    this.mediaStreams = {};
    this.localMediaStream = null;
    this.pendingMediaRequests = new Map();
    this.pendingOccupants = new Set();
    this.availableOccupants = [];
    this.requestedOccupants = null;
    this.blockedClients = new Map();
    this.frozenUpdates = new Map();
    this.timeOffsets = [];
    this.serverTimeRequests = 0;
    this.avgTimeOffset = 0;
    this.onWebsocketOpen = this.onWebsocketOpen.bind(this);
    this.onWebsocketClose = this.onWebsocketClose.bind(this);
    this.onWebsocketMessage = this.onWebsocketMessage.bind(this);
    this.onDataChannelMessage = this.onDataChannelMessage.bind(this);
    this.onData = this.onData.bind(this);
  }
  _createClass(JanusAdapter, [{
    key: "setServerUrl",
    value: function setServerUrl(url) {
      this.serverUrl = url;
    }
  }, {
    key: "setApp",
    value: function setApp(app) {}
  }, {
    key: "setRoom",
    value: function setRoom(roomName) {
      this.room = roomName;
    }
  }, {
    key: "setJoinToken",
    value: function setJoinToken(joinToken) {
      this.joinToken = joinToken;
    }
  }, {
    key: "setClientId",
    value: function setClientId(clientId) {
      this.clientId = clientId;
    }
  }, {
    key: "setWebRtcOptions",
    value: function setWebRtcOptions(options) {
      this.webRtcOptions = options;
    }
  }, {
    key: "setPeerConnectionConfig",
    value: function setPeerConnectionConfig(peerConnectionConfig) {
      this.peerConnectionConfig = peerConnectionConfig;
    }
  }, {
    key: "setServerConnectListeners",
    value: function setServerConnectListeners(successListener, failureListener) {
      this.connectSuccess = successListener;
      this.connectFailure = failureListener;
    }
  }, {
    key: "setRoomOccupantListener",
    value: function setRoomOccupantListener(occupantListener) {
      this.onOccupantsChanged = occupantListener;
    }
  }, {
    key: "setDataChannelListeners",
    value: function setDataChannelListeners(openListener, closedListener, messageListener) {
      this.onOccupantConnected = openListener;
      this.onOccupantDisconnected = closedListener;
      this.onOccupantMessage = messageListener;
    }
  }, {
    key: "setReconnectionListeners",
    value: function setReconnectionListeners(reconnectingListener, reconnectedListener, reconnectionErrorListener) {
      // onReconnecting is called with the number of milliseconds until the next reconnection attempt
      this.onReconnecting = reconnectingListener;
      // onReconnected is called when the connection has been reestablished
      this.onReconnected = reconnectedListener;
      // onReconnectionError is called with an error when maxReconnectionAttempts has been reached
      this.onReconnectionError = reconnectionErrorListener;
    }
  }, {
    key: "setEventLoops",
    value: function setEventLoops(loops) {
      this.loops = loops;
    }
  }, {
    key: "connect",
    value: function connect() {
      var _this2 = this;
      debug("connecting to ".concat(this.serverUrl));
      var websocketConnection = new Promise(function (resolve, reject) {
        _this2.ws = new WebSocket(_this2.serverUrl, "janus-protocol");
        _this2.session = new mj.JanusSession(_this2.ws.send.bind(_this2.ws), {
          timeoutMs: 40000
        });
        _this2.ws.addEventListener("close", _this2.onWebsocketClose);
        _this2.ws.addEventListener("message", _this2.onWebsocketMessage);
        _this2.wsOnOpen = function () {
          _this2.ws.removeEventListener("open", _this2.wsOnOpen);
          _this2.onWebsocketOpen().then(resolve)["catch"](reject);
        };
        _this2.ws.addEventListener("open", _this2.wsOnOpen);
      });
      return Promise.all([websocketConnection, this.updateTimeOffset()]);
    }
  }, {
    key: "disconnect",
    value: function disconnect() {
      debug("disconnecting");
      clearTimeout(this.reconnectionTimeout);
      this.removeAllOccupants();
      if (this.publisher) {
        // Close the publisher peer connection. Which also detaches the plugin handle.
        this.publisher.conn.close();
        this.publisher = null;
      }
      if (this.session) {
        this.session.dispose();
        this.session = null;
      }
      if (this.ws) {
        this.ws.removeEventListener("open", this.wsOnOpen);
        this.ws.removeEventListener("close", this.onWebsocketClose);
        this.ws.removeEventListener("message", this.onWebsocketMessage);
        this.ws.close();
        this.ws = null;
      }

      // Now that all RTCPeerConnection closed, be sure to not call
      // reconnect() again via performDelayedReconnect if previous
      // RTCPeerConnection was in the failed state.
      if (this.delayedReconnectTimeout) {
        clearTimeout(this.delayedReconnectTimeout);
        this.delayedReconnectTimeout = null;
      }
    }
  }, {
    key: "isDisconnected",
    value: function isDisconnected() {
      return this.ws === null;
    }
  }, {
    key: "onWebsocketOpen",
    value: function () {
      var _onWebsocketOpen = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee() {
        var i, occupantId;
        return _regeneratorRuntime().wrap(function _callee$(_context) {
          while (1) switch (_context.prev = _context.next) {
            case 0:
              _context.next = 2;
              return this.session.create();
            case 2:
              _context.next = 4;
              return this.createPublisher();
            case 4:
              this.publisher = _context.sent;
              // Call the naf connectSuccess callback before we start receiving WebRTC messages.
              this.connectSuccess(this.clientId);
              i = 0;
            case 7:
              if (!(i < this.publisher.initialOccupants.length)) {
                _context.next = 15;
                break;
              }
              occupantId = this.publisher.initialOccupants[i];
              if (!(occupantId === this.clientId)) {
                _context.next = 11;
                break;
              }
              return _context.abrupt("continue", 12);
            case 11:
              // Happens during non-graceful reconnects due to zombie sessions
              this.addAvailableOccupant(occupantId);
            case 12:
              i++;
              _context.next = 7;
              break;
            case 15:
              this.syncOccupants();
            case 16:
            case "end":
              return _context.stop();
          }
        }, _callee, this);
      }));
      function onWebsocketOpen() {
        return _onWebsocketOpen.apply(this, arguments);
      }
      return onWebsocketOpen;
    }()
  }, {
    key: "onWebsocketClose",
    value: function onWebsocketClose(event) {
      var _this3 = this;
      // The connection was closed successfully. Don't try to reconnect.
      if (event.code === WS_NORMAL_CLOSURE) {
        return;
      }
      console.warn("Janus websocket closed unexpectedly.");
      if (this.onReconnecting) {
        this.onReconnecting(this.reconnectionDelay);
      }
      this.reconnectionTimeout = setTimeout(function () {
        return _this3.reconnect();
      }, this.reconnectionDelay);
    }
  }, {
    key: "reconnect",
    value: function reconnect() {
      var _this4 = this;
      // Dispose of all networked entities and other resources tied to the session.
      this.disconnect();
      this.connect().then(function () {
        _this4.reconnectionDelay = _this4.initialReconnectionDelay;
        _this4.reconnectionAttempts = 0;
        if (_this4.onReconnected) {
          _this4.onReconnected();
        }
      })["catch"](function (error) {
        _this4.reconnectionDelay += 1000;
        _this4.reconnectionAttempts++;
        if (_this4.reconnectionAttempts > _this4.maxReconnectionAttempts && _this4.onReconnectionError) {
          return _this4.onReconnectionError(new Error("Connection could not be reestablished, exceeded maximum number of reconnection attempts."));
        }
        console.warn("Error during reconnect, retrying.");
        console.warn(error);
        if (_this4.onReconnecting) {
          _this4.onReconnecting(_this4.reconnectionDelay);
        }
        _this4.reconnectionTimeout = setTimeout(function () {
          return _this4.reconnect();
        }, _this4.reconnectionDelay);
      });
    }
  }, {
    key: "performDelayedReconnect",
    value: function performDelayedReconnect() {
      var _this5 = this;
      if (this.delayedReconnectTimeout) {
        clearTimeout(this.delayedReconnectTimeout);
      }
      this.delayedReconnectTimeout = setTimeout(function () {
        _this5.delayedReconnectTimeout = null;
        _this5.reconnect();
      }, 10000);
    }
  }, {
    key: "onWebsocketMessage",
    value: function onWebsocketMessage(event) {
      this.session.receive(JSON.parse(event.data));
    }
  }, {
    key: "addAvailableOccupant",
    value: function addAvailableOccupant(occupantId) {
      if (this.availableOccupants.indexOf(occupantId) === -1) {
        this.availableOccupants.push(occupantId);
      }
    }
  }, {
    key: "removeAvailableOccupant",
    value: function removeAvailableOccupant(occupantId) {
      var idx = this.availableOccupants.indexOf(occupantId);
      if (idx !== -1) {
        this.availableOccupants.splice(idx, 1);
      }
    }
  }, {
    key: "syncOccupants",
    value: function syncOccupants(requestedOccupants) {
      if (requestedOccupants) {
        this.requestedOccupants = requestedOccupants;
      }
      if (!this.requestedOccupants) {
        return;
      }

      // Add any requested, available, and non-pending occupants.
      for (var i = 0; i < this.requestedOccupants.length; i++) {
        var occupantId = this.requestedOccupants[i];
        if (!this.occupants[occupantId] && this.availableOccupants.indexOf(occupantId) !== -1 && !this.pendingOccupants.has(occupantId)) {
          this.addOccupant(occupantId);
        }
      }

      // Remove any unrequested and currently added occupants.
      for (var j = 0; j < this.availableOccupants.length; j++) {
        var _occupantId = this.availableOccupants[j];
        if (this.occupants[_occupantId] && this.requestedOccupants.indexOf(_occupantId) === -1) {
          this.removeOccupant(_occupantId);
        }
      }

      // Call the Networked AFrame callbacks for the updated occupants list.
      this.onOccupantsChanged(this.occupants);
    }
  }, {
    key: "addOccupant",
    value: function () {
      var _addOccupant = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee2(occupantId) {
        var availableOccupantsCount, subscriber;
        return _regeneratorRuntime().wrap(function _callee2$(_context2) {
          while (1) switch (_context2.prev = _context2.next) {
            case 0:
              this.pendingOccupants.add(occupantId);
              availableOccupantsCount = this.availableOccupants.length;
              if (!(availableOccupantsCount > AVAILABLE_OCCUPANTS_THRESHOLD)) {
                _context2.next = 5;
                break;
              }
              _context2.next = 5;
              return randomDelay(0, MAX_SUBSCRIBE_DELAY);
            case 5:
              _context2.next = 7;
              return this.createSubscriber(occupantId);
            case 7:
              subscriber = _context2.sent;
              if (subscriber) {
                if (!this.pendingOccupants.has(occupantId)) {
                  subscriber.conn.close();
                } else {
                  this.pendingOccupants["delete"](occupantId);
                  this.occupantIds.push(occupantId);
                  this.occupants[occupantId] = subscriber;
                  this.setMediaStream(occupantId, subscriber.mediaStream);

                  // Call the Networked AFrame callbacks for the new occupant.
                  this.onOccupantConnected(occupantId);
                }
              }
            case 9:
            case "end":
              return _context2.stop();
          }
        }, _callee2, this);
      }));
      function addOccupant(_x) {
        return _addOccupant.apply(this, arguments);
      }
      return addOccupant;
    }()
  }, {
    key: "removeAllOccupants",
    value: function removeAllOccupants() {
      this.pendingOccupants.clear();
      for (var i = this.occupantIds.length - 1; i >= 0; i--) {
        this.removeOccupant(this.occupantIds[i]);
      }
    }
  }, {
    key: "removeOccupant",
    value: function removeOccupant(occupantId) {
      this.pendingOccupants["delete"](occupantId);
      if (this.occupants[occupantId]) {
        // Close the subscriber peer connection. Which also detaches the plugin handle.
        this.occupants[occupantId].conn.close();
        delete this.occupants[occupantId];
        this.occupantIds.splice(this.occupantIds.indexOf(occupantId), 1);
      }
      if (this.mediaStreams[occupantId]) {
        delete this.mediaStreams[occupantId];
      }
      if (this.pendingMediaRequests.has(occupantId)) {
        var msg = "The user disconnected before the media stream was resolved.";
        this.pendingMediaRequests.get(occupantId).audio.reject(msg);
        this.pendingMediaRequests.get(occupantId).video.reject(msg);
        this.pendingMediaRequests["delete"](occupantId);
      }

      // Call the Networked AFrame callbacks for the removed occupant.
      this.onOccupantDisconnected(occupantId);
    }
  }, {
    key: "associate",
    value: function associate(conn, handle) {
      var _this6 = this;
      conn.addEventListener("icecandidate", function (ev) {
        handle.sendTrickle(ev.candidate || null)["catch"](function (e) {
          return error("Error trickling ICE: %o", e);
        });
      });
      conn.addEventListener("iceconnectionstatechange", function (ev) {
        if (conn.iceConnectionState === "connected") {
          console.log("ICE state changed to connected");
        }
        if (conn.iceConnectionState === "disconnected") {
          console.warn("ICE state changed to disconnected");
        }
        if (conn.iceConnectionState === "failed") {
          console.warn("ICE failure detected. Reconnecting in 10s.");
          _this6.performDelayedReconnect();
        }
      });

      // we have to debounce these because janus gets angry if you send it a new SDP before
      // it's finished processing an existing SDP. in actuality, it seems like this is maybe
      // too liberal and we need to wait some amount of time after an offer before sending another,
      // but we don't currently know any good way of detecting exactly how long :(
      conn.addEventListener("negotiationneeded", debounce(function (ev) {
        debug("Sending new offer for handle: %o", handle);
        var offer = conn.createOffer().then(_this6.configurePublisherSdp).then(_this6.fixSafariIceUFrag);
        var local = offer.then(function (o) {
          return conn.setLocalDescription(o);
        });
        var remote = offer;
        remote = remote.then(_this6.fixSafariIceUFrag).then(function (j) {
          return handle.sendJsep(j);
        }).then(function (r) {
          return conn.setRemoteDescription(r.jsep);
        });
        return Promise.all([local, remote])["catch"](function (e) {
          return error("Error negotiating offer: %o", e);
        });
      }));
      handle.on("event", debounce(function (ev) {
        var jsep = ev.jsep;
        if (jsep && jsep.type == "offer") {
          debug("Accepting new offer for handle: %o", handle);
          var answer = conn.setRemoteDescription(_this6.configureSubscriberSdp(jsep)).then(function (_) {
            return conn.createAnswer();
          }).then(_this6.fixSafariIceUFrag);
          var local = answer.then(function (a) {
            return conn.setLocalDescription(a);
          });
          var remote = answer.then(function (j) {
            return handle.sendJsep(j);
          });
          return Promise.all([local, remote])["catch"](function (e) {
            return error("Error negotiating answer: %o", e);
          });
        } else {
          // some other kind of event, nothing to do
          return null;
        }
      }));
    }
  }, {
    key: "createPublisher",
    value: function () {
      var _createPublisher = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee3() {
        var _this7 = this;
        var handle, conn, webrtcup, reliableChannel, unreliableChannel, message, err, initialOccupants;
        return _regeneratorRuntime().wrap(function _callee3$(_context3) {
          while (1) switch (_context3.prev = _context3.next) {
            case 0:
              handle = new mj.JanusPluginHandle(this.session);
              conn = new RTCPeerConnection(this.peerConnectionConfig || DEFAULT_PEER_CONNECTION_CONFIG);
              debug("pub waiting for sfu");
              _context3.next = 5;
              return handle.attach("janus.plugin.sfu", this.loops && this.clientId ? parseInt(this.clientId) % this.loops : undefined);
            case 5:
              this.associate(conn, handle);
              debug("pub waiting for data channels & webrtcup");
              webrtcup = new Promise(function (resolve) {
                return handle.on("webrtcup", resolve);
              }); // Unreliable datachannel: sending and receiving component updates.
              // Reliable datachannel: sending and recieving entity instantiations.
              reliableChannel = conn.createDataChannel("reliable", {
                ordered: true
              });
              unreliableChannel = conn.createDataChannel("unreliable", {
                ordered: false,
                maxRetransmits: 0
              });
              reliableChannel.addEventListener("message", function (e) {
                return _this7.onDataChannelMessage(e, "janus-reliable");
              });
              unreliableChannel.addEventListener("message", function (e) {
                return _this7.onDataChannelMessage(e, "janus-unreliable");
              });
              _context3.next = 14;
              return webrtcup;
            case 14:
              _context3.next = 16;
              return untilDataChannelOpen(reliableChannel);
            case 16:
              _context3.next = 18;
              return untilDataChannelOpen(unreliableChannel);
            case 18:
              // doing this here is sort of a hack around chrome renegotiation weirdness --
              // if we do it prior to webrtcup, chrome on gear VR will sometimes put a
              // renegotiation offer in flight while the first offer was still being
              // processed by janus. we should find some more principled way to figure out
              // when janus is done in the future.
              if (this.localMediaStream) {
                this.localMediaStream.getTracks().forEach(function (track) {
                  conn.addTrack(track, _this7.localMediaStream);
                });
              }

              // Handle all of the join and leave events.
              handle.on("event", function (ev) {
                var data = ev.plugindata.data;
                if (data.event == "join" && data.room_id == _this7.room) {
                  if (_this7.delayedReconnectTimeout) {
                    // Don't create a new RTCPeerConnection, all RTCPeerConnection will be closed in less than 10s.
                    return;
                  }
                  _this7.addAvailableOccupant(data.user_id);
                  _this7.syncOccupants();
                } else if (data.event == "leave" && data.room_id == _this7.room) {
                  _this7.removeAvailableOccupant(data.user_id);
                  _this7.removeOccupant(data.user_id);
                } else if (data.event == "blocked") {
                  document.body.dispatchEvent(new CustomEvent("blocked", {
                    detail: {
                      clientId: data.by
                    }
                  }));
                } else if (data.event == "unblocked") {
                  document.body.dispatchEvent(new CustomEvent("unblocked", {
                    detail: {
                      clientId: data.by
                    }
                  }));
                } else if (data.event === "data") {
                  _this7.onData(JSON.parse(data.body), "janus-event");
                }
              });
              debug("pub waiting for join");

              // Send join message to janus. Listen for join/leave messages. Automatically subscribe to all users' WebRTC data.
              _context3.next = 23;
              return this.sendJoin(handle, {
                notifications: true,
                data: true
              });
            case 23:
              message = _context3.sent;
              if (message.plugindata.data.success) {
                _context3.next = 29;
                break;
              }
              err = message.plugindata.data.error;
              console.error(err);
              // We may get here because of an expired JWT.
              // Close the connection ourself otherwise janus will close it after
              // session_timeout because we didn't send any keepalive and this will
              // trigger a delayed reconnect because of the iceconnectionstatechange
              // listener for failure state.
              // Even if the app code calls disconnect in case of error, disconnect
              // won't close the peer connection because this.publisher is not set.
              conn.close();
              throw err;
            case 29:
              initialOccupants = message.plugindata.data.response.users[this.room] || [];
              if (initialOccupants.includes(this.clientId)) {
                console.warn("Janus still has previous session for this client. Reconnecting in 10s.");
                this.performDelayedReconnect();
              }
              debug("publisher ready");
              return _context3.abrupt("return", {
                handle: handle,
                initialOccupants: initialOccupants,
                reliableChannel: reliableChannel,
                unreliableChannel: unreliableChannel,
                conn: conn
              });
            case 33:
            case "end":
              return _context3.stop();
          }
        }, _callee3, this);
      }));
      function createPublisher() {
        return _createPublisher.apply(this, arguments);
      }
      return createPublisher;
    }()
  }, {
    key: "configurePublisherSdp",
    value: function configurePublisherSdp(jsep) {
      jsep.sdp = jsep.sdp.replace(/a=fmtp:(109|111).*\r\n/g, function (line, pt) {
        var parameters = Object.assign(sdpUtils.parseFmtp(line), OPUS_PARAMETERS);
        return sdpUtils.writeFmtp({
          payloadType: pt,
          parameters: parameters
        });
      });
      return jsep;
    }
  }, {
    key: "configureSubscriberSdp",
    value: function configureSubscriberSdp(jsep) {
      // todo: consider cleaning up these hacks to use sdputils
      if (!isH264VideoSupported) {
        if (navigator.userAgent.indexOf("HeadlessChrome") !== -1) {
          // HeadlessChrome (e.g. puppeteer) doesn't support webrtc video streams, so we remove those lines from the SDP.
          jsep.sdp = jsep.sdp.replace(/m=video[^]*m=/, "m=");
        }
      }

      // TODO: Hack to get video working on Chrome for Android. https://groups.google.com/forum/#!topic/mozilla.dev.media/Ye29vuMTpo8
      if (navigator.userAgent.indexOf("Android") === -1) {
        jsep.sdp = jsep.sdp.replace("a=rtcp-fb:107 goog-remb\r\n", "a=rtcp-fb:107 goog-remb\r\na=rtcp-fb:107 transport-cc\r\na=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f\r\n");
      } else {
        jsep.sdp = jsep.sdp.replace("a=rtcp-fb:107 goog-remb\r\n", "a=rtcp-fb:107 goog-remb\r\na=rtcp-fb:107 transport-cc\r\na=fmtp:107 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f\r\n");
      }
      return jsep;
    }
  }, {
    key: "fixSafariIceUFrag",
    value: function () {
      var _fixSafariIceUFrag = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee4(jsep) {
        return _regeneratorRuntime().wrap(function _callee4$(_context4) {
          while (1) switch (_context4.prev = _context4.next) {
            case 0:
              // Safari produces a \n instead of an \r\n for the ice-ufrag. See https://github.com/meetecho/janus-gateway/issues/1818
              jsep.sdp = jsep.sdp.replace(/[^\r]\na=ice-ufrag/g, "\r\na=ice-ufrag");
              return _context4.abrupt("return", jsep);
            case 2:
            case "end":
              return _context4.stop();
          }
        }, _callee4);
      }));
      function fixSafariIceUFrag(_x2) {
        return _fixSafariIceUFrag.apply(this, arguments);
      }
      return fixSafariIceUFrag;
    }()
  }, {
    key: "createSubscriber",
    value: function () {
      var _createSubscriber = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee5(occupantId) {
        var _this8 = this;
        var maxRetries,
          handle,
          conn,
          webrtcFailed,
          webrtcup,
          mediaStream,
          receivers,
          _args5 = arguments;
        return _regeneratorRuntime().wrap(function _callee5$(_context5) {
          while (1) switch (_context5.prev = _context5.next) {
            case 0:
              maxRetries = _args5.length > 1 && _args5[1] !== undefined ? _args5[1] : 5;
              if (!(this.availableOccupants.indexOf(occupantId) === -1)) {
                _context5.next = 4;
                break;
              }
              console.warn(occupantId + ": cancelled occupant connection, occupant left before subscription negotation.");
              return _context5.abrupt("return", null);
            case 4:
              handle = new mj.JanusPluginHandle(this.session);
              conn = new RTCPeerConnection(this.peerConnectionConfig || DEFAULT_PEER_CONNECTION_CONFIG);
              debug(occupantId + ": sub waiting for sfu");
              _context5.next = 9;
              return handle.attach("janus.plugin.sfu", this.loops ? parseInt(occupantId) % this.loops : undefined);
            case 9:
              this.associate(conn, handle);
              debug(occupantId + ": sub waiting for join");
              if (!(this.availableOccupants.indexOf(occupantId) === -1)) {
                _context5.next = 15;
                break;
              }
              conn.close();
              console.warn(occupantId + ": cancelled occupant connection, occupant left after attach");
              return _context5.abrupt("return", null);
            case 15:
              webrtcFailed = false;
              webrtcup = new Promise(function (resolve) {
                var leftInterval = setInterval(function () {
                  if (_this8.availableOccupants.indexOf(occupantId) === -1) {
                    clearInterval(leftInterval);
                    resolve();
                  }
                }, 1000);
                var timeout = setTimeout(function () {
                  clearInterval(leftInterval);
                  webrtcFailed = true;
                  resolve();
                }, SUBSCRIBE_TIMEOUT_MS);
                handle.on("webrtcup", function () {
                  clearTimeout(timeout);
                  clearInterval(leftInterval);
                  resolve();
                });
              }); // Send join message to janus. Don't listen for join/leave messages. Subscribe to the occupant's media.
              // Janus should send us an offer for this occupant's media in response to this.
              _context5.next = 19;
              return this.sendJoin(handle, {
                media: occupantId
              });
            case 19:
              if (!(this.availableOccupants.indexOf(occupantId) === -1)) {
                _context5.next = 23;
                break;
              }
              conn.close();
              console.warn(occupantId + ": cancelled occupant connection, occupant left after join");
              return _context5.abrupt("return", null);
            case 23:
              debug(occupantId + ": sub waiting for webrtcup");
              _context5.next = 26;
              return webrtcup;
            case 26:
              if (!(this.availableOccupants.indexOf(occupantId) === -1)) {
                _context5.next = 30;
                break;
              }
              conn.close();
              console.warn(occupantId + ": cancel occupant connection, occupant left during or after webrtcup");
              return _context5.abrupt("return", null);
            case 30:
              if (!webrtcFailed) {
                _context5.next = 39;
                break;
              }
              conn.close();
              if (!(maxRetries > 0)) {
                _context5.next = 37;
                break;
              }
              console.warn(occupantId + ": webrtc up timed out, retrying");
              return _context5.abrupt("return", this.createSubscriber(occupantId, maxRetries - 1));
            case 37:
              console.warn(occupantId + ": webrtc up timed out");
              return _context5.abrupt("return", null);
            case 39:
              if (!(isSafari && !this._iOSHackDelayedInitialPeer)) {
                _context5.next = 43;
                break;
              }
              _context5.next = 42;
              return new Promise(function (resolve) {
                return setTimeout(resolve, 3000);
              });
            case 42:
              this._iOSHackDelayedInitialPeer = true;
            case 43:
              mediaStream = new MediaStream();
              receivers = conn.getReceivers();
              receivers.forEach(function (receiver) {
                if (receiver.track) {
                  mediaStream.addTrack(receiver.track);
                }
              });
              if (mediaStream.getTracks().length === 0) {
                mediaStream = null;
              }
              debug(occupantId + ": subscriber ready");
              return _context5.abrupt("return", {
                handle: handle,
                mediaStream: mediaStream,
                conn: conn
              });
            case 49:
            case "end":
              return _context5.stop();
          }
        }, _callee5, this);
      }));
      function createSubscriber(_x3) {
        return _createSubscriber.apply(this, arguments);
      }
      return createSubscriber;
    }()
  }, {
    key: "sendJoin",
    value: function sendJoin(handle, subscribe) {
      return handle.sendMessage({
        kind: "join",
        room_id: this.room,
        user_id: this.clientId,
        subscribe: subscribe,
        token: this.joinToken
      });
    }
  }, {
    key: "toggleFreeze",
    value: function toggleFreeze() {
      if (this.frozen) {
        this.unfreeze();
      } else {
        this.freeze();
      }
    }
  }, {
    key: "freeze",
    value: function freeze() {
      this.frozen = true;
    }
  }, {
    key: "unfreeze",
    value: function unfreeze() {
      this.frozen = false;
      this.flushPendingUpdates();
    }
  }, {
    key: "dataForUpdateMultiMessage",
    value: function dataForUpdateMultiMessage(networkId, message) {
      // "d" is an array of entity datas, where each item in the array represents a unique entity and contains
      // metadata for the entity, and an array of components that have been updated on the entity.
      // This method finds the data corresponding to the given networkId.
      for (var i = 0, l = message.data.d.length; i < l; i++) {
        var data = message.data.d[i];
        if (data.networkId === networkId) {
          return data;
        }
      }
      return null;
    }
  }, {
    key: "getPendingData",
    value: function getPendingData(networkId, message) {
      if (!message) return null;
      var data = message.dataType === "um" ? this.dataForUpdateMultiMessage(networkId, message) : message.data;

      // Ignore messages relating to users who have disconnected since freezing, their entities
      // will have aleady been removed by NAF.
      // Note that delete messages have no "owner" so we have to check for that as well.
      if (data.owner && !this.occupants[data.owner]) return null;

      // Ignore messages from users that we may have blocked while frozen.
      if (data.owner && this.blockedClients.has(data.owner)) return null;
      return data;
    }

    // Used externally
  }, {
    key: "getPendingDataForNetworkId",
    value: function getPendingDataForNetworkId(networkId) {
      return this.getPendingData(networkId, this.frozenUpdates.get(networkId));
    }
  }, {
    key: "flushPendingUpdates",
    value: function flushPendingUpdates() {
      var _iterator = _createForOfIteratorHelper(this.frozenUpdates),
        _step;
      try {
        for (_iterator.s(); !(_step = _iterator.n()).done;) {
          var _step$value = _slicedToArray(_step.value, 2),
            networkId = _step$value[0],
            message = _step$value[1];
          var data = this.getPendingData(networkId, message);
          if (!data) continue;

          // Override the data type on "um" messages types, since we extract entity updates from "um" messages into
          // individual frozenUpdates in storeSingleMessage.
          var dataType = message.dataType === "um" ? "u" : message.dataType;
          this.onOccupantMessage(null, dataType, data, message.source);
        }
      } catch (err) {
        _iterator.e(err);
      } finally {
        _iterator.f();
      }
      this.frozenUpdates.clear();
    }
  }, {
    key: "storeMessage",
    value: function storeMessage(message) {
      if (message.dataType === "um") {
        // UpdateMulti
        for (var i = 0, l = message.data.d.length; i < l; i++) {
          this.storeSingleMessage(message, i);
        }
      } else {
        this.storeSingleMessage(message);
      }
    }
  }, {
    key: "storeSingleMessage",
    value: function storeSingleMessage(message, index) {
      var data = index !== undefined ? message.data.d[index] : message.data;
      var dataType = message.dataType;
      var source = message.source;
      var networkId = data.networkId;
      if (!this.frozenUpdates.has(networkId)) {
        this.frozenUpdates.set(networkId, message);
      } else {
        var storedMessage = this.frozenUpdates.get(networkId);
        var storedData = storedMessage.dataType === "um" ? this.dataForUpdateMultiMessage(networkId, storedMessage) : storedMessage.data;

        // Avoid updating components if the entity data received did not come from the current owner.
        var isOutdatedMessage = data.lastOwnerTime < storedData.lastOwnerTime;
        var isContemporaneousMessage = data.lastOwnerTime === storedData.lastOwnerTime;
        if (isOutdatedMessage || isContemporaneousMessage && storedData.owner > data.owner) {
          return;
        }
        if (dataType === "r") {
          var createdWhileFrozen = storedData && storedData.isFirstSync;
          if (createdWhileFrozen) {
            // If the entity was created and deleted while frozen, don't bother conveying anything to the consumer.
            this.frozenUpdates["delete"](networkId);
          } else {
            // Delete messages override any other messages for this entity
            this.frozenUpdates.set(networkId, message);
          }
        } else {
          // merge in component updates
          if (storedData.components && data.components) {
            Object.assign(storedData.components, data.components);
          }
        }
      }
    }
  }, {
    key: "onDataChannelMessage",
    value: function onDataChannelMessage(e, source) {
      this.onData(JSON.parse(e.data), source);
    }
  }, {
    key: "onData",
    value: function onData(message, source) {
      if (debug.enabled) {
        debug("DC in: ".concat(message));
      }
      if (!message.dataType) return;
      message.source = source;
      if (this.frozen) {
        this.storeMessage(message);
      } else {
        this.onOccupantMessage(null, message.dataType, message.data, message.source);
      }
    }
  }, {
    key: "shouldStartConnectionTo",
    value: function shouldStartConnectionTo(client) {
      return true;
    }
  }, {
    key: "startStreamConnection",
    value: function startStreamConnection(client) {}
  }, {
    key: "closeStreamConnection",
    value: function closeStreamConnection(client) {}
  }, {
    key: "getConnectStatus",
    value: function getConnectStatus(clientId) {
      return this.occupants[clientId] ? NAF.adapters.IS_CONNECTED : NAF.adapters.NOT_CONNECTED;
    }
  }, {
    key: "updateTimeOffset",
    value: function () {
      var _updateTimeOffset = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee6() {
        var _this9 = this;
        var clientSentTime, res, precision, serverReceivedTime, clientReceivedTime, serverTime, timeOffset;
        return _regeneratorRuntime().wrap(function _callee6$(_context6) {
          while (1) switch (_context6.prev = _context6.next) {
            case 0:
              if (!this.isDisconnected()) {
                _context6.next = 2;
                break;
              }
              return _context6.abrupt("return");
            case 2:
              clientSentTime = Date.now();
              _context6.next = 5;
              return fetch(document.location.href, {
                method: "HEAD",
                cache: "no-cache"
              });
            case 5:
              res = _context6.sent;
              precision = 1000;
              serverReceivedTime = new Date(res.headers.get("Date")).getTime() + precision / 2;
              clientReceivedTime = Date.now();
              serverTime = serverReceivedTime + (clientReceivedTime - clientSentTime) / 2;
              timeOffset = serverTime - clientReceivedTime;
              this.serverTimeRequests++;
              if (this.serverTimeRequests <= 10) {
                this.timeOffsets.push(timeOffset);
              } else {
                this.timeOffsets[this.serverTimeRequests % 10] = timeOffset;
              }
              this.avgTimeOffset = this.timeOffsets.reduce(function (acc, offset) {
                return acc += offset;
              }, 0) / this.timeOffsets.length;
              if (this.serverTimeRequests > 10) {
                debug("new server time offset: ".concat(this.avgTimeOffset, "ms"));
                setTimeout(function () {
                  return _this9.updateTimeOffset();
                }, 5 * 60 * 1000); // Sync clock every 5 minutes.
              } else {
                this.updateTimeOffset();
              }
            case 15:
            case "end":
              return _context6.stop();
          }
        }, _callee6, this);
      }));
      function updateTimeOffset() {
        return _updateTimeOffset.apply(this, arguments);
      }
      return updateTimeOffset;
    }()
  }, {
    key: "getServerTime",
    value: function getServerTime() {
      return Date.now() + this.avgTimeOffset;
    }
  }, {
    key: "getMediaStream",
    value: function getMediaStream(clientId) {
      var _this10 = this;
      var type = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : "audio";
      if (this.mediaStreams[clientId]) {
        debug("Already had ".concat(type, " for ").concat(clientId));
        return Promise.resolve(this.mediaStreams[clientId][type]);
      } else {
        debug("Waiting on ".concat(type, " for ").concat(clientId));
        if (!this.pendingMediaRequests.has(clientId)) {
          this.pendingMediaRequests.set(clientId, {});
          var audioPromise = new Promise(function (resolve, reject) {
            _this10.pendingMediaRequests.get(clientId).audio = {
              resolve: resolve,
              reject: reject
            };
          });
          var videoPromise = new Promise(function (resolve, reject) {
            _this10.pendingMediaRequests.get(clientId).video = {
              resolve: resolve,
              reject: reject
            };
          });
          this.pendingMediaRequests.get(clientId).audio.promise = audioPromise;
          this.pendingMediaRequests.get(clientId).video.promise = videoPromise;
          audioPromise["catch"](function (e) {
            return console.warn("".concat(clientId, " getMediaStream Audio Error"), e);
          });
          videoPromise["catch"](function (e) {
            return console.warn("".concat(clientId, " getMediaStream Video Error"), e);
          });
        }
        return this.pendingMediaRequests.get(clientId)[type].promise;
      }
    }
  }, {
    key: "setMediaStream",
    value: function setMediaStream(clientId, stream) {
      // Safari doesn't like it when you use single a mixed media stream where one of the tracks is inactive, so we
      // split the tracks into two streams.
      var audioStream = new MediaStream();
      try {
        stream.getAudioTracks().forEach(function (track) {
          return audioStream.addTrack(track);
        });
      } catch (e) {
        console.warn("".concat(clientId, " setMediaStream Audio Error"), e);
      }
      var videoStream = new MediaStream();
      try {
        stream.getVideoTracks().forEach(function (track) {
          return videoStream.addTrack(track);
        });
      } catch (e) {
        console.warn("".concat(clientId, " setMediaStream Video Error"), e);
      }
      this.mediaStreams[clientId] = {
        audio: audioStream,
        video: videoStream
      };

      // Resolve the promise for the user's media stream if it exists.
      if (this.pendingMediaRequests.has(clientId)) {
        this.pendingMediaRequests.get(clientId).audio.resolve(audioStream);
        this.pendingMediaRequests.get(clientId).video.resolve(videoStream);
      }
    }
  }, {
    key: "setLocalMediaStream",
    value: function () {
      var _setLocalMediaStream = _asyncToGenerator( /*#__PURE__*/_regeneratorRuntime().mark(function _callee7(stream) {
        var _this11 = this;
        var existingSenders, newSenders, tracks, _loop, i;
        return _regeneratorRuntime().wrap(function _callee7$(_context8) {
          while (1) switch (_context8.prev = _context8.next) {
            case 0:
              if (!(this.publisher && this.publisher.conn)) {
                _context8.next = 12;
                break;
              }
              existingSenders = this.publisher.conn.getSenders();
              newSenders = [];
              tracks = stream.getTracks();
              _loop = /*#__PURE__*/_regeneratorRuntime().mark(function _loop() {
                var t, sender;
                return _regeneratorRuntime().wrap(function _loop$(_context7) {
                  while (1) switch (_context7.prev = _context7.next) {
                    case 0:
                      t = tracks[i];
                      sender = existingSenders.find(function (s) {
                        return s.track != null && s.track.kind == t.kind;
                      });
                      if (!(sender != null)) {
                        _context7.next = 14;
                        break;
                      }
                      if (!sender.replaceTrack) {
                        _context7.next = 9;
                        break;
                      }
                      _context7.next = 6;
                      return sender.replaceTrack(t);
                    case 6:
                      // Workaround https://bugzilla.mozilla.org/show_bug.cgi?id=1576771
                      if (t.kind === "video" && t.enabled && navigator.userAgent.toLowerCase().indexOf('firefox') > -1) {
                        t.enabled = false;
                        setTimeout(function () {
                          return t.enabled = true;
                        }, 1000);
                      }
                      _context7.next = 11;
                      break;
                    case 9:
                      // Fallback for browsers that don't support replaceTrack. At this time of this writing
                      // most browsers support it, and testing this code path seems to not work properly
                      // in Chrome anymore.
                      stream.removeTrack(sender.track);
                      stream.addTrack(t);
                    case 11:
                      newSenders.push(sender);
                      _context7.next = 15;
                      break;
                    case 14:
                      newSenders.push(_this11.publisher.conn.addTrack(t, stream));
                    case 15:
                    case "end":
                      return _context7.stop();
                  }
                }, _loop);
              });
              i = 0;
            case 6:
              if (!(i < tracks.length)) {
                _context8.next = 11;
                break;
              }
              return _context8.delegateYield(_loop(), "t0", 8);
            case 8:
              i++;
              _context8.next = 6;
              break;
            case 11:
              existingSenders.forEach(function (s) {
                if (!newSenders.includes(s)) {
                  s.track.enabled = false;
                }
              });
            case 12:
              this.localMediaStream = stream;
              this.setMediaStream(this.clientId, stream);
            case 14:
            case "end":
              return _context8.stop();
          }
        }, _callee7, this);
      }));
      function setLocalMediaStream(_x4) {
        return _setLocalMediaStream.apply(this, arguments);
      }
      return setLocalMediaStream;
    }()
  }, {
    key: "enableMicrophone",
    value: function enableMicrophone(enabled) {
      if (this.publisher && this.publisher.conn) {
        this.publisher.conn.getSenders().forEach(function (s) {
          if (s.track.kind == "audio") {
            s.track.enabled = enabled;
          }
        });
      }
    }
  }, {
    key: "sendData",
    value: function sendData(clientId, dataType, data) {
      if (!this.publisher) {
        console.warn("sendData called without a publisher");
      } else {
        switch (this.unreliableTransport) {
          case "websocket":
            this.publisher.handle.sendMessage({
              kind: "data",
              body: JSON.stringify({
                dataType: dataType,
                data: data
              }),
              whom: clientId
            });
            break;
          case "datachannel":
            this.publisher.unreliableChannel.send(JSON.stringify({
              clientId: clientId,
              dataType: dataType,
              data: data
            }));
            break;
          default:
            this.unreliableTransport(clientId, dataType, data);
            break;
        }
      }
    }
  }, {
    key: "sendDataGuaranteed",
    value: function sendDataGuaranteed(clientId, dataType, data) {
      if (!this.publisher) {
        console.warn("sendDataGuaranteed called without a publisher");
      } else {
        switch (this.reliableTransport) {
          case "websocket":
            this.publisher.handle.sendMessage({
              kind: "data",
              body: JSON.stringify({
                dataType: dataType,
                data: data
              }),
              whom: clientId
            });
            break;
          case "datachannel":
            this.publisher.reliableChannel.send(JSON.stringify({
              clientId: clientId,
              dataType: dataType,
              data: data
            }));
            break;
          default:
            this.reliableTransport(clientId, dataType, data);
            break;
        }
      }
    }
  }, {
    key: "broadcastData",
    value: function broadcastData(dataType, data) {
      if (!this.publisher) {
        console.warn("broadcastData called without a publisher");
      } else {
        switch (this.unreliableTransport) {
          case "websocket":
            this.publisher.handle.sendMessage({
              kind: "data",
              body: JSON.stringify({
                dataType: dataType,
                data: data
              })
            });
            break;
          case "datachannel":
            this.publisher.unreliableChannel.send(JSON.stringify({
              dataType: dataType,
              data: data
            }));
            break;
          default:
            this.unreliableTransport(undefined, dataType, data);
            break;
        }
      }
    }
  }, {
    key: "broadcastDataGuaranteed",
    value: function broadcastDataGuaranteed(dataType, data) {
      if (!this.publisher) {
        console.warn("broadcastDataGuaranteed called without a publisher");
      } else {
        switch (this.reliableTransport) {
          case "websocket":
            this.publisher.handle.sendMessage({
              kind: "data",
              body: JSON.stringify({
                dataType: dataType,
                data: data
              })
            });
            break;
          case "datachannel":
            this.publisher.reliableChannel.send(JSON.stringify({
              dataType: dataType,
              data: data
            }));
            break;
          default:
            this.reliableTransport(undefined, dataType, data);
            break;
        }
      }
    }
  }, {
    key: "kick",
    value: function kick(clientId, permsToken) {
      return this.publisher.handle.sendMessage({
        kind: "kick",
        room_id: this.room,
        user_id: clientId,
        token: permsToken
      }).then(function () {
        document.body.dispatchEvent(new CustomEvent("kicked", {
          detail: {
            clientId: clientId
          }
        }));
      });
    }
  }, {
    key: "block",
    value: function block(clientId) {
      var _this12 = this;
      return this.publisher.handle.sendMessage({
        kind: "block",
        whom: clientId
      }).then(function () {
        _this12.blockedClients.set(clientId, true);
        document.body.dispatchEvent(new CustomEvent("blocked", {
          detail: {
            clientId: clientId
          }
        }));
      });
    }
  }, {
    key: "unblock",
    value: function unblock(clientId) {
      var _this13 = this;
      return this.publisher.handle.sendMessage({
        kind: "unblock",
        whom: clientId
      }).then(function () {
        _this13.blockedClients["delete"](clientId);
        document.body.dispatchEvent(new CustomEvent("unblocked", {
          detail: {
            clientId: clientId
          }
        }));
      });
    }
  }]);
  return JanusAdapter;
}();
NAF.adapters.register("janus", JanusAdapter);
module.exports = JanusAdapter;

/***/ }),

/***/ "./node_modules/debug/src/browser.js":
/*!*******************************************!*\
  !*** ./node_modules/debug/src/browser.js ***!
  \*******************************************/
/***/ ((module, exports, __webpack_require__) => {

/* eslint-env browser */

/**
 * This is the web browser implementation of `debug()`.
 */

exports.formatArgs = formatArgs;
exports.save = save;
exports.load = load;
exports.useColors = useColors;
exports.storage = localstorage();
exports.destroy = (() => {
	let warned = false;

	return () => {
		if (!warned) {
			warned = true;
			console.warn('Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.');
		}
	};
})();

/**
 * Colors.
 */

exports.colors = [
	'#0000CC',
	'#0000FF',
	'#0033CC',
	'#0033FF',
	'#0066CC',
	'#0066FF',
	'#0099CC',
	'#0099FF',
	'#00CC00',
	'#00CC33',
	'#00CC66',
	'#00CC99',
	'#00CCCC',
	'#00CCFF',
	'#3300CC',
	'#3300FF',
	'#3333CC',
	'#3333FF',
	'#3366CC',
	'#3366FF',
	'#3399CC',
	'#3399FF',
	'#33CC00',
	'#33CC33',
	'#33CC66',
	'#33CC99',
	'#33CCCC',
	'#33CCFF',
	'#6600CC',
	'#6600FF',
	'#6633CC',
	'#6633FF',
	'#66CC00',
	'#66CC33',
	'#9900CC',
	'#9900FF',
	'#9933CC',
	'#9933FF',
	'#99CC00',
	'#99CC33',
	'#CC0000',
	'#CC0033',
	'#CC0066',
	'#CC0099',
	'#CC00CC',
	'#CC00FF',
	'#CC3300',
	'#CC3333',
	'#CC3366',
	'#CC3399',
	'#CC33CC',
	'#CC33FF',
	'#CC6600',
	'#CC6633',
	'#CC9900',
	'#CC9933',
	'#CCCC00',
	'#CCCC33',
	'#FF0000',
	'#FF0033',
	'#FF0066',
	'#FF0099',
	'#FF00CC',
	'#FF00FF',
	'#FF3300',
	'#FF3333',
	'#FF3366',
	'#FF3399',
	'#FF33CC',
	'#FF33FF',
	'#FF6600',
	'#FF6633',
	'#FF9900',
	'#FF9933',
	'#FFCC00',
	'#FFCC33'
];

/**
 * Currently only WebKit-based Web Inspectors, Firefox >= v31,
 * and the Firebug extension (any Firefox version) are known
 * to support "%c" CSS customizations.
 *
 * TODO: add a `localStorage` variable to explicitly enable/disable colors
 */

// eslint-disable-next-line complexity
function useColors() {
	// NB: In an Electron preload script, document will be defined but not fully
	// initialized. Since we know we're in Chrome, we'll just detect this case
	// explicitly
	if (typeof window !== 'undefined' && window.process && (window.process.type === 'renderer' || window.process.__nwjs)) {
		return true;
	}

	// Internet Explorer and Edge do not support colors.
	if (typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/(edge|trident)\/(\d+)/)) {
		return false;
	}

	// Is webkit? http://stackoverflow.com/a/16459606/376773
	// document is undefined in react-native: https://github.com/facebook/react-native/pull/1632
	return (typeof document !== 'undefined' && document.documentElement && document.documentElement.style && document.documentElement.style.WebkitAppearance) ||
		// Is firebug? http://stackoverflow.com/a/398120/376773
		(typeof window !== 'undefined' && window.console && (window.console.firebug || (window.console.exception && window.console.table))) ||
		// Is firefox >= v31?
		// https://developer.mozilla.org/en-US/docs/Tools/Web_Console#Styling_messages
		(typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/firefox\/(\d+)/) && parseInt(RegExp.$1, 10) >= 31) ||
		// Double check webkit in userAgent just in case we are in a worker
		(typeof navigator !== 'undefined' && navigator.userAgent && navigator.userAgent.toLowerCase().match(/applewebkit\/(\d+)/));
}

/**
 * Colorize log arguments if enabled.
 *
 * @api public
 */

function formatArgs(args) {
	args[0] = (this.useColors ? '%c' : '') +
		this.namespace +
		(this.useColors ? ' %c' : ' ') +
		args[0] +
		(this.useColors ? '%c ' : ' ') +
		'+' + module.exports.humanize(this.diff);

	if (!this.useColors) {
		return;
	}

	const c = 'color: ' + this.color;
	args.splice(1, 0, c, 'color: inherit');

	// The final "%c" is somewhat tricky, because there could be other
	// arguments passed either before or after the %c, so we need to
	// figure out the correct index to insert the CSS into
	let index = 0;
	let lastC = 0;
	args[0].replace(/%[a-zA-Z%]/g, match => {
		if (match === '%%') {
			return;
		}
		index++;
		if (match === '%c') {
			// We only are interested in the *last* %c
			// (the user may have provided their own)
			lastC = index;
		}
	});

	args.splice(lastC, 0, c);
}

/**
 * Invokes `console.debug()` when available.
 * No-op when `console.debug` is not a "function".
 * If `console.debug` is not available, falls back
 * to `console.log`.
 *
 * @api public
 */
exports.log = console.debug || console.log || (() => {});

/**
 * Save `namespaces`.
 *
 * @param {String} namespaces
 * @api private
 */
function save(namespaces) {
	try {
		if (namespaces) {
			exports.storage.setItem('debug', namespaces);
		} else {
			exports.storage.removeItem('debug');
		}
	} catch (error) {
		// Swallow
		// XXX (@Qix-) should we be logging these?
	}
}

/**
 * Load `namespaces`.
 *
 * @return {String} returns the previously persisted debug modes
 * @api private
 */
function load() {
	let r;
	try {
		r = exports.storage.getItem('debug');
	} catch (error) {
		// Swallow
		// XXX (@Qix-) should we be logging these?
	}

	// If debug isn't set in LS, and we're in Electron, try to load $DEBUG
	if (!r && typeof process !== 'undefined' && 'env' in process) {
		r = process.env.DEBUG;
	}

	return r;
}

/**
 * Localstorage attempts to return the localstorage.
 *
 * This is necessary because safari throws
 * when a user disables cookies/localstorage
 * and you attempt to access it.
 *
 * @return {LocalStorage}
 * @api private
 */

function localstorage() {
	try {
		// TVMLKit (Apple TV JS Runtime) does not have a window object, just localStorage in the global context
		// The Browser also has localStorage in the global context.
		return localStorage;
	} catch (error) {
		// Swallow
		// XXX (@Qix-) should we be logging these?
	}
}

module.exports = __webpack_require__(/*! ./common */ "./node_modules/debug/src/common.js")(exports);

const {formatters} = module.exports;

/**
 * Map %j to `JSON.stringify()`, since no Web Inspectors do that by default.
 */

formatters.j = function (v) {
	try {
		return JSON.stringify(v);
	} catch (error) {
		return '[UnexpectedJSONParseError]: ' + error.message;
	}
};


/***/ }),

/***/ "./node_modules/debug/src/common.js":
/*!******************************************!*\
  !*** ./node_modules/debug/src/common.js ***!
  \******************************************/
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


/**
 * This is the common logic for both the Node.js and web browser
 * implementations of `debug()`.
 */

function setup(env) {
	createDebug.debug = createDebug;
	createDebug.default = createDebug;
	createDebug.coerce = coerce;
	createDebug.disable = disable;
	createDebug.enable = enable;
	createDebug.enabled = enabled;
	createDebug.humanize = __webpack_require__(/*! ms */ "./node_modules/ms/index.js");
	createDebug.destroy = destroy;

	Object.keys(env).forEach(key => {
		createDebug[key] = env[key];
	});

	/**
	* The currently active debug mode names, and names to skip.
	*/

	createDebug.names = [];
	createDebug.skips = [];

	/**
	* Map of special "%n" handling functions, for the debug "format" argument.
	*
	* Valid key names are a single, lower or upper-case letter, i.e. "n" and "N".
	*/
	createDebug.formatters = {};

	/**
	* Selects a color for a debug namespace
	* @param {String} namespace The namespace string for the debug instance to be colored
	* @return {Number|String} An ANSI color code for the given namespace
	* @api private
	*/
	function selectColor(namespace) {
		let hash = 0;

		for (let i = 0; i < namespace.length; i++) {
			hash = ((hash << 5) - hash) + namespace.charCodeAt(i);
			hash |= 0; // Convert to 32bit integer
		}

		return createDebug.colors[Math.abs(hash) % createDebug.colors.length];
	}
	createDebug.selectColor = selectColor;

	/**
	* Create a debugger with the given `namespace`.
	*
	* @param {String} namespace
	* @return {Function}
	* @api public
	*/
	function createDebug(namespace) {
		let prevTime;
		let enableOverride = null;
		let namespacesCache;
		let enabledCache;

		function debug(...args) {
			// Disabled?
			if (!debug.enabled) {
				return;
			}

			const self = debug;

			// Set `diff` timestamp
			const curr = Number(new Date());
			const ms = curr - (prevTime || curr);
			self.diff = ms;
			self.prev = prevTime;
			self.curr = curr;
			prevTime = curr;

			args[0] = createDebug.coerce(args[0]);

			if (typeof args[0] !== 'string') {
				// Anything else let's inspect with %O
				args.unshift('%O');
			}

			// Apply any `formatters` transformations
			let index = 0;
			args[0] = args[0].replace(/%([a-zA-Z%])/g, (match, format) => {
				// If we encounter an escaped % then don't increase the array index
				if (match === '%%') {
					return '%';
				}
				index++;
				const formatter = createDebug.formatters[format];
				if (typeof formatter === 'function') {
					const val = args[index];
					match = formatter.call(self, val);

					// Now we need to remove `args[index]` since it's inlined in the `format`
					args.splice(index, 1);
					index--;
				}
				return match;
			});

			// Apply env-specific formatting (colors, etc.)
			createDebug.formatArgs.call(self, args);

			const logFn = self.log || createDebug.log;
			logFn.apply(self, args);
		}

		debug.namespace = namespace;
		debug.useColors = createDebug.useColors();
		debug.color = createDebug.selectColor(namespace);
		debug.extend = extend;
		debug.destroy = createDebug.destroy; // XXX Temporary. Will be removed in the next major release.

		Object.defineProperty(debug, 'enabled', {
			enumerable: true,
			configurable: false,
			get: () => {
				if (enableOverride !== null) {
					return enableOverride;
				}
				if (namespacesCache !== createDebug.namespaces) {
					namespacesCache = createDebug.namespaces;
					enabledCache = createDebug.enabled(namespace);
				}

				return enabledCache;
			},
			set: v => {
				enableOverride = v;
			}
		});

		// Env-specific initialization logic for debug instances
		if (typeof createDebug.init === 'function') {
			createDebug.init(debug);
		}

		return debug;
	}

	function extend(namespace, delimiter) {
		const newDebug = createDebug(this.namespace + (typeof delimiter === 'undefined' ? ':' : delimiter) + namespace);
		newDebug.log = this.log;
		return newDebug;
	}

	/**
	* Enables a debug mode by namespaces. This can include modes
	* separated by a colon and wildcards.
	*
	* @param {String} namespaces
	* @api public
	*/
	function enable(namespaces) {
		createDebug.save(namespaces);
		createDebug.namespaces = namespaces;

		createDebug.names = [];
		createDebug.skips = [];

		let i;
		const split = (typeof namespaces === 'string' ? namespaces : '').split(/[\s,]+/);
		const len = split.length;

		for (i = 0; i < len; i++) {
			if (!split[i]) {
				// ignore empty strings
				continue;
			}

			namespaces = split[i].replace(/\*/g, '.*?');

			if (namespaces[0] === '-') {
				createDebug.skips.push(new RegExp('^' + namespaces.slice(1) + '$'));
			} else {
				createDebug.names.push(new RegExp('^' + namespaces + '$'));
			}
		}
	}

	/**
	* Disable debug output.
	*
	* @return {String} namespaces
	* @api public
	*/
	function disable() {
		const namespaces = [
			...createDebug.names.map(toNamespace),
			...createDebug.skips.map(toNamespace).map(namespace => '-' + namespace)
		].join(',');
		createDebug.enable('');
		return namespaces;
	}

	/**
	* Returns true if the given mode name is enabled, false otherwise.
	*
	* @param {String} name
	* @return {Boolean}
	* @api public
	*/
	function enabled(name) {
		if (name[name.length - 1] === '*') {
			return true;
		}

		let i;
		let len;

		for (i = 0, len = createDebug.skips.length; i < len; i++) {
			if (createDebug.skips[i].test(name)) {
				return false;
			}
		}

		for (i = 0, len = createDebug.names.length; i < len; i++) {
			if (createDebug.names[i].test(name)) {
				return true;
			}
		}

		return false;
	}

	/**
	* Convert regexp to namespace
	*
	* @param {RegExp} regxep
	* @return {String} namespace
	* @api private
	*/
	function toNamespace(regexp) {
		return regexp.toString()
			.substring(2, regexp.toString().length - 2)
			.replace(/\.\*\?$/, '*');
	}

	/**
	* Coerce `val`.
	*
	* @param {Mixed} val
	* @return {Mixed}
	* @api private
	*/
	function coerce(val) {
		if (val instanceof Error) {
			return val.stack || val.message;
		}
		return val;
	}

	/**
	* XXX DO NOT USE. This is a temporary stub function.
	* XXX It WILL be removed in the next major release.
	*/
	function destroy() {
		console.warn('Instance method `debug.destroy()` is deprecated and no longer does anything. It will be removed in the next major version of `debug`.');
	}

	createDebug.enable(createDebug.load());

	return createDebug;
}

module.exports = setup;


/***/ }),

/***/ "./node_modules/ms/index.js":
/*!**********************************!*\
  !*** ./node_modules/ms/index.js ***!
  \**********************************/
/***/ ((module) => {

/**
 * Helpers.
 */

var s = 1000;
var m = s * 60;
var h = m * 60;
var d = h * 24;
var w = d * 7;
var y = d * 365.25;

/**
 * Parse or format the given `val`.
 *
 * Options:
 *
 *  - `long` verbose formatting [false]
 *
 * @param {String|Number} val
 * @param {Object} [options]
 * @throws {Error} throw an error if val is not a non-empty string or a number
 * @return {String|Number}
 * @api public
 */

module.exports = function(val, options) {
  options = options || {};
  var type = typeof val;
  if (type === 'string' && val.length > 0) {
    return parse(val);
  } else if (type === 'number' && isFinite(val)) {
    return options.long ? fmtLong(val) : fmtShort(val);
  }
  throw new Error(
    'val is not a non-empty string or a valid number. val=' +
      JSON.stringify(val)
  );
};

/**
 * Parse the given `str` and return milliseconds.
 *
 * @param {String} str
 * @return {Number}
 * @api private
 */

function parse(str) {
  str = String(str);
  if (str.length > 100) {
    return;
  }
  var match = /^(-?(?:\d+)?\.?\d+) *(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i.exec(
    str
  );
  if (!match) {
    return;
  }
  var n = parseFloat(match[1]);
  var type = (match[2] || 'ms').toLowerCase();
  switch (type) {
    case 'years':
    case 'year':
    case 'yrs':
    case 'yr':
    case 'y':
      return n * y;
    case 'weeks':
    case 'week':
    case 'w':
      return n * w;
    case 'days':
    case 'day':
    case 'd':
      return n * d;
    case 'hours':
    case 'hour':
    case 'hrs':
    case 'hr':
    case 'h':
      return n * h;
    case 'minutes':
    case 'minute':
    case 'mins':
    case 'min':
    case 'm':
      return n * m;
    case 'seconds':
    case 'second':
    case 'secs':
    case 'sec':
    case 's':
      return n * s;
    case 'milliseconds':
    case 'millisecond':
    case 'msecs':
    case 'msec':
    case 'ms':
      return n;
    default:
      return undefined;
  }
}

/**
 * Short format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtShort(ms) {
  var msAbs = Math.abs(ms);
  if (msAbs >= d) {
    return Math.round(ms / d) + 'd';
  }
  if (msAbs >= h) {
    return Math.round(ms / h) + 'h';
  }
  if (msAbs >= m) {
    return Math.round(ms / m) + 'm';
  }
  if (msAbs >= s) {
    return Math.round(ms / s) + 's';
  }
  return ms + 'ms';
}

/**
 * Long format for `ms`.
 *
 * @param {Number} ms
 * @return {String}
 * @api private
 */

function fmtLong(ms) {
  var msAbs = Math.abs(ms);
  if (msAbs >= d) {
    return plural(ms, msAbs, d, 'day');
  }
  if (msAbs >= h) {
    return plural(ms, msAbs, h, 'hour');
  }
  if (msAbs >= m) {
    return plural(ms, msAbs, m, 'minute');
  }
  if (msAbs >= s) {
    return plural(ms, msAbs, s, 'second');
  }
  return ms + ' ms';
}

/**
 * Pluralization helper.
 */

function plural(ms, msAbs, n, name) {
  var isPlural = msAbs >= n * 1.5;
  return Math.round(ms / n) + ' ' + name + (isPlural ? 's' : '');
}


/***/ }),

/***/ "./node_modules/sdp/sdp.js":
/*!*********************************!*\
  !*** ./node_modules/sdp/sdp.js ***!
  \*********************************/
/***/ ((module) => {

"use strict";
/* eslint-env node */


// SDP helpers.
const SDPUtils = {};

// Generate an alphanumeric identifier for cname or mids.
// TODO: use UUIDs instead? https://gist.github.com/jed/982883
SDPUtils.generateIdentifier = function() {
  return Math.random().toString(36).substring(2, 12);
};

// The RTCP CNAME used by all peerconnections from the same JS.
SDPUtils.localCName = SDPUtils.generateIdentifier();

// Splits SDP into lines, dealing with both CRLF and LF.
SDPUtils.splitLines = function(blob) {
  return blob.trim().split('\n').map(line => line.trim());
};
// Splits SDP into sessionpart and mediasections. Ensures CRLF.
SDPUtils.splitSections = function(blob) {
  const parts = blob.split('\nm=');
  return parts.map((part, index) => (index > 0 ?
    'm=' + part : part).trim() + '\r\n');
};

// Returns the session description.
SDPUtils.getDescription = function(blob) {
  const sections = SDPUtils.splitSections(blob);
  return sections && sections[0];
};

// Returns the individual media sections.
SDPUtils.getMediaSections = function(blob) {
  const sections = SDPUtils.splitSections(blob);
  sections.shift();
  return sections;
};

// Returns lines that start with a certain prefix.
SDPUtils.matchPrefix = function(blob, prefix) {
  return SDPUtils.splitLines(blob).filter(line => line.indexOf(prefix) === 0);
};

// Parses an ICE candidate line. Sample input:
// candidate:702786350 2 udp 41819902 8.8.8.8 60769 typ relay raddr 8.8.8.8
// rport 55996"
// Input can be prefixed with a=.
SDPUtils.parseCandidate = function(line) {
  let parts;
  // Parse both variants.
  if (line.indexOf('a=candidate:') === 0) {
    parts = line.substring(12).split(' ');
  } else {
    parts = line.substring(10).split(' ');
  }

  const candidate = {
    foundation: parts[0],
    component: {1: 'rtp', 2: 'rtcp'}[parts[1]] || parts[1],
    protocol: parts[2].toLowerCase(),
    priority: parseInt(parts[3], 10),
    ip: parts[4],
    address: parts[4], // address is an alias for ip.
    port: parseInt(parts[5], 10),
    // skip parts[6] == 'typ'
    type: parts[7],
  };

  for (let i = 8; i < parts.length; i += 2) {
    switch (parts[i]) {
      case 'raddr':
        candidate.relatedAddress = parts[i + 1];
        break;
      case 'rport':
        candidate.relatedPort = parseInt(parts[i + 1], 10);
        break;
      case 'tcptype':
        candidate.tcpType = parts[i + 1];
        break;
      case 'ufrag':
        candidate.ufrag = parts[i + 1]; // for backward compatibility.
        candidate.usernameFragment = parts[i + 1];
        break;
      default: // extension handling, in particular ufrag. Don't overwrite.
        if (candidate[parts[i]] === undefined) {
          candidate[parts[i]] = parts[i + 1];
        }
        break;
    }
  }
  return candidate;
};

// Translates a candidate object into SDP candidate attribute.
// This does not include the a= prefix!
SDPUtils.writeCandidate = function(candidate) {
  const sdp = [];
  sdp.push(candidate.foundation);

  const component = candidate.component;
  if (component === 'rtp') {
    sdp.push(1);
  } else if (component === 'rtcp') {
    sdp.push(2);
  } else {
    sdp.push(component);
  }
  sdp.push(candidate.protocol.toUpperCase());
  sdp.push(candidate.priority);
  sdp.push(candidate.address || candidate.ip);
  sdp.push(candidate.port);

  const type = candidate.type;
  sdp.push('typ');
  sdp.push(type);
  if (type !== 'host' && candidate.relatedAddress &&
      candidate.relatedPort) {
    sdp.push('raddr');
    sdp.push(candidate.relatedAddress);
    sdp.push('rport');
    sdp.push(candidate.relatedPort);
  }
  if (candidate.tcpType && candidate.protocol.toLowerCase() === 'tcp') {
    sdp.push('tcptype');
    sdp.push(candidate.tcpType);
  }
  if (candidate.usernameFragment || candidate.ufrag) {
    sdp.push('ufrag');
    sdp.push(candidate.usernameFragment || candidate.ufrag);
  }
  return 'candidate:' + sdp.join(' ');
};

// Parses an ice-options line, returns an array of option tags.
// Sample input:
// a=ice-options:foo bar
SDPUtils.parseIceOptions = function(line) {
  return line.substring(14).split(' ');
};

// Parses a rtpmap line, returns RTCRtpCoddecParameters. Sample input:
// a=rtpmap:111 opus/48000/2
SDPUtils.parseRtpMap = function(line) {
  let parts = line.substring(9).split(' ');
  const parsed = {
    payloadType: parseInt(parts.shift(), 10), // was: id
  };

  parts = parts[0].split('/');

  parsed.name = parts[0];
  parsed.clockRate = parseInt(parts[1], 10); // was: clockrate
  parsed.channels = parts.length === 3 ? parseInt(parts[2], 10) : 1;
  // legacy alias, got renamed back to channels in ORTC.
  parsed.numChannels = parsed.channels;
  return parsed;
};

// Generates a rtpmap line from RTCRtpCodecCapability or
// RTCRtpCodecParameters.
SDPUtils.writeRtpMap = function(codec) {
  let pt = codec.payloadType;
  if (codec.preferredPayloadType !== undefined) {
    pt = codec.preferredPayloadType;
  }
  const channels = codec.channels || codec.numChannels || 1;
  return 'a=rtpmap:' + pt + ' ' + codec.name + '/' + codec.clockRate +
      (channels !== 1 ? '/' + channels : '') + '\r\n';
};

// Parses a extmap line (headerextension from RFC 5285). Sample input:
// a=extmap:2 urn:ietf:params:rtp-hdrext:toffset
// a=extmap:2/sendonly urn:ietf:params:rtp-hdrext:toffset
SDPUtils.parseExtmap = function(line) {
  const parts = line.substring(9).split(' ');
  return {
    id: parseInt(parts[0], 10),
    direction: parts[0].indexOf('/') > 0 ? parts[0].split('/')[1] : 'sendrecv',
    uri: parts[1],
    attributes: parts.slice(2).join(' '),
  };
};

// Generates an extmap line from RTCRtpHeaderExtensionParameters or
// RTCRtpHeaderExtension.
SDPUtils.writeExtmap = function(headerExtension) {
  return 'a=extmap:' + (headerExtension.id || headerExtension.preferredId) +
      (headerExtension.direction && headerExtension.direction !== 'sendrecv'
        ? '/' + headerExtension.direction
        : '') +
      ' ' + headerExtension.uri +
      (headerExtension.attributes ? ' ' + headerExtension.attributes : '') +
      '\r\n';
};

// Parses a fmtp line, returns dictionary. Sample input:
// a=fmtp:96 vbr=on;cng=on
// Also deals with vbr=on; cng=on
SDPUtils.parseFmtp = function(line) {
  const parsed = {};
  let kv;
  const parts = line.substring(line.indexOf(' ') + 1).split(';');
  for (let j = 0; j < parts.length; j++) {
    kv = parts[j].trim().split('=');
    parsed[kv[0].trim()] = kv[1];
  }
  return parsed;
};

// Generates a fmtp line from RTCRtpCodecCapability or RTCRtpCodecParameters.
SDPUtils.writeFmtp = function(codec) {
  let line = '';
  let pt = codec.payloadType;
  if (codec.preferredPayloadType !== undefined) {
    pt = codec.preferredPayloadType;
  }
  if (codec.parameters && Object.keys(codec.parameters).length) {
    const params = [];
    Object.keys(codec.parameters).forEach(param => {
      if (codec.parameters[param] !== undefined) {
        params.push(param + '=' + codec.parameters[param]);
      } else {
        params.push(param);
      }
    });
    line += 'a=fmtp:' + pt + ' ' + params.join(';') + '\r\n';
  }
  return line;
};

// Parses a rtcp-fb line, returns RTCPRtcpFeedback object. Sample input:
// a=rtcp-fb:98 nack rpsi
SDPUtils.parseRtcpFb = function(line) {
  const parts = line.substring(line.indexOf(' ') + 1).split(' ');
  return {
    type: parts.shift(),
    parameter: parts.join(' '),
  };
};

// Generate a=rtcp-fb lines from RTCRtpCodecCapability or RTCRtpCodecParameters.
SDPUtils.writeRtcpFb = function(codec) {
  let lines = '';
  let pt = codec.payloadType;
  if (codec.preferredPayloadType !== undefined) {
    pt = codec.preferredPayloadType;
  }
  if (codec.rtcpFeedback && codec.rtcpFeedback.length) {
    // FIXME: special handling for trr-int?
    codec.rtcpFeedback.forEach(fb => {
      lines += 'a=rtcp-fb:' + pt + ' ' + fb.type +
      (fb.parameter && fb.parameter.length ? ' ' + fb.parameter : '') +
          '\r\n';
    });
  }
  return lines;
};

// Parses a RFC 5576 ssrc media attribute. Sample input:
// a=ssrc:3735928559 cname:something
SDPUtils.parseSsrcMedia = function(line) {
  const sp = line.indexOf(' ');
  const parts = {
    ssrc: parseInt(line.substring(7, sp), 10),
  };
  const colon = line.indexOf(':', sp);
  if (colon > -1) {
    parts.attribute = line.substring(sp + 1, colon);
    parts.value = line.substring(colon + 1);
  } else {
    parts.attribute = line.substring(sp + 1);
  }
  return parts;
};

// Parse a ssrc-group line (see RFC 5576). Sample input:
// a=ssrc-group:semantics 12 34
SDPUtils.parseSsrcGroup = function(line) {
  const parts = line.substring(13).split(' ');
  return {
    semantics: parts.shift(),
    ssrcs: parts.map(ssrc => parseInt(ssrc, 10)),
  };
};

// Extracts the MID (RFC 5888) from a media section.
// Returns the MID or undefined if no mid line was found.
SDPUtils.getMid = function(mediaSection) {
  const mid = SDPUtils.matchPrefix(mediaSection, 'a=mid:')[0];
  if (mid) {
    return mid.substring(6);
  }
};

// Parses a fingerprint line for DTLS-SRTP.
SDPUtils.parseFingerprint = function(line) {
  const parts = line.substring(14).split(' ');
  return {
    algorithm: parts[0].toLowerCase(), // algorithm is case-sensitive in Edge.
    value: parts[1].toUpperCase(), // the definition is upper-case in RFC 4572.
  };
};

// Extracts DTLS parameters from SDP media section or sessionpart.
// FIXME: for consistency with other functions this should only
//   get the fingerprint line as input. See also getIceParameters.
SDPUtils.getDtlsParameters = function(mediaSection, sessionpart) {
  const lines = SDPUtils.matchPrefix(mediaSection + sessionpart,
    'a=fingerprint:');
  // Note: a=setup line is ignored since we use the 'auto' role in Edge.
  return {
    role: 'auto',
    fingerprints: lines.map(SDPUtils.parseFingerprint),
  };
};

// Serializes DTLS parameters to SDP.
SDPUtils.writeDtlsParameters = function(params, setupType) {
  let sdp = 'a=setup:' + setupType + '\r\n';
  params.fingerprints.forEach(fp => {
    sdp += 'a=fingerprint:' + fp.algorithm + ' ' + fp.value + '\r\n';
  });
  return sdp;
};

// Parses a=crypto lines into
//   https://rawgit.com/aboba/edgertc/master/msortc-rs4.html#dictionary-rtcsrtpsdesparameters-members
SDPUtils.parseCryptoLine = function(line) {
  const parts = line.substring(9).split(' ');
  return {
    tag: parseInt(parts[0], 10),
    cryptoSuite: parts[1],
    keyParams: parts[2],
    sessionParams: parts.slice(3),
  };
};

SDPUtils.writeCryptoLine = function(parameters) {
  return 'a=crypto:' + parameters.tag + ' ' +
    parameters.cryptoSuite + ' ' +
    (typeof parameters.keyParams === 'object'
      ? SDPUtils.writeCryptoKeyParams(parameters.keyParams)
      : parameters.keyParams) +
    (parameters.sessionParams ? ' ' + parameters.sessionParams.join(' ') : '') +
    '\r\n';
};

// Parses the crypto key parameters into
//   https://rawgit.com/aboba/edgertc/master/msortc-rs4.html#rtcsrtpkeyparam*
SDPUtils.parseCryptoKeyParams = function(keyParams) {
  if (keyParams.indexOf('inline:') !== 0) {
    return null;
  }
  const parts = keyParams.substring(7).split('|');
  return {
    keyMethod: 'inline',
    keySalt: parts[0],
    lifeTime: parts[1],
    mkiValue: parts[2] ? parts[2].split(':')[0] : undefined,
    mkiLength: parts[2] ? parts[2].split(':')[1] : undefined,
  };
};

SDPUtils.writeCryptoKeyParams = function(keyParams) {
  return keyParams.keyMethod + ':'
    + keyParams.keySalt +
    (keyParams.lifeTime ? '|' + keyParams.lifeTime : '') +
    (keyParams.mkiValue && keyParams.mkiLength
      ? '|' + keyParams.mkiValue + ':' + keyParams.mkiLength
      : '');
};

// Extracts all SDES parameters.
SDPUtils.getCryptoParameters = function(mediaSection, sessionpart) {
  const lines = SDPUtils.matchPrefix(mediaSection + sessionpart,
    'a=crypto:');
  return lines.map(SDPUtils.parseCryptoLine);
};

// Parses ICE information from SDP media section or sessionpart.
// FIXME: for consistency with other functions this should only
//   get the ice-ufrag and ice-pwd lines as input.
SDPUtils.getIceParameters = function(mediaSection, sessionpart) {
  const ufrag = SDPUtils.matchPrefix(mediaSection + sessionpart,
    'a=ice-ufrag:')[0];
  const pwd = SDPUtils.matchPrefix(mediaSection + sessionpart,
    'a=ice-pwd:')[0];
  if (!(ufrag && pwd)) {
    return null;
  }
  return {
    usernameFragment: ufrag.substring(12),
    password: pwd.substring(10),
  };
};

// Serializes ICE parameters to SDP.
SDPUtils.writeIceParameters = function(params) {
  let sdp = 'a=ice-ufrag:' + params.usernameFragment + '\r\n' +
      'a=ice-pwd:' + params.password + '\r\n';
  if (params.iceLite) {
    sdp += 'a=ice-lite\r\n';
  }
  return sdp;
};

// Parses the SDP media section and returns RTCRtpParameters.
SDPUtils.parseRtpParameters = function(mediaSection) {
  const description = {
    codecs: [],
    headerExtensions: [],
    fecMechanisms: [],
    rtcp: [],
  };
  const lines = SDPUtils.splitLines(mediaSection);
  const mline = lines[0].split(' ');
  description.profile = mline[2];
  for (let i = 3; i < mline.length; i++) { // find all codecs from mline[3..]
    const pt = mline[i];
    const rtpmapline = SDPUtils.matchPrefix(
      mediaSection, 'a=rtpmap:' + pt + ' ')[0];
    if (rtpmapline) {
      const codec = SDPUtils.parseRtpMap(rtpmapline);
      const fmtps = SDPUtils.matchPrefix(
        mediaSection, 'a=fmtp:' + pt + ' ');
      // Only the first a=fmtp:<pt> is considered.
      codec.parameters = fmtps.length ? SDPUtils.parseFmtp(fmtps[0]) : {};
      codec.rtcpFeedback = SDPUtils.matchPrefix(
        mediaSection, 'a=rtcp-fb:' + pt + ' ')
        .map(SDPUtils.parseRtcpFb);
      description.codecs.push(codec);
      // parse FEC mechanisms from rtpmap lines.
      switch (codec.name.toUpperCase()) {
        case 'RED':
        case 'ULPFEC':
          description.fecMechanisms.push(codec.name.toUpperCase());
          break;
        default: // only RED and ULPFEC are recognized as FEC mechanisms.
          break;
      }
    }
  }
  SDPUtils.matchPrefix(mediaSection, 'a=extmap:').forEach(line => {
    description.headerExtensions.push(SDPUtils.parseExtmap(line));
  });
  const wildcardRtcpFb = SDPUtils.matchPrefix(mediaSection, 'a=rtcp-fb:* ')
    .map(SDPUtils.parseRtcpFb);
  description.codecs.forEach(codec => {
    wildcardRtcpFb.forEach(fb=> {
      const duplicate = codec.rtcpFeedback.find(existingFeedback => {
        return existingFeedback.type === fb.type &&
          existingFeedback.parameter === fb.parameter;
      });
      if (!duplicate) {
        codec.rtcpFeedback.push(fb);
      }
    });
  });
  // FIXME: parse rtcp.
  return description;
};

// Generates parts of the SDP media section describing the capabilities /
// parameters.
SDPUtils.writeRtpDescription = function(kind, caps) {
  let sdp = '';

  // Build the mline.
  sdp += 'm=' + kind + ' ';
  sdp += caps.codecs.length > 0 ? '9' : '0'; // reject if no codecs.
  sdp += ' ' + (caps.profile || 'UDP/TLS/RTP/SAVPF') + ' ';
  sdp += caps.codecs.map(codec => {
    if (codec.preferredPayloadType !== undefined) {
      return codec.preferredPayloadType;
    }
    return codec.payloadType;
  }).join(' ') + '\r\n';

  sdp += 'c=IN IP4 0.0.0.0\r\n';
  sdp += 'a=rtcp:9 IN IP4 0.0.0.0\r\n';

  // Add a=rtpmap lines for each codec. Also fmtp and rtcp-fb.
  caps.codecs.forEach(codec => {
    sdp += SDPUtils.writeRtpMap(codec);
    sdp += SDPUtils.writeFmtp(codec);
    sdp += SDPUtils.writeRtcpFb(codec);
  });
  let maxptime = 0;
  caps.codecs.forEach(codec => {
    if (codec.maxptime > maxptime) {
      maxptime = codec.maxptime;
    }
  });
  if (maxptime > 0) {
    sdp += 'a=maxptime:' + maxptime + '\r\n';
  }

  if (caps.headerExtensions) {
    caps.headerExtensions.forEach(extension => {
      sdp += SDPUtils.writeExtmap(extension);
    });
  }
  // FIXME: write fecMechanisms.
  return sdp;
};

// Parses the SDP media section and returns an array of
// RTCRtpEncodingParameters.
SDPUtils.parseRtpEncodingParameters = function(mediaSection) {
  const encodingParameters = [];
  const description = SDPUtils.parseRtpParameters(mediaSection);
  const hasRed = description.fecMechanisms.indexOf('RED') !== -1;
  const hasUlpfec = description.fecMechanisms.indexOf('ULPFEC') !== -1;

  // filter a=ssrc:... cname:, ignore PlanB-msid
  const ssrcs = SDPUtils.matchPrefix(mediaSection, 'a=ssrc:')
    .map(line => SDPUtils.parseSsrcMedia(line))
    .filter(parts => parts.attribute === 'cname');
  const primarySsrc = ssrcs.length > 0 && ssrcs[0].ssrc;
  let secondarySsrc;

  const flows = SDPUtils.matchPrefix(mediaSection, 'a=ssrc-group:FID')
    .map(line => {
      const parts = line.substring(17).split(' ');
      return parts.map(part => parseInt(part, 10));
    });
  if (flows.length > 0 && flows[0].length > 1 && flows[0][0] === primarySsrc) {
    secondarySsrc = flows[0][1];
  }

  description.codecs.forEach(codec => {
    if (codec.name.toUpperCase() === 'RTX' && codec.parameters.apt) {
      let encParam = {
        ssrc: primarySsrc,
        codecPayloadType: parseInt(codec.parameters.apt, 10),
      };
      if (primarySsrc && secondarySsrc) {
        encParam.rtx = {ssrc: secondarySsrc};
      }
      encodingParameters.push(encParam);
      if (hasRed) {
        encParam = JSON.parse(JSON.stringify(encParam));
        encParam.fec = {
          ssrc: primarySsrc,
          mechanism: hasUlpfec ? 'red+ulpfec' : 'red',
        };
        encodingParameters.push(encParam);
      }
    }
  });
  if (encodingParameters.length === 0 && primarySsrc) {
    encodingParameters.push({
      ssrc: primarySsrc,
    });
  }

  // we support both b=AS and b=TIAS but interpret AS as TIAS.
  let bandwidth = SDPUtils.matchPrefix(mediaSection, 'b=');
  if (bandwidth.length) {
    if (bandwidth[0].indexOf('b=TIAS:') === 0) {
      bandwidth = parseInt(bandwidth[0].substring(7), 10);
    } else if (bandwidth[0].indexOf('b=AS:') === 0) {
      // use formula from JSEP to convert b=AS to TIAS value.
      bandwidth = parseInt(bandwidth[0].substring(5), 10) * 1000 * 0.95
          - (50 * 40 * 8);
    } else {
      bandwidth = undefined;
    }
    encodingParameters.forEach(params => {
      params.maxBitrate = bandwidth;
    });
  }
  return encodingParameters;
};

// parses http://draft.ortc.org/#rtcrtcpparameters*
SDPUtils.parseRtcpParameters = function(mediaSection) {
  const rtcpParameters = {};

  // Gets the first SSRC. Note that with RTX there might be multiple
  // SSRCs.
  const remoteSsrc = SDPUtils.matchPrefix(mediaSection, 'a=ssrc:')
    .map(line => SDPUtils.parseSsrcMedia(line))
    .filter(obj => obj.attribute === 'cname')[0];
  if (remoteSsrc) {
    rtcpParameters.cname = remoteSsrc.value;
    rtcpParameters.ssrc = remoteSsrc.ssrc;
  }

  // Edge uses the compound attribute instead of reducedSize
  // compound is !reducedSize
  const rsize = SDPUtils.matchPrefix(mediaSection, 'a=rtcp-rsize');
  rtcpParameters.reducedSize = rsize.length > 0;
  rtcpParameters.compound = rsize.length === 0;

  // parses the rtcp-mux attrіbute.
  // Note that Edge does not support unmuxed RTCP.
  const mux = SDPUtils.matchPrefix(mediaSection, 'a=rtcp-mux');
  rtcpParameters.mux = mux.length > 0;

  return rtcpParameters;
};

SDPUtils.writeRtcpParameters = function(rtcpParameters) {
  let sdp = '';
  if (rtcpParameters.reducedSize) {
    sdp += 'a=rtcp-rsize\r\n';
  }
  if (rtcpParameters.mux) {
    sdp += 'a=rtcp-mux\r\n';
  }
  if (rtcpParameters.ssrc !== undefined && rtcpParameters.cname) {
    sdp += 'a=ssrc:' + rtcpParameters.ssrc +
      ' cname:' + rtcpParameters.cname + '\r\n';
  }
  return sdp;
};


// parses either a=msid: or a=ssrc:... msid lines and returns
// the id of the MediaStream and MediaStreamTrack.
SDPUtils.parseMsid = function(mediaSection) {
  let parts;
  const spec = SDPUtils.matchPrefix(mediaSection, 'a=msid:');
  if (spec.length === 1) {
    parts = spec[0].substring(7).split(' ');
    return {stream: parts[0], track: parts[1]};
  }
  const planB = SDPUtils.matchPrefix(mediaSection, 'a=ssrc:')
    .map(line => SDPUtils.parseSsrcMedia(line))
    .filter(msidParts => msidParts.attribute === 'msid');
  if (planB.length > 0) {
    parts = planB[0].value.split(' ');
    return {stream: parts[0], track: parts[1]};
  }
};

// SCTP
// parses draft-ietf-mmusic-sctp-sdp-26 first and falls back
// to draft-ietf-mmusic-sctp-sdp-05
SDPUtils.parseSctpDescription = function(mediaSection) {
  const mline = SDPUtils.parseMLine(mediaSection);
  const maxSizeLine = SDPUtils.matchPrefix(mediaSection, 'a=max-message-size:');
  let maxMessageSize;
  if (maxSizeLine.length > 0) {
    maxMessageSize = parseInt(maxSizeLine[0].substring(19), 10);
  }
  if (isNaN(maxMessageSize)) {
    maxMessageSize = 65536;
  }
  const sctpPort = SDPUtils.matchPrefix(mediaSection, 'a=sctp-port:');
  if (sctpPort.length > 0) {
    return {
      port: parseInt(sctpPort[0].substring(12), 10),
      protocol: mline.fmt,
      maxMessageSize,
    };
  }
  const sctpMapLines = SDPUtils.matchPrefix(mediaSection, 'a=sctpmap:');
  if (sctpMapLines.length > 0) {
    const parts = sctpMapLines[0]
      .substring(10)
      .split(' ');
    return {
      port: parseInt(parts[0], 10),
      protocol: parts[1],
      maxMessageSize,
    };
  }
};

// SCTP
// outputs the draft-ietf-mmusic-sctp-sdp-26 version that all browsers
// support by now receiving in this format, unless we originally parsed
// as the draft-ietf-mmusic-sctp-sdp-05 format (indicated by the m-line
// protocol of DTLS/SCTP -- without UDP/ or TCP/)
SDPUtils.writeSctpDescription = function(media, sctp) {
  let output = [];
  if (media.protocol !== 'DTLS/SCTP') {
    output = [
      'm=' + media.kind + ' 9 ' + media.protocol + ' ' + sctp.protocol + '\r\n',
      'c=IN IP4 0.0.0.0\r\n',
      'a=sctp-port:' + sctp.port + '\r\n',
    ];
  } else {
    output = [
      'm=' + media.kind + ' 9 ' + media.protocol + ' ' + sctp.port + '\r\n',
      'c=IN IP4 0.0.0.0\r\n',
      'a=sctpmap:' + sctp.port + ' ' + sctp.protocol + ' 65535\r\n',
    ];
  }
  if (sctp.maxMessageSize !== undefined) {
    output.push('a=max-message-size:' + sctp.maxMessageSize + '\r\n');
  }
  return output.join('');
};

// Generate a session ID for SDP.
// https://tools.ietf.org/html/draft-ietf-rtcweb-jsep-20#section-5.2.1
// recommends using a cryptographically random +ve 64-bit value
// but right now this should be acceptable and within the right range
SDPUtils.generateSessionId = function() {
  return Math.random().toString().substr(2, 22);
};

// Write boiler plate for start of SDP
// sessId argument is optional - if not supplied it will
// be generated randomly
// sessVersion is optional and defaults to 2
// sessUser is optional and defaults to 'thisisadapterortc'
SDPUtils.writeSessionBoilerplate = function(sessId, sessVer, sessUser) {
  let sessionId;
  const version = sessVer !== undefined ? sessVer : 2;
  if (sessId) {
    sessionId = sessId;
  } else {
    sessionId = SDPUtils.generateSessionId();
  }
  const user = sessUser || 'thisisadapterortc';
  // FIXME: sess-id should be an NTP timestamp.
  return 'v=0\r\n' +
      'o=' + user + ' ' + sessionId + ' ' + version +
        ' IN IP4 127.0.0.1\r\n' +
      's=-\r\n' +
      't=0 0\r\n';
};

// Gets the direction from the mediaSection or the sessionpart.
SDPUtils.getDirection = function(mediaSection, sessionpart) {
  // Look for sendrecv, sendonly, recvonly, inactive, default to sendrecv.
  const lines = SDPUtils.splitLines(mediaSection);
  for (let i = 0; i < lines.length; i++) {
    switch (lines[i]) {
      case 'a=sendrecv':
      case 'a=sendonly':
      case 'a=recvonly':
      case 'a=inactive':
        return lines[i].substring(2);
      default:
        // FIXME: What should happen here?
    }
  }
  if (sessionpart) {
    return SDPUtils.getDirection(sessionpart);
  }
  return 'sendrecv';
};

SDPUtils.getKind = function(mediaSection) {
  const lines = SDPUtils.splitLines(mediaSection);
  const mline = lines[0].split(' ');
  return mline[0].substring(2);
};

SDPUtils.isRejected = function(mediaSection) {
  return mediaSection.split(' ', 2)[1] === '0';
};

SDPUtils.parseMLine = function(mediaSection) {
  const lines = SDPUtils.splitLines(mediaSection);
  const parts = lines[0].substring(2).split(' ');
  return {
    kind: parts[0],
    port: parseInt(parts[1], 10),
    protocol: parts[2],
    fmt: parts.slice(3).join(' '),
  };
};

SDPUtils.parseOLine = function(mediaSection) {
  const line = SDPUtils.matchPrefix(mediaSection, 'o=')[0];
  const parts = line.substring(2).split(' ');
  return {
    username: parts[0],
    sessionId: parts[1],
    sessionVersion: parseInt(parts[2], 10),
    netType: parts[3],
    addressType: parts[4],
    address: parts[5],
  };
};

// a very naive interpretation of a valid SDP.
SDPUtils.isValidSDP = function(blob) {
  if (typeof blob !== 'string' || blob.length === 0) {
    return false;
  }
  const lines = SDPUtils.splitLines(blob);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length < 2 || lines[i].charAt(1) !== '=') {
      return false;
    }
    // TODO: check the modifier a bit more.
  }
  return true;
};

// Expose public methods.
if (true) {
  module.exports = SDPUtils;
}


/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId](module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__("./src/index.js");
/******/ 	
/******/ })()
;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoibmFmLWphbnVzLWFkYXB0ZXIuanMiLCJtYXBwaW5ncyI6Ijs7Ozs7Ozs7O0FBQUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0Esa0JBQWtCO0FBQ2xCO0FBQ0E7QUFDQTtBQUNBLEdBQUc7QUFDSDs7QUFFQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsR0FBRztBQUNIOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLGlEQUFpRCxvQkFBb0I7QUFDckU7O0FBRUE7QUFDQTtBQUNBLGdDQUFnQyxZQUFZO0FBQzVDOztBQUVBO0FBQ0E7QUFDQSxnQ0FBZ0MsUUFBUSxjQUFjO0FBQ3REOztBQUVBO0FBQ0E7QUFDQSxnQ0FBZ0Msc0JBQXNCO0FBQ3REOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsR0FBRztBQUNIOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxHQUFHO0FBQ0g7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEdBQUc7QUFDSDs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsZ0dBQWdHO0FBQ2hHO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQSxvQkFBb0IscUJBQXFCO0FBQ3pDO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLHNHQUFzRztBQUN0RztBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsMkJBQTJCLDJDQUEyQztBQUN0RTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxPQUFPO0FBQ1A7QUFDQSxzQ0FBc0M7QUFDdEM7QUFDQSxHQUFHO0FBQ0g7O0FBRUE7QUFDQSwyQkFBMkIsYUFBYTs7QUFFeEMseUJBQXlCO0FBQ3pCLDZCQUE2QixxQkFBcUI7QUFDbEQ7O0FBRUE7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEtBQUs7QUFDTDtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7OytDQzNQQSxxSkFBQUEsbUJBQUEsWUFBQUEsb0JBQUEsV0FBQUMsQ0FBQSxTQUFBQyxDQUFBLEVBQUFELENBQUEsT0FBQUUsQ0FBQSxHQUFBQyxNQUFBLENBQUFDLFNBQUEsRUFBQUMsQ0FBQSxHQUFBSCxDQUFBLENBQUFJLGNBQUEsRUFBQUMsQ0FBQSxHQUFBSixNQUFBLENBQUFLLGNBQUEsY0FBQVAsQ0FBQSxFQUFBRCxDQUFBLEVBQUFFLENBQUEsSUFBQUQsQ0FBQSxDQUFBRCxDQUFBLElBQUFFLENBQUEsQ0FBQU8sS0FBQSxLQUFBQyxDQUFBLHdCQUFBQyxNQUFBLEdBQUFBLE1BQUEsT0FBQUMsQ0FBQSxHQUFBRixDQUFBLENBQUFHLFFBQUEsa0JBQUFDLENBQUEsR0FBQUosQ0FBQSxDQUFBSyxhQUFBLHVCQUFBQyxDQUFBLEdBQUFOLENBQUEsQ0FBQU8sV0FBQSw4QkFBQUMsT0FBQWpCLENBQUEsRUFBQUQsQ0FBQSxFQUFBRSxDQUFBLFdBQUFDLE1BQUEsQ0FBQUssY0FBQSxDQUFBUCxDQUFBLEVBQUFELENBQUEsSUFBQVMsS0FBQSxFQUFBUCxDQUFBLEVBQUFpQixVQUFBLE1BQUFDLFlBQUEsTUFBQUMsUUFBQSxTQUFBcEIsQ0FBQSxDQUFBRCxDQUFBLFdBQUFrQixNQUFBLG1CQUFBakIsQ0FBQSxJQUFBaUIsTUFBQSxZQUFBQSxPQUFBakIsQ0FBQSxFQUFBRCxDQUFBLEVBQUFFLENBQUEsV0FBQUQsQ0FBQSxDQUFBRCxDQUFBLElBQUFFLENBQUEsZ0JBQUFvQixLQUFBckIsQ0FBQSxFQUFBRCxDQUFBLEVBQUFFLENBQUEsRUFBQUcsQ0FBQSxRQUFBSyxDQUFBLEdBQUFWLENBQUEsSUFBQUEsQ0FBQSxDQUFBSSxTQUFBLFlBQUFtQixTQUFBLEdBQUF2QixDQUFBLEdBQUF1QixTQUFBLEVBQUFYLENBQUEsR0FBQVQsTUFBQSxDQUFBcUIsTUFBQSxDQUFBZCxDQUFBLENBQUFOLFNBQUEsR0FBQVUsQ0FBQSxPQUFBVyxPQUFBLENBQUFwQixDQUFBLGdCQUFBRSxDQUFBLENBQUFLLENBQUEsZUFBQUgsS0FBQSxFQUFBaUIsZ0JBQUEsQ0FBQXpCLENBQUEsRUFBQUMsQ0FBQSxFQUFBWSxDQUFBLE1BQUFGLENBQUEsYUFBQWUsU0FBQTFCLENBQUEsRUFBQUQsQ0FBQSxFQUFBRSxDQUFBLG1CQUFBMEIsSUFBQSxZQUFBQyxHQUFBLEVBQUE1QixDQUFBLENBQUE2QixJQUFBLENBQUE5QixDQUFBLEVBQUFFLENBQUEsY0FBQUQsQ0FBQSxhQUFBMkIsSUFBQSxXQUFBQyxHQUFBLEVBQUE1QixDQUFBLFFBQUFELENBQUEsQ0FBQXNCLElBQUEsR0FBQUEsSUFBQSxNQUFBUyxDQUFBLHFCQUFBQyxDQUFBLHFCQUFBQyxDQUFBLGdCQUFBQyxDQUFBLGdCQUFBQyxDQUFBLGdCQUFBWixVQUFBLGNBQUFhLGtCQUFBLGNBQUFDLDJCQUFBLFNBQUFDLENBQUEsT0FBQXBCLE1BQUEsQ0FBQW9CLENBQUEsRUFBQTFCLENBQUEscUNBQUEyQixDQUFBLEdBQUFwQyxNQUFBLENBQUFxQyxjQUFBLEVBQUFDLENBQUEsR0FBQUYsQ0FBQSxJQUFBQSxDQUFBLENBQUFBLENBQUEsQ0FBQUcsTUFBQSxRQUFBRCxDQUFBLElBQUFBLENBQUEsS0FBQXZDLENBQUEsSUFBQUcsQ0FBQSxDQUFBeUIsSUFBQSxDQUFBVyxDQUFBLEVBQUE3QixDQUFBLE1BQUEwQixDQUFBLEdBQUFHLENBQUEsT0FBQUUsQ0FBQSxHQUFBTiwwQkFBQSxDQUFBakMsU0FBQSxHQUFBbUIsU0FBQSxDQUFBbkIsU0FBQSxHQUFBRCxNQUFBLENBQUFxQixNQUFBLENBQUFjLENBQUEsWUFBQU0sc0JBQUEzQyxDQUFBLGdDQUFBNEMsT0FBQSxXQUFBN0MsQ0FBQSxJQUFBa0IsTUFBQSxDQUFBakIsQ0FBQSxFQUFBRCxDQUFBLFlBQUFDLENBQUEsZ0JBQUE2QyxPQUFBLENBQUE5QyxDQUFBLEVBQUFDLENBQUEsc0JBQUE4QyxjQUFBOUMsQ0FBQSxFQUFBRCxDQUFBLGFBQUFnRCxPQUFBOUMsQ0FBQSxFQUFBSyxDQUFBLEVBQUFHLENBQUEsRUFBQUUsQ0FBQSxRQUFBRSxDQUFBLEdBQUFhLFFBQUEsQ0FBQTFCLENBQUEsQ0FBQUMsQ0FBQSxHQUFBRCxDQUFBLEVBQUFNLENBQUEsbUJBQUFPLENBQUEsQ0FBQWMsSUFBQSxRQUFBWixDQUFBLEdBQUFGLENBQUEsQ0FBQWUsR0FBQSxFQUFBRSxDQUFBLEdBQUFmLENBQUEsQ0FBQVAsS0FBQSxTQUFBc0IsQ0FBQSxnQkFBQWtCLE9BQUEsQ0FBQWxCLENBQUEsS0FBQTFCLENBQUEsQ0FBQXlCLElBQUEsQ0FBQUMsQ0FBQSxlQUFBL0IsQ0FBQSxDQUFBa0QsT0FBQSxDQUFBbkIsQ0FBQSxDQUFBb0IsT0FBQSxFQUFBQyxJQUFBLFdBQUFuRCxDQUFBLElBQUErQyxNQUFBLFNBQUEvQyxDQUFBLEVBQUFTLENBQUEsRUFBQUUsQ0FBQSxnQkFBQVgsQ0FBQSxJQUFBK0MsTUFBQSxVQUFBL0MsQ0FBQSxFQUFBUyxDQUFBLEVBQUFFLENBQUEsUUFBQVosQ0FBQSxDQUFBa0QsT0FBQSxDQUFBbkIsQ0FBQSxFQUFBcUIsSUFBQSxXQUFBbkQsQ0FBQSxJQUFBZSxDQUFBLENBQUFQLEtBQUEsR0FBQVIsQ0FBQSxFQUFBUyxDQUFBLENBQUFNLENBQUEsZ0JBQUFmLENBQUEsV0FBQStDLE1BQUEsVUFBQS9DLENBQUEsRUFBQVMsQ0FBQSxFQUFBRSxDQUFBLFNBQUFBLENBQUEsQ0FBQUUsQ0FBQSxDQUFBZSxHQUFBLFNBQUEzQixDQUFBLEVBQUFLLENBQUEsb0JBQUFFLEtBQUEsV0FBQUEsTUFBQVIsQ0FBQSxFQUFBSSxDQUFBLGFBQUFnRCwyQkFBQSxlQUFBckQsQ0FBQSxXQUFBQSxDQUFBLEVBQUFFLENBQUEsSUFBQThDLE1BQUEsQ0FBQS9DLENBQUEsRUFBQUksQ0FBQSxFQUFBTCxDQUFBLEVBQUFFLENBQUEsZ0JBQUFBLENBQUEsR0FBQUEsQ0FBQSxHQUFBQSxDQUFBLENBQUFrRCxJQUFBLENBQUFDLDBCQUFBLEVBQUFBLDBCQUFBLElBQUFBLDBCQUFBLHFCQUFBM0IsaUJBQUExQixDQUFBLEVBQUFFLENBQUEsRUFBQUcsQ0FBQSxRQUFBRSxDQUFBLEdBQUF3QixDQUFBLG1CQUFBckIsQ0FBQSxFQUFBRSxDQUFBLFFBQUFMLENBQUEsS0FBQTBCLENBQUEsWUFBQXFCLEtBQUEsc0NBQUEvQyxDQUFBLEtBQUEyQixDQUFBLG9CQUFBeEIsQ0FBQSxRQUFBRSxDQUFBLFdBQUFILEtBQUEsRUFBQVIsQ0FBQSxFQUFBc0QsSUFBQSxlQUFBbEQsQ0FBQSxDQUFBbUQsTUFBQSxHQUFBOUMsQ0FBQSxFQUFBTCxDQUFBLENBQUF3QixHQUFBLEdBQUFqQixDQUFBLFVBQUFFLENBQUEsR0FBQVQsQ0FBQSxDQUFBb0QsUUFBQSxNQUFBM0MsQ0FBQSxRQUFBRSxDQUFBLEdBQUEwQyxtQkFBQSxDQUFBNUMsQ0FBQSxFQUFBVCxDQUFBLE9BQUFXLENBQUEsUUFBQUEsQ0FBQSxLQUFBbUIsQ0FBQSxtQkFBQW5CLENBQUEscUJBQUFYLENBQUEsQ0FBQW1ELE1BQUEsRUFBQW5ELENBQUEsQ0FBQXNELElBQUEsR0FBQXRELENBQUEsQ0FBQXVELEtBQUEsR0FBQXZELENBQUEsQ0FBQXdCLEdBQUEsc0JBQUF4QixDQUFBLENBQUFtRCxNQUFBLFFBQUFqRCxDQUFBLEtBQUF3QixDQUFBLFFBQUF4QixDQUFBLEdBQUEyQixDQUFBLEVBQUE3QixDQUFBLENBQUF3QixHQUFBLEVBQUF4QixDQUFBLENBQUF3RCxpQkFBQSxDQUFBeEQsQ0FBQSxDQUFBd0IsR0FBQSx1QkFBQXhCLENBQUEsQ0FBQW1ELE1BQUEsSUFBQW5ELENBQUEsQ0FBQXlELE1BQUEsV0FBQXpELENBQUEsQ0FBQXdCLEdBQUEsR0FBQXRCLENBQUEsR0FBQTBCLENBQUEsTUFBQUssQ0FBQSxHQUFBWCxRQUFBLENBQUEzQixDQUFBLEVBQUFFLENBQUEsRUFBQUcsQ0FBQSxvQkFBQWlDLENBQUEsQ0FBQVYsSUFBQSxRQUFBckIsQ0FBQSxHQUFBRixDQUFBLENBQUFrRCxJQUFBLEdBQUFyQixDQUFBLEdBQUFGLENBQUEsRUFBQU0sQ0FBQSxDQUFBVCxHQUFBLEtBQUFNLENBQUEscUJBQUExQixLQUFBLEVBQUE2QixDQUFBLENBQUFULEdBQUEsRUFBQTBCLElBQUEsRUFBQWxELENBQUEsQ0FBQWtELElBQUEsa0JBQUFqQixDQUFBLENBQUFWLElBQUEsS0FBQXJCLENBQUEsR0FBQTJCLENBQUEsRUFBQTdCLENBQUEsQ0FBQW1ELE1BQUEsWUFBQW5ELENBQUEsQ0FBQXdCLEdBQUEsR0FBQVMsQ0FBQSxDQUFBVCxHQUFBLG1CQUFBNkIsb0JBQUExRCxDQUFBLEVBQUFFLENBQUEsUUFBQUcsQ0FBQSxHQUFBSCxDQUFBLENBQUFzRCxNQUFBLEVBQUFqRCxDQUFBLEdBQUFQLENBQUEsQ0FBQWEsUUFBQSxDQUFBUixDQUFBLE9BQUFFLENBQUEsS0FBQU4sQ0FBQSxTQUFBQyxDQUFBLENBQUF1RCxRQUFBLHFCQUFBcEQsQ0FBQSxJQUFBTCxDQUFBLENBQUFhLFFBQUEsZUFBQVgsQ0FBQSxDQUFBc0QsTUFBQSxhQUFBdEQsQ0FBQSxDQUFBMkIsR0FBQSxHQUFBNUIsQ0FBQSxFQUFBeUQsbUJBQUEsQ0FBQTFELENBQUEsRUFBQUUsQ0FBQSxlQUFBQSxDQUFBLENBQUFzRCxNQUFBLGtCQUFBbkQsQ0FBQSxLQUFBSCxDQUFBLENBQUFzRCxNQUFBLFlBQUF0RCxDQUFBLENBQUEyQixHQUFBLE9BQUFrQyxTQUFBLHVDQUFBMUQsQ0FBQSxpQkFBQThCLENBQUEsTUFBQXpCLENBQUEsR0FBQWlCLFFBQUEsQ0FBQXBCLENBQUEsRUFBQVAsQ0FBQSxDQUFBYSxRQUFBLEVBQUFYLENBQUEsQ0FBQTJCLEdBQUEsbUJBQUFuQixDQUFBLENBQUFrQixJQUFBLFNBQUExQixDQUFBLENBQUFzRCxNQUFBLFlBQUF0RCxDQUFBLENBQUEyQixHQUFBLEdBQUFuQixDQUFBLENBQUFtQixHQUFBLEVBQUEzQixDQUFBLENBQUF1RCxRQUFBLFNBQUF0QixDQUFBLE1BQUF2QixDQUFBLEdBQUFGLENBQUEsQ0FBQW1CLEdBQUEsU0FBQWpCLENBQUEsR0FBQUEsQ0FBQSxDQUFBMkMsSUFBQSxJQUFBckQsQ0FBQSxDQUFBRixDQUFBLENBQUFnRSxVQUFBLElBQUFwRCxDQUFBLENBQUFILEtBQUEsRUFBQVAsQ0FBQSxDQUFBK0QsSUFBQSxHQUFBakUsQ0FBQSxDQUFBa0UsT0FBQSxlQUFBaEUsQ0FBQSxDQUFBc0QsTUFBQSxLQUFBdEQsQ0FBQSxDQUFBc0QsTUFBQSxXQUFBdEQsQ0FBQSxDQUFBMkIsR0FBQSxHQUFBNUIsQ0FBQSxHQUFBQyxDQUFBLENBQUF1RCxRQUFBLFNBQUF0QixDQUFBLElBQUF2QixDQUFBLElBQUFWLENBQUEsQ0FBQXNELE1BQUEsWUFBQXRELENBQUEsQ0FBQTJCLEdBQUEsT0FBQWtDLFNBQUEsc0NBQUE3RCxDQUFBLENBQUF1RCxRQUFBLFNBQUF0QixDQUFBLGNBQUFnQyxhQUFBbEUsQ0FBQSxRQUFBRCxDQUFBLEtBQUFvRSxNQUFBLEVBQUFuRSxDQUFBLFlBQUFBLENBQUEsS0FBQUQsQ0FBQSxDQUFBcUUsUUFBQSxHQUFBcEUsQ0FBQSxXQUFBQSxDQUFBLEtBQUFELENBQUEsQ0FBQXNFLFVBQUEsR0FBQXJFLENBQUEsS0FBQUQsQ0FBQSxDQUFBdUUsUUFBQSxHQUFBdEUsQ0FBQSxXQUFBdUUsVUFBQSxDQUFBQyxJQUFBLENBQUF6RSxDQUFBLGNBQUEwRSxjQUFBekUsQ0FBQSxRQUFBRCxDQUFBLEdBQUFDLENBQUEsQ0FBQTBFLFVBQUEsUUFBQTNFLENBQUEsQ0FBQTRCLElBQUEsb0JBQUE1QixDQUFBLENBQUE2QixHQUFBLEVBQUE1QixDQUFBLENBQUEwRSxVQUFBLEdBQUEzRSxDQUFBLGFBQUF5QixRQUFBeEIsQ0FBQSxTQUFBdUUsVUFBQSxNQUFBSixNQUFBLGFBQUFuRSxDQUFBLENBQUE0QyxPQUFBLENBQUFzQixZQUFBLGNBQUFTLEtBQUEsaUJBQUFsQyxPQUFBMUMsQ0FBQSxRQUFBQSxDQUFBLFdBQUFBLENBQUEsUUFBQUUsQ0FBQSxHQUFBRixDQUFBLENBQUFZLENBQUEsT0FBQVYsQ0FBQSxTQUFBQSxDQUFBLENBQUE0QixJQUFBLENBQUE5QixDQUFBLDRCQUFBQSxDQUFBLENBQUFpRSxJQUFBLFNBQUFqRSxDQUFBLE9BQUE2RSxLQUFBLENBQUE3RSxDQUFBLENBQUE4RSxNQUFBLFNBQUF2RSxDQUFBLE9BQUFHLENBQUEsWUFBQXVELEtBQUEsYUFBQTFELENBQUEsR0FBQVAsQ0FBQSxDQUFBOEUsTUFBQSxPQUFBekUsQ0FBQSxDQUFBeUIsSUFBQSxDQUFBOUIsQ0FBQSxFQUFBTyxDQUFBLFVBQUEwRCxJQUFBLENBQUF4RCxLQUFBLEdBQUFULENBQUEsQ0FBQU8sQ0FBQSxHQUFBMEQsSUFBQSxDQUFBVixJQUFBLE9BQUFVLElBQUEsU0FBQUEsSUFBQSxDQUFBeEQsS0FBQSxHQUFBUixDQUFBLEVBQUFnRSxJQUFBLENBQUFWLElBQUEsT0FBQVUsSUFBQSxZQUFBdkQsQ0FBQSxDQUFBdUQsSUFBQSxHQUFBdkQsQ0FBQSxnQkFBQXFELFNBQUEsQ0FBQWQsT0FBQSxDQUFBakQsQ0FBQSxrQ0FBQW9DLGlCQUFBLENBQUFoQyxTQUFBLEdBQUFpQywwQkFBQSxFQUFBOUIsQ0FBQSxDQUFBb0MsQ0FBQSxtQkFBQWxDLEtBQUEsRUFBQTRCLDBCQUFBLEVBQUFqQixZQUFBLFNBQUFiLENBQUEsQ0FBQThCLDBCQUFBLG1CQUFBNUIsS0FBQSxFQUFBMkIsaUJBQUEsRUFBQWhCLFlBQUEsU0FBQWdCLGlCQUFBLENBQUEyQyxXQUFBLEdBQUE3RCxNQUFBLENBQUFtQiwwQkFBQSxFQUFBckIsQ0FBQSx3QkFBQWhCLENBQUEsQ0FBQWdGLG1CQUFBLGFBQUEvRSxDQUFBLFFBQUFELENBQUEsd0JBQUFDLENBQUEsSUFBQUEsQ0FBQSxDQUFBZ0YsV0FBQSxXQUFBakYsQ0FBQSxLQUFBQSxDQUFBLEtBQUFvQyxpQkFBQSw2QkFBQXBDLENBQUEsQ0FBQStFLFdBQUEsSUFBQS9FLENBQUEsQ0FBQWtGLElBQUEsT0FBQWxGLENBQUEsQ0FBQW1GLElBQUEsYUFBQWxGLENBQUEsV0FBQUUsTUFBQSxDQUFBaUYsY0FBQSxHQUFBakYsTUFBQSxDQUFBaUYsY0FBQSxDQUFBbkYsQ0FBQSxFQUFBb0MsMEJBQUEsS0FBQXBDLENBQUEsQ0FBQW9GLFNBQUEsR0FBQWhELDBCQUFBLEVBQUFuQixNQUFBLENBQUFqQixDQUFBLEVBQUFlLENBQUEseUJBQUFmLENBQUEsQ0FBQUcsU0FBQSxHQUFBRCxNQUFBLENBQUFxQixNQUFBLENBQUFtQixDQUFBLEdBQUExQyxDQUFBLEtBQUFELENBQUEsQ0FBQXNGLEtBQUEsYUFBQXJGLENBQUEsYUFBQWtELE9BQUEsRUFBQWxELENBQUEsT0FBQTJDLHFCQUFBLENBQUFHLGFBQUEsQ0FBQTNDLFNBQUEsR0FBQWMsTUFBQSxDQUFBNkIsYUFBQSxDQUFBM0MsU0FBQSxFQUFBVSxDQUFBLGlDQUFBZCxDQUFBLENBQUErQyxhQUFBLEdBQUFBLGFBQUEsRUFBQS9DLENBQUEsQ0FBQXVGLEtBQUEsYUFBQXRGLENBQUEsRUFBQUMsQ0FBQSxFQUFBRyxDQUFBLEVBQUFFLENBQUEsRUFBQUcsQ0FBQSxlQUFBQSxDQUFBLEtBQUFBLENBQUEsR0FBQThFLE9BQUEsT0FBQTVFLENBQUEsT0FBQW1DLGFBQUEsQ0FBQXpCLElBQUEsQ0FBQXJCLENBQUEsRUFBQUMsQ0FBQSxFQUFBRyxDQUFBLEVBQUFFLENBQUEsR0FBQUcsQ0FBQSxVQUFBVixDQUFBLENBQUFnRixtQkFBQSxDQUFBOUUsQ0FBQSxJQUFBVSxDQUFBLEdBQUFBLENBQUEsQ0FBQXFELElBQUEsR0FBQWIsSUFBQSxXQUFBbkQsQ0FBQSxXQUFBQSxDQUFBLENBQUFzRCxJQUFBLEdBQUF0RCxDQUFBLENBQUFRLEtBQUEsR0FBQUcsQ0FBQSxDQUFBcUQsSUFBQSxXQUFBckIscUJBQUEsQ0FBQUQsQ0FBQSxHQUFBekIsTUFBQSxDQUFBeUIsQ0FBQSxFQUFBM0IsQ0FBQSxnQkFBQUUsTUFBQSxDQUFBeUIsQ0FBQSxFQUFBL0IsQ0FBQSxpQ0FBQU0sTUFBQSxDQUFBeUIsQ0FBQSw2REFBQTNDLENBQUEsQ0FBQXlGLElBQUEsYUFBQXhGLENBQUEsUUFBQUQsQ0FBQSxHQUFBRyxNQUFBLENBQUFGLENBQUEsR0FBQUMsQ0FBQSxnQkFBQUcsQ0FBQSxJQUFBTCxDQUFBLEVBQUFFLENBQUEsQ0FBQXVFLElBQUEsQ0FBQXBFLENBQUEsVUFBQUgsQ0FBQSxDQUFBd0YsT0FBQSxhQUFBekIsS0FBQSxXQUFBL0QsQ0FBQSxDQUFBNEUsTUFBQSxTQUFBN0UsQ0FBQSxHQUFBQyxDQUFBLENBQUF5RixHQUFBLFFBQUExRixDQUFBLElBQUFELENBQUEsU0FBQWlFLElBQUEsQ0FBQXhELEtBQUEsR0FBQVIsQ0FBQSxFQUFBZ0UsSUFBQSxDQUFBVixJQUFBLE9BQUFVLElBQUEsV0FBQUEsSUFBQSxDQUFBVixJQUFBLE9BQUFVLElBQUEsUUFBQWpFLENBQUEsQ0FBQTBDLE1BQUEsR0FBQUEsTUFBQSxFQUFBakIsT0FBQSxDQUFBckIsU0FBQSxLQUFBNkUsV0FBQSxFQUFBeEQsT0FBQSxFQUFBbUQsS0FBQSxXQUFBQSxNQUFBNUUsQ0FBQSxhQUFBNEYsSUFBQSxXQUFBM0IsSUFBQSxXQUFBTixJQUFBLFFBQUFDLEtBQUEsR0FBQTNELENBQUEsT0FBQXNELElBQUEsWUFBQUUsUUFBQSxjQUFBRCxNQUFBLGdCQUFBM0IsR0FBQSxHQUFBNUIsQ0FBQSxPQUFBdUUsVUFBQSxDQUFBM0IsT0FBQSxDQUFBNkIsYUFBQSxJQUFBMUUsQ0FBQSxXQUFBRSxDQUFBLGtCQUFBQSxDQUFBLENBQUEyRixNQUFBLE9BQUF4RixDQUFBLENBQUF5QixJQUFBLE9BQUE1QixDQUFBLE1BQUEyRSxLQUFBLEVBQUEzRSxDQUFBLENBQUE0RixLQUFBLGNBQUE1RixDQUFBLElBQUFELENBQUEsTUFBQThGLElBQUEsV0FBQUEsS0FBQSxTQUFBeEMsSUFBQSxXQUFBdEQsQ0FBQSxRQUFBdUUsVUFBQSxJQUFBRyxVQUFBLGtCQUFBMUUsQ0FBQSxDQUFBMkIsSUFBQSxRQUFBM0IsQ0FBQSxDQUFBNEIsR0FBQSxjQUFBbUUsSUFBQSxLQUFBbkMsaUJBQUEsV0FBQUEsa0JBQUE3RCxDQUFBLGFBQUF1RCxJQUFBLFFBQUF2RCxDQUFBLE1BQUFFLENBQUEsa0JBQUErRixPQUFBNUYsQ0FBQSxFQUFBRSxDQUFBLFdBQUFLLENBQUEsQ0FBQWdCLElBQUEsWUFBQWhCLENBQUEsQ0FBQWlCLEdBQUEsR0FBQTdCLENBQUEsRUFBQUUsQ0FBQSxDQUFBK0QsSUFBQSxHQUFBNUQsQ0FBQSxFQUFBRSxDQUFBLEtBQUFMLENBQUEsQ0FBQXNELE1BQUEsV0FBQXRELENBQUEsQ0FBQTJCLEdBQUEsR0FBQTVCLENBQUEsS0FBQU0sQ0FBQSxhQUFBQSxDQUFBLFFBQUFpRSxVQUFBLENBQUFNLE1BQUEsTUFBQXZFLENBQUEsU0FBQUEsQ0FBQSxRQUFBRyxDQUFBLFFBQUE4RCxVQUFBLENBQUFqRSxDQUFBLEdBQUFLLENBQUEsR0FBQUYsQ0FBQSxDQUFBaUUsVUFBQSxpQkFBQWpFLENBQUEsQ0FBQTBELE1BQUEsU0FBQTZCLE1BQUEsYUFBQXZGLENBQUEsQ0FBQTBELE1BQUEsU0FBQXdCLElBQUEsUUFBQTlFLENBQUEsR0FBQVQsQ0FBQSxDQUFBeUIsSUFBQSxDQUFBcEIsQ0FBQSxlQUFBTSxDQUFBLEdBQUFYLENBQUEsQ0FBQXlCLElBQUEsQ0FBQXBCLENBQUEscUJBQUFJLENBQUEsSUFBQUUsQ0FBQSxhQUFBNEUsSUFBQSxHQUFBbEYsQ0FBQSxDQUFBMkQsUUFBQSxTQUFBNEIsTUFBQSxDQUFBdkYsQ0FBQSxDQUFBMkQsUUFBQSxnQkFBQXVCLElBQUEsR0FBQWxGLENBQUEsQ0FBQTRELFVBQUEsU0FBQTJCLE1BQUEsQ0FBQXZGLENBQUEsQ0FBQTRELFVBQUEsY0FBQXhELENBQUEsYUFBQThFLElBQUEsR0FBQWxGLENBQUEsQ0FBQTJELFFBQUEsU0FBQTRCLE1BQUEsQ0FBQXZGLENBQUEsQ0FBQTJELFFBQUEscUJBQUFyRCxDQUFBLFlBQUFzQyxLQUFBLHFEQUFBc0MsSUFBQSxHQUFBbEYsQ0FBQSxDQUFBNEQsVUFBQSxTQUFBMkIsTUFBQSxDQUFBdkYsQ0FBQSxDQUFBNEQsVUFBQSxZQUFBUixNQUFBLFdBQUFBLE9BQUE3RCxDQUFBLEVBQUFELENBQUEsYUFBQUUsQ0FBQSxRQUFBc0UsVUFBQSxDQUFBTSxNQUFBLE1BQUE1RSxDQUFBLFNBQUFBLENBQUEsUUFBQUssQ0FBQSxRQUFBaUUsVUFBQSxDQUFBdEUsQ0FBQSxPQUFBSyxDQUFBLENBQUE2RCxNQUFBLFNBQUF3QixJQUFBLElBQUF2RixDQUFBLENBQUF5QixJQUFBLENBQUF2QixDQUFBLHdCQUFBcUYsSUFBQSxHQUFBckYsQ0FBQSxDQUFBK0QsVUFBQSxRQUFBNUQsQ0FBQSxHQUFBSCxDQUFBLGFBQUFHLENBQUEsaUJBQUFULENBQUEsbUJBQUFBLENBQUEsS0FBQVMsQ0FBQSxDQUFBMEQsTUFBQSxJQUFBcEUsQ0FBQSxJQUFBQSxDQUFBLElBQUFVLENBQUEsQ0FBQTRELFVBQUEsS0FBQTVELENBQUEsY0FBQUUsQ0FBQSxHQUFBRixDQUFBLEdBQUFBLENBQUEsQ0FBQWlFLFVBQUEsY0FBQS9ELENBQUEsQ0FBQWdCLElBQUEsR0FBQTNCLENBQUEsRUFBQVcsQ0FBQSxDQUFBaUIsR0FBQSxHQUFBN0IsQ0FBQSxFQUFBVSxDQUFBLFNBQUE4QyxNQUFBLGdCQUFBUyxJQUFBLEdBQUF2RCxDQUFBLENBQUE0RCxVQUFBLEVBQUFuQyxDQUFBLFNBQUErRCxRQUFBLENBQUF0RixDQUFBLE1BQUFzRixRQUFBLFdBQUFBLFNBQUFqRyxDQUFBLEVBQUFELENBQUEsb0JBQUFDLENBQUEsQ0FBQTJCLElBQUEsUUFBQTNCLENBQUEsQ0FBQTRCLEdBQUEscUJBQUE1QixDQUFBLENBQUEyQixJQUFBLG1CQUFBM0IsQ0FBQSxDQUFBMkIsSUFBQSxRQUFBcUMsSUFBQSxHQUFBaEUsQ0FBQSxDQUFBNEIsR0FBQSxnQkFBQTVCLENBQUEsQ0FBQTJCLElBQUEsU0FBQW9FLElBQUEsUUFBQW5FLEdBQUEsR0FBQTVCLENBQUEsQ0FBQTRCLEdBQUEsT0FBQTJCLE1BQUEsa0JBQUFTLElBQUEseUJBQUFoRSxDQUFBLENBQUEyQixJQUFBLElBQUE1QixDQUFBLFVBQUFpRSxJQUFBLEdBQUFqRSxDQUFBLEdBQUFtQyxDQUFBLEtBQUFnRSxNQUFBLFdBQUFBLE9BQUFsRyxDQUFBLGFBQUFELENBQUEsUUFBQXdFLFVBQUEsQ0FBQU0sTUFBQSxNQUFBOUUsQ0FBQSxTQUFBQSxDQUFBLFFBQUFFLENBQUEsUUFBQXNFLFVBQUEsQ0FBQXhFLENBQUEsT0FBQUUsQ0FBQSxDQUFBb0UsVUFBQSxLQUFBckUsQ0FBQSxjQUFBaUcsUUFBQSxDQUFBaEcsQ0FBQSxDQUFBeUUsVUFBQSxFQUFBekUsQ0FBQSxDQUFBcUUsUUFBQSxHQUFBRyxhQUFBLENBQUF4RSxDQUFBLEdBQUFpQyxDQUFBLHlCQUFBaUUsT0FBQW5HLENBQUEsYUFBQUQsQ0FBQSxRQUFBd0UsVUFBQSxDQUFBTSxNQUFBLE1BQUE5RSxDQUFBLFNBQUFBLENBQUEsUUFBQUUsQ0FBQSxRQUFBc0UsVUFBQSxDQUFBeEUsQ0FBQSxPQUFBRSxDQUFBLENBQUFrRSxNQUFBLEtBQUFuRSxDQUFBLFFBQUFJLENBQUEsR0FBQUgsQ0FBQSxDQUFBeUUsVUFBQSxrQkFBQXRFLENBQUEsQ0FBQXVCLElBQUEsUUFBQXJCLENBQUEsR0FBQUYsQ0FBQSxDQUFBd0IsR0FBQSxFQUFBNkMsYUFBQSxDQUFBeEUsQ0FBQSxZQUFBSyxDQUFBLGdCQUFBK0MsS0FBQSw4QkFBQStDLGFBQUEsV0FBQUEsY0FBQXJHLENBQUEsRUFBQUUsQ0FBQSxFQUFBRyxDQUFBLGdCQUFBb0QsUUFBQSxLQUFBNUMsUUFBQSxFQUFBNkIsTUFBQSxDQUFBMUMsQ0FBQSxHQUFBZ0UsVUFBQSxFQUFBOUQsQ0FBQSxFQUFBZ0UsT0FBQSxFQUFBN0QsQ0FBQSxvQkFBQW1ELE1BQUEsVUFBQTNCLEdBQUEsR0FBQTVCLENBQUEsR0FBQWtDLENBQUEsT0FBQW5DLENBQUE7QUFBQSxTQUFBc0csbUJBQUFDLEdBQUEsRUFBQXJELE9BQUEsRUFBQXNELE1BQUEsRUFBQUMsS0FBQSxFQUFBQyxNQUFBLEVBQUFDLEdBQUEsRUFBQTlFLEdBQUEsY0FBQStFLElBQUEsR0FBQUwsR0FBQSxDQUFBSSxHQUFBLEVBQUE5RSxHQUFBLE9BQUFwQixLQUFBLEdBQUFtRyxJQUFBLENBQUFuRyxLQUFBLFdBQUFvRyxLQUFBLElBQUFMLE1BQUEsQ0FBQUssS0FBQSxpQkFBQUQsSUFBQSxDQUFBckQsSUFBQSxJQUFBTCxPQUFBLENBQUF6QyxLQUFBLFlBQUErRSxPQUFBLENBQUF0QyxPQUFBLENBQUF6QyxLQUFBLEVBQUEyQyxJQUFBLENBQUFxRCxLQUFBLEVBQUFDLE1BQUE7QUFBQSxTQUFBSSxrQkFBQUMsRUFBQSw2QkFBQUMsSUFBQSxTQUFBQyxJQUFBLEdBQUFDLFNBQUEsYUFBQTFCLE9BQUEsV0FBQXRDLE9BQUEsRUFBQXNELE1BQUEsUUFBQUQsR0FBQSxHQUFBUSxFQUFBLENBQUFJLEtBQUEsQ0FBQUgsSUFBQSxFQUFBQyxJQUFBLFlBQUFSLE1BQUFoRyxLQUFBLElBQUE2RixrQkFBQSxDQUFBQyxHQUFBLEVBQUFyRCxPQUFBLEVBQUFzRCxNQUFBLEVBQUFDLEtBQUEsRUFBQUMsTUFBQSxVQUFBakcsS0FBQSxjQUFBaUcsT0FBQVUsR0FBQSxJQUFBZCxrQkFBQSxDQUFBQyxHQUFBLEVBQUFyRCxPQUFBLEVBQUFzRCxNQUFBLEVBQUFDLEtBQUEsRUFBQUMsTUFBQSxXQUFBVSxHQUFBLEtBQUFYLEtBQUEsQ0FBQVksU0FBQTtBQUFBLFNBQUFDLGdCQUFBQyxRQUFBLEVBQUFDLFdBQUEsVUFBQUQsUUFBQSxZQUFBQyxXQUFBLGVBQUF6RCxTQUFBO0FBQUEsU0FBQTBELGtCQUFBQyxNQUFBLEVBQUFDLEtBQUEsYUFBQWpILENBQUEsTUFBQUEsQ0FBQSxHQUFBaUgsS0FBQSxDQUFBN0MsTUFBQSxFQUFBcEUsQ0FBQSxVQUFBa0gsVUFBQSxHQUFBRCxLQUFBLENBQUFqSCxDQUFBLEdBQUFrSCxVQUFBLENBQUF6RyxVQUFBLEdBQUF5RyxVQUFBLENBQUF6RyxVQUFBLFdBQUF5RyxVQUFBLENBQUF4RyxZQUFBLHdCQUFBd0csVUFBQSxFQUFBQSxVQUFBLENBQUF2RyxRQUFBLFNBQUFsQixNQUFBLENBQUFLLGNBQUEsQ0FBQWtILE1BQUEsRUFBQUcsY0FBQSxDQUFBRCxVQUFBLENBQUFqQixHQUFBLEdBQUFpQixVQUFBO0FBQUEsU0FBQUUsYUFBQU4sV0FBQSxFQUFBTyxVQUFBLEVBQUFDLFdBQUEsUUFBQUQsVUFBQSxFQUFBTixpQkFBQSxDQUFBRCxXQUFBLENBQUFwSCxTQUFBLEVBQUEySCxVQUFBLE9BQUFDLFdBQUEsRUFBQVAsaUJBQUEsQ0FBQUQsV0FBQSxFQUFBUSxXQUFBLEdBQUE3SCxNQUFBLENBQUFLLGNBQUEsQ0FBQWdILFdBQUEsaUJBQUFuRyxRQUFBLG1CQUFBbUcsV0FBQTtBQUFBLFNBQUFLLGVBQUE1SCxDQUFBLFFBQUFTLENBQUEsR0FBQXVILFlBQUEsQ0FBQWhJLENBQUEsZ0NBQUFnRCxPQUFBLENBQUF2QyxDQUFBLElBQUFBLENBQUEsR0FBQXdILE1BQUEsQ0FBQXhILENBQUE7QUFBQSxTQUFBdUgsYUFBQWhJLENBQUEsRUFBQUMsQ0FBQSxvQkFBQStDLE9BQUEsQ0FBQWhELENBQUEsTUFBQUEsQ0FBQSxTQUFBQSxDQUFBLE1BQUFELENBQUEsR0FBQUMsQ0FBQSxDQUFBVSxNQUFBLENBQUF3SCxXQUFBLGtCQUFBbkksQ0FBQSxRQUFBVSxDQUFBLEdBQUFWLENBQUEsQ0FBQThCLElBQUEsQ0FBQTdCLENBQUEsRUFBQUMsQ0FBQSxnQ0FBQStDLE9BQUEsQ0FBQXZDLENBQUEsVUFBQUEsQ0FBQSxZQUFBcUQsU0FBQSx5RUFBQTdELENBQUEsR0FBQWdJLE1BQUEsR0FBQUUsTUFBQSxFQUFBbkksQ0FBQTtBQURBO0FBQ0EsSUFBSW9JLEVBQUUsR0FBR0MsbUJBQU8sQ0FBQyw0RkFBNkIsQ0FBQztBQUMvQ0QsRUFBRSxDQUFDRSxZQUFZLENBQUNuSSxTQUFTLENBQUNvSSxZQUFZLEdBQUdILEVBQUUsQ0FBQ0UsWUFBWSxDQUFDbkksU0FBUyxDQUFDcUksSUFBSTtBQUN2RUosRUFBRSxDQUFDRSxZQUFZLENBQUNuSSxTQUFTLENBQUNxSSxJQUFJLEdBQUcsVUFBUzdHLElBQUksRUFBRThHLE1BQU0sRUFBRTtFQUN0RCxPQUFPLElBQUksQ0FBQ0YsWUFBWSxDQUFDNUcsSUFBSSxFQUFFOEcsTUFBTSxDQUFDLFNBQU0sQ0FBQyxVQUFDMUksQ0FBQyxFQUFLO0lBQ2xELElBQUlBLENBQUMsQ0FBQzJJLE9BQU8sSUFBSTNJLENBQUMsQ0FBQzJJLE9BQU8sQ0FBQ0MsT0FBTyxDQUFDLFdBQVcsQ0FBQyxHQUFHLENBQUMsQ0FBQyxFQUFFO01BQ3BEQyxPQUFPLENBQUNoQyxLQUFLLENBQUMsc0JBQXNCLENBQUM7TUFDckNpQyxHQUFHLENBQUNDLFVBQVUsQ0FBQ0MsT0FBTyxDQUFDQyxTQUFTLENBQUMsQ0FBQztJQUNwQyxDQUFDLE1BQU07TUFDTCxNQUFNakosQ0FBQztJQUNUO0VBQ0YsQ0FBQyxDQUFDO0FBQ0osQ0FBQztBQUVELElBQUlrSixRQUFRLEdBQUdaLG1CQUFPLENBQUMsc0NBQUssQ0FBQztBQUM3QixJQUFJYSxLQUFLLEdBQUdiLG1CQUFPLENBQUMsa0RBQU8sQ0FBQyxDQUFDLHlCQUF5QixDQUFDO0FBQ3ZELElBQUljLElBQUksR0FBR2QsbUJBQU8sQ0FBQyxrREFBTyxDQUFDLENBQUMsd0JBQXdCLENBQUM7QUFDckQsSUFBSXpCLEtBQUssR0FBR3lCLG1CQUFPLENBQUMsa0RBQU8sQ0FBQyxDQUFDLHlCQUF5QixDQUFDO0FBQ3ZELElBQUllLFFBQVEsR0FBRyxnQ0FBZ0MsQ0FBQ0MsSUFBSSxDQUFDQyxTQUFTLENBQUNDLFNBQVMsQ0FBQztBQUV6RSxJQUFNQyxvQkFBb0IsR0FBRyxLQUFLO0FBRWxDLElBQU1DLDZCQUE2QixHQUFHLENBQUM7QUFDdkMsSUFBTUMsbUJBQW1CLEdBQUcsSUFBSTtBQUVoQyxTQUFTQyxXQUFXQSxDQUFDQyxHQUFHLEVBQUVDLEdBQUcsRUFBRTtFQUM3QixPQUFPLElBQUl0RSxPQUFPLENBQUMsVUFBQXRDLE9BQU8sRUFBSTtJQUM1QixJQUFNNkcsS0FBSyxHQUFHQyxJQUFJLENBQUNDLE1BQU0sQ0FBQyxDQUFDLElBQUlILEdBQUcsR0FBR0QsR0FBRyxDQUFDLEdBQUdBLEdBQUc7SUFDL0NLLFVBQVUsQ0FBQ2hILE9BQU8sRUFBRTZHLEtBQUssQ0FBQztFQUM1QixDQUFDLENBQUM7QUFDSjtBQUVBLFNBQVNJLFFBQVFBLENBQUNwRCxFQUFFLEVBQUU7RUFDcEIsSUFBSXFELElBQUksR0FBRzVFLE9BQU8sQ0FBQ3RDLE9BQU8sQ0FBQyxDQUFDO0VBQzVCLE9BQU8sWUFBVztJQUFBLElBQUFtSCxLQUFBO0lBQ2hCLElBQUlwRCxJQUFJLEdBQUdxRCxLQUFLLENBQUNsSyxTQUFTLENBQUMwRixLQUFLLENBQUNoRSxJQUFJLENBQUNvRixTQUFTLENBQUM7SUFDaERrRCxJQUFJLEdBQUdBLElBQUksQ0FBQ2hILElBQUksQ0FBQyxVQUFBbUgsQ0FBQztNQUFBLE9BQUl4RCxFQUFFLENBQUNJLEtBQUssQ0FBQ2tELEtBQUksRUFBRXBELElBQUksQ0FBQztJQUFBLEVBQUM7RUFDN0MsQ0FBQztBQUNIO0FBRUEsU0FBU3VELFVBQVVBLENBQUEsRUFBRztFQUNwQixPQUFPUixJQUFJLENBQUNTLEtBQUssQ0FBQ1QsSUFBSSxDQUFDQyxNQUFNLENBQUMsQ0FBQyxHQUFHN0IsTUFBTSxDQUFDc0MsZ0JBQWdCLENBQUM7QUFDNUQ7QUFFQSxTQUFTQyxvQkFBb0JBLENBQUNDLFdBQVcsRUFBRTtFQUN6QyxPQUFPLElBQUlwRixPQUFPLENBQUMsVUFBQ3RDLE9BQU8sRUFBRXNELE1BQU0sRUFBSztJQUN0QyxJQUFJb0UsV0FBVyxDQUFDQyxVQUFVLEtBQUssTUFBTSxFQUFFO01BQ3JDM0gsT0FBTyxDQUFDLENBQUM7SUFDWCxDQUFDLE1BQU07TUFDTCxJQUFJNEgsUUFBUSxFQUFFQyxRQUFRO01BRXRCLElBQU1DLEtBQUssR0FBRyxTQUFSQSxLQUFLQSxDQUFBLEVBQVM7UUFDbEJKLFdBQVcsQ0FBQ0ssbUJBQW1CLENBQUMsTUFBTSxFQUFFSCxRQUFRLENBQUM7UUFDakRGLFdBQVcsQ0FBQ0ssbUJBQW1CLENBQUMsT0FBTyxFQUFFRixRQUFRLENBQUM7TUFDcEQsQ0FBQztNQUVERCxRQUFRLEdBQUcsU0FBQUEsU0FBQSxFQUFNO1FBQ2ZFLEtBQUssQ0FBQyxDQUFDO1FBQ1A5SCxPQUFPLENBQUMsQ0FBQztNQUNYLENBQUM7TUFDRDZILFFBQVEsR0FBRyxTQUFBQSxTQUFBLEVBQU07UUFDZkMsS0FBSyxDQUFDLENBQUM7UUFDUHhFLE1BQU0sQ0FBQyxDQUFDO01BQ1YsQ0FBQztNQUVEb0UsV0FBVyxDQUFDTSxnQkFBZ0IsQ0FBQyxNQUFNLEVBQUVKLFFBQVEsQ0FBQztNQUM5Q0YsV0FBVyxDQUFDTSxnQkFBZ0IsQ0FBQyxPQUFPLEVBQUVILFFBQVEsQ0FBQztJQUNqRDtFQUNGLENBQUMsQ0FBQztBQUNKO0FBRUEsSUFBTUksb0JBQW9CLEdBQUksWUFBTTtFQUNsQyxJQUFNQyxLQUFLLEdBQUdDLFFBQVEsQ0FBQ0MsYUFBYSxDQUFDLE9BQU8sQ0FBQztFQUM3QyxPQUFPRixLQUFLLENBQUNHLFdBQVcsQ0FBQyw0Q0FBNEMsQ0FBQyxLQUFLLEVBQUU7QUFDL0UsQ0FBQyxDQUFFLENBQUM7QUFFSixJQUFNQyxlQUFlLEdBQUc7RUFDdEI7RUFDQUMsTUFBTSxFQUFFLENBQUM7RUFDVDtFQUNBQyxNQUFNLEVBQUUsQ0FBQztFQUNUO0VBQ0EsY0FBYyxFQUFFO0FBQ2xCLENBQUM7QUFFRCxJQUFNQyw4QkFBOEIsR0FBRztFQUNyQ0MsVUFBVSxFQUFFLENBQUM7SUFBRUMsSUFBSSxFQUFFO0VBQWdDLENBQUMsRUFBRTtJQUFFQSxJQUFJLEVBQUU7RUFBZ0MsQ0FBQztBQUNuRyxDQUFDO0FBRUQsSUFBTUMsaUJBQWlCLEdBQUcsSUFBSTtBQUFDLElBRXpCQyxZQUFZO0VBQ2hCLFNBQUFBLGFBQUEsRUFBYztJQUFBekUsZUFBQSxPQUFBeUUsWUFBQTtJQUNaLElBQUksQ0FBQ0MsSUFBSSxHQUFHLElBQUk7SUFDaEI7SUFDQSxJQUFJLENBQUNDLFFBQVEsR0FBRyxJQUFJO0lBQ3BCLElBQUksQ0FBQ0MsU0FBUyxHQUFHLElBQUk7SUFFckIsSUFBSSxDQUFDQyxTQUFTLEdBQUcsSUFBSTtJQUNyQixJQUFJLENBQUNDLGFBQWEsR0FBRyxDQUFDLENBQUM7SUFDdkIsSUFBSSxDQUFDQyxvQkFBb0IsR0FBRyxJQUFJO0lBQ2hDLElBQUksQ0FBQ0MsRUFBRSxHQUFHLElBQUk7SUFDZCxJQUFJLENBQUNDLE9BQU8sR0FBRyxJQUFJO0lBQ25CLElBQUksQ0FBQ0MsaUJBQWlCLEdBQUcsYUFBYTtJQUN0QyxJQUFJLENBQUNDLG1CQUFtQixHQUFHLGFBQWE7O0lBRXhDO0lBQ0E7SUFDQSxJQUFJLENBQUNDLHdCQUF3QixHQUFHLElBQUksR0FBRzFDLElBQUksQ0FBQ0MsTUFBTSxDQUFDLENBQUM7SUFDcEQsSUFBSSxDQUFDMEMsaUJBQWlCLEdBQUcsSUFBSSxDQUFDRCx3QkFBd0I7SUFDdEQsSUFBSSxDQUFDRSxtQkFBbUIsR0FBRyxJQUFJO0lBQy9CLElBQUksQ0FBQ0MsdUJBQXVCLEdBQUcsRUFBRTtJQUNqQyxJQUFJLENBQUNDLG9CQUFvQixHQUFHLENBQUM7SUFFN0IsSUFBSSxDQUFDQyxTQUFTLEdBQUcsSUFBSTtJQUNyQixJQUFJLENBQUNDLFdBQVcsR0FBRyxFQUFFO0lBQ3JCLElBQUksQ0FBQ0MsU0FBUyxHQUFHLENBQUMsQ0FBQztJQUNuQixJQUFJLENBQUNDLFlBQVksR0FBRyxDQUFDLENBQUM7SUFDdEIsSUFBSSxDQUFDQyxnQkFBZ0IsR0FBRyxJQUFJO0lBQzVCLElBQUksQ0FBQ0Msb0JBQW9CLEdBQUcsSUFBSUMsR0FBRyxDQUFDLENBQUM7SUFFckMsSUFBSSxDQUFDQyxnQkFBZ0IsR0FBRyxJQUFJQyxHQUFHLENBQUMsQ0FBQztJQUNqQyxJQUFJLENBQUNDLGtCQUFrQixHQUFHLEVBQUU7SUFDNUIsSUFBSSxDQUFDQyxrQkFBa0IsR0FBRyxJQUFJO0lBRTlCLElBQUksQ0FBQ0MsY0FBYyxHQUFHLElBQUlMLEdBQUcsQ0FBQyxDQUFDO0lBQy9CLElBQUksQ0FBQ00sYUFBYSxHQUFHLElBQUlOLEdBQUcsQ0FBQyxDQUFDO0lBRTlCLElBQUksQ0FBQ08sV0FBVyxHQUFHLEVBQUU7SUFDckIsSUFBSSxDQUFDQyxrQkFBa0IsR0FBRyxDQUFDO0lBQzNCLElBQUksQ0FBQ0MsYUFBYSxHQUFHLENBQUM7SUFFdEIsSUFBSSxDQUFDQyxlQUFlLEdBQUcsSUFBSSxDQUFDQSxlQUFlLENBQUNDLElBQUksQ0FBQyxJQUFJLENBQUM7SUFDdEQsSUFBSSxDQUFDQyxnQkFBZ0IsR0FBRyxJQUFJLENBQUNBLGdCQUFnQixDQUFDRCxJQUFJLENBQUMsSUFBSSxDQUFDO0lBQ3hELElBQUksQ0FBQ0Usa0JBQWtCLEdBQUcsSUFBSSxDQUFDQSxrQkFBa0IsQ0FBQ0YsSUFBSSxDQUFDLElBQUksQ0FBQztJQUM1RCxJQUFJLENBQUNHLG9CQUFvQixHQUFHLElBQUksQ0FBQ0Esb0JBQW9CLENBQUNILElBQUksQ0FBQyxJQUFJLENBQUM7SUFDaEUsSUFBSSxDQUFDSSxNQUFNLEdBQUcsSUFBSSxDQUFDQSxNQUFNLENBQUNKLElBQUksQ0FBQyxJQUFJLENBQUM7RUFDdEM7RUFBQ2xHLFlBQUEsQ0FBQWlFLFlBQUE7SUFBQXBGLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBNE4sYUFBYUMsR0FBRyxFQUFFO01BQ2hCLElBQUksQ0FBQ25DLFNBQVMsR0FBR21DLEdBQUc7SUFDdEI7RUFBQztJQUFBM0gsR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUE4TixPQUFPQyxHQUFHLEVBQUUsQ0FBQztFQUFDO0lBQUE3SCxHQUFBO0lBQUFsRyxLQUFBLEVBRWQsU0FBQWdPLFFBQVFDLFFBQVEsRUFBRTtNQUNoQixJQUFJLENBQUMxQyxJQUFJLEdBQUcwQyxRQUFRO0lBQ3RCO0VBQUM7SUFBQS9ILEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBa08sYUFBYXpDLFNBQVMsRUFBRTtNQUN0QixJQUFJLENBQUNBLFNBQVMsR0FBR0EsU0FBUztJQUM1QjtFQUFDO0lBQUF2RixHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQW1PLFlBQVkzQyxRQUFRLEVBQUU7TUFDcEIsSUFBSSxDQUFDQSxRQUFRLEdBQUdBLFFBQVE7SUFDMUI7RUFBQztJQUFBdEYsR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUFvTyxpQkFBaUJDLE9BQU8sRUFBRTtNQUN4QixJQUFJLENBQUMxQyxhQUFhLEdBQUcwQyxPQUFPO0lBQzlCO0VBQUM7SUFBQW5JLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBc08sd0JBQXdCMUMsb0JBQW9CLEVBQUU7TUFDNUMsSUFBSSxDQUFDQSxvQkFBb0IsR0FBR0Esb0JBQW9CO0lBQ2xEO0VBQUM7SUFBQTFGLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBdU8sMEJBQTBCQyxlQUFlLEVBQUVDLGVBQWUsRUFBRTtNQUMxRCxJQUFJLENBQUNDLGNBQWMsR0FBR0YsZUFBZTtNQUNyQyxJQUFJLENBQUNHLGNBQWMsR0FBR0YsZUFBZTtJQUN2QztFQUFDO0lBQUF2SSxHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQTRPLHdCQUF3QkMsZ0JBQWdCLEVBQUU7TUFDeEMsSUFBSSxDQUFDQyxrQkFBa0IsR0FBR0QsZ0JBQWdCO0lBQzVDO0VBQUM7SUFBQTNJLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBK08sd0JBQXdCQyxZQUFZLEVBQUVDLGNBQWMsRUFBRUMsZUFBZSxFQUFFO01BQ3JFLElBQUksQ0FBQ0MsbUJBQW1CLEdBQUdILFlBQVk7TUFDdkMsSUFBSSxDQUFDSSxzQkFBc0IsR0FBR0gsY0FBYztNQUM1QyxJQUFJLENBQUNJLGlCQUFpQixHQUFHSCxlQUFlO0lBQzFDO0VBQUM7SUFBQWhKLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBc1AseUJBQXlCQyxvQkFBb0IsRUFBRUMsbUJBQW1CLEVBQUVDLHlCQUF5QixFQUFFO01BQzdGO01BQ0EsSUFBSSxDQUFDQyxjQUFjLEdBQUdILG9CQUFvQjtNQUMxQztNQUNBLElBQUksQ0FBQ0ksYUFBYSxHQUFHSCxtQkFBbUI7TUFDeEM7TUFDQSxJQUFJLENBQUNJLG1CQUFtQixHQUFHSCx5QkFBeUI7SUFDdEQ7RUFBQztJQUFBdkosR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUE2UCxjQUFjQyxLQUFLLEVBQUU7TUFDbkIsSUFBSSxDQUFDQSxLQUFLLEdBQUdBLEtBQUs7SUFDcEI7RUFBQztJQUFBNUosR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUErUCxRQUFBLEVBQVU7TUFBQSxJQUFBQyxNQUFBO01BQ1J0SCxLQUFLLGtCQUFBdUgsTUFBQSxDQUFrQixJQUFJLENBQUN2RSxTQUFTLENBQUUsQ0FBQztNQUV4QyxJQUFNd0UsbUJBQW1CLEdBQUcsSUFBSW5MLE9BQU8sQ0FBQyxVQUFDdEMsT0FBTyxFQUFFc0QsTUFBTSxFQUFLO1FBQzNEaUssTUFBSSxDQUFDbkUsRUFBRSxHQUFHLElBQUlzRSxTQUFTLENBQUNILE1BQUksQ0FBQ3RFLFNBQVMsRUFBRSxnQkFBZ0IsQ0FBQztRQUV6RHNFLE1BQUksQ0FBQ2xFLE9BQU8sR0FBRyxJQUFJbEUsRUFBRSxDQUFDRSxZQUFZLENBQUNrSSxNQUFJLENBQUNuRSxFQUFFLENBQUM3RCxJQUFJLENBQUN1RixJQUFJLENBQUN5QyxNQUFJLENBQUNuRSxFQUFFLENBQUMsRUFBRTtVQUFFdUUsU0FBUyxFQUFFO1FBQU0sQ0FBQyxDQUFDO1FBRXBGSixNQUFJLENBQUNuRSxFQUFFLENBQUNwQixnQkFBZ0IsQ0FBQyxPQUFPLEVBQUV1RixNQUFJLENBQUN4QyxnQkFBZ0IsQ0FBQztRQUN4RHdDLE1BQUksQ0FBQ25FLEVBQUUsQ0FBQ3BCLGdCQUFnQixDQUFDLFNBQVMsRUFBRXVGLE1BQUksQ0FBQ3ZDLGtCQUFrQixDQUFDO1FBRTVEdUMsTUFBSSxDQUFDSyxRQUFRLEdBQUcsWUFBTTtVQUNwQkwsTUFBSSxDQUFDbkUsRUFBRSxDQUFDckIsbUJBQW1CLENBQUMsTUFBTSxFQUFFd0YsTUFBSSxDQUFDSyxRQUFRLENBQUM7VUFDbERMLE1BQUksQ0FBQzFDLGVBQWUsQ0FBQyxDQUFDLENBQ25CM0ssSUFBSSxDQUFDRixPQUFPLENBQUMsU0FDUixDQUFDc0QsTUFBTSxDQUFDO1FBQ2xCLENBQUM7UUFFRGlLLE1BQUksQ0FBQ25FLEVBQUUsQ0FBQ3BCLGdCQUFnQixDQUFDLE1BQU0sRUFBRXVGLE1BQUksQ0FBQ0ssUUFBUSxDQUFDO01BQ2pELENBQUMsQ0FBQztNQUVGLE9BQU90TCxPQUFPLENBQUN1TCxHQUFHLENBQUMsQ0FBQ0osbUJBQW1CLEVBQUUsSUFBSSxDQUFDSyxnQkFBZ0IsQ0FBQyxDQUFDLENBQUMsQ0FBQztJQUNwRTtFQUFDO0lBQUFySyxHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQXdRLFdBQUEsRUFBYTtNQUNYOUgsS0FBSyxnQkFBZ0IsQ0FBQztNQUV0QitILFlBQVksQ0FBQyxJQUFJLENBQUN0RSxtQkFBbUIsQ0FBQztNQUV0QyxJQUFJLENBQUN1RSxrQkFBa0IsQ0FBQyxDQUFDO01BRXpCLElBQUksSUFBSSxDQUFDcEUsU0FBUyxFQUFFO1FBQ2xCO1FBQ0EsSUFBSSxDQUFDQSxTQUFTLENBQUNxRSxJQUFJLENBQUNDLEtBQUssQ0FBQyxDQUFDO1FBQzNCLElBQUksQ0FBQ3RFLFNBQVMsR0FBRyxJQUFJO01BQ3ZCO01BRUEsSUFBSSxJQUFJLENBQUNSLE9BQU8sRUFBRTtRQUNoQixJQUFJLENBQUNBLE9BQU8sQ0FBQytFLE9BQU8sQ0FBQyxDQUFDO1FBQ3RCLElBQUksQ0FBQy9FLE9BQU8sR0FBRyxJQUFJO01BQ3JCO01BRUEsSUFBSSxJQUFJLENBQUNELEVBQUUsRUFBRTtRQUNYLElBQUksQ0FBQ0EsRUFBRSxDQUFDckIsbUJBQW1CLENBQUMsTUFBTSxFQUFFLElBQUksQ0FBQzZGLFFBQVEsQ0FBQztRQUNsRCxJQUFJLENBQUN4RSxFQUFFLENBQUNyQixtQkFBbUIsQ0FBQyxPQUFPLEVBQUUsSUFBSSxDQUFDZ0QsZ0JBQWdCLENBQUM7UUFDM0QsSUFBSSxDQUFDM0IsRUFBRSxDQUFDckIsbUJBQW1CLENBQUMsU0FBUyxFQUFFLElBQUksQ0FBQ2lELGtCQUFrQixDQUFDO1FBQy9ELElBQUksQ0FBQzVCLEVBQUUsQ0FBQytFLEtBQUssQ0FBQyxDQUFDO1FBQ2YsSUFBSSxDQUFDL0UsRUFBRSxHQUFHLElBQUk7TUFDaEI7O01BRUE7TUFDQTtNQUNBO01BQ0EsSUFBSSxJQUFJLENBQUNpRix1QkFBdUIsRUFBRTtRQUNoQ0wsWUFBWSxDQUFDLElBQUksQ0FBQ0ssdUJBQXVCLENBQUM7UUFDMUMsSUFBSSxDQUFDQSx1QkFBdUIsR0FBRyxJQUFJO01BQ3JDO0lBQ0Y7RUFBQztJQUFBNUssR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUErUSxlQUFBLEVBQWlCO01BQ2YsT0FBTyxJQUFJLENBQUNsRixFQUFFLEtBQUssSUFBSTtJQUN6QjtFQUFDO0lBQUEzRixHQUFBO0lBQUFsRyxLQUFBO01BQUEsSUFBQWdSLGdCQUFBLEdBQUEzSyxpQkFBQSxlQUFBL0csbUJBQUEsR0FBQW9GLElBQUEsQ0FFRCxTQUFBdU0sUUFBQTtRQUFBLElBQUFoUixDQUFBLEVBQUFpUixVQUFBO1FBQUEsT0FBQTVSLG1CQUFBLEdBQUF1QixJQUFBLFVBQUFzUSxTQUFBQyxRQUFBO1VBQUEsa0JBQUFBLFFBQUEsQ0FBQWpNLElBQUEsR0FBQWlNLFFBQUEsQ0FBQTVOLElBQUE7WUFBQTtjQUFBNE4sUUFBQSxDQUFBNU4sSUFBQTtjQUFBLE9BRVEsSUFBSSxDQUFDc0ksT0FBTyxDQUFDL0ssTUFBTSxDQUFDLENBQUM7WUFBQTtjQUFBcVEsUUFBQSxDQUFBNU4sSUFBQTtjQUFBLE9BS0osSUFBSSxDQUFDNk4sZUFBZSxDQUFDLENBQUM7WUFBQTtjQUE3QyxJQUFJLENBQUMvRSxTQUFTLEdBQUE4RSxRQUFBLENBQUFsTyxJQUFBO2NBRWQ7Y0FDQSxJQUFJLENBQUN3TCxjQUFjLENBQUMsSUFBSSxDQUFDbEQsUUFBUSxDQUFDO2NBRXpCdkwsQ0FBQyxHQUFHLENBQUM7WUFBQTtjQUFBLE1BQUVBLENBQUMsR0FBRyxJQUFJLENBQUNxTSxTQUFTLENBQUNnRixnQkFBZ0IsQ0FBQ2pOLE1BQU07Z0JBQUErTSxRQUFBLENBQUE1TixJQUFBO2dCQUFBO2NBQUE7Y0FDbEQwTixVQUFVLEdBQUcsSUFBSSxDQUFDNUUsU0FBUyxDQUFDZ0YsZ0JBQWdCLENBQUNyUixDQUFDLENBQUM7Y0FBQSxNQUNqRGlSLFVBQVUsS0FBSyxJQUFJLENBQUMxRixRQUFRO2dCQUFBNEYsUUFBQSxDQUFBNU4sSUFBQTtnQkFBQTtjQUFBO2NBQUEsT0FBQTROLFFBQUEsQ0FBQS9OLE1BQUE7WUFBQTtjQUFZO2NBQzVDLElBQUksQ0FBQ2tPLG9CQUFvQixDQUFDTCxVQUFVLENBQUM7WUFBQztjQUhvQmpSLENBQUMsRUFBRTtjQUFBbVIsUUFBQSxDQUFBNU4sSUFBQTtjQUFBO1lBQUE7Y0FNL0QsSUFBSSxDQUFDZ08sYUFBYSxDQUFDLENBQUM7WUFBQztZQUFBO2NBQUEsT0FBQUosUUFBQSxDQUFBOUwsSUFBQTtVQUFBO1FBQUEsR0FBQTJMLE9BQUE7TUFBQSxDQUN0QjtNQUFBLFNBQUEzRCxnQkFBQTtRQUFBLE9BQUEwRCxnQkFBQSxDQUFBdEssS0FBQSxPQUFBRCxTQUFBO01BQUE7TUFBQSxPQUFBNkcsZUFBQTtJQUFBO0VBQUE7SUFBQXBILEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBd04saUJBQWlCaUUsS0FBSyxFQUFFO01BQUEsSUFBQUMsTUFBQTtNQUN0QjtNQUNBLElBQUlELEtBQUssQ0FBQ0UsSUFBSSxLQUFLdEcsaUJBQWlCLEVBQUU7UUFDcEM7TUFDRjtNQUVBakQsT0FBTyxDQUFDTyxJQUFJLENBQUMsc0NBQXNDLENBQUM7TUFDcEQsSUFBSSxJQUFJLENBQUMrRyxjQUFjLEVBQUU7UUFDdkIsSUFBSSxDQUFDQSxjQUFjLENBQUMsSUFBSSxDQUFDeEQsaUJBQWlCLENBQUM7TUFDN0M7TUFFQSxJQUFJLENBQUNDLG1CQUFtQixHQUFHMUMsVUFBVSxDQUFDO1FBQUEsT0FBTWlJLE1BQUksQ0FBQ2xKLFNBQVMsQ0FBQyxDQUFDO01BQUEsR0FBRSxJQUFJLENBQUMwRCxpQkFBaUIsQ0FBQztJQUN2RjtFQUFDO0lBQUFoRyxHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQXdJLFVBQUEsRUFBWTtNQUFBLElBQUFvSixNQUFBO01BQ1Y7TUFDQSxJQUFJLENBQUNwQixVQUFVLENBQUMsQ0FBQztNQUVqQixJQUFJLENBQUNULE9BQU8sQ0FBQyxDQUFDLENBQ1hwTixJQUFJLENBQUMsWUFBTTtRQUNWaVAsTUFBSSxDQUFDMUYsaUJBQWlCLEdBQUcwRixNQUFJLENBQUMzRix3QkFBd0I7UUFDdEQyRixNQUFJLENBQUN2RixvQkFBb0IsR0FBRyxDQUFDO1FBRTdCLElBQUl1RixNQUFJLENBQUNqQyxhQUFhLEVBQUU7VUFDdEJpQyxNQUFJLENBQUNqQyxhQUFhLENBQUMsQ0FBQztRQUN0QjtNQUNGLENBQUMsQ0FBQyxTQUNJLENBQUMsVUFBQXZKLEtBQUssRUFBSTtRQUNkd0wsTUFBSSxDQUFDMUYsaUJBQWlCLElBQUksSUFBSTtRQUM5QjBGLE1BQUksQ0FBQ3ZGLG9CQUFvQixFQUFFO1FBRTNCLElBQUl1RixNQUFJLENBQUN2RixvQkFBb0IsR0FBR3VGLE1BQUksQ0FBQ3hGLHVCQUF1QixJQUFJd0YsTUFBSSxDQUFDaEMsbUJBQW1CLEVBQUU7VUFDeEYsT0FBT2dDLE1BQUksQ0FBQ2hDLG1CQUFtQixDQUM3QixJQUFJL00sS0FBSyxDQUFDLDBGQUEwRixDQUN0RyxDQUFDO1FBQ0g7UUFFQXVGLE9BQU8sQ0FBQ08sSUFBSSxDQUFDLG1DQUFtQyxDQUFDO1FBQ2pEUCxPQUFPLENBQUNPLElBQUksQ0FBQ3ZDLEtBQUssQ0FBQztRQUVuQixJQUFJd0wsTUFBSSxDQUFDbEMsY0FBYyxFQUFFO1VBQ3ZCa0MsTUFBSSxDQUFDbEMsY0FBYyxDQUFDa0MsTUFBSSxDQUFDMUYsaUJBQWlCLENBQUM7UUFDN0M7UUFFQTBGLE1BQUksQ0FBQ3pGLG1CQUFtQixHQUFHMUMsVUFBVSxDQUFDO1VBQUEsT0FBTW1JLE1BQUksQ0FBQ3BKLFNBQVMsQ0FBQyxDQUFDO1FBQUEsR0FBRW9KLE1BQUksQ0FBQzFGLGlCQUFpQixDQUFDO01BQ3ZGLENBQUMsQ0FBQztJQUNOO0VBQUM7SUFBQWhHLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBNlIsd0JBQUEsRUFBMEI7TUFBQSxJQUFBQyxNQUFBO01BQ3hCLElBQUksSUFBSSxDQUFDaEIsdUJBQXVCLEVBQUU7UUFDaENMLFlBQVksQ0FBQyxJQUFJLENBQUNLLHVCQUF1QixDQUFDO01BQzVDO01BRUEsSUFBSSxDQUFDQSx1QkFBdUIsR0FBR3JILFVBQVUsQ0FBQyxZQUFNO1FBQzlDcUksTUFBSSxDQUFDaEIsdUJBQXVCLEdBQUcsSUFBSTtRQUNuQ2dCLE1BQUksQ0FBQ3RKLFNBQVMsQ0FBQyxDQUFDO01BQ2xCLENBQUMsRUFBRSxLQUFLLENBQUM7SUFDWDtFQUFDO0lBQUF0QyxHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQXlOLG1CQUFtQmdFLEtBQUssRUFBRTtNQUN4QixJQUFJLENBQUMzRixPQUFPLENBQUNpRyxPQUFPLENBQUNDLElBQUksQ0FBQ0MsS0FBSyxDQUFDUixLQUFLLENBQUNTLElBQUksQ0FBQyxDQUFDO0lBQzlDO0VBQUM7SUFBQWhNLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBdVIscUJBQXFCTCxVQUFVLEVBQUU7TUFDL0IsSUFBSSxJQUFJLENBQUNuRSxrQkFBa0IsQ0FBQzVFLE9BQU8sQ0FBQytJLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFO1FBQ3RELElBQUksQ0FBQ25FLGtCQUFrQixDQUFDL0ksSUFBSSxDQUFDa04sVUFBVSxDQUFDO01BQzFDO0lBQ0Y7RUFBQztJQUFBaEwsR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUFtUyx3QkFBd0JqQixVQUFVLEVBQUU7TUFDbEMsSUFBTWtCLEdBQUcsR0FBRyxJQUFJLENBQUNyRixrQkFBa0IsQ0FBQzVFLE9BQU8sQ0FBQytJLFVBQVUsQ0FBQztNQUN2RCxJQUFJa0IsR0FBRyxLQUFLLENBQUMsQ0FBQyxFQUFFO1FBQ2QsSUFBSSxDQUFDckYsa0JBQWtCLENBQUNzRixNQUFNLENBQUNELEdBQUcsRUFBRSxDQUFDLENBQUM7TUFDeEM7SUFDRjtFQUFDO0lBQUFsTSxHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQXdSLGNBQWN4RSxrQkFBa0IsRUFBRTtNQUNoQyxJQUFJQSxrQkFBa0IsRUFBRTtRQUN0QixJQUFJLENBQUNBLGtCQUFrQixHQUFHQSxrQkFBa0I7TUFDOUM7TUFFQSxJQUFJLENBQUMsSUFBSSxDQUFDQSxrQkFBa0IsRUFBRTtRQUM1QjtNQUNGOztNQUVBO01BQ0EsS0FBSyxJQUFJL00sQ0FBQyxHQUFHLENBQUMsRUFBRUEsQ0FBQyxHQUFHLElBQUksQ0FBQytNLGtCQUFrQixDQUFDM0ksTUFBTSxFQUFFcEUsQ0FBQyxFQUFFLEVBQUU7UUFDdkQsSUFBTWlSLFVBQVUsR0FBRyxJQUFJLENBQUNsRSxrQkFBa0IsQ0FBQy9NLENBQUMsQ0FBQztRQUM3QyxJQUFJLENBQUMsSUFBSSxDQUFDdU0sU0FBUyxDQUFDMEUsVUFBVSxDQUFDLElBQUksSUFBSSxDQUFDbkUsa0JBQWtCLENBQUM1RSxPQUFPLENBQUMrSSxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUMsSUFBSSxDQUFDLElBQUksQ0FBQ3JFLGdCQUFnQixDQUFDeUYsR0FBRyxDQUFDcEIsVUFBVSxDQUFDLEVBQUU7VUFDL0gsSUFBSSxDQUFDcUIsV0FBVyxDQUFDckIsVUFBVSxDQUFDO1FBQzlCO01BQ0Y7O01BRUE7TUFDQSxLQUFLLElBQUlzQixDQUFDLEdBQUcsQ0FBQyxFQUFFQSxDQUFDLEdBQUcsSUFBSSxDQUFDekYsa0JBQWtCLENBQUMxSSxNQUFNLEVBQUVtTyxDQUFDLEVBQUUsRUFBRTtRQUN2RCxJQUFNdEIsV0FBVSxHQUFHLElBQUksQ0FBQ25FLGtCQUFrQixDQUFDeUYsQ0FBQyxDQUFDO1FBQzdDLElBQUksSUFBSSxDQUFDaEcsU0FBUyxDQUFDMEUsV0FBVSxDQUFDLElBQUksSUFBSSxDQUFDbEUsa0JBQWtCLENBQUM3RSxPQUFPLENBQUMrSSxXQUFVLENBQUMsS0FBSyxDQUFDLENBQUMsRUFBRTtVQUNwRixJQUFJLENBQUN1QixjQUFjLENBQUN2QixXQUFVLENBQUM7UUFDakM7TUFDRjs7TUFFQTtNQUNBLElBQUksQ0FBQ3BDLGtCQUFrQixDQUFDLElBQUksQ0FBQ3RDLFNBQVMsQ0FBQztJQUN6QztFQUFDO0lBQUF0RyxHQUFBO0lBQUFsRyxLQUFBO01BQUEsSUFBQTBTLFlBQUEsR0FBQXJNLGlCQUFBLGVBQUEvRyxtQkFBQSxHQUFBb0YsSUFBQSxDQUVELFNBQUFpTyxTQUFrQnpCLFVBQVU7UUFBQSxJQUFBMEIsdUJBQUEsRUFBQUMsVUFBQTtRQUFBLE9BQUF2VCxtQkFBQSxHQUFBdUIsSUFBQSxVQUFBaVMsVUFBQUMsU0FBQTtVQUFBLGtCQUFBQSxTQUFBLENBQUE1TixJQUFBLEdBQUE0TixTQUFBLENBQUF2UCxJQUFBO1lBQUE7Y0FDMUIsSUFBSSxDQUFDcUosZ0JBQWdCLENBQUNtRyxHQUFHLENBQUM5QixVQUFVLENBQUM7Y0FFL0IwQix1QkFBdUIsR0FBRyxJQUFJLENBQUM3RixrQkFBa0IsQ0FBQzFJLE1BQU07Y0FBQSxNQUMxRHVPLHVCQUF1QixHQUFHM0osNkJBQTZCO2dCQUFBOEosU0FBQSxDQUFBdlAsSUFBQTtnQkFBQTtjQUFBO2NBQUF1UCxTQUFBLENBQUF2UCxJQUFBO2NBQUEsT0FDbkQyRixXQUFXLENBQUMsQ0FBQyxFQUFFRCxtQkFBbUIsQ0FBQztZQUFBO2NBQUE2SixTQUFBLENBQUF2UCxJQUFBO2NBQUEsT0FHbEIsSUFBSSxDQUFDeVAsZ0JBQWdCLENBQUMvQixVQUFVLENBQUM7WUFBQTtjQUFwRDJCLFVBQVUsR0FBQUUsU0FBQSxDQUFBN1AsSUFBQTtjQUNoQixJQUFJMlAsVUFBVSxFQUFFO2dCQUNkLElBQUcsQ0FBQyxJQUFJLENBQUNoRyxnQkFBZ0IsQ0FBQ3lGLEdBQUcsQ0FBQ3BCLFVBQVUsQ0FBQyxFQUFFO2tCQUN6QzJCLFVBQVUsQ0FBQ2xDLElBQUksQ0FBQ0MsS0FBSyxDQUFDLENBQUM7Z0JBQ3pCLENBQUMsTUFBTTtrQkFDTCxJQUFJLENBQUMvRCxnQkFBZ0IsVUFBTyxDQUFDcUUsVUFBVSxDQUFDO2tCQUN4QyxJQUFJLENBQUMzRSxXQUFXLENBQUN2SSxJQUFJLENBQUNrTixVQUFVLENBQUM7a0JBQ2pDLElBQUksQ0FBQzFFLFNBQVMsQ0FBQzBFLFVBQVUsQ0FBQyxHQUFHMkIsVUFBVTtrQkFFdkMsSUFBSSxDQUFDSyxjQUFjLENBQUNoQyxVQUFVLEVBQUUyQixVQUFVLENBQUNNLFdBQVcsQ0FBQzs7a0JBRXZEO2tCQUNBLElBQUksQ0FBQ2hFLG1CQUFtQixDQUFDK0IsVUFBVSxDQUFDO2dCQUN0QztjQUNGO1lBQUM7WUFBQTtjQUFBLE9BQUE2QixTQUFBLENBQUF6TixJQUFBO1VBQUE7UUFBQSxHQUFBcU4sUUFBQTtNQUFBLENBQ0Y7TUFBQSxTQUFBSixZQUFBYSxFQUFBO1FBQUEsT0FBQVYsWUFBQSxDQUFBaE0sS0FBQSxPQUFBRCxTQUFBO01BQUE7TUFBQSxPQUFBOEwsV0FBQTtJQUFBO0VBQUE7SUFBQXJNLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBMFEsbUJBQUEsRUFBcUI7TUFDbkIsSUFBSSxDQUFDN0QsZ0JBQWdCLENBQUN0QyxLQUFLLENBQUMsQ0FBQztNQUM3QixLQUFLLElBQUl0SyxDQUFDLEdBQUcsSUFBSSxDQUFDc00sV0FBVyxDQUFDbEksTUFBTSxHQUFHLENBQUMsRUFBRXBFLENBQUMsSUFBSSxDQUFDLEVBQUVBLENBQUMsRUFBRSxFQUFFO1FBQ3JELElBQUksQ0FBQ3dTLGNBQWMsQ0FBQyxJQUFJLENBQUNsRyxXQUFXLENBQUN0TSxDQUFDLENBQUMsQ0FBQztNQUMxQztJQUNGO0VBQUM7SUFBQWlHLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBeVMsZUFBZXZCLFVBQVUsRUFBRTtNQUN6QixJQUFJLENBQUNyRSxnQkFBZ0IsVUFBTyxDQUFDcUUsVUFBVSxDQUFDO01BRXhDLElBQUksSUFBSSxDQUFDMUUsU0FBUyxDQUFDMEUsVUFBVSxDQUFDLEVBQUU7UUFDOUI7UUFDQSxJQUFJLENBQUMxRSxTQUFTLENBQUMwRSxVQUFVLENBQUMsQ0FBQ1AsSUFBSSxDQUFDQyxLQUFLLENBQUMsQ0FBQztRQUN2QyxPQUFPLElBQUksQ0FBQ3BFLFNBQVMsQ0FBQzBFLFVBQVUsQ0FBQztRQUVqQyxJQUFJLENBQUMzRSxXQUFXLENBQUM4RixNQUFNLENBQUMsSUFBSSxDQUFDOUYsV0FBVyxDQUFDcEUsT0FBTyxDQUFDK0ksVUFBVSxDQUFDLEVBQUUsQ0FBQyxDQUFDO01BQ2xFO01BRUEsSUFBSSxJQUFJLENBQUN6RSxZQUFZLENBQUN5RSxVQUFVLENBQUMsRUFBRTtRQUNqQyxPQUFPLElBQUksQ0FBQ3pFLFlBQVksQ0FBQ3lFLFVBQVUsQ0FBQztNQUN0QztNQUVBLElBQUksSUFBSSxDQUFDdkUsb0JBQW9CLENBQUMyRixHQUFHLENBQUNwQixVQUFVLENBQUMsRUFBRTtRQUM3QyxJQUFNbUMsR0FBRyxHQUFHLDZEQUE2RDtRQUN6RSxJQUFJLENBQUMxRyxvQkFBb0IsQ0FBQzJHLEdBQUcsQ0FBQ3BDLFVBQVUsQ0FBQyxDQUFDcUMsS0FBSyxDQUFDeE4sTUFBTSxDQUFDc04sR0FBRyxDQUFDO1FBQzNELElBQUksQ0FBQzFHLG9CQUFvQixDQUFDMkcsR0FBRyxDQUFDcEMsVUFBVSxDQUFDLENBQUN2RyxLQUFLLENBQUM1RSxNQUFNLENBQUNzTixHQUFHLENBQUM7UUFDM0QsSUFBSSxDQUFDMUcsb0JBQW9CLFVBQU8sQ0FBQ3VFLFVBQVUsQ0FBQztNQUM5Qzs7TUFFQTtNQUNBLElBQUksQ0FBQzlCLHNCQUFzQixDQUFDOEIsVUFBVSxDQUFDO0lBQ3pDO0VBQUM7SUFBQWhMLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBd1QsVUFBVTdDLElBQUksRUFBRW5MLE1BQU0sRUFBRTtNQUFBLElBQUFpTyxNQUFBO01BQ3RCOUMsSUFBSSxDQUFDbEcsZ0JBQWdCLENBQUMsY0FBYyxFQUFFLFVBQUFpSixFQUFFLEVBQUk7UUFDMUNsTyxNQUFNLENBQUNtTyxXQUFXLENBQUNELEVBQUUsQ0FBQ0UsU0FBUyxJQUFJLElBQUksQ0FBQyxTQUFNLENBQUMsVUFBQXJVLENBQUM7VUFBQSxPQUFJNkcsS0FBSyxDQUFDLHlCQUF5QixFQUFFN0csQ0FBQyxDQUFDO1FBQUEsRUFBQztNQUMxRixDQUFDLENBQUM7TUFDRm9SLElBQUksQ0FBQ2xHLGdCQUFnQixDQUFDLDBCQUEwQixFQUFFLFVBQUFpSixFQUFFLEVBQUk7UUFDdEQsSUFBSS9DLElBQUksQ0FBQ2tELGtCQUFrQixLQUFLLFdBQVcsRUFBRTtVQUMzQ3pMLE9BQU8sQ0FBQzBMLEdBQUcsQ0FBQyxnQ0FBZ0MsQ0FBQztRQUMvQztRQUNBLElBQUluRCxJQUFJLENBQUNrRCxrQkFBa0IsS0FBSyxjQUFjLEVBQUU7VUFDOUN6TCxPQUFPLENBQUNPLElBQUksQ0FBQyxtQ0FBbUMsQ0FBQztRQUNuRDtRQUNBLElBQUlnSSxJQUFJLENBQUNrRCxrQkFBa0IsS0FBSyxRQUFRLEVBQUU7VUFDeEN6TCxPQUFPLENBQUNPLElBQUksQ0FBQyw0Q0FBNEMsQ0FBQztVQUMxRDhLLE1BQUksQ0FBQzVCLHVCQUF1QixDQUFDLENBQUM7UUFDaEM7TUFDRixDQUFDLENBQUM7O01BRUY7TUFDQTtNQUNBO01BQ0E7TUFDQWxCLElBQUksQ0FBQ2xHLGdCQUFnQixDQUNuQixtQkFBbUIsRUFDbkJmLFFBQVEsQ0FBQyxVQUFBZ0ssRUFBRSxFQUFJO1FBQ2JoTCxLQUFLLENBQUMsa0NBQWtDLEVBQUVsRCxNQUFNLENBQUM7UUFDakQsSUFBSXVPLEtBQUssR0FBR3BELElBQUksQ0FBQ3FELFdBQVcsQ0FBQyxDQUFDLENBQUNyUixJQUFJLENBQUM4USxNQUFJLENBQUNRLHFCQUFxQixDQUFDLENBQUN0UixJQUFJLENBQUM4USxNQUFJLENBQUNTLGlCQUFpQixDQUFDO1FBQzVGLElBQUlDLEtBQUssR0FBR0osS0FBSyxDQUFDcFIsSUFBSSxDQUFDLFVBQUE3QyxDQUFDO1VBQUEsT0FBSTZRLElBQUksQ0FBQ3lELG1CQUFtQixDQUFDdFUsQ0FBQyxDQUFDO1FBQUEsRUFBQztRQUN4RCxJQUFJdVUsTUFBTSxHQUFHTixLQUFLO1FBRWxCTSxNQUFNLEdBQUdBLE1BQU0sQ0FDWjFSLElBQUksQ0FBQzhRLE1BQUksQ0FBQ1MsaUJBQWlCLENBQUMsQ0FDNUJ2UixJQUFJLENBQUMsVUFBQTZQLENBQUM7VUFBQSxPQUFJaE4sTUFBTSxDQUFDOE8sUUFBUSxDQUFDOUIsQ0FBQyxDQUFDO1FBQUEsRUFBQyxDQUM3QjdQLElBQUksQ0FBQyxVQUFBbEQsQ0FBQztVQUFBLE9BQUlrUixJQUFJLENBQUM0RCxvQkFBb0IsQ0FBQzlVLENBQUMsQ0FBQytVLElBQUksQ0FBQztRQUFBLEVBQUM7UUFDL0MsT0FBT3pQLE9BQU8sQ0FBQ3VMLEdBQUcsQ0FBQyxDQUFDNkQsS0FBSyxFQUFFRSxNQUFNLENBQUMsQ0FBQyxTQUFNLENBQUMsVUFBQTlVLENBQUM7VUFBQSxPQUFJNkcsS0FBSyxDQUFDLDZCQUE2QixFQUFFN0csQ0FBQyxDQUFDO1FBQUEsRUFBQztNQUN6RixDQUFDLENBQ0gsQ0FBQztNQUNEaUcsTUFBTSxDQUFDaVAsRUFBRSxDQUNQLE9BQU8sRUFDUC9LLFFBQVEsQ0FBQyxVQUFBZ0ssRUFBRSxFQUFJO1FBQ2IsSUFBSWMsSUFBSSxHQUFHZCxFQUFFLENBQUNjLElBQUk7UUFDbEIsSUFBSUEsSUFBSSxJQUFJQSxJQUFJLENBQUNyVCxJQUFJLElBQUksT0FBTyxFQUFFO1VBQ2hDdUgsS0FBSyxDQUFDLG9DQUFvQyxFQUFFbEQsTUFBTSxDQUFDO1VBQ25ELElBQUlrUCxNQUFNLEdBQUcvRCxJQUFJLENBQ2Q0RCxvQkFBb0IsQ0FBQ2QsTUFBSSxDQUFDa0Isc0JBQXNCLENBQUNILElBQUksQ0FBQyxDQUFDLENBQ3ZEN1IsSUFBSSxDQUFDLFVBQUFtSCxDQUFDO1lBQUEsT0FBSTZHLElBQUksQ0FBQ2lFLFlBQVksQ0FBQyxDQUFDO1VBQUEsRUFBQyxDQUM5QmpTLElBQUksQ0FBQzhRLE1BQUksQ0FBQ1MsaUJBQWlCLENBQUM7VUFDL0IsSUFBSUMsS0FBSyxHQUFHTyxNQUFNLENBQUMvUixJQUFJLENBQUMsVUFBQXhDLENBQUM7WUFBQSxPQUFJd1EsSUFBSSxDQUFDeUQsbUJBQW1CLENBQUNqVSxDQUFDLENBQUM7VUFBQSxFQUFDO1VBQ3pELElBQUlrVSxNQUFNLEdBQUdLLE1BQU0sQ0FBQy9SLElBQUksQ0FBQyxVQUFBNlAsQ0FBQztZQUFBLE9BQUloTixNQUFNLENBQUM4TyxRQUFRLENBQUM5QixDQUFDLENBQUM7VUFBQSxFQUFDO1VBQ2pELE9BQU96TixPQUFPLENBQUN1TCxHQUFHLENBQUMsQ0FBQzZELEtBQUssRUFBRUUsTUFBTSxDQUFDLENBQUMsU0FBTSxDQUFDLFVBQUE5VSxDQUFDO1lBQUEsT0FBSTZHLEtBQUssQ0FBQyw4QkFBOEIsRUFBRTdHLENBQUMsQ0FBQztVQUFBLEVBQUM7UUFDMUYsQ0FBQyxNQUFNO1VBQ0w7VUFDQSxPQUFPLElBQUk7UUFDYjtNQUNGLENBQUMsQ0FDSCxDQUFDO0lBQ0g7RUFBQztJQUFBMkcsR0FBQTtJQUFBbEcsS0FBQTtNQUFBLElBQUE2VSxnQkFBQSxHQUFBeE8saUJBQUEsZUFBQS9HLG1CQUFBLEdBQUFvRixJQUFBLENBRUQsU0FBQW9RLFNBQUE7UUFBQSxJQUFBQyxNQUFBO1FBQUEsSUFBQXZQLE1BQUEsRUFBQW1MLElBQUEsRUFBQXFFLFFBQUEsRUFBQUMsZUFBQSxFQUFBQyxpQkFBQSxFQUFBaE4sT0FBQSxFQUFBdkIsR0FBQSxFQUFBMkssZ0JBQUE7UUFBQSxPQUFBaFMsbUJBQUEsR0FBQXVCLElBQUEsVUFBQXNVLFVBQUFDLFNBQUE7VUFBQSxrQkFBQUEsU0FBQSxDQUFBalEsSUFBQSxHQUFBaVEsU0FBQSxDQUFBNVIsSUFBQTtZQUFBO2NBQ01nQyxNQUFNLEdBQUcsSUFBSW9DLEVBQUUsQ0FBQ3lOLGlCQUFpQixDQUFDLElBQUksQ0FBQ3ZKLE9BQU8sQ0FBQztjQUMvQzZFLElBQUksR0FBRyxJQUFJMkUsaUJBQWlCLENBQUMsSUFBSSxDQUFDMUosb0JBQW9CLElBQUlWLDhCQUE4QixDQUFDO2NBRTdGeEMsS0FBSyxDQUFDLHFCQUFxQixDQUFDO2NBQUMwTSxTQUFBLENBQUE1UixJQUFBO2NBQUEsT0FDdkJnQyxNQUFNLENBQUMrUCxNQUFNLENBQUMsa0JBQWtCLEVBQUUsSUFBSSxDQUFDekYsS0FBSyxJQUFJLElBQUksQ0FBQ3RFLFFBQVEsR0FBR2dLLFFBQVEsQ0FBQyxJQUFJLENBQUNoSyxRQUFRLENBQUMsR0FBRyxJQUFJLENBQUNzRSxLQUFLLEdBQUdsSixTQUFTLENBQUM7WUFBQTtjQUV2SCxJQUFJLENBQUM0TSxTQUFTLENBQUM3QyxJQUFJLEVBQUVuTCxNQUFNLENBQUM7Y0FFNUJrRCxLQUFLLENBQUMsMENBQTBDLENBQUM7Y0FDN0NzTSxRQUFRLEdBQUcsSUFBSWpRLE9BQU8sQ0FBQyxVQUFBdEMsT0FBTztnQkFBQSxPQUFJK0MsTUFBTSxDQUFDaVAsRUFBRSxDQUFDLFVBQVUsRUFBRWhTLE9BQU8sQ0FBQztjQUFBLEVBQUMsRUFFckU7Y0FDQTtjQUNJd1MsZUFBZSxHQUFHdEUsSUFBSSxDQUFDOEUsaUJBQWlCLENBQUMsVUFBVSxFQUFFO2dCQUFFQyxPQUFPLEVBQUU7Y0FBSyxDQUFDLENBQUM7Y0FDdkVSLGlCQUFpQixHQUFHdkUsSUFBSSxDQUFDOEUsaUJBQWlCLENBQUMsWUFBWSxFQUFFO2dCQUMzREMsT0FBTyxFQUFFLEtBQUs7Z0JBQ2RDLGNBQWMsRUFBRTtjQUNsQixDQUFDLENBQUM7Y0FFRlYsZUFBZSxDQUFDeEssZ0JBQWdCLENBQUMsU0FBUyxFQUFFLFVBQUFsTCxDQUFDO2dCQUFBLE9BQUl3VixNQUFJLENBQUNySCxvQkFBb0IsQ0FBQ25PLENBQUMsRUFBRSxnQkFBZ0IsQ0FBQztjQUFBLEVBQUM7Y0FDaEcyVixpQkFBaUIsQ0FBQ3pLLGdCQUFnQixDQUFDLFNBQVMsRUFBRSxVQUFBbEwsQ0FBQztnQkFBQSxPQUFJd1YsTUFBSSxDQUFDckgsb0JBQW9CLENBQUNuTyxDQUFDLEVBQUUsa0JBQWtCLENBQUM7Y0FBQSxFQUFDO2NBQUM2VixTQUFBLENBQUE1UixJQUFBO2NBQUEsT0FFL0Z3UixRQUFRO1lBQUE7Y0FBQUksU0FBQSxDQUFBNVIsSUFBQTtjQUFBLE9BQ1IwRyxvQkFBb0IsQ0FBQytLLGVBQWUsQ0FBQztZQUFBO2NBQUFHLFNBQUEsQ0FBQTVSLElBQUE7Y0FBQSxPQUNyQzBHLG9CQUFvQixDQUFDZ0wsaUJBQWlCLENBQUM7WUFBQTtjQUU3QztjQUNBO2NBQ0E7Y0FDQTtjQUNBO2NBQ0EsSUFBSSxJQUFJLENBQUN4SSxnQkFBZ0IsRUFBRTtnQkFDekIsSUFBSSxDQUFDQSxnQkFBZ0IsQ0FBQ2tKLFNBQVMsQ0FBQyxDQUFDLENBQUN4VCxPQUFPLENBQUMsVUFBQXlULEtBQUssRUFBSTtrQkFDakRsRixJQUFJLENBQUNtRixRQUFRLENBQUNELEtBQUssRUFBRWQsTUFBSSxDQUFDckksZ0JBQWdCLENBQUM7Z0JBQzdDLENBQUMsQ0FBQztjQUNKOztjQUVBO2NBQ0FsSCxNQUFNLENBQUNpUCxFQUFFLENBQUMsT0FBTyxFQUFFLFVBQUFmLEVBQUUsRUFBSTtnQkFDdkIsSUFBSXhCLElBQUksR0FBR3dCLEVBQUUsQ0FBQ3FDLFVBQVUsQ0FBQzdELElBQUk7Z0JBQzdCLElBQUlBLElBQUksQ0FBQ1QsS0FBSyxJQUFJLE1BQU0sSUFBSVMsSUFBSSxDQUFDOEQsT0FBTyxJQUFJakIsTUFBSSxDQUFDeEosSUFBSSxFQUFFO2tCQUNyRCxJQUFJd0osTUFBSSxDQUFDakUsdUJBQXVCLEVBQUU7b0JBQ2hDO29CQUNBO2tCQUNGO2tCQUNBaUUsTUFBSSxDQUFDeEQsb0JBQW9CLENBQUNXLElBQUksQ0FBQytELE9BQU8sQ0FBQztrQkFDdkNsQixNQUFJLENBQUN2RCxhQUFhLENBQUMsQ0FBQztnQkFDdEIsQ0FBQyxNQUFNLElBQUlVLElBQUksQ0FBQ1QsS0FBSyxJQUFJLE9BQU8sSUFBSVMsSUFBSSxDQUFDOEQsT0FBTyxJQUFJakIsTUFBSSxDQUFDeEosSUFBSSxFQUFFO2tCQUM3RHdKLE1BQUksQ0FBQzVDLHVCQUF1QixDQUFDRCxJQUFJLENBQUMrRCxPQUFPLENBQUM7a0JBQzFDbEIsTUFBSSxDQUFDdEMsY0FBYyxDQUFDUCxJQUFJLENBQUMrRCxPQUFPLENBQUM7Z0JBQ25DLENBQUMsTUFBTSxJQUFJL0QsSUFBSSxDQUFDVCxLQUFLLElBQUksU0FBUyxFQUFFO2tCQUNsQzdHLFFBQVEsQ0FBQ3NMLElBQUksQ0FBQ0MsYUFBYSxDQUFDLElBQUlDLFdBQVcsQ0FBQyxTQUFTLEVBQUU7b0JBQUVDLE1BQU0sRUFBRTtzQkFBRTdLLFFBQVEsRUFBRTBHLElBQUksQ0FBQ29FO29CQUFHO2tCQUFFLENBQUMsQ0FBQyxDQUFDO2dCQUM1RixDQUFDLE1BQU0sSUFBSXBFLElBQUksQ0FBQ1QsS0FBSyxJQUFJLFdBQVcsRUFBRTtrQkFDcEM3RyxRQUFRLENBQUNzTCxJQUFJLENBQUNDLGFBQWEsQ0FBQyxJQUFJQyxXQUFXLENBQUMsV0FBVyxFQUFFO29CQUFFQyxNQUFNLEVBQUU7c0JBQUU3SyxRQUFRLEVBQUUwRyxJQUFJLENBQUNvRTtvQkFBRztrQkFBRSxDQUFDLENBQUMsQ0FBQztnQkFDOUYsQ0FBQyxNQUFNLElBQUlwRSxJQUFJLENBQUNULEtBQUssS0FBSyxNQUFNLEVBQUU7a0JBQ2hDc0QsTUFBSSxDQUFDcEgsTUFBTSxDQUFDcUUsSUFBSSxDQUFDQyxLQUFLLENBQUNDLElBQUksQ0FBQ2dFLElBQUksQ0FBQyxFQUFFLGFBQWEsQ0FBQztnQkFDbkQ7Y0FDRixDQUFDLENBQUM7Y0FFRnhOLEtBQUssQ0FBQyxzQkFBc0IsQ0FBQzs7Y0FFN0I7Y0FBQTBNLFNBQUEsQ0FBQTVSLElBQUE7Y0FBQSxPQUNvQixJQUFJLENBQUMrUyxRQUFRLENBQUMvUSxNQUFNLEVBQUU7Z0JBQ3hDZ1IsYUFBYSxFQUFFLElBQUk7Z0JBQ25CdEUsSUFBSSxFQUFFO2NBQ1IsQ0FBQyxDQUFDO1lBQUE7Y0FIRWhLLE9BQU8sR0FBQWtOLFNBQUEsQ0FBQWxTLElBQUE7Y0FBQSxJQUtOZ0YsT0FBTyxDQUFDNk4sVUFBVSxDQUFDN0QsSUFBSSxDQUFDdUUsT0FBTztnQkFBQXJCLFNBQUEsQ0FBQTVSLElBQUE7Z0JBQUE7Y0FBQTtjQUM1Qm1ELEdBQUcsR0FBR3VCLE9BQU8sQ0FBQzZOLFVBQVUsQ0FBQzdELElBQUksQ0FBQzlMLEtBQUs7Y0FDekNnQyxPQUFPLENBQUNoQyxLQUFLLENBQUNPLEdBQUcsQ0FBQztjQUNsQjtjQUNBO2NBQ0E7Y0FDQTtjQUNBO2NBQ0E7Y0FDQTtjQUNBZ0ssSUFBSSxDQUFDQyxLQUFLLENBQUMsQ0FBQztjQUFDLE1BQ1BqSyxHQUFHO1lBQUE7Y0FHUDJLLGdCQUFnQixHQUFHcEosT0FBTyxDQUFDNk4sVUFBVSxDQUFDN0QsSUFBSSxDQUFDd0UsUUFBUSxDQUFDQyxLQUFLLENBQUMsSUFBSSxDQUFDcEwsSUFBSSxDQUFDLElBQUksRUFBRTtjQUU5RSxJQUFJK0YsZ0JBQWdCLENBQUNzRixRQUFRLENBQUMsSUFBSSxDQUFDcEwsUUFBUSxDQUFDLEVBQUU7Z0JBQzVDcEQsT0FBTyxDQUFDTyxJQUFJLENBQUMsd0VBQXdFLENBQUM7Z0JBQ3RGLElBQUksQ0FBQ2tKLHVCQUF1QixDQUFDLENBQUM7Y0FDaEM7Y0FFQW5KLEtBQUssQ0FBQyxpQkFBaUIsQ0FBQztjQUFDLE9BQUEwTSxTQUFBLENBQUEvUixNQUFBLFdBQ2xCO2dCQUNMbUMsTUFBTSxFQUFOQSxNQUFNO2dCQUNOOEwsZ0JBQWdCLEVBQWhCQSxnQkFBZ0I7Z0JBQ2hCMkQsZUFBZSxFQUFmQSxlQUFlO2dCQUNmQyxpQkFBaUIsRUFBakJBLGlCQUFpQjtnQkFDakJ2RSxJQUFJLEVBQUpBO2NBQ0YsQ0FBQztZQUFBO1lBQUE7Y0FBQSxPQUFBeUUsU0FBQSxDQUFBOVAsSUFBQTtVQUFBO1FBQUEsR0FBQXdQLFFBQUE7TUFBQSxDQUNGO01BQUEsU0FBQXpELGdCQUFBO1FBQUEsT0FBQXdELGdCQUFBLENBQUFuTyxLQUFBLE9BQUFELFNBQUE7TUFBQTtNQUFBLE9BQUE0SyxlQUFBO0lBQUE7RUFBQTtJQUFBbkwsR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUFpVSxzQkFBc0JPLElBQUksRUFBRTtNQUMxQkEsSUFBSSxDQUFDcUMsR0FBRyxHQUFHckMsSUFBSSxDQUFDcUMsR0FBRyxDQUFDQyxPQUFPLENBQUMseUJBQXlCLEVBQUUsVUFBQ0MsSUFBSSxFQUFFQyxFQUFFLEVBQUs7UUFDbkUsSUFBTUMsVUFBVSxHQUFHdlgsTUFBTSxDQUFDd1gsTUFBTSxDQUFDek8sUUFBUSxDQUFDME8sU0FBUyxDQUFDSixJQUFJLENBQUMsRUFBRWhNLGVBQWUsQ0FBQztRQUMzRSxPQUFPdEMsUUFBUSxDQUFDMk8sU0FBUyxDQUFDO1VBQUVDLFdBQVcsRUFBRUwsRUFBRTtVQUFFQyxVQUFVLEVBQUVBO1FBQVcsQ0FBQyxDQUFDO01BQ3hFLENBQUMsQ0FBQztNQUNGLE9BQU96QyxJQUFJO0lBQ2I7RUFBQztJQUFBdE8sR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUEyVSx1QkFBdUJILElBQUksRUFBRTtNQUMzQjtNQUNBLElBQUksQ0FBQzlKLG9CQUFvQixFQUFFO1FBQ3pCLElBQUk1QixTQUFTLENBQUNDLFNBQVMsQ0FBQ1osT0FBTyxDQUFDLGdCQUFnQixDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUU7VUFDeEQ7VUFDQXFNLElBQUksQ0FBQ3FDLEdBQUcsR0FBR3JDLElBQUksQ0FBQ3FDLEdBQUcsQ0FBQ0MsT0FBTyxDQUFDLGVBQWUsRUFBRSxJQUFJLENBQUM7UUFDcEQ7TUFDRjs7TUFFQTtNQUNBLElBQUloTyxTQUFTLENBQUNDLFNBQVMsQ0FBQ1osT0FBTyxDQUFDLFNBQVMsQ0FBQyxLQUFLLENBQUMsQ0FBQyxFQUFFO1FBQ2pEcU0sSUFBSSxDQUFDcUMsR0FBRyxHQUFHckMsSUFBSSxDQUFDcUMsR0FBRyxDQUFDQyxPQUFPLENBQ3pCLDZCQUE2QixFQUM3QixnSkFDRixDQUFDO01BQ0gsQ0FBQyxNQUFNO1FBQ0x0QyxJQUFJLENBQUNxQyxHQUFHLEdBQUdyQyxJQUFJLENBQUNxQyxHQUFHLENBQUNDLE9BQU8sQ0FDekIsNkJBQTZCLEVBQzdCLGdKQUNGLENBQUM7TUFDSDtNQUNBLE9BQU90QyxJQUFJO0lBQ2I7RUFBQztJQUFBdE8sR0FBQTtJQUFBbEcsS0FBQTtNQUFBLElBQUFzWCxrQkFBQSxHQUFBalIsaUJBQUEsZUFBQS9HLG1CQUFBLEdBQUFvRixJQUFBLENBRUQsU0FBQTZTLFNBQXdCL0MsSUFBSTtRQUFBLE9BQUFsVixtQkFBQSxHQUFBdUIsSUFBQSxVQUFBMlcsVUFBQUMsU0FBQTtVQUFBLGtCQUFBQSxTQUFBLENBQUF0UyxJQUFBLEdBQUFzUyxTQUFBLENBQUFqVSxJQUFBO1lBQUE7Y0FDMUI7Y0FDQWdSLElBQUksQ0FBQ3FDLEdBQUcsR0FBR3JDLElBQUksQ0FBQ3FDLEdBQUcsQ0FBQ0MsT0FBTyxDQUFDLHFCQUFxQixFQUFFLGlCQUFpQixDQUFDO2NBQUMsT0FBQVcsU0FBQSxDQUFBcFUsTUFBQSxXQUMvRG1SLElBQUk7WUFBQTtZQUFBO2NBQUEsT0FBQWlELFNBQUEsQ0FBQW5TLElBQUE7VUFBQTtRQUFBLEdBQUFpUyxRQUFBO01BQUEsQ0FDWjtNQUFBLFNBQUFyRCxrQkFBQXdELEdBQUE7UUFBQSxPQUFBSixrQkFBQSxDQUFBNVEsS0FBQSxPQUFBRCxTQUFBO01BQUE7TUFBQSxPQUFBeU4saUJBQUE7SUFBQTtFQUFBO0lBQUFoTyxHQUFBO0lBQUFsRyxLQUFBO01BQUEsSUFBQTJYLGlCQUFBLEdBQUF0UixpQkFBQSxlQUFBL0csbUJBQUEsR0FBQW9GLElBQUEsQ0FFRCxTQUFBa1QsU0FBdUIxRyxVQUFVO1FBQUEsSUFBQTJHLE1BQUE7UUFBQSxJQUFBQyxVQUFBO1VBQUF0UyxNQUFBO1VBQUFtTCxJQUFBO1VBQUFvSCxZQUFBO1VBQUEvQyxRQUFBO1VBQUE3QixXQUFBO1VBQUE2RSxTQUFBO1VBQUFDLE1BQUEsR0FBQXhSLFNBQUE7UUFBQSxPQUFBbkgsbUJBQUEsR0FBQXVCLElBQUEsVUFBQXFYLFVBQUFDLFNBQUE7VUFBQSxrQkFBQUEsU0FBQSxDQUFBaFQsSUFBQSxHQUFBZ1QsU0FBQSxDQUFBM1UsSUFBQTtZQUFBO2NBQUVzVSxVQUFVLEdBQUFHLE1BQUEsQ0FBQTVULE1BQUEsUUFBQTRULE1BQUEsUUFBQXJSLFNBQUEsR0FBQXFSLE1BQUEsTUFBRyxDQUFDO2NBQUEsTUFDM0MsSUFBSSxDQUFDbEwsa0JBQWtCLENBQUM1RSxPQUFPLENBQUMrSSxVQUFVLENBQUMsS0FBSyxDQUFDLENBQUM7Z0JBQUFpSCxTQUFBLENBQUEzVSxJQUFBO2dCQUFBO2NBQUE7Y0FDcEQ0RSxPQUFPLENBQUNPLElBQUksQ0FBQ3VJLFVBQVUsR0FBRyxnRkFBZ0YsQ0FBQztjQUFDLE9BQUFpSCxTQUFBLENBQUE5VSxNQUFBLFdBQ3JHLElBQUk7WUFBQTtjQUdUbUMsTUFBTSxHQUFHLElBQUlvQyxFQUFFLENBQUN5TixpQkFBaUIsQ0FBQyxJQUFJLENBQUN2SixPQUFPLENBQUM7Y0FDL0M2RSxJQUFJLEdBQUcsSUFBSTJFLGlCQUFpQixDQUFDLElBQUksQ0FBQzFKLG9CQUFvQixJQUFJViw4QkFBOEIsQ0FBQztjQUU3RnhDLEtBQUssQ0FBQ3dJLFVBQVUsR0FBRyx1QkFBdUIsQ0FBQztjQUFDaUgsU0FBQSxDQUFBM1UsSUFBQTtjQUFBLE9BQ3RDZ0MsTUFBTSxDQUFDK1AsTUFBTSxDQUFDLGtCQUFrQixFQUFFLElBQUksQ0FBQ3pGLEtBQUssR0FBRzBGLFFBQVEsQ0FBQ3RFLFVBQVUsQ0FBQyxHQUFHLElBQUksQ0FBQ3BCLEtBQUssR0FBR2xKLFNBQVMsQ0FBQztZQUFBO2NBRW5HLElBQUksQ0FBQzRNLFNBQVMsQ0FBQzdDLElBQUksRUFBRW5MLE1BQU0sQ0FBQztjQUU1QmtELEtBQUssQ0FBQ3dJLFVBQVUsR0FBRyx3QkFBd0IsQ0FBQztjQUFDLE1BRXpDLElBQUksQ0FBQ25FLGtCQUFrQixDQUFDNUUsT0FBTyxDQUFDK0ksVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDO2dCQUFBaUgsU0FBQSxDQUFBM1UsSUFBQTtnQkFBQTtjQUFBO2NBQ3BEbU4sSUFBSSxDQUFDQyxLQUFLLENBQUMsQ0FBQztjQUNaeEksT0FBTyxDQUFDTyxJQUFJLENBQUN1SSxVQUFVLEdBQUcsNkRBQTZELENBQUM7Y0FBQyxPQUFBaUgsU0FBQSxDQUFBOVUsTUFBQSxXQUNsRixJQUFJO1lBQUE7Y0FHVDBVLFlBQVksR0FBRyxLQUFLO2NBRWxCL0MsUUFBUSxHQUFHLElBQUlqUSxPQUFPLENBQUMsVUFBQXRDLE9BQU8sRUFBSTtnQkFDdEMsSUFBTTJWLFlBQVksR0FBR0MsV0FBVyxDQUFDLFlBQU07a0JBQ3JDLElBQUlSLE1BQUksQ0FBQzlLLGtCQUFrQixDQUFDNUUsT0FBTyxDQUFDK0ksVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDLEVBQUU7b0JBQ3REb0gsYUFBYSxDQUFDRixZQUFZLENBQUM7b0JBQzNCM1YsT0FBTyxDQUFDLENBQUM7a0JBQ1g7Z0JBQ0YsQ0FBQyxFQUFFLElBQUksQ0FBQztnQkFFUixJQUFNOFYsT0FBTyxHQUFHOU8sVUFBVSxDQUFDLFlBQU07a0JBQy9CNk8sYUFBYSxDQUFDRixZQUFZLENBQUM7a0JBQzNCTCxZQUFZLEdBQUcsSUFBSTtrQkFDbkJ0VixPQUFPLENBQUMsQ0FBQztnQkFDWCxDQUFDLEVBQUV1RyxvQkFBb0IsQ0FBQztnQkFFeEJ4RCxNQUFNLENBQUNpUCxFQUFFLENBQUMsVUFBVSxFQUFFLFlBQU07a0JBQzFCaEUsWUFBWSxDQUFDOEgsT0FBTyxDQUFDO2tCQUNyQkQsYUFBYSxDQUFDRixZQUFZLENBQUM7a0JBQzNCM1YsT0FBTyxDQUFDLENBQUM7Z0JBQ1gsQ0FBQyxDQUFDO2NBQ0osQ0FBQyxDQUFDLEVBRUY7Y0FDQTtjQUFBMFYsU0FBQSxDQUFBM1UsSUFBQTtjQUFBLE9BQ00sSUFBSSxDQUFDK1MsUUFBUSxDQUFDL1EsTUFBTSxFQUFFO2dCQUFFZ1QsS0FBSyxFQUFFdEg7Y0FBVyxDQUFDLENBQUM7WUFBQTtjQUFBLE1BRTlDLElBQUksQ0FBQ25FLGtCQUFrQixDQUFDNUUsT0FBTyxDQUFDK0ksVUFBVSxDQUFDLEtBQUssQ0FBQyxDQUFDO2dCQUFBaUgsU0FBQSxDQUFBM1UsSUFBQTtnQkFBQTtjQUFBO2NBQ3BEbU4sSUFBSSxDQUFDQyxLQUFLLENBQUMsQ0FBQztjQUNaeEksT0FBTyxDQUFDTyxJQUFJLENBQUN1SSxVQUFVLEdBQUcsMkRBQTJELENBQUM7Y0FBQyxPQUFBaUgsU0FBQSxDQUFBOVUsTUFBQSxXQUNoRixJQUFJO1lBQUE7Y0FHYnFGLEtBQUssQ0FBQ3dJLFVBQVUsR0FBRyw0QkFBNEIsQ0FBQztjQUFDaUgsU0FBQSxDQUFBM1UsSUFBQTtjQUFBLE9BQzNDd1IsUUFBUTtZQUFBO2NBQUEsTUFFVixJQUFJLENBQUNqSSxrQkFBa0IsQ0FBQzVFLE9BQU8sQ0FBQytJLFVBQVUsQ0FBQyxLQUFLLENBQUMsQ0FBQztnQkFBQWlILFNBQUEsQ0FBQTNVLElBQUE7Z0JBQUE7Y0FBQTtjQUNwRG1OLElBQUksQ0FBQ0MsS0FBSyxDQUFDLENBQUM7Y0FDWnhJLE9BQU8sQ0FBQ08sSUFBSSxDQUFDdUksVUFBVSxHQUFHLHNFQUFzRSxDQUFDO2NBQUMsT0FBQWlILFNBQUEsQ0FBQTlVLE1BQUEsV0FDM0YsSUFBSTtZQUFBO2NBQUEsS0FHVDBVLFlBQVk7Z0JBQUFJLFNBQUEsQ0FBQTNVLElBQUE7Z0JBQUE7Y0FBQTtjQUNkbU4sSUFBSSxDQUFDQyxLQUFLLENBQUMsQ0FBQztjQUFDLE1BQ1RrSCxVQUFVLEdBQUcsQ0FBQztnQkFBQUssU0FBQSxDQUFBM1UsSUFBQTtnQkFBQTtjQUFBO2NBQ2hCNEUsT0FBTyxDQUFDTyxJQUFJLENBQUN1SSxVQUFVLEdBQUcsaUNBQWlDLENBQUM7Y0FBQyxPQUFBaUgsU0FBQSxDQUFBOVUsTUFBQSxXQUN0RCxJQUFJLENBQUM0UCxnQkFBZ0IsQ0FBQy9CLFVBQVUsRUFBRTRHLFVBQVUsR0FBRyxDQUFDLENBQUM7WUFBQTtjQUV4RDFQLE9BQU8sQ0FBQ08sSUFBSSxDQUFDdUksVUFBVSxHQUFHLHVCQUF1QixDQUFDO2NBQUMsT0FBQWlILFNBQUEsQ0FBQTlVLE1BQUEsV0FDNUMsSUFBSTtZQUFBO2NBQUEsTUFJWHVGLFFBQVEsSUFBSSxDQUFDLElBQUksQ0FBQzZQLDBCQUEwQjtnQkFBQU4sU0FBQSxDQUFBM1UsSUFBQTtnQkFBQTtjQUFBO2NBQUEyVSxTQUFBLENBQUEzVSxJQUFBO2NBQUEsT0FHdkMsSUFBSXVCLE9BQU8sQ0FBQyxVQUFDdEMsT0FBTztnQkFBQSxPQUFLZ0gsVUFBVSxDQUFDaEgsT0FBTyxFQUFFLElBQUksQ0FBQztjQUFBLEVBQUM7WUFBQTtjQUMxRCxJQUFJLENBQUNnVywwQkFBMEIsR0FBRyxJQUFJO1lBQUM7Y0FHckN0RixXQUFXLEdBQUcsSUFBSXVGLFdBQVcsQ0FBQyxDQUFDO2NBQy9CVixTQUFTLEdBQUdySCxJQUFJLENBQUNnSSxZQUFZLENBQUMsQ0FBQztjQUNuQ1gsU0FBUyxDQUFDNVYsT0FBTyxDQUFDLFVBQUF3VyxRQUFRLEVBQUk7Z0JBQzVCLElBQUlBLFFBQVEsQ0FBQy9DLEtBQUssRUFBRTtrQkFDbEIxQyxXQUFXLENBQUMyQyxRQUFRLENBQUM4QyxRQUFRLENBQUMvQyxLQUFLLENBQUM7Z0JBQ3RDO2NBQ0YsQ0FBQyxDQUFDO2NBQ0YsSUFBSTFDLFdBQVcsQ0FBQ3lDLFNBQVMsQ0FBQyxDQUFDLENBQUN2UixNQUFNLEtBQUssQ0FBQyxFQUFFO2dCQUN4QzhPLFdBQVcsR0FBRyxJQUFJO2NBQ3BCO2NBRUF6SyxLQUFLLENBQUN3SSxVQUFVLEdBQUcsb0JBQW9CLENBQUM7Y0FBQyxPQUFBaUgsU0FBQSxDQUFBOVUsTUFBQSxXQUNsQztnQkFDTG1DLE1BQU0sRUFBTkEsTUFBTTtnQkFDTjJOLFdBQVcsRUFBWEEsV0FBVztnQkFDWHhDLElBQUksRUFBSkE7Y0FDRixDQUFDO1lBQUE7WUFBQTtjQUFBLE9BQUF3SCxTQUFBLENBQUE3UyxJQUFBO1VBQUE7UUFBQSxHQUFBc1MsUUFBQTtNQUFBLENBQ0Y7TUFBQSxTQUFBM0UsaUJBQUE0RixHQUFBO1FBQUEsT0FBQWxCLGlCQUFBLENBQUFqUixLQUFBLE9BQUFELFNBQUE7TUFBQTtNQUFBLE9BQUF3TSxnQkFBQTtJQUFBO0VBQUE7SUFBQS9NLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBdVcsU0FBUy9RLE1BQU0sRUFBRXNULFNBQVMsRUFBRTtNQUMxQixPQUFPdFQsTUFBTSxDQUFDdVQsV0FBVyxDQUFDO1FBQ3hCQyxJQUFJLEVBQUUsTUFBTTtRQUNaaEQsT0FBTyxFQUFFLElBQUksQ0FBQ3pLLElBQUk7UUFDbEIwSyxPQUFPLEVBQUUsSUFBSSxDQUFDekssUUFBUTtRQUN0QnNOLFNBQVMsRUFBVEEsU0FBUztRQUNURyxLQUFLLEVBQUUsSUFBSSxDQUFDeE47TUFDZCxDQUFDLENBQUM7SUFDSjtFQUFDO0lBQUF2RixHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQWtaLGFBQUEsRUFBZTtNQUNiLElBQUksSUFBSSxDQUFDQyxNQUFNLEVBQUU7UUFDZixJQUFJLENBQUNDLFFBQVEsQ0FBQyxDQUFDO01BQ2pCLENBQUMsTUFBTTtRQUNMLElBQUksQ0FBQ0MsTUFBTSxDQUFDLENBQUM7TUFDZjtJQUNGO0VBQUM7SUFBQW5ULEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBcVosT0FBQSxFQUFTO01BQ1AsSUFBSSxDQUFDRixNQUFNLEdBQUcsSUFBSTtJQUNwQjtFQUFDO0lBQUFqVCxHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQW9aLFNBQUEsRUFBVztNQUNULElBQUksQ0FBQ0QsTUFBTSxHQUFHLEtBQUs7TUFDbkIsSUFBSSxDQUFDRyxtQkFBbUIsQ0FBQyxDQUFDO0lBQzVCO0VBQUM7SUFBQXBULEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBdVosMEJBQTBCQyxTQUFTLEVBQUV0UixPQUFPLEVBQUU7TUFDNUM7TUFDQTtNQUNBO01BQ0EsS0FBSyxJQUFJakksQ0FBQyxHQUFHLENBQUMsRUFBRXNCLENBQUMsR0FBRzJHLE9BQU8sQ0FBQ2dLLElBQUksQ0FBQ3BRLENBQUMsQ0FBQ3VDLE1BQU0sRUFBRXBFLENBQUMsR0FBR3NCLENBQUMsRUFBRXRCLENBQUMsRUFBRSxFQUFFO1FBQ3JELElBQU1pUyxJQUFJLEdBQUdoSyxPQUFPLENBQUNnSyxJQUFJLENBQUNwUSxDQUFDLENBQUM3QixDQUFDLENBQUM7UUFFOUIsSUFBSWlTLElBQUksQ0FBQ3NILFNBQVMsS0FBS0EsU0FBUyxFQUFFO1VBQ2hDLE9BQU90SCxJQUFJO1FBQ2I7TUFDRjtNQUVBLE9BQU8sSUFBSTtJQUNiO0VBQUM7SUFBQWhNLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBeVosZUFBZUQsU0FBUyxFQUFFdFIsT0FBTyxFQUFFO01BQ2pDLElBQUksQ0FBQ0EsT0FBTyxFQUFFLE9BQU8sSUFBSTtNQUV6QixJQUFJZ0ssSUFBSSxHQUFHaEssT0FBTyxDQUFDd1IsUUFBUSxLQUFLLElBQUksR0FBRyxJQUFJLENBQUNILHlCQUF5QixDQUFDQyxTQUFTLEVBQUV0UixPQUFPLENBQUMsR0FBR0EsT0FBTyxDQUFDZ0ssSUFBSTs7TUFFeEc7TUFDQTtNQUNBO01BQ0EsSUFBSUEsSUFBSSxDQUFDeUgsS0FBSyxJQUFJLENBQUMsSUFBSSxDQUFDbk4sU0FBUyxDQUFDMEYsSUFBSSxDQUFDeUgsS0FBSyxDQUFDLEVBQUUsT0FBTyxJQUFJOztNQUUxRDtNQUNBLElBQUl6SCxJQUFJLENBQUN5SCxLQUFLLElBQUksSUFBSSxDQUFDMU0sY0FBYyxDQUFDcUYsR0FBRyxDQUFDSixJQUFJLENBQUN5SCxLQUFLLENBQUMsRUFBRSxPQUFPLElBQUk7TUFFbEUsT0FBT3pILElBQUk7SUFDYjs7SUFFQTtFQUFBO0lBQUFoTSxHQUFBO0lBQUFsRyxLQUFBLEVBQ0EsU0FBQTRaLDJCQUEyQkosU0FBUyxFQUFFO01BQ3BDLE9BQU8sSUFBSSxDQUFDQyxjQUFjLENBQUNELFNBQVMsRUFBRSxJQUFJLENBQUN0TSxhQUFhLENBQUNvRyxHQUFHLENBQUNrRyxTQUFTLENBQUMsQ0FBQztJQUMxRTtFQUFDO0lBQUF0VCxHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQXNaLG9CQUFBLEVBQXNCO01BQUEsSUFBQU8sU0FBQSxHQUFBQywwQkFBQSxDQUNlLElBQUksQ0FBQzVNLGFBQWE7UUFBQTZNLEtBQUE7TUFBQTtRQUFyRCxLQUFBRixTQUFBLENBQUFwWSxDQUFBLE1BQUFzWSxLQUFBLEdBQUFGLFNBQUEsQ0FBQWphLENBQUEsSUFBQWtELElBQUEsR0FBdUQ7VUFBQSxJQUFBa1gsV0FBQSxHQUFBQyxjQUFBLENBQUFGLEtBQUEsQ0FBQS9aLEtBQUE7WUFBM0N3WixTQUFTLEdBQUFRLFdBQUE7WUFBRTlSLE9BQU8sR0FBQThSLFdBQUE7VUFDNUIsSUFBSTlILElBQUksR0FBRyxJQUFJLENBQUN1SCxjQUFjLENBQUNELFNBQVMsRUFBRXRSLE9BQU8sQ0FBQztVQUNsRCxJQUFJLENBQUNnSyxJQUFJLEVBQUU7O1VBRVg7VUFDQTtVQUNBLElBQU13SCxRQUFRLEdBQUd4UixPQUFPLENBQUN3UixRQUFRLEtBQUssSUFBSSxHQUFHLEdBQUcsR0FBR3hSLE9BQU8sQ0FBQ3dSLFFBQVE7VUFFbkUsSUFBSSxDQUFDckssaUJBQWlCLENBQUMsSUFBSSxFQUFFcUssUUFBUSxFQUFFeEgsSUFBSSxFQUFFaEssT0FBTyxDQUFDZ1MsTUFBTSxDQUFDO1FBQzlEO01BQUMsU0FBQXZULEdBQUE7UUFBQWtULFNBQUEsQ0FBQXRhLENBQUEsQ0FBQW9ILEdBQUE7TUFBQTtRQUFBa1QsU0FBQSxDQUFBclksQ0FBQTtNQUFBO01BQ0QsSUFBSSxDQUFDMEwsYUFBYSxDQUFDM0MsS0FBSyxDQUFDLENBQUM7SUFDNUI7RUFBQztJQUFBckUsR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUFtYSxhQUFhalMsT0FBTyxFQUFFO01BQ3BCLElBQUlBLE9BQU8sQ0FBQ3dSLFFBQVEsS0FBSyxJQUFJLEVBQUU7UUFBRTtRQUMvQixLQUFLLElBQUl6WixDQUFDLEdBQUcsQ0FBQyxFQUFFc0IsQ0FBQyxHQUFHMkcsT0FBTyxDQUFDZ0ssSUFBSSxDQUFDcFEsQ0FBQyxDQUFDdUMsTUFBTSxFQUFFcEUsQ0FBQyxHQUFHc0IsQ0FBQyxFQUFFdEIsQ0FBQyxFQUFFLEVBQUU7VUFDckQsSUFBSSxDQUFDbWEsa0JBQWtCLENBQUNsUyxPQUFPLEVBQUVqSSxDQUFDLENBQUM7UUFDckM7TUFDRixDQUFDLE1BQU07UUFDTCxJQUFJLENBQUNtYSxrQkFBa0IsQ0FBQ2xTLE9BQU8sQ0FBQztNQUNsQztJQUNGO0VBQUM7SUFBQWhDLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBb2EsbUJBQW1CbFMsT0FBTyxFQUFFbVMsS0FBSyxFQUFFO01BQ2pDLElBQU1uSSxJQUFJLEdBQUdtSSxLQUFLLEtBQUt6VCxTQUFTLEdBQUdzQixPQUFPLENBQUNnSyxJQUFJLENBQUNwUSxDQUFDLENBQUN1WSxLQUFLLENBQUMsR0FBR25TLE9BQU8sQ0FBQ2dLLElBQUk7TUFDdkUsSUFBTXdILFFBQVEsR0FBR3hSLE9BQU8sQ0FBQ3dSLFFBQVE7TUFDakMsSUFBTVEsTUFBTSxHQUFHaFMsT0FBTyxDQUFDZ1MsTUFBTTtNQUU3QixJQUFNVixTQUFTLEdBQUd0SCxJQUFJLENBQUNzSCxTQUFTO01BRWhDLElBQUksQ0FBQyxJQUFJLENBQUN0TSxhQUFhLENBQUNvRixHQUFHLENBQUNrSCxTQUFTLENBQUMsRUFBRTtRQUN0QyxJQUFJLENBQUN0TSxhQUFhLENBQUNvTixHQUFHLENBQUNkLFNBQVMsRUFBRXRSLE9BQU8sQ0FBQztNQUM1QyxDQUFDLE1BQU07UUFDTCxJQUFNcVMsYUFBYSxHQUFHLElBQUksQ0FBQ3JOLGFBQWEsQ0FBQ29HLEdBQUcsQ0FBQ2tHLFNBQVMsQ0FBQztRQUN2RCxJQUFNZ0IsVUFBVSxHQUFHRCxhQUFhLENBQUNiLFFBQVEsS0FBSyxJQUFJLEdBQUcsSUFBSSxDQUFDSCx5QkFBeUIsQ0FBQ0MsU0FBUyxFQUFFZSxhQUFhLENBQUMsR0FBR0EsYUFBYSxDQUFDckksSUFBSTs7UUFFbEk7UUFDQSxJQUFNdUksaUJBQWlCLEdBQUd2SSxJQUFJLENBQUN3SSxhQUFhLEdBQUdGLFVBQVUsQ0FBQ0UsYUFBYTtRQUN2RSxJQUFNQyx3QkFBd0IsR0FBR3pJLElBQUksQ0FBQ3dJLGFBQWEsS0FBS0YsVUFBVSxDQUFDRSxhQUFhO1FBQ2hGLElBQUlELGlCQUFpQixJQUFLRSx3QkFBd0IsSUFBSUgsVUFBVSxDQUFDYixLQUFLLEdBQUd6SCxJQUFJLENBQUN5SCxLQUFNLEVBQUU7VUFDcEY7UUFDRjtRQUVBLElBQUlELFFBQVEsS0FBSyxHQUFHLEVBQUU7VUFDcEIsSUFBTWtCLGtCQUFrQixHQUFHSixVQUFVLElBQUlBLFVBQVUsQ0FBQ0ssV0FBVztVQUMvRCxJQUFJRCxrQkFBa0IsRUFBRTtZQUN0QjtZQUNBLElBQUksQ0FBQzFOLGFBQWEsVUFBTyxDQUFDc00sU0FBUyxDQUFDO1VBQ3RDLENBQUMsTUFBTTtZQUNMO1lBQ0EsSUFBSSxDQUFDdE0sYUFBYSxDQUFDb04sR0FBRyxDQUFDZCxTQUFTLEVBQUV0UixPQUFPLENBQUM7VUFDNUM7UUFDRixDQUFDLE1BQU07VUFDTDtVQUNBLElBQUlzUyxVQUFVLENBQUNNLFVBQVUsSUFBSTVJLElBQUksQ0FBQzRJLFVBQVUsRUFBRTtZQUM1Q3BiLE1BQU0sQ0FBQ3dYLE1BQU0sQ0FBQ3NELFVBQVUsQ0FBQ00sVUFBVSxFQUFFNUksSUFBSSxDQUFDNEksVUFBVSxDQUFDO1VBQ3ZEO1FBQ0Y7TUFDRjtJQUNGO0VBQUM7SUFBQTVVLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBME4scUJBQXFCbk8sQ0FBQyxFQUFFMmEsTUFBTSxFQUFFO01BQzlCLElBQUksQ0FBQ3ZNLE1BQU0sQ0FBQ3FFLElBQUksQ0FBQ0MsS0FBSyxDQUFDMVMsQ0FBQyxDQUFDMlMsSUFBSSxDQUFDLEVBQUVnSSxNQUFNLENBQUM7SUFDekM7RUFBQztJQUFBaFUsR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUEyTixPQUFPekYsT0FBTyxFQUFFZ1MsTUFBTSxFQUFFO01BQ3RCLElBQUl4UixLQUFLLENBQUNxUyxPQUFPLEVBQUU7UUFDakJyUyxLQUFLLFdBQUF1SCxNQUFBLENBQVcvSCxPQUFPLENBQUUsQ0FBQztNQUM1QjtNQUVBLElBQUksQ0FBQ0EsT0FBTyxDQUFDd1IsUUFBUSxFQUFFO01BRXZCeFIsT0FBTyxDQUFDZ1MsTUFBTSxHQUFHQSxNQUFNO01BRXZCLElBQUksSUFBSSxDQUFDZixNQUFNLEVBQUU7UUFDZixJQUFJLENBQUNnQixZQUFZLENBQUNqUyxPQUFPLENBQUM7TUFDNUIsQ0FBQyxNQUFNO1FBQ0wsSUFBSSxDQUFDbUgsaUJBQWlCLENBQUMsSUFBSSxFQUFFbkgsT0FBTyxDQUFDd1IsUUFBUSxFQUFFeFIsT0FBTyxDQUFDZ0ssSUFBSSxFQUFFaEssT0FBTyxDQUFDZ1MsTUFBTSxDQUFDO01BQzlFO0lBQ0Y7RUFBQztJQUFBaFUsR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUFnYix3QkFBd0JDLE1BQU0sRUFBRTtNQUM5QixPQUFPLElBQUk7SUFDYjtFQUFDO0lBQUEvVSxHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQWtiLHNCQUFzQkQsTUFBTSxFQUFFLENBQUM7RUFBQztJQUFBL1UsR0FBQTtJQUFBbEcsS0FBQSxFQUVoQyxTQUFBbWIsc0JBQXNCRixNQUFNLEVBQUUsQ0FBQztFQUFDO0lBQUEvVSxHQUFBO0lBQUFsRyxLQUFBLEVBRWhDLFNBQUFvYixpQkFBaUI1UCxRQUFRLEVBQUU7TUFDekIsT0FBTyxJQUFJLENBQUNnQixTQUFTLENBQUNoQixRQUFRLENBQUMsR0FBR25ELEdBQUcsQ0FBQ2dULFFBQVEsQ0FBQ0MsWUFBWSxHQUFHalQsR0FBRyxDQUFDZ1QsUUFBUSxDQUFDRSxhQUFhO0lBQzFGO0VBQUM7SUFBQXJWLEdBQUE7SUFBQWxHLEtBQUE7TUFBQSxJQUFBd2IsaUJBQUEsR0FBQW5WLGlCQUFBLGVBQUEvRyxtQkFBQSxHQUFBb0YsSUFBQSxDQUVELFNBQUErVyxTQUFBO1FBQUEsSUFBQUMsTUFBQTtRQUFBLElBQUFDLGNBQUEsRUFBQUMsR0FBQSxFQUFBQyxTQUFBLEVBQUFDLGtCQUFBLEVBQUFDLGtCQUFBLEVBQUFDLFVBQUEsRUFBQUMsVUFBQTtRQUFBLE9BQUEzYyxtQkFBQSxHQUFBdUIsSUFBQSxVQUFBcWIsVUFBQUMsU0FBQTtVQUFBLGtCQUFBQSxTQUFBLENBQUFoWCxJQUFBLEdBQUFnWCxTQUFBLENBQUEzWSxJQUFBO1lBQUE7Y0FBQSxLQUNNLElBQUksQ0FBQ3VOLGNBQWMsQ0FBQyxDQUFDO2dCQUFBb0wsU0FBQSxDQUFBM1ksSUFBQTtnQkFBQTtjQUFBO2NBQUEsT0FBQTJZLFNBQUEsQ0FBQTlZLE1BQUE7WUFBQTtjQUVuQnNZLGNBQWMsR0FBR1MsSUFBSSxDQUFDQyxHQUFHLENBQUMsQ0FBQztjQUFBRixTQUFBLENBQUEzWSxJQUFBO2NBQUEsT0FFZjhZLEtBQUssQ0FBQzFSLFFBQVEsQ0FBQzJSLFFBQVEsQ0FBQ0MsSUFBSSxFQUFFO2dCQUM5Q3paLE1BQU0sRUFBRSxNQUFNO2dCQUNkMFosS0FBSyxFQUFFO2NBQ1QsQ0FBQyxDQUFDO1lBQUE7Y0FISWIsR0FBRyxHQUFBTyxTQUFBLENBQUFqWixJQUFBO2NBS0gyWSxTQUFTLEdBQUcsSUFBSTtjQUNoQkMsa0JBQWtCLEdBQUcsSUFBSU0sSUFBSSxDQUFDUixHQUFHLENBQUNjLE9BQU8sQ0FBQ3BKLEdBQUcsQ0FBQyxNQUFNLENBQUMsQ0FBQyxDQUFDcUosT0FBTyxDQUFDLENBQUMsR0FBR2QsU0FBUyxHQUFHLENBQUM7Y0FDaEZFLGtCQUFrQixHQUFHSyxJQUFJLENBQUNDLEdBQUcsQ0FBQyxDQUFDO2NBQy9CTCxVQUFVLEdBQUdGLGtCQUFrQixHQUFHLENBQUNDLGtCQUFrQixHQUFHSixjQUFjLElBQUksQ0FBQztjQUMzRU0sVUFBVSxHQUFHRCxVQUFVLEdBQUdELGtCQUFrQjtjQUVsRCxJQUFJLENBQUMzTyxrQkFBa0IsRUFBRTtjQUV6QixJQUFJLElBQUksQ0FBQ0Esa0JBQWtCLElBQUksRUFBRSxFQUFFO2dCQUNqQyxJQUFJLENBQUNELFdBQVcsQ0FBQ25KLElBQUksQ0FBQ2lZLFVBQVUsQ0FBQztjQUNuQyxDQUFDLE1BQU07Z0JBQ0wsSUFBSSxDQUFDOU8sV0FBVyxDQUFDLElBQUksQ0FBQ0Msa0JBQWtCLEdBQUcsRUFBRSxDQUFDLEdBQUc2TyxVQUFVO2NBQzdEO2NBRUEsSUFBSSxDQUFDNU8sYUFBYSxHQUFHLElBQUksQ0FBQ0YsV0FBVyxDQUFDeVAsTUFBTSxDQUFDLFVBQUNDLEdBQUcsRUFBRUMsTUFBTTtnQkFBQSxPQUFNRCxHQUFHLElBQUlDLE1BQU07Y0FBQSxDQUFDLEVBQUUsQ0FBQyxDQUFDLEdBQUcsSUFBSSxDQUFDM1AsV0FBVyxDQUFDOUksTUFBTTtjQUUzRyxJQUFJLElBQUksQ0FBQytJLGtCQUFrQixHQUFHLEVBQUUsRUFBRTtnQkFDaEMxRSxLQUFLLDRCQUFBdUgsTUFBQSxDQUE0QixJQUFJLENBQUM1QyxhQUFhLE9BQUksQ0FBQztnQkFDeEQ1RCxVQUFVLENBQUM7a0JBQUEsT0FBTWlTLE1BQUksQ0FBQ25MLGdCQUFnQixDQUFDLENBQUM7Z0JBQUEsR0FBRSxDQUFDLEdBQUcsRUFBRSxHQUFHLElBQUksQ0FBQyxDQUFDLENBQUM7Y0FDNUQsQ0FBQyxNQUFNO2dCQUNMLElBQUksQ0FBQ0EsZ0JBQWdCLENBQUMsQ0FBQztjQUN6QjtZQUFDO1lBQUE7Y0FBQSxPQUFBNEwsU0FBQSxDQUFBN1csSUFBQTtVQUFBO1FBQUEsR0FBQW1XLFFBQUE7TUFBQSxDQUNGO01BQUEsU0FBQWxMLGlCQUFBO1FBQUEsT0FBQWlMLGlCQUFBLENBQUE5VSxLQUFBLE9BQUFELFNBQUE7TUFBQTtNQUFBLE9BQUE4SixnQkFBQTtJQUFBO0VBQUE7SUFBQXJLLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBK2MsY0FBQSxFQUFnQjtNQUNkLE9BQU9YLElBQUksQ0FBQ0MsR0FBRyxDQUFDLENBQUMsR0FBRyxJQUFJLENBQUNoUCxhQUFhO0lBQ3hDO0VBQUM7SUFBQW5ILEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBZ2QsZUFBZXhSLFFBQVEsRUFBa0I7TUFBQSxJQUFBeVIsT0FBQTtNQUFBLElBQWhCOWIsSUFBSSxHQUFBc0YsU0FBQSxDQUFBcEMsTUFBQSxRQUFBb0MsU0FBQSxRQUFBRyxTQUFBLEdBQUFILFNBQUEsTUFBRyxPQUFPO01BQ3JDLElBQUksSUFBSSxDQUFDZ0csWUFBWSxDQUFDakIsUUFBUSxDQUFDLEVBQUU7UUFDL0I5QyxLQUFLLGdCQUFBdUgsTUFBQSxDQUFnQjlPLElBQUksV0FBQThPLE1BQUEsQ0FBUXpFLFFBQVEsQ0FBRSxDQUFDO1FBQzVDLE9BQU96RyxPQUFPLENBQUN0QyxPQUFPLENBQUMsSUFBSSxDQUFDZ0ssWUFBWSxDQUFDakIsUUFBUSxDQUFDLENBQUNySyxJQUFJLENBQUMsQ0FBQztNQUMzRCxDQUFDLE1BQU07UUFDTHVILEtBQUssZUFBQXVILE1BQUEsQ0FBZTlPLElBQUksV0FBQThPLE1BQUEsQ0FBUXpFLFFBQVEsQ0FBRSxDQUFDO1FBQzNDLElBQUksQ0FBQyxJQUFJLENBQUNtQixvQkFBb0IsQ0FBQzJGLEdBQUcsQ0FBQzlHLFFBQVEsQ0FBQyxFQUFFO1VBQzVDLElBQUksQ0FBQ21CLG9CQUFvQixDQUFDMk4sR0FBRyxDQUFDOU8sUUFBUSxFQUFFLENBQUMsQ0FBQyxDQUFDO1VBRTNDLElBQU0wUixZQUFZLEdBQUcsSUFBSW5ZLE9BQU8sQ0FBQyxVQUFDdEMsT0FBTyxFQUFFc0QsTUFBTSxFQUFLO1lBQ3BEa1gsT0FBSSxDQUFDdFEsb0JBQW9CLENBQUMyRyxHQUFHLENBQUM5SCxRQUFRLENBQUMsQ0FBQytILEtBQUssR0FBRztjQUFFOVEsT0FBTyxFQUFQQSxPQUFPO2NBQUVzRCxNQUFNLEVBQU5BO1lBQU8sQ0FBQztVQUNyRSxDQUFDLENBQUM7VUFDRixJQUFNb1gsWUFBWSxHQUFHLElBQUlwWSxPQUFPLENBQUMsVUFBQ3RDLE9BQU8sRUFBRXNELE1BQU0sRUFBSztZQUNwRGtYLE9BQUksQ0FBQ3RRLG9CQUFvQixDQUFDMkcsR0FBRyxDQUFDOUgsUUFBUSxDQUFDLENBQUNiLEtBQUssR0FBRztjQUFFbEksT0FBTyxFQUFQQSxPQUFPO2NBQUVzRCxNQUFNLEVBQU5BO1lBQU8sQ0FBQztVQUNyRSxDQUFDLENBQUM7VUFFRixJQUFJLENBQUM0RyxvQkFBb0IsQ0FBQzJHLEdBQUcsQ0FBQzlILFFBQVEsQ0FBQyxDQUFDK0gsS0FBSyxDQUFDNkosT0FBTyxHQUFHRixZQUFZO1VBQ3BFLElBQUksQ0FBQ3ZRLG9CQUFvQixDQUFDMkcsR0FBRyxDQUFDOUgsUUFBUSxDQUFDLENBQUNiLEtBQUssQ0FBQ3lTLE9BQU8sR0FBR0QsWUFBWTtVQUVwRUQsWUFBWSxTQUFNLENBQUMsVUFBQTNkLENBQUM7WUFBQSxPQUFJNkksT0FBTyxDQUFDTyxJQUFJLElBQUFzSCxNQUFBLENBQUl6RSxRQUFRLGtDQUErQmpNLENBQUMsQ0FBQztVQUFBLEVBQUM7VUFDbEY0ZCxZQUFZLFNBQU0sQ0FBQyxVQUFBNWQsQ0FBQztZQUFBLE9BQUk2SSxPQUFPLENBQUNPLElBQUksSUFBQXNILE1BQUEsQ0FBSXpFLFFBQVEsa0NBQStCak0sQ0FBQyxDQUFDO1VBQUEsRUFBQztRQUNwRjtRQUNBLE9BQU8sSUFBSSxDQUFDb04sb0JBQW9CLENBQUMyRyxHQUFHLENBQUM5SCxRQUFRLENBQUMsQ0FBQ3JLLElBQUksQ0FBQyxDQUFDaWMsT0FBTztNQUM5RDtJQUNGO0VBQUM7SUFBQWxYLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBa1QsZUFBZTFILFFBQVEsRUFBRTZSLE1BQU0sRUFBRTtNQUMvQjtNQUNBO01BQ0EsSUFBTUMsV0FBVyxHQUFHLElBQUk1RSxXQUFXLENBQUMsQ0FBQztNQUNyQyxJQUFJO1FBQ0oyRSxNQUFNLENBQUNFLGNBQWMsQ0FBQyxDQUFDLENBQUNuYixPQUFPLENBQUMsVUFBQXlULEtBQUs7VUFBQSxPQUFJeUgsV0FBVyxDQUFDeEgsUUFBUSxDQUFDRCxLQUFLLENBQUM7UUFBQSxFQUFDO01BRXJFLENBQUMsQ0FBQyxPQUFNdFcsQ0FBQyxFQUFFO1FBQ1Q2SSxPQUFPLENBQUNPLElBQUksSUFBQXNILE1BQUEsQ0FBSXpFLFFBQVEsa0NBQStCak0sQ0FBQyxDQUFDO01BQzNEO01BQ0EsSUFBTWllLFdBQVcsR0FBRyxJQUFJOUUsV0FBVyxDQUFDLENBQUM7TUFDckMsSUFBSTtRQUNKMkUsTUFBTSxDQUFDSSxjQUFjLENBQUMsQ0FBQyxDQUFDcmIsT0FBTyxDQUFDLFVBQUF5VCxLQUFLO1VBQUEsT0FBSTJILFdBQVcsQ0FBQzFILFFBQVEsQ0FBQ0QsS0FBSyxDQUFDO1FBQUEsRUFBQztNQUVyRSxDQUFDLENBQUMsT0FBT3RXLENBQUMsRUFBRTtRQUNWNkksT0FBTyxDQUFDTyxJQUFJLElBQUFzSCxNQUFBLENBQUl6RSxRQUFRLGtDQUErQmpNLENBQUMsQ0FBQztNQUMzRDtNQUVBLElBQUksQ0FBQ2tOLFlBQVksQ0FBQ2pCLFFBQVEsQ0FBQyxHQUFHO1FBQUUrSCxLQUFLLEVBQUUrSixXQUFXO1FBQUUzUyxLQUFLLEVBQUU2UztNQUFZLENBQUM7O01BRXhFO01BQ0EsSUFBSSxJQUFJLENBQUM3USxvQkFBb0IsQ0FBQzJGLEdBQUcsQ0FBQzlHLFFBQVEsQ0FBQyxFQUFFO1FBQzNDLElBQUksQ0FBQ21CLG9CQUFvQixDQUFDMkcsR0FBRyxDQUFDOUgsUUFBUSxDQUFDLENBQUMrSCxLQUFLLENBQUM5USxPQUFPLENBQUM2YSxXQUFXLENBQUM7UUFDbEUsSUFBSSxDQUFDM1Esb0JBQW9CLENBQUMyRyxHQUFHLENBQUM5SCxRQUFRLENBQUMsQ0FBQ2IsS0FBSyxDQUFDbEksT0FBTyxDQUFDK2EsV0FBVyxDQUFDO01BQ3BFO0lBQ0Y7RUFBQztJQUFBdFgsR0FBQTtJQUFBbEcsS0FBQTtNQUFBLElBQUEwZCxvQkFBQSxHQUFBclgsaUJBQUEsZUFBQS9HLG1CQUFBLEdBQUFvRixJQUFBLENBRUQsU0FBQWlaLFNBQTBCTixNQUFNO1FBQUEsSUFBQU8sT0FBQTtRQUFBLElBQUFDLGVBQUEsRUFBQUMsVUFBQSxFQUFBQyxNQUFBLEVBQUFDLEtBQUEsRUFBQS9kLENBQUE7UUFBQSxPQUFBWCxtQkFBQSxHQUFBdUIsSUFBQSxVQUFBb2QsVUFBQUMsU0FBQTtVQUFBLGtCQUFBQSxTQUFBLENBQUEvWSxJQUFBLEdBQUErWSxTQUFBLENBQUExYSxJQUFBO1lBQUE7Y0FBQSxNQVExQixJQUFJLENBQUM4SSxTQUFTLElBQUksSUFBSSxDQUFDQSxTQUFTLENBQUNxRSxJQUFJO2dCQUFBdU4sU0FBQSxDQUFBMWEsSUFBQTtnQkFBQTtjQUFBO2NBQ2pDcWEsZUFBZSxHQUFHLElBQUksQ0FBQ3ZSLFNBQVMsQ0FBQ3FFLElBQUksQ0FBQ3dOLFVBQVUsQ0FBQyxDQUFDO2NBQ2xETCxVQUFVLEdBQUcsRUFBRTtjQUNmQyxNQUFNLEdBQUdWLE1BQU0sQ0FBQ3pILFNBQVMsQ0FBQyxDQUFDO2NBQUFvSSxLQUFBLGdCQUFBMWUsbUJBQUEsR0FBQW9GLElBQUEsVUFBQXNaLE1BQUE7Z0JBQUEsSUFBQXhlLENBQUEsRUFBQTRlLE1BQUE7Z0JBQUEsT0FBQTllLG1CQUFBLEdBQUF1QixJQUFBLFVBQUF3ZCxPQUFBQyxTQUFBO2tCQUFBLGtCQUFBQSxTQUFBLENBQUFuWixJQUFBLEdBQUFtWixTQUFBLENBQUE5YSxJQUFBO29CQUFBO3NCQUd6QmhFLENBQUMsR0FBR3VlLE1BQU0sQ0FBQzlkLENBQUMsQ0FBQztzQkFDYm1lLE1BQU0sR0FBR1AsZUFBZSxDQUFDVSxJQUFJLENBQUMsVUFBQTljLENBQUM7d0JBQUEsT0FBSUEsQ0FBQyxDQUFDb1UsS0FBSyxJQUFJLElBQUksSUFBSXBVLENBQUMsQ0FBQ29VLEtBQUssQ0FBQ21ELElBQUksSUFBSXhaLENBQUMsQ0FBQ3daLElBQUk7c0JBQUEsRUFBQztzQkFBQSxNQUUvRW9GLE1BQU0sSUFBSSxJQUFJO3dCQUFBRSxTQUFBLENBQUE5YSxJQUFBO3dCQUFBO3NCQUFBO3NCQUFBLEtBQ1o0YSxNQUFNLENBQUNJLFlBQVk7d0JBQUFGLFNBQUEsQ0FBQTlhLElBQUE7d0JBQUE7c0JBQUE7c0JBQUE4YSxTQUFBLENBQUE5YSxJQUFBO3NCQUFBLE9BQ2Y0YSxNQUFNLENBQUNJLFlBQVksQ0FBQ2hmLENBQUMsQ0FBQztvQkFBQTtzQkFFNUI7c0JBQ0EsSUFBSUEsQ0FBQyxDQUFDd1osSUFBSSxLQUFLLE9BQU8sSUFBSXhaLENBQUMsQ0FBQ3ViLE9BQU8sSUFBSWpTLFNBQVMsQ0FBQ0MsU0FBUyxDQUFDMFYsV0FBVyxDQUFDLENBQUMsQ0FBQ3RXLE9BQU8sQ0FBQyxTQUFTLENBQUMsR0FBRyxDQUFDLENBQUMsRUFBRTt3QkFDaEczSSxDQUFDLENBQUN1YixPQUFPLEdBQUcsS0FBSzt3QkFDakJ0UixVQUFVLENBQUM7MEJBQUEsT0FBTWpLLENBQUMsQ0FBQ3ViLE9BQU8sR0FBRyxJQUFJO3dCQUFBLEdBQUUsSUFBSSxDQUFDO3NCQUMxQztzQkFBQ3VELFNBQUEsQ0FBQTlhLElBQUE7c0JBQUE7b0JBQUE7c0JBRUQ7c0JBQ0E7c0JBQ0E7c0JBQ0E2WixNQUFNLENBQUNxQixXQUFXLENBQUNOLE1BQU0sQ0FBQ3ZJLEtBQUssQ0FBQztzQkFDaEN3SCxNQUFNLENBQUN2SCxRQUFRLENBQUN0VyxDQUFDLENBQUM7b0JBQUM7c0JBRXJCc2UsVUFBVSxDQUFDOVosSUFBSSxDQUFDb2EsTUFBTSxDQUFDO3NCQUFDRSxTQUFBLENBQUE5YSxJQUFBO3NCQUFBO29CQUFBO3NCQUV4QnNhLFVBQVUsQ0FBQzlaLElBQUksQ0FBQzRaLE9BQUksQ0FBQ3RSLFNBQVMsQ0FBQ3FFLElBQUksQ0FBQ21GLFFBQVEsQ0FBQ3RXLENBQUMsRUFBRTZkLE1BQU0sQ0FBQyxDQUFDO29CQUFDO29CQUFBO3NCQUFBLE9BQUFpQixTQUFBLENBQUFoWixJQUFBO2tCQUFBO2dCQUFBLEdBQUEwWSxLQUFBO2NBQUE7Y0F0QnBEL2QsQ0FBQyxHQUFHLENBQUM7WUFBQTtjQUFBLE1BQUVBLENBQUMsR0FBRzhkLE1BQU0sQ0FBQzFaLE1BQU07Z0JBQUE2WixTQUFBLENBQUExYSxJQUFBO2dCQUFBO2NBQUE7Y0FBQSxPQUFBMGEsU0FBQSxDQUFBdFksYUFBQSxDQUFBb1ksS0FBQTtZQUFBO2NBQUUvZCxDQUFDLEVBQUU7Y0FBQWllLFNBQUEsQ0FBQTFhLElBQUE7Y0FBQTtZQUFBO2NBeUJ0Q3FhLGVBQWUsQ0FBQ3piLE9BQU8sQ0FBQyxVQUFBWCxDQUFDLEVBQUk7Z0JBQzNCLElBQUksQ0FBQ3FjLFVBQVUsQ0FBQ2xILFFBQVEsQ0FBQ25WLENBQUMsQ0FBQyxFQUFFO2tCQUMzQkEsQ0FBQyxDQUFDb1UsS0FBSyxDQUFDa0YsT0FBTyxHQUFHLEtBQUs7Z0JBQ3pCO2NBQ0YsQ0FBQyxDQUFDO1lBQUM7Y0FFTCxJQUFJLENBQUNyTyxnQkFBZ0IsR0FBRzJRLE1BQU07Y0FDOUIsSUFBSSxDQUFDbkssY0FBYyxDQUFDLElBQUksQ0FBQzFILFFBQVEsRUFBRTZSLE1BQU0sQ0FBQztZQUFDO1lBQUE7Y0FBQSxPQUFBYSxTQUFBLENBQUE1WSxJQUFBO1VBQUE7UUFBQSxHQUFBcVksUUFBQTtNQUFBLENBQzVDO01BQUEsU0FBQWdCLG9CQUFBQyxHQUFBO1FBQUEsT0FBQWxCLG9CQUFBLENBQUFoWCxLQUFBLE9BQUFELFNBQUE7TUFBQTtNQUFBLE9BQUFrWSxtQkFBQTtJQUFBO0VBQUE7SUFBQXpZLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBNmUsaUJBQWlCOUQsT0FBTyxFQUFFO01BQ3hCLElBQUksSUFBSSxDQUFDek8sU0FBUyxJQUFJLElBQUksQ0FBQ0EsU0FBUyxDQUFDcUUsSUFBSSxFQUFFO1FBQ3pDLElBQUksQ0FBQ3JFLFNBQVMsQ0FBQ3FFLElBQUksQ0FBQ3dOLFVBQVUsQ0FBQyxDQUFDLENBQUMvYixPQUFPLENBQUMsVUFBQVgsQ0FBQyxFQUFJO1VBQzVDLElBQUlBLENBQUMsQ0FBQ29VLEtBQUssQ0FBQ21ELElBQUksSUFBSSxPQUFPLEVBQUU7WUFDM0J2WCxDQUFDLENBQUNvVSxLQUFLLENBQUNrRixPQUFPLEdBQUdBLE9BQU87VUFDM0I7UUFDRixDQUFDLENBQUM7TUFDSjtJQUNGO0VBQUM7SUFBQTdVLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBOGUsU0FBU3RULFFBQVEsRUFBRWtPLFFBQVEsRUFBRXhILElBQUksRUFBRTtNQUNqQyxJQUFJLENBQUMsSUFBSSxDQUFDNUYsU0FBUyxFQUFFO1FBQ25CbEUsT0FBTyxDQUFDTyxJQUFJLENBQUMscUNBQXFDLENBQUM7TUFDckQsQ0FBQyxNQUFNO1FBQ0wsUUFBUSxJQUFJLENBQUNxRCxtQkFBbUI7VUFDOUIsS0FBSyxXQUFXO1lBQ2QsSUFBSSxDQUFDTSxTQUFTLENBQUM5RyxNQUFNLENBQUN1VCxXQUFXLENBQUM7Y0FBRUMsSUFBSSxFQUFFLE1BQU07Y0FBRTlDLElBQUksRUFBRWxFLElBQUksQ0FBQytNLFNBQVMsQ0FBQztnQkFBRXJGLFFBQVEsRUFBUkEsUUFBUTtnQkFBRXhILElBQUksRUFBSkE7Y0FBSyxDQUFDLENBQUM7Y0FBRThNLElBQUksRUFBRXhUO1lBQVMsQ0FBQyxDQUFDO1lBQzdHO1VBQ0YsS0FBSyxhQUFhO1lBQ2hCLElBQUksQ0FBQ2MsU0FBUyxDQUFDNEksaUJBQWlCLENBQUNsTixJQUFJLENBQUNnSyxJQUFJLENBQUMrTSxTQUFTLENBQUM7Y0FBRXZULFFBQVEsRUFBUkEsUUFBUTtjQUFFa08sUUFBUSxFQUFSQSxRQUFRO2NBQUV4SCxJQUFJLEVBQUpBO1lBQUssQ0FBQyxDQUFDLENBQUM7WUFDbkY7VUFDRjtZQUNFLElBQUksQ0FBQ2xHLG1CQUFtQixDQUFDUixRQUFRLEVBQUVrTyxRQUFRLEVBQUV4SCxJQUFJLENBQUM7WUFDbEQ7UUFDSjtNQUNGO0lBQ0Y7RUFBQztJQUFBaE0sR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUFpZixtQkFBbUJ6VCxRQUFRLEVBQUVrTyxRQUFRLEVBQUV4SCxJQUFJLEVBQUU7TUFDM0MsSUFBSSxDQUFDLElBQUksQ0FBQzVGLFNBQVMsRUFBRTtRQUNuQmxFLE9BQU8sQ0FBQ08sSUFBSSxDQUFDLCtDQUErQyxDQUFDO01BQy9ELENBQUMsTUFBTTtRQUNMLFFBQVEsSUFBSSxDQUFDb0QsaUJBQWlCO1VBQzVCLEtBQUssV0FBVztZQUNkLElBQUksQ0FBQ08sU0FBUyxDQUFDOUcsTUFBTSxDQUFDdVQsV0FBVyxDQUFDO2NBQUVDLElBQUksRUFBRSxNQUFNO2NBQUU5QyxJQUFJLEVBQUVsRSxJQUFJLENBQUMrTSxTQUFTLENBQUM7Z0JBQUVyRixRQUFRLEVBQVJBLFFBQVE7Z0JBQUV4SCxJQUFJLEVBQUpBO2NBQUssQ0FBQyxDQUFDO2NBQUU4TSxJQUFJLEVBQUV4VDtZQUFTLENBQUMsQ0FBQztZQUM3RztVQUNGLEtBQUssYUFBYTtZQUNoQixJQUFJLENBQUNjLFNBQVMsQ0FBQzJJLGVBQWUsQ0FBQ2pOLElBQUksQ0FBQ2dLLElBQUksQ0FBQytNLFNBQVMsQ0FBQztjQUFFdlQsUUFBUSxFQUFSQSxRQUFRO2NBQUVrTyxRQUFRLEVBQVJBLFFBQVE7Y0FBRXhILElBQUksRUFBSkE7WUFBSyxDQUFDLENBQUMsQ0FBQztZQUNqRjtVQUNGO1lBQ0UsSUFBSSxDQUFDbkcsaUJBQWlCLENBQUNQLFFBQVEsRUFBRWtPLFFBQVEsRUFBRXhILElBQUksQ0FBQztZQUNoRDtRQUNKO01BQ0Y7SUFDRjtFQUFDO0lBQUFoTSxHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQWtmLGNBQWN4RixRQUFRLEVBQUV4SCxJQUFJLEVBQUU7TUFDNUIsSUFBSSxDQUFDLElBQUksQ0FBQzVGLFNBQVMsRUFBRTtRQUNuQmxFLE9BQU8sQ0FBQ08sSUFBSSxDQUFDLDBDQUEwQyxDQUFDO01BQzFELENBQUMsTUFBTTtRQUNMLFFBQVEsSUFBSSxDQUFDcUQsbUJBQW1CO1VBQzlCLEtBQUssV0FBVztZQUNkLElBQUksQ0FBQ00sU0FBUyxDQUFDOUcsTUFBTSxDQUFDdVQsV0FBVyxDQUFDO2NBQUVDLElBQUksRUFBRSxNQUFNO2NBQUU5QyxJQUFJLEVBQUVsRSxJQUFJLENBQUMrTSxTQUFTLENBQUM7Z0JBQUVyRixRQUFRLEVBQVJBLFFBQVE7Z0JBQUV4SCxJQUFJLEVBQUpBO2NBQUssQ0FBQztZQUFFLENBQUMsQ0FBQztZQUM3RjtVQUNGLEtBQUssYUFBYTtZQUNoQixJQUFJLENBQUM1RixTQUFTLENBQUM0SSxpQkFBaUIsQ0FBQ2xOLElBQUksQ0FBQ2dLLElBQUksQ0FBQytNLFNBQVMsQ0FBQztjQUFFckYsUUFBUSxFQUFSQSxRQUFRO2NBQUV4SCxJQUFJLEVBQUpBO1lBQUssQ0FBQyxDQUFDLENBQUM7WUFDekU7VUFDRjtZQUNFLElBQUksQ0FBQ2xHLG1CQUFtQixDQUFDcEYsU0FBUyxFQUFFOFMsUUFBUSxFQUFFeEgsSUFBSSxDQUFDO1lBQ25EO1FBQ0o7TUFDRjtJQUNGO0VBQUM7SUFBQWhNLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBbWYsd0JBQXdCekYsUUFBUSxFQUFFeEgsSUFBSSxFQUFFO01BQ3RDLElBQUksQ0FBQyxJQUFJLENBQUM1RixTQUFTLEVBQUU7UUFDbkJsRSxPQUFPLENBQUNPLElBQUksQ0FBQyxvREFBb0QsQ0FBQztNQUNwRSxDQUFDLE1BQU07UUFDTCxRQUFRLElBQUksQ0FBQ29ELGlCQUFpQjtVQUM1QixLQUFLLFdBQVc7WUFDZCxJQUFJLENBQUNPLFNBQVMsQ0FBQzlHLE1BQU0sQ0FBQ3VULFdBQVcsQ0FBQztjQUFFQyxJQUFJLEVBQUUsTUFBTTtjQUFFOUMsSUFBSSxFQUFFbEUsSUFBSSxDQUFDK00sU0FBUyxDQUFDO2dCQUFFckYsUUFBUSxFQUFSQSxRQUFRO2dCQUFFeEgsSUFBSSxFQUFKQTtjQUFLLENBQUM7WUFBRSxDQUFDLENBQUM7WUFDN0Y7VUFDRixLQUFLLGFBQWE7WUFDaEIsSUFBSSxDQUFDNUYsU0FBUyxDQUFDMkksZUFBZSxDQUFDak4sSUFBSSxDQUFDZ0ssSUFBSSxDQUFDK00sU0FBUyxDQUFDO2NBQUVyRixRQUFRLEVBQVJBLFFBQVE7Y0FBRXhILElBQUksRUFBSkE7WUFBSyxDQUFDLENBQUMsQ0FBQztZQUN2RTtVQUNGO1lBQ0UsSUFBSSxDQUFDbkcsaUJBQWlCLENBQUNuRixTQUFTLEVBQUU4UyxRQUFRLEVBQUV4SCxJQUFJLENBQUM7WUFDakQ7UUFDSjtNQUNGO0lBQ0Y7RUFBQztJQUFBaE0sR0FBQTtJQUFBbEcsS0FBQSxFQUVELFNBQUFvZixLQUFLNVQsUUFBUSxFQUFFNlQsVUFBVSxFQUFFO01BQ3pCLE9BQU8sSUFBSSxDQUFDL1MsU0FBUyxDQUFDOUcsTUFBTSxDQUFDdVQsV0FBVyxDQUFDO1FBQUVDLElBQUksRUFBRSxNQUFNO1FBQUVoRCxPQUFPLEVBQUUsSUFBSSxDQUFDekssSUFBSTtRQUFFMEssT0FBTyxFQUFFekssUUFBUTtRQUFFeU4sS0FBSyxFQUFFb0c7TUFBVyxDQUFDLENBQUMsQ0FBQzFjLElBQUksQ0FBQyxZQUFNO1FBQzlIaUksUUFBUSxDQUFDc0wsSUFBSSxDQUFDQyxhQUFhLENBQUMsSUFBSUMsV0FBVyxDQUFDLFFBQVEsRUFBRTtVQUFFQyxNQUFNLEVBQUU7WUFBRTdLLFFBQVEsRUFBRUE7VUFBUztRQUFFLENBQUMsQ0FBQyxDQUFDO01BQzVGLENBQUMsQ0FBQztJQUNKO0VBQUM7SUFBQXRGLEdBQUE7SUFBQWxHLEtBQUEsRUFFRCxTQUFBc2YsTUFBTTlULFFBQVEsRUFBRTtNQUFBLElBQUErVCxPQUFBO01BQ2QsT0FBTyxJQUFJLENBQUNqVCxTQUFTLENBQUM5RyxNQUFNLENBQUN1VCxXQUFXLENBQUM7UUFBRUMsSUFBSSxFQUFFLE9BQU87UUFBRWdHLElBQUksRUFBRXhUO01BQVMsQ0FBQyxDQUFDLENBQUM3SSxJQUFJLENBQUMsWUFBTTtRQUNyRjRjLE9BQUksQ0FBQ3RTLGNBQWMsQ0FBQ3FOLEdBQUcsQ0FBQzlPLFFBQVEsRUFBRSxJQUFJLENBQUM7UUFDdkNaLFFBQVEsQ0FBQ3NMLElBQUksQ0FBQ0MsYUFBYSxDQUFDLElBQUlDLFdBQVcsQ0FBQyxTQUFTLEVBQUU7VUFBRUMsTUFBTSxFQUFFO1lBQUU3SyxRQUFRLEVBQUVBO1VBQVM7UUFBRSxDQUFDLENBQUMsQ0FBQztNQUM3RixDQUFDLENBQUM7SUFDSjtFQUFDO0lBQUF0RixHQUFBO0lBQUFsRyxLQUFBLEVBRUQsU0FBQXdmLFFBQVFoVSxRQUFRLEVBQUU7TUFBQSxJQUFBaVUsT0FBQTtNQUNoQixPQUFPLElBQUksQ0FBQ25ULFNBQVMsQ0FBQzlHLE1BQU0sQ0FBQ3VULFdBQVcsQ0FBQztRQUFFQyxJQUFJLEVBQUUsU0FBUztRQUFFZ0csSUFBSSxFQUFFeFQ7TUFBUyxDQUFDLENBQUMsQ0FBQzdJLElBQUksQ0FBQyxZQUFNO1FBQ3ZGOGMsT0FBSSxDQUFDeFMsY0FBYyxVQUFPLENBQUN6QixRQUFRLENBQUM7UUFDcENaLFFBQVEsQ0FBQ3NMLElBQUksQ0FBQ0MsYUFBYSxDQUFDLElBQUlDLFdBQVcsQ0FBQyxXQUFXLEVBQUU7VUFBRUMsTUFBTSxFQUFFO1lBQUU3SyxRQUFRLEVBQUVBO1VBQVM7UUFBRSxDQUFDLENBQUMsQ0FBQztNQUMvRixDQUFDLENBQUM7SUFDSjtFQUFDO0VBQUEsT0FBQUYsWUFBQTtBQUFBO0FBR0hqRCxHQUFHLENBQUNnVCxRQUFRLENBQUNxRSxRQUFRLENBQUMsT0FBTyxFQUFFcFUsWUFBWSxDQUFDO0FBRTVDcVUsTUFBTSxDQUFDQyxPQUFPLEdBQUd0VSxZQUFZOzs7Ozs7Ozs7O0FDaG5DN0I7O0FBRUE7QUFDQTtBQUNBOztBQUVBLGtCQUFrQjtBQUNsQixZQUFZO0FBQ1osWUFBWTtBQUNaLGlCQUFpQjtBQUNqQixlQUFlO0FBQ2YsZUFBZTtBQUNmOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLENBQUM7O0FBRUQ7QUFDQTtBQUNBOztBQUVBLGNBQWM7QUFDZDtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEVBQUU7O0FBRUY7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsV0FBVyw0Q0FBNEM7O0FBRXZEO0FBQ0E7QUFDQTtBQUNBLFdBQVcsUUFBUTtBQUNuQjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFJO0FBQ0o7QUFDQTtBQUNBLEdBQUc7QUFDSDtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQSxZQUFZLFFBQVE7QUFDcEI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsR0FBRztBQUNIO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsWUFBWTtBQUNaO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEdBQUc7QUFDSDtBQUNBO0FBQ0E7QUFDQTs7QUFFQSxpQkFBaUIsbUJBQU8sQ0FBQyxvREFBVTs7QUFFbkMsT0FBTyxZQUFZOztBQUVuQjtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0EsR0FBRztBQUNIO0FBQ0E7QUFDQTs7Ozs7Ozs7Ozs7O0FDM1FBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0Esd0JBQXdCLG1CQUFPLENBQUMsc0NBQUk7QUFDcEM7O0FBRUE7QUFDQTtBQUNBLEVBQUU7O0FBRUY7QUFDQTtBQUNBOztBQUVBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQSxXQUFXLFFBQVE7QUFDbkIsWUFBWSxlQUFlO0FBQzNCO0FBQ0E7QUFDQTtBQUNBOztBQUVBLGtCQUFrQixzQkFBc0I7QUFDeEM7QUFDQSxjQUFjO0FBQ2Q7O0FBRUE7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBLFdBQVcsUUFBUTtBQUNuQixZQUFZO0FBQ1o7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUk7O0FBRUo7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQSx1Q0FBdUM7O0FBRXZDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQSxJQUFJO0FBQ0o7QUFDQTtBQUNBO0FBQ0EsR0FBRzs7QUFFSDtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQSxXQUFXLFFBQVE7QUFDbkI7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTs7QUFFQSxjQUFjLFNBQVM7QUFDdkI7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7O0FBRUE7QUFDQTtBQUNBLEtBQUs7QUFDTDtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQSxZQUFZLFFBQVE7QUFDcEI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0EsV0FBVyxRQUFRO0FBQ25CLFlBQVk7QUFDWjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTs7QUFFQSw4Q0FBOEMsU0FBUztBQUN2RDtBQUNBO0FBQ0E7QUFDQTs7QUFFQSw4Q0FBOEMsU0FBUztBQUN2RDtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBLFdBQVcsUUFBUTtBQUNuQixZQUFZLFFBQVE7QUFDcEI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0EsV0FBVyxPQUFPO0FBQ2xCLFlBQVk7QUFDWjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBOztBQUVBO0FBQ0E7O0FBRUE7Ozs7Ozs7Ozs7O0FDalJBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxXQUFXLGVBQWU7QUFDMUIsV0FBVyxRQUFRO0FBQ25CLFlBQVksT0FBTztBQUNuQixZQUFZO0FBQ1o7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBSTtBQUNKO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBLFdBQVcsUUFBUTtBQUNuQixZQUFZO0FBQ1o7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBLFdBQVcsUUFBUTtBQUNuQixZQUFZO0FBQ1o7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQSxXQUFXLFFBQVE7QUFDbkIsWUFBWTtBQUNaO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7Ozs7Ozs7QUNqS0E7QUFDYTs7QUFFYjtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFJO0FBQ0o7QUFDQTs7QUFFQTtBQUNBO0FBQ0EsZ0JBQWdCLG9CQUFvQjtBQUNwQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBLGtCQUFrQixrQkFBa0I7QUFDcEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLHdDQUF3QztBQUN4QztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0EsSUFBSTtBQUNKO0FBQ0EsSUFBSTtBQUNKO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTs7QUFFQTtBQUNBLDZDQUE2QztBQUM3QztBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQSxvQkFBb0I7QUFDcEIsMkJBQTJCO0FBQzNCO0FBQ0E7QUFDQTtBQUNBLDhEQUE4RDtBQUM5RCxrQkFBa0Isa0JBQWtCO0FBQ3BDO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsUUFBUTtBQUNSO0FBQ0E7QUFDQSxLQUFLO0FBQ0wsaURBQWlEO0FBQ2pEO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxLQUFLO0FBQ0w7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxJQUFJO0FBQ0o7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEdBQUc7QUFDSDtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLGtCQUFrQixrQkFBa0IsT0FBTztBQUMzQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsR0FBRztBQUNIO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsT0FBTztBQUNQO0FBQ0E7QUFDQTtBQUNBLEtBQUs7QUFDTCxHQUFHO0FBQ0g7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQSw2Q0FBNkM7QUFDN0M7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsR0FBRzs7QUFFSDtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSxHQUFHO0FBQ0g7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEdBQUc7QUFDSDtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0EsS0FBSztBQUNMO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEtBQUs7QUFDTDtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSx3QkFBd0I7QUFDeEI7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLEdBQUc7QUFDSDtBQUNBO0FBQ0E7QUFDQSxLQUFLO0FBQ0w7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLE1BQU07QUFDTjtBQUNBO0FBQ0E7QUFDQSxNQUFNO0FBQ047QUFDQTtBQUNBO0FBQ0E7QUFDQSxLQUFLO0FBQ0w7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7OztBQUdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsWUFBWTtBQUNaO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLFlBQVk7QUFDWjtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLElBQUk7QUFDSjtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EsSUFBSTtBQUNKO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0Esa0JBQWtCLGtCQUFrQjtBQUNwQztBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUFFQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBLGtCQUFrQixrQkFBa0I7QUFDcEM7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FBRUE7QUFDQSxJQUFJLElBQTBCO0FBQzlCO0FBQ0E7Ozs7Ozs7VUNqeUJBO1VBQ0E7O1VBRUE7VUFDQTtVQUNBO1VBQ0E7VUFDQTtVQUNBO1VBQ0E7VUFDQTtVQUNBO1VBQ0E7VUFDQTtVQUNBO1VBQ0E7O1VBRUE7VUFDQTs7VUFFQTtVQUNBO1VBQ0E7Ozs7VUV0QkE7VUFDQTtVQUNBO1VBQ0EiLCJzb3VyY2VzIjpbIndlYnBhY2s6Ly9AbmV0d29ya2VkLWFmcmFtZS9uYWYtamFudXMtYWRhcHRlci8uL25vZGVfbW9kdWxlcy9AbmV0d29ya2VkLWFmcmFtZS9taW5pamFudXMvbWluaWphbnVzLmpzIiwid2VicGFjazovL0BuZXR3b3JrZWQtYWZyYW1lL25hZi1qYW51cy1hZGFwdGVyLy4vc3JjL2luZGV4LmpzIiwid2VicGFjazovL0BuZXR3b3JrZWQtYWZyYW1lL25hZi1qYW51cy1hZGFwdGVyLy4vbm9kZV9tb2R1bGVzL2RlYnVnL3NyYy9icm93c2VyLmpzIiwid2VicGFjazovL0BuZXR3b3JrZWQtYWZyYW1lL25hZi1qYW51cy1hZGFwdGVyLy4vbm9kZV9tb2R1bGVzL2RlYnVnL3NyYy9jb21tb24uanMiLCJ3ZWJwYWNrOi8vQG5ldHdvcmtlZC1hZnJhbWUvbmFmLWphbnVzLWFkYXB0ZXIvLi9ub2RlX21vZHVsZXMvbXMvaW5kZXguanMiLCJ3ZWJwYWNrOi8vQG5ldHdvcmtlZC1hZnJhbWUvbmFmLWphbnVzLWFkYXB0ZXIvLi9ub2RlX21vZHVsZXMvc2RwL3NkcC5qcyIsIndlYnBhY2s6Ly9AbmV0d29ya2VkLWFmcmFtZS9uYWYtamFudXMtYWRhcHRlci93ZWJwYWNrL2Jvb3RzdHJhcCIsIndlYnBhY2s6Ly9AbmV0d29ya2VkLWFmcmFtZS9uYWYtamFudXMtYWRhcHRlci93ZWJwYWNrL2JlZm9yZS1zdGFydHVwIiwid2VicGFjazovL0BuZXR3b3JrZWQtYWZyYW1lL25hZi1qYW51cy1hZGFwdGVyL3dlYnBhY2svc3RhcnR1cCIsIndlYnBhY2s6Ly9AbmV0d29ya2VkLWFmcmFtZS9uYWYtamFudXMtYWRhcHRlci93ZWJwYWNrL2FmdGVyLXN0YXJ0dXAiXSwic291cmNlc0NvbnRlbnQiOlsiLyoqXG4gKiBSZXByZXNlbnRzIGEgaGFuZGxlIHRvIGEgc2luZ2xlIEphbnVzIHBsdWdpbiBvbiBhIEphbnVzIHNlc3Npb24uIEVhY2ggV2ViUlRDIGNvbm5lY3Rpb24gdG8gdGhlIEphbnVzIHNlcnZlciB3aWxsIGJlXG4gKiBhc3NvY2lhdGVkIHdpdGggYSBzaW5nbGUgaGFuZGxlLiBPbmNlIGF0dGFjaGVkIHRvIHRoZSBzZXJ2ZXIsIHRoaXMgaGFuZGxlIHdpbGwgYmUgZ2l2ZW4gYSB1bmlxdWUgSUQgd2hpY2ggc2hvdWxkIGJlXG4gKiB1c2VkIHRvIGFzc29jaWF0ZSBpdCB3aXRoIGZ1dHVyZSBzaWduYWxsaW5nIG1lc3NhZ2VzLlxuICpcbiAqIFNlZSBodHRwczovL2phbnVzLmNvbmYubWVldGVjaG8uY29tL2RvY3MvcmVzdC5odG1sI2hhbmRsZXMuXG4gKiovXG5mdW5jdGlvbiBKYW51c1BsdWdpbkhhbmRsZShzZXNzaW9uKSB7XG4gIHRoaXMuc2Vzc2lvbiA9IHNlc3Npb247XG4gIHRoaXMuaWQgPSB1bmRlZmluZWQ7XG59XG5cbi8qKiBBdHRhY2hlcyB0aGlzIGhhbmRsZSB0byB0aGUgSmFudXMgc2VydmVyIGFuZCBzZXRzIGl0cyBJRC4gKiovXG5KYW51c1BsdWdpbkhhbmRsZS5wcm90b3R5cGUuYXR0YWNoID0gZnVuY3Rpb24ocGx1Z2luLCBsb29wX2luZGV4KSB7XG4gIHZhciBwYXlsb2FkID0geyBwbHVnaW46IHBsdWdpbiwgbG9vcF9pbmRleDogbG9vcF9pbmRleCwgXCJmb3JjZS1idW5kbGVcIjogdHJ1ZSwgXCJmb3JjZS1ydGNwLW11eFwiOiB0cnVlIH07XG4gIHJldHVybiB0aGlzLnNlc3Npb24uc2VuZChcImF0dGFjaFwiLCBwYXlsb2FkKS50aGVuKHJlc3AgPT4ge1xuICAgIHRoaXMuaWQgPSByZXNwLmRhdGEuaWQ7XG4gICAgcmV0dXJuIHJlc3A7XG4gIH0pO1xufTtcblxuLyoqIERldGFjaGVzIHRoaXMgaGFuZGxlLiAqKi9cbkphbnVzUGx1Z2luSGFuZGxlLnByb3RvdHlwZS5kZXRhY2ggPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuc2VuZChcImRldGFjaFwiKTtcbn07XG5cbi8qKiBSZWdpc3RlcnMgYSBjYWxsYmFjayB0byBiZSBmaXJlZCB1cG9uIHRoZSByZWNlcHRpb24gb2YgYW55IGluY29taW5nIEphbnVzIHNpZ25hbHMgZm9yIHRoaXMgcGx1Z2luIGhhbmRsZSB3aXRoIHRoZVxuICogYGphbnVzYCBhdHRyaWJ1dGUgZXF1YWwgdG8gYGV2YC5cbiAqKi9cbkphbnVzUGx1Z2luSGFuZGxlLnByb3RvdHlwZS5vbiA9IGZ1bmN0aW9uKGV2LCBjYWxsYmFjaykge1xuICByZXR1cm4gdGhpcy5zZXNzaW9uLm9uKGV2LCBzaWduYWwgPT4ge1xuICAgIGlmIChzaWduYWwuc2VuZGVyID09IHRoaXMuaWQpIHtcbiAgICAgIGNhbGxiYWNrKHNpZ25hbCk7XG4gICAgfVxuICB9KTtcbn07XG5cbi8qKlxuICogU2VuZHMgYSBzaWduYWwgYXNzb2NpYXRlZCB3aXRoIHRoaXMgaGFuZGxlLiBTaWduYWxzIHNob3VsZCBiZSBKU09OLXNlcmlhbGl6YWJsZSBvYmplY3RzLiBSZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHdpbGxcbiAqIGJlIHJlc29sdmVkIG9yIHJlamVjdGVkIHdoZW4gYSByZXNwb25zZSB0byB0aGlzIHNpZ25hbCBpcyByZWNlaXZlZCwgb3Igd2hlbiBubyByZXNwb25zZSBpcyByZWNlaXZlZCB3aXRoaW4gdGhlXG4gKiBzZXNzaW9uIHRpbWVvdXQuXG4gKiovXG5KYW51c1BsdWdpbkhhbmRsZS5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uKHR5cGUsIHNpZ25hbCkge1xuICByZXR1cm4gdGhpcy5zZXNzaW9uLnNlbmQodHlwZSwgT2JqZWN0LmFzc2lnbih7IGhhbmRsZV9pZDogdGhpcy5pZCB9LCBzaWduYWwpKTtcbn07XG5cbi8qKiBTZW5kcyBhIHBsdWdpbi1zcGVjaWZpYyBtZXNzYWdlIGFzc29jaWF0ZWQgd2l0aCB0aGlzIGhhbmRsZS4gKiovXG5KYW51c1BsdWdpbkhhbmRsZS5wcm90b3R5cGUuc2VuZE1lc3NhZ2UgPSBmdW5jdGlvbihib2R5KSB7XG4gIHJldHVybiB0aGlzLnNlbmQoXCJtZXNzYWdlXCIsIHsgYm9keTogYm9keSB9KTtcbn07XG5cbi8qKiBTZW5kcyBhIEpTRVAgb2ZmZXIgb3IgYW5zd2VyIGFzc29jaWF0ZWQgd2l0aCB0aGlzIGhhbmRsZS4gKiovXG5KYW51c1BsdWdpbkhhbmRsZS5wcm90b3R5cGUuc2VuZEpzZXAgPSBmdW5jdGlvbihqc2VwKSB7XG4gIHJldHVybiB0aGlzLnNlbmQoXCJtZXNzYWdlXCIsIHsgYm9keToge30sIGpzZXA6IGpzZXAgfSk7XG59O1xuXG4vKiogU2VuZHMgYW4gSUNFIHRyaWNrbGUgY2FuZGlkYXRlIGFzc29jaWF0ZWQgd2l0aCB0aGlzIGhhbmRsZS4gKiovXG5KYW51c1BsdWdpbkhhbmRsZS5wcm90b3R5cGUuc2VuZFRyaWNrbGUgPSBmdW5jdGlvbihjYW5kaWRhdGUpIHtcbiAgcmV0dXJuIHRoaXMuc2VuZChcInRyaWNrbGVcIiwgeyBjYW5kaWRhdGU6IGNhbmRpZGF0ZSB9KTtcbn07XG5cbi8qKlxuICogUmVwcmVzZW50cyBhIEphbnVzIHNlc3Npb24gLS0gYSBKYW51cyBjb250ZXh0IGZyb20gd2l0aGluIHdoaWNoIHlvdSBjYW4gb3BlbiBtdWx0aXBsZSBoYW5kbGVzIGFuZCBjb25uZWN0aW9ucy4gT25jZVxuICogY3JlYXRlZCwgdGhpcyBzZXNzaW9uIHdpbGwgYmUgZ2l2ZW4gYSB1bmlxdWUgSUQgd2hpY2ggc2hvdWxkIGJlIHVzZWQgdG8gYXNzb2NpYXRlIGl0IHdpdGggZnV0dXJlIHNpZ25hbGxpbmcgbWVzc2FnZXMuXG4gKlxuICogU2VlIGh0dHBzOi8vamFudXMuY29uZi5tZWV0ZWNoby5jb20vZG9jcy9yZXN0Lmh0bWwjc2Vzc2lvbnMuXG4gKiovXG5mdW5jdGlvbiBKYW51c1Nlc3Npb24ob3V0cHV0LCBvcHRpb25zKSB7XG4gIHRoaXMub3V0cHV0ID0gb3V0cHV0O1xuICB0aGlzLmlkID0gdW5kZWZpbmVkO1xuICB0aGlzLm5leHRUeElkID0gMDtcbiAgdGhpcy50eG5zID0ge307XG4gIHRoaXMuZXZlbnRIYW5kbGVycyA9IHt9O1xuICB0aGlzLm9wdGlvbnMgPSBPYmplY3QuYXNzaWduKHtcbiAgICB2ZXJib3NlOiBmYWxzZSxcbiAgICB0aW1lb3V0TXM6IDEwMDAwLFxuICAgIGtlZXBhbGl2ZU1zOiAzMDAwMFxuICB9LCBvcHRpb25zKTtcbn1cblxuLyoqIENyZWF0ZXMgdGhpcyBzZXNzaW9uIG9uIHRoZSBKYW51cyBzZXJ2ZXIgYW5kIHNldHMgaXRzIElELiAqKi9cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuY3JlYXRlID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLnNlbmQoXCJjcmVhdGVcIikudGhlbihyZXNwID0+IHtcbiAgICB0aGlzLmlkID0gcmVzcC5kYXRhLmlkO1xuICAgIHJldHVybiByZXNwO1xuICB9KTtcbn07XG5cbi8qKlxuICogRGVzdHJveXMgdGhpcyBzZXNzaW9uLiBOb3RlIHRoYXQgdXBvbiBkZXN0cnVjdGlvbiwgSmFudXMgd2lsbCBhbHNvIGNsb3NlIHRoZSBzaWduYWxsaW5nIHRyYW5zcG9ydCAoaWYgYXBwbGljYWJsZSkgYW5kXG4gKiBhbnkgb3BlbiBXZWJSVEMgY29ubmVjdGlvbnMuXG4gKiovXG5KYW51c1Nlc3Npb24ucHJvdG90eXBlLmRlc3Ryb3kgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIHRoaXMuc2VuZChcImRlc3Ryb3lcIikudGhlbigocmVzcCkgPT4ge1xuICAgIHRoaXMuZGlzcG9zZSgpO1xuICAgIHJldHVybiByZXNwO1xuICB9KTtcbn07XG5cbi8qKlxuICogRGlzcG9zZXMgb2YgdGhpcyBzZXNzaW9uIGluIGEgd2F5IHN1Y2ggdGhhdCBubyBmdXJ0aGVyIGluY29taW5nIHNpZ25hbGxpbmcgbWVzc2FnZXMgd2lsbCBiZSBwcm9jZXNzZWQuXG4gKiBPdXRzdGFuZGluZyB0cmFuc2FjdGlvbnMgd2lsbCBiZSByZWplY3RlZC5cbiAqKi9cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuZGlzcG9zZSA9IGZ1bmN0aW9uKCkge1xuICB0aGlzLl9raWxsS2VlcGFsaXZlKCk7XG4gIHRoaXMuZXZlbnRIYW5kbGVycyA9IHt9O1xuICBmb3IgKHZhciB0eElkIGluIHRoaXMudHhucykge1xuICAgIGlmICh0aGlzLnR4bnMuaGFzT3duUHJvcGVydHkodHhJZCkpIHtcbiAgICAgIHZhciB0eG4gPSB0aGlzLnR4bnNbdHhJZF07XG4gICAgICBjbGVhclRpbWVvdXQodHhuLnRpbWVvdXQpO1xuICAgICAgdHhuLnJlamVjdChuZXcgRXJyb3IoXCJKYW51cyBzZXNzaW9uIHdhcyBkaXNwb3NlZC5cIikpO1xuICAgICAgZGVsZXRlIHRoaXMudHhuc1t0eElkXTtcbiAgICB9XG4gIH1cbn07XG5cbi8qKlxuICogV2hldGhlciB0aGlzIHNpZ25hbCByZXByZXNlbnRzIGFuIGVycm9yLCBhbmQgdGhlIGFzc29jaWF0ZWQgcHJvbWlzZSAoaWYgYW55KSBzaG91bGQgYmUgcmVqZWN0ZWQuXG4gKiBVc2VycyBzaG91bGQgb3ZlcnJpZGUgdGhpcyB0byBoYW5kbGUgYW55IGN1c3RvbSBwbHVnaW4tc3BlY2lmaWMgZXJyb3IgY29udmVudGlvbnMuXG4gKiovXG5KYW51c1Nlc3Npb24ucHJvdG90eXBlLmlzRXJyb3IgPSBmdW5jdGlvbihzaWduYWwpIHtcbiAgcmV0dXJuIHNpZ25hbC5qYW51cyA9PT0gXCJlcnJvclwiO1xufTtcblxuLyoqIFJlZ2lzdGVycyBhIGNhbGxiYWNrIHRvIGJlIGZpcmVkIHVwb24gdGhlIHJlY2VwdGlvbiBvZiBhbnkgaW5jb21pbmcgSmFudXMgc2lnbmFscyBmb3IgdGhpcyBzZXNzaW9uIHdpdGggdGhlXG4gKiBgamFudXNgIGF0dHJpYnV0ZSBlcXVhbCB0byBgZXZgLlxuICoqL1xuSmFudXNTZXNzaW9uLnByb3RvdHlwZS5vbiA9IGZ1bmN0aW9uKGV2LCBjYWxsYmFjaykge1xuICB2YXIgaGFuZGxlcnMgPSB0aGlzLmV2ZW50SGFuZGxlcnNbZXZdO1xuICBpZiAoaGFuZGxlcnMgPT0gbnVsbCkge1xuICAgIGhhbmRsZXJzID0gdGhpcy5ldmVudEhhbmRsZXJzW2V2XSA9IFtdO1xuICB9XG4gIGhhbmRsZXJzLnB1c2goY2FsbGJhY2spO1xufTtcblxuLyoqXG4gKiBDYWxsYmFjayBmb3IgcmVjZWl2aW5nIEpTT04gc2lnbmFsbGluZyBtZXNzYWdlcyBwZXJ0aW5lbnQgdG8gdGhpcyBzZXNzaW9uLiBJZiB0aGUgc2lnbmFscyBhcmUgcmVzcG9uc2VzIHRvIHByZXZpb3VzbHlcbiAqIHNlbnQgc2lnbmFscywgdGhlIHByb21pc2VzIGZvciB0aGUgb3V0Z29pbmcgc2lnbmFscyB3aWxsIGJlIHJlc29sdmVkIG9yIHJlamVjdGVkIGFwcHJvcHJpYXRlbHkgd2l0aCB0aGlzIHNpZ25hbCBhcyBhblxuICogYXJndW1lbnQuXG4gKlxuICogRXh0ZXJuYWwgY2FsbGVycyBzaG91bGQgY2FsbCB0aGlzIGZ1bmN0aW9uIGV2ZXJ5IHRpbWUgYSBuZXcgc2lnbmFsIGFycml2ZXMgb24gdGhlIHRyYW5zcG9ydDsgZm9yIGV4YW1wbGUsIGluIGFcbiAqIFdlYlNvY2tldCdzIGBtZXNzYWdlYCBldmVudCwgb3Igd2hlbiBhIG5ldyBkYXR1bSBzaG93cyB1cCBpbiBhbiBIVFRQIGxvbmctcG9sbGluZyByZXNwb25zZS5cbiAqKi9cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUucmVjZWl2ZSA9IGZ1bmN0aW9uKHNpZ25hbCkge1xuICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2UpIHtcbiAgICB0aGlzLl9sb2dJbmNvbWluZyhzaWduYWwpO1xuICB9XG4gIGlmIChzaWduYWwuc2Vzc2lvbl9pZCAhPSB0aGlzLmlkKSB7XG4gICAgY29uc29sZS53YXJuKFwiSW5jb3JyZWN0IHNlc3Npb24gSUQgcmVjZWl2ZWQgaW4gSmFudXMgc2lnbmFsbGluZyBtZXNzYWdlOiB3YXMgXCIgKyBzaWduYWwuc2Vzc2lvbl9pZCArIFwiLCBleHBlY3RlZCBcIiArIHRoaXMuaWQgKyBcIi5cIik7XG4gIH1cblxuICB2YXIgcmVzcG9uc2VUeXBlID0gc2lnbmFsLmphbnVzO1xuICB2YXIgaGFuZGxlcnMgPSB0aGlzLmV2ZW50SGFuZGxlcnNbcmVzcG9uc2VUeXBlXTtcbiAgaWYgKGhhbmRsZXJzICE9IG51bGwpIHtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGhhbmRsZXJzLmxlbmd0aDsgaSsrKSB7XG4gICAgICBoYW5kbGVyc1tpXShzaWduYWwpO1xuICAgIH1cbiAgfVxuXG4gIGlmIChzaWduYWwudHJhbnNhY3Rpb24gIT0gbnVsbCkge1xuICAgIHZhciB0eG4gPSB0aGlzLnR4bnNbc2lnbmFsLnRyYW5zYWN0aW9uXTtcbiAgICBpZiAodHhuID09IG51bGwpIHtcbiAgICAgIC8vIHRoaXMgaXMgYSByZXNwb25zZSB0byBhIHRyYW5zYWN0aW9uIHRoYXQgd2Fzbid0IGNhdXNlZCB2aWEgSmFudXNTZXNzaW9uLnNlbmQsIG9yIGEgcGx1Z2luIHJlcGxpZWQgdHdpY2UgdG8gYVxuICAgICAgLy8gc2luZ2xlIHJlcXVlc3QsIG9yIHRoZSBzZXNzaW9uIHdhcyBkaXNwb3NlZCwgb3Igc29tZXRoaW5nIGVsc2UgdGhhdCBpc24ndCB1bmRlciBvdXIgcHVydmlldzsgdGhhdCdzIGZpbmVcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBpZiAocmVzcG9uc2VUeXBlID09PSBcImFja1wiICYmIHR4bi50eXBlID09IFwibWVzc2FnZVwiKSB7XG4gICAgICAvLyB0aGlzIGlzIGFuIGFjayBvZiBhbiBhc3luY2hyb25vdXNseS1wcm9jZXNzZWQgcGx1Z2luIHJlcXVlc3QsIHdlIHNob3VsZCB3YWl0IHRvIHJlc29sdmUgdGhlIHByb21pc2UgdW50aWwgdGhlXG4gICAgICAvLyBhY3R1YWwgcmVzcG9uc2UgY29tZXMgaW5cbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICBjbGVhclRpbWVvdXQodHhuLnRpbWVvdXQpO1xuXG4gICAgZGVsZXRlIHRoaXMudHhuc1tzaWduYWwudHJhbnNhY3Rpb25dO1xuICAgICh0aGlzLmlzRXJyb3Ioc2lnbmFsKSA/IHR4bi5yZWplY3QgOiB0eG4ucmVzb2x2ZSkoc2lnbmFsKTtcbiAgfVxufTtcblxuLyoqXG4gKiBTZW5kcyBhIHNpZ25hbCBhc3NvY2lhdGVkIHdpdGggdGhpcyBzZXNzaW9uLCBiZWdpbm5pbmcgYSBuZXcgdHJhbnNhY3Rpb24uIFJldHVybnMgYSBwcm9taXNlIHRoYXQgd2lsbCBiZSByZXNvbHZlZCBvclxuICogcmVqZWN0ZWQgd2hlbiBhIHJlc3BvbnNlIGlzIHJlY2VpdmVkIGluIHRoZSBzYW1lIHRyYW5zYWN0aW9uLCBvciB3aGVuIG5vIHJlc3BvbnNlIGlzIHJlY2VpdmVkIHdpdGhpbiB0aGUgc2Vzc2lvblxuICogdGltZW91dC5cbiAqKi9cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uKHR5cGUsIHNpZ25hbCkge1xuICBzaWduYWwgPSBPYmplY3QuYXNzaWduKHsgdHJhbnNhY3Rpb246ICh0aGlzLm5leHRUeElkKyspLnRvU3RyaW5nKCkgfSwgc2lnbmFsKTtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICB2YXIgdGltZW91dCA9IG51bGw7XG4gICAgaWYgKHRoaXMub3B0aW9ucy50aW1lb3V0TXMpIHtcbiAgICAgIHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgZGVsZXRlIHRoaXMudHhuc1tzaWduYWwudHJhbnNhY3Rpb25dO1xuICAgICAgICByZWplY3QobmV3IEVycm9yKFwiU2lnbmFsbGluZyB0cmFuc2FjdGlvbiB3aXRoIHR4aWQgXCIgKyBzaWduYWwudHJhbnNhY3Rpb24gKyBcIiB0aW1lZCBvdXQuXCIpKTtcbiAgICAgIH0sIHRoaXMub3B0aW9ucy50aW1lb3V0TXMpO1xuICAgIH1cbiAgICB0aGlzLnR4bnNbc2lnbmFsLnRyYW5zYWN0aW9uXSA9IHsgcmVzb2x2ZTogcmVzb2x2ZSwgcmVqZWN0OiByZWplY3QsIHRpbWVvdXQ6IHRpbWVvdXQsIHR5cGU6IHR5cGUgfTtcbiAgICB0aGlzLl90cmFuc21pdCh0eXBlLCBzaWduYWwpO1xuICB9KTtcbn07XG5cbkphbnVzU2Vzc2lvbi5wcm90b3R5cGUuX3RyYW5zbWl0ID0gZnVuY3Rpb24odHlwZSwgc2lnbmFsKSB7XG4gIHNpZ25hbCA9IE9iamVjdC5hc3NpZ24oeyBqYW51czogdHlwZSB9LCBzaWduYWwpO1xuXG4gIGlmICh0aGlzLmlkICE9IG51bGwpIHsgLy8gdGhpcy5pZCBpcyB1bmRlZmluZWQgaW4gdGhlIHNwZWNpYWwgY2FzZSB3aGVuIHdlJ3JlIHNlbmRpbmcgdGhlIHNlc3Npb24gY3JlYXRlIG1lc3NhZ2VcbiAgICBzaWduYWwgPSBPYmplY3QuYXNzaWduKHsgc2Vzc2lvbl9pZDogdGhpcy5pZCB9LCBzaWduYWwpO1xuICB9XG5cbiAgaWYgKHRoaXMub3B0aW9ucy52ZXJib3NlKSB7XG4gICAgdGhpcy5fbG9nT3V0Z29pbmcoc2lnbmFsKTtcbiAgfVxuXG4gIHRoaXMub3V0cHV0KEpTT04uc3RyaW5naWZ5KHNpZ25hbCkpO1xuICB0aGlzLl9yZXNldEtlZXBhbGl2ZSgpO1xufTtcblxuSmFudXNTZXNzaW9uLnByb3RvdHlwZS5fbG9nT3V0Z29pbmcgPSBmdW5jdGlvbihzaWduYWwpIHtcbiAgdmFyIGtpbmQgPSBzaWduYWwuamFudXM7XG4gIGlmIChraW5kID09PSBcIm1lc3NhZ2VcIiAmJiBzaWduYWwuanNlcCkge1xuICAgIGtpbmQgPSBzaWduYWwuanNlcC50eXBlO1xuICB9XG4gIHZhciBtZXNzYWdlID0gXCI+IE91dGdvaW5nIEphbnVzIFwiICsgKGtpbmQgfHwgXCJzaWduYWxcIikgKyBcIiAoI1wiICsgc2lnbmFsLnRyYW5zYWN0aW9uICsgXCIpOiBcIjtcbiAgY29uc29sZS5kZWJ1ZyhcIiVjXCIgKyBtZXNzYWdlLCBcImNvbG9yOiAjMDQwXCIsIHNpZ25hbCk7XG59O1xuXG5KYW51c1Nlc3Npb24ucHJvdG90eXBlLl9sb2dJbmNvbWluZyA9IGZ1bmN0aW9uKHNpZ25hbCkge1xuICB2YXIga2luZCA9IHNpZ25hbC5qYW51cztcbiAgdmFyIG1lc3NhZ2UgPSBzaWduYWwudHJhbnNhY3Rpb24gP1xuICAgICAgXCI8IEluY29taW5nIEphbnVzIFwiICsgKGtpbmQgfHwgXCJzaWduYWxcIikgKyBcIiAoI1wiICsgc2lnbmFsLnRyYW5zYWN0aW9uICsgXCIpOiBcIiA6XG4gICAgICBcIjwgSW5jb21pbmcgSmFudXMgXCIgKyAoa2luZCB8fCBcInNpZ25hbFwiKSArIFwiOiBcIjtcbiAgY29uc29sZS5kZWJ1ZyhcIiVjXCIgKyBtZXNzYWdlLCBcImNvbG9yOiAjMDA0XCIsIHNpZ25hbCk7XG59O1xuXG5KYW51c1Nlc3Npb24ucHJvdG90eXBlLl9zZW5kS2VlcGFsaXZlID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiB0aGlzLnNlbmQoXCJrZWVwYWxpdmVcIik7XG59O1xuXG5KYW51c1Nlc3Npb24ucHJvdG90eXBlLl9raWxsS2VlcGFsaXZlID0gZnVuY3Rpb24oKSB7XG4gIGNsZWFyVGltZW91dCh0aGlzLmtlZXBhbGl2ZVRpbWVvdXQpO1xufTtcblxuSmFudXNTZXNzaW9uLnByb3RvdHlwZS5fcmVzZXRLZWVwYWxpdmUgPSBmdW5jdGlvbigpIHtcbiAgdGhpcy5fa2lsbEtlZXBhbGl2ZSgpO1xuICBpZiAodGhpcy5vcHRpb25zLmtlZXBhbGl2ZU1zKSB7XG4gICAgdGhpcy5rZWVwYWxpdmVUaW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLl9zZW5kS2VlcGFsaXZlKCkuY2F0Y2goZSA9PiBjb25zb2xlLmVycm9yKFwiRXJyb3IgcmVjZWl2ZWQgZnJvbSBrZWVwYWxpdmU6IFwiLCBlKSk7XG4gICAgfSwgdGhpcy5vcHRpb25zLmtlZXBhbGl2ZU1zKTtcbiAgfVxufTtcblxubW9kdWxlLmV4cG9ydHMgPSB7XG4gIEphbnVzUGx1Z2luSGFuZGxlLFxuICBKYW51c1Nlc3Npb25cbn07XG4iLCIvKiBnbG9iYWwgTkFGICovXG52YXIgbWogPSByZXF1aXJlKFwiQG5ldHdvcmtlZC1hZnJhbWUvbWluaWphbnVzXCIpO1xubWouSmFudXNTZXNzaW9uLnByb3RvdHlwZS5zZW5kT3JpZ2luYWwgPSBtai5KYW51c1Nlc3Npb24ucHJvdG90eXBlLnNlbmQ7XG5tai5KYW51c1Nlc3Npb24ucHJvdG90eXBlLnNlbmQgPSBmdW5jdGlvbih0eXBlLCBzaWduYWwpIHtcbiAgcmV0dXJuIHRoaXMuc2VuZE9yaWdpbmFsKHR5cGUsIHNpZ25hbCkuY2F0Y2goKGUpID0+IHtcbiAgICBpZiAoZS5tZXNzYWdlICYmIGUubWVzc2FnZS5pbmRleE9mKFwidGltZWQgb3V0XCIpID4gLTEpIHtcbiAgICAgIGNvbnNvbGUuZXJyb3IoXCJ3ZWIgc29ja2V0IHRpbWVkIG91dFwiKTtcbiAgICAgIE5BRi5jb25uZWN0aW9uLmFkYXB0ZXIucmVjb25uZWN0KCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIHRocm93KGUpO1xuICAgIH1cbiAgfSk7XG59XG5cbnZhciBzZHBVdGlscyA9IHJlcXVpcmUoXCJzZHBcIik7XG52YXIgZGVidWcgPSByZXF1aXJlKFwiZGVidWdcIikoXCJuYWYtamFudXMtYWRhcHRlcjpkZWJ1Z1wiKTtcbnZhciB3YXJuID0gcmVxdWlyZShcImRlYnVnXCIpKFwibmFmLWphbnVzLWFkYXB0ZXI6d2FyblwiKTtcbnZhciBlcnJvciA9IHJlcXVpcmUoXCJkZWJ1Z1wiKShcIm5hZi1qYW51cy1hZGFwdGVyOmVycm9yXCIpO1xudmFyIGlzU2FmYXJpID0gL14oKD8hY2hyb21lfGFuZHJvaWQpLikqc2FmYXJpL2kudGVzdChuYXZpZ2F0b3IudXNlckFnZW50KTtcblxuY29uc3QgU1VCU0NSSUJFX1RJTUVPVVRfTVMgPSAxNTAwMDtcblxuY29uc3QgQVZBSUxBQkxFX09DQ1VQQU5UU19USFJFU0hPTEQgPSA1O1xuY29uc3QgTUFYX1NVQlNDUklCRV9ERUxBWSA9IDUwMDA7XG5cbmZ1bmN0aW9uIHJhbmRvbURlbGF5KG1pbiwgbWF4KSB7XG4gIHJldHVybiBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICBjb25zdCBkZWxheSA9IE1hdGgucmFuZG9tKCkgKiAobWF4IC0gbWluKSArIG1pbjtcbiAgICBzZXRUaW1lb3V0KHJlc29sdmUsIGRlbGF5KTtcbiAgfSk7XG59XG5cbmZ1bmN0aW9uIGRlYm91bmNlKGZuKSB7XG4gIHZhciBjdXJyID0gUHJvbWlzZS5yZXNvbHZlKCk7XG4gIHJldHVybiBmdW5jdGlvbigpIHtcbiAgICB2YXIgYXJncyA9IEFycmF5LnByb3RvdHlwZS5zbGljZS5jYWxsKGFyZ3VtZW50cyk7XG4gICAgY3VyciA9IGN1cnIudGhlbihfID0+IGZuLmFwcGx5KHRoaXMsIGFyZ3MpKTtcbiAgfTtcbn1cblxuZnVuY3Rpb24gcmFuZG9tVWludCgpIHtcbiAgcmV0dXJuIE1hdGguZmxvb3IoTWF0aC5yYW5kb20oKSAqIE51bWJlci5NQVhfU0FGRV9JTlRFR0VSKTtcbn1cblxuZnVuY3Rpb24gdW50aWxEYXRhQ2hhbm5lbE9wZW4oZGF0YUNoYW5uZWwpIHtcbiAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICBpZiAoZGF0YUNoYW5uZWwucmVhZHlTdGF0ZSA9PT0gXCJvcGVuXCIpIHtcbiAgICAgIHJlc29sdmUoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgbGV0IHJlc29sdmVyLCByZWplY3RvcjtcblxuICAgICAgY29uc3QgY2xlYXIgPSAoKSA9PiB7XG4gICAgICAgIGRhdGFDaGFubmVsLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJvcGVuXCIsIHJlc29sdmVyKTtcbiAgICAgICAgZGF0YUNoYW5uZWwucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIHJlamVjdG9yKTtcbiAgICAgIH07XG5cbiAgICAgIHJlc29sdmVyID0gKCkgPT4ge1xuICAgICAgICBjbGVhcigpO1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9O1xuICAgICAgcmVqZWN0b3IgPSAoKSA9PiB7XG4gICAgICAgIGNsZWFyKCk7XG4gICAgICAgIHJlamVjdCgpO1xuICAgICAgfTtcblxuICAgICAgZGF0YUNoYW5uZWwuYWRkRXZlbnRMaXN0ZW5lcihcIm9wZW5cIiwgcmVzb2x2ZXIpO1xuICAgICAgZGF0YUNoYW5uZWwuYWRkRXZlbnRMaXN0ZW5lcihcImVycm9yXCIsIHJlamVjdG9yKTtcbiAgICB9XG4gIH0pO1xufVxuXG5jb25zdCBpc0gyNjRWaWRlb1N1cHBvcnRlZCA9ICgoKSA9PiB7XG4gIGNvbnN0IHZpZGVvID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcInZpZGVvXCIpO1xuICByZXR1cm4gdmlkZW8uY2FuUGxheVR5cGUoJ3ZpZGVvL21wNDsgY29kZWNzPVwiYXZjMS40MkUwMUUsIG1wNGEuNDAuMlwiJykgIT09IFwiXCI7XG59KSgpO1xuXG5jb25zdCBPUFVTX1BBUkFNRVRFUlMgPSB7XG4gIC8vIGluZGljYXRlcyB0aGF0IHdlIHdhbnQgdG8gZW5hYmxlIERUWCB0byBlbGlkZSBzaWxlbmNlIHBhY2tldHNcbiAgdXNlZHR4OiAxLFxuICAvLyBpbmRpY2F0ZXMgdGhhdCB3ZSBwcmVmZXIgdG8gcmVjZWl2ZSBtb25vIGF1ZGlvIChpbXBvcnRhbnQgZm9yIHZvaXAgcHJvZmlsZSlcbiAgc3RlcmVvOiAwLFxuICAvLyBpbmRpY2F0ZXMgdGhhdCB3ZSBwcmVmZXIgdG8gc2VuZCBtb25vIGF1ZGlvIChpbXBvcnRhbnQgZm9yIHZvaXAgcHJvZmlsZSlcbiAgXCJzcHJvcC1zdGVyZW9cIjogMFxufTtcblxuY29uc3QgREVGQVVMVF9QRUVSX0NPTk5FQ1RJT05fQ09ORklHID0ge1xuICBpY2VTZXJ2ZXJzOiBbeyB1cmxzOiBcInN0dW46c3R1bjEubC5nb29nbGUuY29tOjE5MzAyXCIgfSwgeyB1cmxzOiBcInN0dW46c3R1bjIubC5nb29nbGUuY29tOjE5MzAyXCIgfV1cbn07XG5cbmNvbnN0IFdTX05PUk1BTF9DTE9TVVJFID0gMTAwMDtcblxuY2xhc3MgSmFudXNBZGFwdGVyIHtcbiAgY29uc3RydWN0b3IoKSB7XG4gICAgdGhpcy5yb29tID0gbnVsbDtcbiAgICAvLyBXZSBleHBlY3QgdGhlIGNvbnN1bWVyIHRvIHNldCBhIGNsaWVudCBpZCBiZWZvcmUgY29ubmVjdGluZy5cbiAgICB0aGlzLmNsaWVudElkID0gbnVsbDtcbiAgICB0aGlzLmpvaW5Ub2tlbiA9IG51bGw7XG5cbiAgICB0aGlzLnNlcnZlclVybCA9IG51bGw7XG4gICAgdGhpcy53ZWJSdGNPcHRpb25zID0ge307XG4gICAgdGhpcy5wZWVyQ29ubmVjdGlvbkNvbmZpZyA9IG51bGw7XG4gICAgdGhpcy53cyA9IG51bGw7XG4gICAgdGhpcy5zZXNzaW9uID0gbnVsbDtcbiAgICB0aGlzLnJlbGlhYmxlVHJhbnNwb3J0ID0gXCJkYXRhY2hhbm5lbFwiO1xuICAgIHRoaXMudW5yZWxpYWJsZVRyYW5zcG9ydCA9IFwiZGF0YWNoYW5uZWxcIjtcblxuICAgIC8vIEluIHRoZSBldmVudCB0aGUgc2VydmVyIHJlc3RhcnRzIGFuZCBhbGwgY2xpZW50cyBsb3NlIGNvbm5lY3Rpb24sIHJlY29ubmVjdCB3aXRoXG4gICAgLy8gc29tZSByYW5kb20gaml0dGVyIGFkZGVkIHRvIHByZXZlbnQgc2ltdWx0YW5lb3VzIHJlY29ubmVjdGlvbiByZXF1ZXN0cy5cbiAgICB0aGlzLmluaXRpYWxSZWNvbm5lY3Rpb25EZWxheSA9IDEwMDAgKiBNYXRoLnJhbmRvbSgpO1xuICAgIHRoaXMucmVjb25uZWN0aW9uRGVsYXkgPSB0aGlzLmluaXRpYWxSZWNvbm5lY3Rpb25EZWxheTtcbiAgICB0aGlzLnJlY29ubmVjdGlvblRpbWVvdXQgPSBudWxsO1xuICAgIHRoaXMubWF4UmVjb25uZWN0aW9uQXR0ZW1wdHMgPSAxMDtcbiAgICB0aGlzLnJlY29ubmVjdGlvbkF0dGVtcHRzID0gMDtcblxuICAgIHRoaXMucHVibGlzaGVyID0gbnVsbDtcbiAgICB0aGlzLm9jY3VwYW50SWRzID0gW107XG4gICAgdGhpcy5vY2N1cGFudHMgPSB7fTtcbiAgICB0aGlzLm1lZGlhU3RyZWFtcyA9IHt9O1xuICAgIHRoaXMubG9jYWxNZWRpYVN0cmVhbSA9IG51bGw7XG4gICAgdGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cyA9IG5ldyBNYXAoKTtcblxuICAgIHRoaXMucGVuZGluZ09jY3VwYW50cyA9IG5ldyBTZXQoKTtcbiAgICB0aGlzLmF2YWlsYWJsZU9jY3VwYW50cyA9IFtdO1xuICAgIHRoaXMucmVxdWVzdGVkT2NjdXBhbnRzID0gbnVsbDtcblxuICAgIHRoaXMuYmxvY2tlZENsaWVudHMgPSBuZXcgTWFwKCk7XG4gICAgdGhpcy5mcm96ZW5VcGRhdGVzID0gbmV3IE1hcCgpO1xuXG4gICAgdGhpcy50aW1lT2Zmc2V0cyA9IFtdO1xuICAgIHRoaXMuc2VydmVyVGltZVJlcXVlc3RzID0gMDtcbiAgICB0aGlzLmF2Z1RpbWVPZmZzZXQgPSAwO1xuXG4gICAgdGhpcy5vbldlYnNvY2tldE9wZW4gPSB0aGlzLm9uV2Vic29ja2V0T3Blbi5iaW5kKHRoaXMpO1xuICAgIHRoaXMub25XZWJzb2NrZXRDbG9zZSA9IHRoaXMub25XZWJzb2NrZXRDbG9zZS5iaW5kKHRoaXMpO1xuICAgIHRoaXMub25XZWJzb2NrZXRNZXNzYWdlID0gdGhpcy5vbldlYnNvY2tldE1lc3NhZ2UuYmluZCh0aGlzKTtcbiAgICB0aGlzLm9uRGF0YUNoYW5uZWxNZXNzYWdlID0gdGhpcy5vbkRhdGFDaGFubmVsTWVzc2FnZS5iaW5kKHRoaXMpO1xuICAgIHRoaXMub25EYXRhID0gdGhpcy5vbkRhdGEuYmluZCh0aGlzKTtcbiAgfVxuXG4gIHNldFNlcnZlclVybCh1cmwpIHtcbiAgICB0aGlzLnNlcnZlclVybCA9IHVybDtcbiAgfVxuXG4gIHNldEFwcChhcHApIHt9XG5cbiAgc2V0Um9vbShyb29tTmFtZSkge1xuICAgIHRoaXMucm9vbSA9IHJvb21OYW1lO1xuICB9XG5cbiAgc2V0Sm9pblRva2VuKGpvaW5Ub2tlbikge1xuICAgIHRoaXMuam9pblRva2VuID0gam9pblRva2VuO1xuICB9XG5cbiAgc2V0Q2xpZW50SWQoY2xpZW50SWQpIHtcbiAgICB0aGlzLmNsaWVudElkID0gY2xpZW50SWQ7XG4gIH1cblxuICBzZXRXZWJSdGNPcHRpb25zKG9wdGlvbnMpIHtcbiAgICB0aGlzLndlYlJ0Y09wdGlvbnMgPSBvcHRpb25zO1xuICB9XG5cbiAgc2V0UGVlckNvbm5lY3Rpb25Db25maWcocGVlckNvbm5lY3Rpb25Db25maWcpIHtcbiAgICB0aGlzLnBlZXJDb25uZWN0aW9uQ29uZmlnID0gcGVlckNvbm5lY3Rpb25Db25maWc7XG4gIH1cblxuICBzZXRTZXJ2ZXJDb25uZWN0TGlzdGVuZXJzKHN1Y2Nlc3NMaXN0ZW5lciwgZmFpbHVyZUxpc3RlbmVyKSB7XG4gICAgdGhpcy5jb25uZWN0U3VjY2VzcyA9IHN1Y2Nlc3NMaXN0ZW5lcjtcbiAgICB0aGlzLmNvbm5lY3RGYWlsdXJlID0gZmFpbHVyZUxpc3RlbmVyO1xuICB9XG5cbiAgc2V0Um9vbU9jY3VwYW50TGlzdGVuZXIob2NjdXBhbnRMaXN0ZW5lcikge1xuICAgIHRoaXMub25PY2N1cGFudHNDaGFuZ2VkID0gb2NjdXBhbnRMaXN0ZW5lcjtcbiAgfVxuXG4gIHNldERhdGFDaGFubmVsTGlzdGVuZXJzKG9wZW5MaXN0ZW5lciwgY2xvc2VkTGlzdGVuZXIsIG1lc3NhZ2VMaXN0ZW5lcikge1xuICAgIHRoaXMub25PY2N1cGFudENvbm5lY3RlZCA9IG9wZW5MaXN0ZW5lcjtcbiAgICB0aGlzLm9uT2NjdXBhbnREaXNjb25uZWN0ZWQgPSBjbG9zZWRMaXN0ZW5lcjtcbiAgICB0aGlzLm9uT2NjdXBhbnRNZXNzYWdlID0gbWVzc2FnZUxpc3RlbmVyO1xuICB9XG5cbiAgc2V0UmVjb25uZWN0aW9uTGlzdGVuZXJzKHJlY29ubmVjdGluZ0xpc3RlbmVyLCByZWNvbm5lY3RlZExpc3RlbmVyLCByZWNvbm5lY3Rpb25FcnJvckxpc3RlbmVyKSB7XG4gICAgLy8gb25SZWNvbm5lY3RpbmcgaXMgY2FsbGVkIHdpdGggdGhlIG51bWJlciBvZiBtaWxsaXNlY29uZHMgdW50aWwgdGhlIG5leHQgcmVjb25uZWN0aW9uIGF0dGVtcHRcbiAgICB0aGlzLm9uUmVjb25uZWN0aW5nID0gcmVjb25uZWN0aW5nTGlzdGVuZXI7XG4gICAgLy8gb25SZWNvbm5lY3RlZCBpcyBjYWxsZWQgd2hlbiB0aGUgY29ubmVjdGlvbiBoYXMgYmVlbiByZWVzdGFibGlzaGVkXG4gICAgdGhpcy5vblJlY29ubmVjdGVkID0gcmVjb25uZWN0ZWRMaXN0ZW5lcjtcbiAgICAvLyBvblJlY29ubmVjdGlvbkVycm9yIGlzIGNhbGxlZCB3aXRoIGFuIGVycm9yIHdoZW4gbWF4UmVjb25uZWN0aW9uQXR0ZW1wdHMgaGFzIGJlZW4gcmVhY2hlZFxuICAgIHRoaXMub25SZWNvbm5lY3Rpb25FcnJvciA9IHJlY29ubmVjdGlvbkVycm9yTGlzdGVuZXI7XG4gIH1cblxuICBzZXRFdmVudExvb3BzKGxvb3BzKSB7XG4gICAgdGhpcy5sb29wcyA9IGxvb3BzO1xuICB9XG5cbiAgY29ubmVjdCgpIHtcbiAgICBkZWJ1ZyhgY29ubmVjdGluZyB0byAke3RoaXMuc2VydmVyVXJsfWApO1xuXG4gICAgY29uc3Qgd2Vic29ja2V0Q29ubmVjdGlvbiA9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgIHRoaXMud3MgPSBuZXcgV2ViU29ja2V0KHRoaXMuc2VydmVyVXJsLCBcImphbnVzLXByb3RvY29sXCIpO1xuXG4gICAgICB0aGlzLnNlc3Npb24gPSBuZXcgbWouSmFudXNTZXNzaW9uKHRoaXMud3Muc2VuZC5iaW5kKHRoaXMud3MpLCB7IHRpbWVvdXRNczogNDAwMDAgfSk7XG5cbiAgICAgIHRoaXMud3MuYWRkRXZlbnRMaXN0ZW5lcihcImNsb3NlXCIsIHRoaXMub25XZWJzb2NrZXRDbG9zZSk7XG4gICAgICB0aGlzLndzLmFkZEV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIHRoaXMub25XZWJzb2NrZXRNZXNzYWdlKTtcblxuICAgICAgdGhpcy53c09uT3BlbiA9ICgpID0+IHtcbiAgICAgICAgdGhpcy53cy5yZW1vdmVFdmVudExpc3RlbmVyKFwib3BlblwiLCB0aGlzLndzT25PcGVuKTtcbiAgICAgICAgdGhpcy5vbldlYnNvY2tldE9wZW4oKVxuICAgICAgICAgIC50aGVuKHJlc29sdmUpXG4gICAgICAgICAgLmNhdGNoKHJlamVjdCk7XG4gICAgICB9O1xuXG4gICAgICB0aGlzLndzLmFkZEV2ZW50TGlzdGVuZXIoXCJvcGVuXCIsIHRoaXMud3NPbk9wZW4pO1xuICAgIH0pO1xuXG4gICAgcmV0dXJuIFByb21pc2UuYWxsKFt3ZWJzb2NrZXRDb25uZWN0aW9uLCB0aGlzLnVwZGF0ZVRpbWVPZmZzZXQoKV0pO1xuICB9XG5cbiAgZGlzY29ubmVjdCgpIHtcbiAgICBkZWJ1ZyhgZGlzY29ubmVjdGluZ2ApO1xuXG4gICAgY2xlYXJUaW1lb3V0KHRoaXMucmVjb25uZWN0aW9uVGltZW91dCk7XG5cbiAgICB0aGlzLnJlbW92ZUFsbE9jY3VwYW50cygpO1xuXG4gICAgaWYgKHRoaXMucHVibGlzaGVyKSB7XG4gICAgICAvLyBDbG9zZSB0aGUgcHVibGlzaGVyIHBlZXIgY29ubmVjdGlvbi4gV2hpY2ggYWxzbyBkZXRhY2hlcyB0aGUgcGx1Z2luIGhhbmRsZS5cbiAgICAgIHRoaXMucHVibGlzaGVyLmNvbm4uY2xvc2UoKTtcbiAgICAgIHRoaXMucHVibGlzaGVyID0gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy5zZXNzaW9uKSB7XG4gICAgICB0aGlzLnNlc3Npb24uZGlzcG9zZSgpO1xuICAgICAgdGhpcy5zZXNzaW9uID0gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAodGhpcy53cykge1xuICAgICAgdGhpcy53cy5yZW1vdmVFdmVudExpc3RlbmVyKFwib3BlblwiLCB0aGlzLndzT25PcGVuKTtcbiAgICAgIHRoaXMud3MucmVtb3ZlRXZlbnRMaXN0ZW5lcihcImNsb3NlXCIsIHRoaXMub25XZWJzb2NrZXRDbG9zZSk7XG4gICAgICB0aGlzLndzLnJlbW92ZUV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIHRoaXMub25XZWJzb2NrZXRNZXNzYWdlKTtcbiAgICAgIHRoaXMud3MuY2xvc2UoKTtcbiAgICAgIHRoaXMud3MgPSBudWxsO1xuICAgIH1cblxuICAgIC8vIE5vdyB0aGF0IGFsbCBSVENQZWVyQ29ubmVjdGlvbiBjbG9zZWQsIGJlIHN1cmUgdG8gbm90IGNhbGxcbiAgICAvLyByZWNvbm5lY3QoKSBhZ2FpbiB2aWEgcGVyZm9ybURlbGF5ZWRSZWNvbm5lY3QgaWYgcHJldmlvdXNcbiAgICAvLyBSVENQZWVyQ29ubmVjdGlvbiB3YXMgaW4gdGhlIGZhaWxlZCBzdGF0ZS5cbiAgICBpZiAodGhpcy5kZWxheWVkUmVjb25uZWN0VGltZW91dCkge1xuICAgICAgY2xlYXJUaW1lb3V0KHRoaXMuZGVsYXllZFJlY29ubmVjdFRpbWVvdXQpO1xuICAgICAgdGhpcy5kZWxheWVkUmVjb25uZWN0VGltZW91dCA9IG51bGw7XG4gICAgfVxuICB9XG5cbiAgaXNEaXNjb25uZWN0ZWQoKSB7XG4gICAgcmV0dXJuIHRoaXMud3MgPT09IG51bGw7XG4gIH1cblxuICBhc3luYyBvbldlYnNvY2tldE9wZW4oKSB7XG4gICAgLy8gQ3JlYXRlIHRoZSBKYW51cyBTZXNzaW9uXG4gICAgYXdhaXQgdGhpcy5zZXNzaW9uLmNyZWF0ZSgpO1xuXG4gICAgLy8gQXR0YWNoIHRoZSBTRlUgUGx1Z2luIGFuZCBjcmVhdGUgYSBSVENQZWVyQ29ubmVjdGlvbiBmb3IgdGhlIHB1Ymxpc2hlci5cbiAgICAvLyBUaGUgcHVibGlzaGVyIHNlbmRzIGF1ZGlvIGFuZCBvcGVucyB0d28gYmlkaXJlY3Rpb25hbCBkYXRhIGNoYW5uZWxzLlxuICAgIC8vIE9uZSByZWxpYWJsZSBkYXRhY2hhbm5lbCBhbmQgb25lIHVucmVsaWFibGUuXG4gICAgdGhpcy5wdWJsaXNoZXIgPSBhd2FpdCB0aGlzLmNyZWF0ZVB1Ymxpc2hlcigpO1xuXG4gICAgLy8gQ2FsbCB0aGUgbmFmIGNvbm5lY3RTdWNjZXNzIGNhbGxiYWNrIGJlZm9yZSB3ZSBzdGFydCByZWNlaXZpbmcgV2ViUlRDIG1lc3NhZ2VzLlxuICAgIHRoaXMuY29ubmVjdFN1Y2Nlc3ModGhpcy5jbGllbnRJZCk7XG5cbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHRoaXMucHVibGlzaGVyLmluaXRpYWxPY2N1cGFudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IG9jY3VwYW50SWQgPSB0aGlzLnB1Ymxpc2hlci5pbml0aWFsT2NjdXBhbnRzW2ldO1xuICAgICAgaWYgKG9jY3VwYW50SWQgPT09IHRoaXMuY2xpZW50SWQpIGNvbnRpbnVlOyAvLyBIYXBwZW5zIGR1cmluZyBub24tZ3JhY2VmdWwgcmVjb25uZWN0cyBkdWUgdG8gem9tYmllIHNlc3Npb25zXG4gICAgICB0aGlzLmFkZEF2YWlsYWJsZU9jY3VwYW50KG9jY3VwYW50SWQpO1xuICAgIH1cblxuICAgIHRoaXMuc3luY09jY3VwYW50cygpO1xuICB9XG5cbiAgb25XZWJzb2NrZXRDbG9zZShldmVudCkge1xuICAgIC8vIFRoZSBjb25uZWN0aW9uIHdhcyBjbG9zZWQgc3VjY2Vzc2Z1bGx5LiBEb24ndCB0cnkgdG8gcmVjb25uZWN0LlxuICAgIGlmIChldmVudC5jb2RlID09PSBXU19OT1JNQUxfQ0xPU1VSRSkge1xuICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIGNvbnNvbGUud2FybihcIkphbnVzIHdlYnNvY2tldCBjbG9zZWQgdW5leHBlY3RlZGx5LlwiKTtcbiAgICBpZiAodGhpcy5vblJlY29ubmVjdGluZykge1xuICAgICAgdGhpcy5vblJlY29ubmVjdGluZyh0aGlzLnJlY29ubmVjdGlvbkRlbGF5KTtcbiAgICB9XG5cbiAgICB0aGlzLnJlY29ubmVjdGlvblRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHRoaXMucmVjb25uZWN0KCksIHRoaXMucmVjb25uZWN0aW9uRGVsYXkpO1xuICB9XG5cbiAgcmVjb25uZWN0KCkge1xuICAgIC8vIERpc3Bvc2Ugb2YgYWxsIG5ldHdvcmtlZCBlbnRpdGllcyBhbmQgb3RoZXIgcmVzb3VyY2VzIHRpZWQgdG8gdGhlIHNlc3Npb24uXG4gICAgdGhpcy5kaXNjb25uZWN0KCk7XG5cbiAgICB0aGlzLmNvbm5lY3QoKVxuICAgICAgLnRoZW4oKCkgPT4ge1xuICAgICAgICB0aGlzLnJlY29ubmVjdGlvbkRlbGF5ID0gdGhpcy5pbml0aWFsUmVjb25uZWN0aW9uRGVsYXk7XG4gICAgICAgIHRoaXMucmVjb25uZWN0aW9uQXR0ZW1wdHMgPSAwO1xuXG4gICAgICAgIGlmICh0aGlzLm9uUmVjb25uZWN0ZWQpIHtcbiAgICAgICAgICB0aGlzLm9uUmVjb25uZWN0ZWQoKTtcbiAgICAgICAgfVxuICAgICAgfSlcbiAgICAgIC5jYXRjaChlcnJvciA9PiB7XG4gICAgICAgIHRoaXMucmVjb25uZWN0aW9uRGVsYXkgKz0gMTAwMDtcbiAgICAgICAgdGhpcy5yZWNvbm5lY3Rpb25BdHRlbXB0cysrO1xuXG4gICAgICAgIGlmICh0aGlzLnJlY29ubmVjdGlvbkF0dGVtcHRzID4gdGhpcy5tYXhSZWNvbm5lY3Rpb25BdHRlbXB0cyAmJiB0aGlzLm9uUmVjb25uZWN0aW9uRXJyb3IpIHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5vblJlY29ubmVjdGlvbkVycm9yKFxuICAgICAgICAgICAgbmV3IEVycm9yKFwiQ29ubmVjdGlvbiBjb3VsZCBub3QgYmUgcmVlc3RhYmxpc2hlZCwgZXhjZWVkZWQgbWF4aW11bSBudW1iZXIgb2YgcmVjb25uZWN0aW9uIGF0dGVtcHRzLlwiKVxuICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBjb25zb2xlLndhcm4oXCJFcnJvciBkdXJpbmcgcmVjb25uZWN0LCByZXRyeWluZy5cIik7XG4gICAgICAgIGNvbnNvbGUud2FybihlcnJvcik7XG5cbiAgICAgICAgaWYgKHRoaXMub25SZWNvbm5lY3RpbmcpIHtcbiAgICAgICAgICB0aGlzLm9uUmVjb25uZWN0aW5nKHRoaXMucmVjb25uZWN0aW9uRGVsYXkpO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5yZWNvbm5lY3Rpb25UaW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB0aGlzLnJlY29ubmVjdCgpLCB0aGlzLnJlY29ubmVjdGlvbkRlbGF5KTtcbiAgICAgIH0pO1xuICB9XG5cbiAgcGVyZm9ybURlbGF5ZWRSZWNvbm5lY3QoKSB7XG4gICAgaWYgKHRoaXMuZGVsYXllZFJlY29ubmVjdFRpbWVvdXQpIHtcbiAgICAgIGNsZWFyVGltZW91dCh0aGlzLmRlbGF5ZWRSZWNvbm5lY3RUaW1lb3V0KTtcbiAgICB9XG5cbiAgICB0aGlzLmRlbGF5ZWRSZWNvbm5lY3RUaW1lb3V0ID0gc2V0VGltZW91dCgoKSA9PiB7XG4gICAgICB0aGlzLmRlbGF5ZWRSZWNvbm5lY3RUaW1lb3V0ID0gbnVsbDtcbiAgICAgIHRoaXMucmVjb25uZWN0KCk7XG4gICAgfSwgMTAwMDApO1xuICB9XG5cbiAgb25XZWJzb2NrZXRNZXNzYWdlKGV2ZW50KSB7XG4gICAgdGhpcy5zZXNzaW9uLnJlY2VpdmUoSlNPTi5wYXJzZShldmVudC5kYXRhKSk7XG4gIH1cblxuICBhZGRBdmFpbGFibGVPY2N1cGFudChvY2N1cGFudElkKSB7XG4gICAgaWYgKHRoaXMuYXZhaWxhYmxlT2NjdXBhbnRzLmluZGV4T2Yob2NjdXBhbnRJZCkgPT09IC0xKSB7XG4gICAgICB0aGlzLmF2YWlsYWJsZU9jY3VwYW50cy5wdXNoKG9jY3VwYW50SWQpO1xuICAgIH1cbiAgfVxuXG4gIHJlbW92ZUF2YWlsYWJsZU9jY3VwYW50KG9jY3VwYW50SWQpIHtcbiAgICBjb25zdCBpZHggPSB0aGlzLmF2YWlsYWJsZU9jY3VwYW50cy5pbmRleE9mKG9jY3VwYW50SWQpO1xuICAgIGlmIChpZHggIT09IC0xKSB7XG4gICAgICB0aGlzLmF2YWlsYWJsZU9jY3VwYW50cy5zcGxpY2UoaWR4LCAxKTtcbiAgICB9XG4gIH1cblxuICBzeW5jT2NjdXBhbnRzKHJlcXVlc3RlZE9jY3VwYW50cykge1xuICAgIGlmIChyZXF1ZXN0ZWRPY2N1cGFudHMpIHtcbiAgICAgIHRoaXMucmVxdWVzdGVkT2NjdXBhbnRzID0gcmVxdWVzdGVkT2NjdXBhbnRzO1xuICAgIH1cblxuICAgIGlmICghdGhpcy5yZXF1ZXN0ZWRPY2N1cGFudHMpIHtcbiAgICAgIHJldHVybjtcbiAgICB9XG5cbiAgICAvLyBBZGQgYW55IHJlcXVlc3RlZCwgYXZhaWxhYmxlLCBhbmQgbm9uLXBlbmRpbmcgb2NjdXBhbnRzLlxuICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdGhpcy5yZXF1ZXN0ZWRPY2N1cGFudHMubGVuZ3RoOyBpKyspIHtcbiAgICAgIGNvbnN0IG9jY3VwYW50SWQgPSB0aGlzLnJlcXVlc3RlZE9jY3VwYW50c1tpXTtcbiAgICAgIGlmICghdGhpcy5vY2N1cGFudHNbb2NjdXBhbnRJZF0gJiYgdGhpcy5hdmFpbGFibGVPY2N1cGFudHMuaW5kZXhPZihvY2N1cGFudElkKSAhPT0gLTEgJiYgIXRoaXMucGVuZGluZ09jY3VwYW50cy5oYXMob2NjdXBhbnRJZCkpIHtcbiAgICAgICAgdGhpcy5hZGRPY2N1cGFudChvY2N1cGFudElkKTtcbiAgICAgIH1cbiAgICB9XG5cbiAgICAvLyBSZW1vdmUgYW55IHVucmVxdWVzdGVkIGFuZCBjdXJyZW50bHkgYWRkZWQgb2NjdXBhbnRzLlxuICAgIGZvciAobGV0IGogPSAwOyBqIDwgdGhpcy5hdmFpbGFibGVPY2N1cGFudHMubGVuZ3RoOyBqKyspIHtcbiAgICAgIGNvbnN0IG9jY3VwYW50SWQgPSB0aGlzLmF2YWlsYWJsZU9jY3VwYW50c1tqXTtcbiAgICAgIGlmICh0aGlzLm9jY3VwYW50c1tvY2N1cGFudElkXSAmJiB0aGlzLnJlcXVlc3RlZE9jY3VwYW50cy5pbmRleE9mKG9jY3VwYW50SWQpID09PSAtMSkge1xuICAgICAgICB0aGlzLnJlbW92ZU9jY3VwYW50KG9jY3VwYW50SWQpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIENhbGwgdGhlIE5ldHdvcmtlZCBBRnJhbWUgY2FsbGJhY2tzIGZvciB0aGUgdXBkYXRlZCBvY2N1cGFudHMgbGlzdC5cbiAgICB0aGlzLm9uT2NjdXBhbnRzQ2hhbmdlZCh0aGlzLm9jY3VwYW50cyk7XG4gIH1cblxuICBhc3luYyBhZGRPY2N1cGFudChvY2N1cGFudElkKSB7XG4gICAgdGhpcy5wZW5kaW5nT2NjdXBhbnRzLmFkZChvY2N1cGFudElkKTtcbiAgICBcbiAgICBjb25zdCBhdmFpbGFibGVPY2N1cGFudHNDb3VudCA9IHRoaXMuYXZhaWxhYmxlT2NjdXBhbnRzLmxlbmd0aDtcbiAgICBpZiAoYXZhaWxhYmxlT2NjdXBhbnRzQ291bnQgPiBBVkFJTEFCTEVfT0NDVVBBTlRTX1RIUkVTSE9MRCkge1xuICAgICAgYXdhaXQgcmFuZG9tRGVsYXkoMCwgTUFYX1NVQlNDUklCRV9ERUxBWSk7XG4gICAgfVxuICBcbiAgICBjb25zdCBzdWJzY3JpYmVyID0gYXdhaXQgdGhpcy5jcmVhdGVTdWJzY3JpYmVyKG9jY3VwYW50SWQpO1xuICAgIGlmIChzdWJzY3JpYmVyKSB7XG4gICAgICBpZighdGhpcy5wZW5kaW5nT2NjdXBhbnRzLmhhcyhvY2N1cGFudElkKSkge1xuICAgICAgICBzdWJzY3JpYmVyLmNvbm4uY2xvc2UoKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMucGVuZGluZ09jY3VwYW50cy5kZWxldGUob2NjdXBhbnRJZCk7XG4gICAgICAgIHRoaXMub2NjdXBhbnRJZHMucHVzaChvY2N1cGFudElkKTtcbiAgICAgICAgdGhpcy5vY2N1cGFudHNbb2NjdXBhbnRJZF0gPSBzdWJzY3JpYmVyO1xuXG4gICAgICAgIHRoaXMuc2V0TWVkaWFTdHJlYW0ob2NjdXBhbnRJZCwgc3Vic2NyaWJlci5tZWRpYVN0cmVhbSk7XG5cbiAgICAgICAgLy8gQ2FsbCB0aGUgTmV0d29ya2VkIEFGcmFtZSBjYWxsYmFja3MgZm9yIHRoZSBuZXcgb2NjdXBhbnQuXG4gICAgICAgIHRoaXMub25PY2N1cGFudENvbm5lY3RlZChvY2N1cGFudElkKTtcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICByZW1vdmVBbGxPY2N1cGFudHMoKSB7XG4gICAgdGhpcy5wZW5kaW5nT2NjdXBhbnRzLmNsZWFyKCk7XG4gICAgZm9yIChsZXQgaSA9IHRoaXMub2NjdXBhbnRJZHMubGVuZ3RoIC0gMTsgaSA+PSAwOyBpLS0pIHtcbiAgICAgIHRoaXMucmVtb3ZlT2NjdXBhbnQodGhpcy5vY2N1cGFudElkc1tpXSk7XG4gICAgfVxuICB9XG5cbiAgcmVtb3ZlT2NjdXBhbnQob2NjdXBhbnRJZCkge1xuICAgIHRoaXMucGVuZGluZ09jY3VwYW50cy5kZWxldGUob2NjdXBhbnRJZCk7XG4gICAgXG4gICAgaWYgKHRoaXMub2NjdXBhbnRzW29jY3VwYW50SWRdKSB7XG4gICAgICAvLyBDbG9zZSB0aGUgc3Vic2NyaWJlciBwZWVyIGNvbm5lY3Rpb24uIFdoaWNoIGFsc28gZGV0YWNoZXMgdGhlIHBsdWdpbiBoYW5kbGUuXG4gICAgICB0aGlzLm9jY3VwYW50c1tvY2N1cGFudElkXS5jb25uLmNsb3NlKCk7XG4gICAgICBkZWxldGUgdGhpcy5vY2N1cGFudHNbb2NjdXBhbnRJZF07XG4gICAgICBcbiAgICAgIHRoaXMub2NjdXBhbnRJZHMuc3BsaWNlKHRoaXMub2NjdXBhbnRJZHMuaW5kZXhPZihvY2N1cGFudElkKSwgMSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMubWVkaWFTdHJlYW1zW29jY3VwYW50SWRdKSB7XG4gICAgICBkZWxldGUgdGhpcy5tZWRpYVN0cmVhbXNbb2NjdXBhbnRJZF07XG4gICAgfVxuXG4gICAgaWYgKHRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuaGFzKG9jY3VwYW50SWQpKSB7XG4gICAgICBjb25zdCBtc2cgPSBcIlRoZSB1c2VyIGRpc2Nvbm5lY3RlZCBiZWZvcmUgdGhlIG1lZGlhIHN0cmVhbSB3YXMgcmVzb2x2ZWQuXCI7XG4gICAgICB0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLmdldChvY2N1cGFudElkKS5hdWRpby5yZWplY3QobXNnKTtcbiAgICAgIHRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuZ2V0KG9jY3VwYW50SWQpLnZpZGVvLnJlamVjdChtc2cpO1xuICAgICAgdGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cy5kZWxldGUob2NjdXBhbnRJZCk7XG4gICAgfVxuXG4gICAgLy8gQ2FsbCB0aGUgTmV0d29ya2VkIEFGcmFtZSBjYWxsYmFja3MgZm9yIHRoZSByZW1vdmVkIG9jY3VwYW50LlxuICAgIHRoaXMub25PY2N1cGFudERpc2Nvbm5lY3RlZChvY2N1cGFudElkKTtcbiAgfVxuXG4gIGFzc29jaWF0ZShjb25uLCBoYW5kbGUpIHtcbiAgICBjb25uLmFkZEV2ZW50TGlzdGVuZXIoXCJpY2VjYW5kaWRhdGVcIiwgZXYgPT4ge1xuICAgICAgaGFuZGxlLnNlbmRUcmlja2xlKGV2LmNhbmRpZGF0ZSB8fCBudWxsKS5jYXRjaChlID0+IGVycm9yKFwiRXJyb3IgdHJpY2tsaW5nIElDRTogJW9cIiwgZSkpO1xuICAgIH0pO1xuICAgIGNvbm4uYWRkRXZlbnRMaXN0ZW5lcihcImljZWNvbm5lY3Rpb25zdGF0ZWNoYW5nZVwiLCBldiA9PiB7XG4gICAgICBpZiAoY29ubi5pY2VDb25uZWN0aW9uU3RhdGUgPT09IFwiY29ubmVjdGVkXCIpIHtcbiAgICAgICAgY29uc29sZS5sb2coXCJJQ0Ugc3RhdGUgY2hhbmdlZCB0byBjb25uZWN0ZWRcIik7XG4gICAgICB9XG4gICAgICBpZiAoY29ubi5pY2VDb25uZWN0aW9uU3RhdGUgPT09IFwiZGlzY29ubmVjdGVkXCIpIHtcbiAgICAgICAgY29uc29sZS53YXJuKFwiSUNFIHN0YXRlIGNoYW5nZWQgdG8gZGlzY29ubmVjdGVkXCIpO1xuICAgICAgfVxuICAgICAgaWYgKGNvbm4uaWNlQ29ubmVjdGlvblN0YXRlID09PSBcImZhaWxlZFwiKSB7XG4gICAgICAgIGNvbnNvbGUud2FybihcIklDRSBmYWlsdXJlIGRldGVjdGVkLiBSZWNvbm5lY3RpbmcgaW4gMTBzLlwiKTtcbiAgICAgICAgdGhpcy5wZXJmb3JtRGVsYXllZFJlY29ubmVjdCgpO1xuICAgICAgfVxuICAgIH0pXG5cbiAgICAvLyB3ZSBoYXZlIHRvIGRlYm91bmNlIHRoZXNlIGJlY2F1c2UgamFudXMgZ2V0cyBhbmdyeSBpZiB5b3Ugc2VuZCBpdCBhIG5ldyBTRFAgYmVmb3JlXG4gICAgLy8gaXQncyBmaW5pc2hlZCBwcm9jZXNzaW5nIGFuIGV4aXN0aW5nIFNEUC4gaW4gYWN0dWFsaXR5LCBpdCBzZWVtcyBsaWtlIHRoaXMgaXMgbWF5YmVcbiAgICAvLyB0b28gbGliZXJhbCBhbmQgd2UgbmVlZCB0byB3YWl0IHNvbWUgYW1vdW50IG9mIHRpbWUgYWZ0ZXIgYW4gb2ZmZXIgYmVmb3JlIHNlbmRpbmcgYW5vdGhlcixcbiAgICAvLyBidXQgd2UgZG9uJ3QgY3VycmVudGx5IGtub3cgYW55IGdvb2Qgd2F5IG9mIGRldGVjdGluZyBleGFjdGx5IGhvdyBsb25nIDooXG4gICAgY29ubi5hZGRFdmVudExpc3RlbmVyKFxuICAgICAgXCJuZWdvdGlhdGlvbm5lZWRlZFwiLFxuICAgICAgZGVib3VuY2UoZXYgPT4ge1xuICAgICAgICBkZWJ1ZyhcIlNlbmRpbmcgbmV3IG9mZmVyIGZvciBoYW5kbGU6ICVvXCIsIGhhbmRsZSk7XG4gICAgICAgIHZhciBvZmZlciA9IGNvbm4uY3JlYXRlT2ZmZXIoKS50aGVuKHRoaXMuY29uZmlndXJlUHVibGlzaGVyU2RwKS50aGVuKHRoaXMuZml4U2FmYXJpSWNlVUZyYWcpO1xuICAgICAgICB2YXIgbG9jYWwgPSBvZmZlci50aGVuKG8gPT4gY29ubi5zZXRMb2NhbERlc2NyaXB0aW9uKG8pKTtcbiAgICAgICAgdmFyIHJlbW90ZSA9IG9mZmVyO1xuXG4gICAgICAgIHJlbW90ZSA9IHJlbW90ZVxuICAgICAgICAgIC50aGVuKHRoaXMuZml4U2FmYXJpSWNlVUZyYWcpXG4gICAgICAgICAgLnRoZW4oaiA9PiBoYW5kbGUuc2VuZEpzZXAoaikpXG4gICAgICAgICAgLnRoZW4ociA9PiBjb25uLnNldFJlbW90ZURlc2NyaXB0aW9uKHIuanNlcCkpO1xuICAgICAgICByZXR1cm4gUHJvbWlzZS5hbGwoW2xvY2FsLCByZW1vdGVdKS5jYXRjaChlID0+IGVycm9yKFwiRXJyb3IgbmVnb3RpYXRpbmcgb2ZmZXI6ICVvXCIsIGUpKTtcbiAgICAgIH0pXG4gICAgKTtcbiAgICBoYW5kbGUub24oXG4gICAgICBcImV2ZW50XCIsXG4gICAgICBkZWJvdW5jZShldiA9PiB7XG4gICAgICAgIHZhciBqc2VwID0gZXYuanNlcDtcbiAgICAgICAgaWYgKGpzZXAgJiYganNlcC50eXBlID09IFwib2ZmZXJcIikge1xuICAgICAgICAgIGRlYnVnKFwiQWNjZXB0aW5nIG5ldyBvZmZlciBmb3IgaGFuZGxlOiAlb1wiLCBoYW5kbGUpO1xuICAgICAgICAgIHZhciBhbnN3ZXIgPSBjb25uXG4gICAgICAgICAgICAuc2V0UmVtb3RlRGVzY3JpcHRpb24odGhpcy5jb25maWd1cmVTdWJzY3JpYmVyU2RwKGpzZXApKVxuICAgICAgICAgICAgLnRoZW4oXyA9PiBjb25uLmNyZWF0ZUFuc3dlcigpKVxuICAgICAgICAgICAgLnRoZW4odGhpcy5maXhTYWZhcmlJY2VVRnJhZyk7XG4gICAgICAgICAgdmFyIGxvY2FsID0gYW5zd2VyLnRoZW4oYSA9PiBjb25uLnNldExvY2FsRGVzY3JpcHRpb24oYSkpO1xuICAgICAgICAgIHZhciByZW1vdGUgPSBhbnN3ZXIudGhlbihqID0+IGhhbmRsZS5zZW5kSnNlcChqKSk7XG4gICAgICAgICAgcmV0dXJuIFByb21pc2UuYWxsKFtsb2NhbCwgcmVtb3RlXSkuY2F0Y2goZSA9PiBlcnJvcihcIkVycm9yIG5lZ290aWF0aW5nIGFuc3dlcjogJW9cIiwgZSkpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIC8vIHNvbWUgb3RoZXIga2luZCBvZiBldmVudCwgbm90aGluZyB0byBkb1xuICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgICB9KVxuICAgICk7XG4gIH1cblxuICBhc3luYyBjcmVhdGVQdWJsaXNoZXIoKSB7XG4gICAgdmFyIGhhbmRsZSA9IG5ldyBtai5KYW51c1BsdWdpbkhhbmRsZSh0aGlzLnNlc3Npb24pO1xuICAgIHZhciBjb25uID0gbmV3IFJUQ1BlZXJDb25uZWN0aW9uKHRoaXMucGVlckNvbm5lY3Rpb25Db25maWcgfHwgREVGQVVMVF9QRUVSX0NPTk5FQ1RJT05fQ09ORklHKTtcblxuICAgIGRlYnVnKFwicHViIHdhaXRpbmcgZm9yIHNmdVwiKTtcbiAgICBhd2FpdCBoYW5kbGUuYXR0YWNoKFwiamFudXMucGx1Z2luLnNmdVwiLCB0aGlzLmxvb3BzICYmIHRoaXMuY2xpZW50SWQgPyBwYXJzZUludCh0aGlzLmNsaWVudElkKSAlIHRoaXMubG9vcHMgOiB1bmRlZmluZWQpO1xuXG4gICAgdGhpcy5hc3NvY2lhdGUoY29ubiwgaGFuZGxlKTtcblxuICAgIGRlYnVnKFwicHViIHdhaXRpbmcgZm9yIGRhdGEgY2hhbm5lbHMgJiB3ZWJydGN1cFwiKTtcbiAgICB2YXIgd2VicnRjdXAgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IGhhbmRsZS5vbihcIndlYnJ0Y3VwXCIsIHJlc29sdmUpKTtcblxuICAgIC8vIFVucmVsaWFibGUgZGF0YWNoYW5uZWw6IHNlbmRpbmcgYW5kIHJlY2VpdmluZyBjb21wb25lbnQgdXBkYXRlcy5cbiAgICAvLyBSZWxpYWJsZSBkYXRhY2hhbm5lbDogc2VuZGluZyBhbmQgcmVjaWV2aW5nIGVudGl0eSBpbnN0YW50aWF0aW9ucy5cbiAgICB2YXIgcmVsaWFibGVDaGFubmVsID0gY29ubi5jcmVhdGVEYXRhQ2hhbm5lbChcInJlbGlhYmxlXCIsIHsgb3JkZXJlZDogdHJ1ZSB9KTtcbiAgICB2YXIgdW5yZWxpYWJsZUNoYW5uZWwgPSBjb25uLmNyZWF0ZURhdGFDaGFubmVsKFwidW5yZWxpYWJsZVwiLCB7XG4gICAgICBvcmRlcmVkOiBmYWxzZSxcbiAgICAgIG1heFJldHJhbnNtaXRzOiAwXG4gICAgfSk7XG5cbiAgICByZWxpYWJsZUNoYW5uZWwuYWRkRXZlbnRMaXN0ZW5lcihcIm1lc3NhZ2VcIiwgZSA9PiB0aGlzLm9uRGF0YUNoYW5uZWxNZXNzYWdlKGUsIFwiamFudXMtcmVsaWFibGVcIikpO1xuICAgIHVucmVsaWFibGVDaGFubmVsLmFkZEV2ZW50TGlzdGVuZXIoXCJtZXNzYWdlXCIsIGUgPT4gdGhpcy5vbkRhdGFDaGFubmVsTWVzc2FnZShlLCBcImphbnVzLXVucmVsaWFibGVcIikpO1xuXG4gICAgYXdhaXQgd2VicnRjdXA7XG4gICAgYXdhaXQgdW50aWxEYXRhQ2hhbm5lbE9wZW4ocmVsaWFibGVDaGFubmVsKTtcbiAgICBhd2FpdCB1bnRpbERhdGFDaGFubmVsT3Blbih1bnJlbGlhYmxlQ2hhbm5lbCk7XG5cbiAgICAvLyBkb2luZyB0aGlzIGhlcmUgaXMgc29ydCBvZiBhIGhhY2sgYXJvdW5kIGNocm9tZSByZW5lZ290aWF0aW9uIHdlaXJkbmVzcyAtLVxuICAgIC8vIGlmIHdlIGRvIGl0IHByaW9yIHRvIHdlYnJ0Y3VwLCBjaHJvbWUgb24gZ2VhciBWUiB3aWxsIHNvbWV0aW1lcyBwdXQgYVxuICAgIC8vIHJlbmVnb3RpYXRpb24gb2ZmZXIgaW4gZmxpZ2h0IHdoaWxlIHRoZSBmaXJzdCBvZmZlciB3YXMgc3RpbGwgYmVpbmdcbiAgICAvLyBwcm9jZXNzZWQgYnkgamFudXMuIHdlIHNob3VsZCBmaW5kIHNvbWUgbW9yZSBwcmluY2lwbGVkIHdheSB0byBmaWd1cmUgb3V0XG4gICAgLy8gd2hlbiBqYW51cyBpcyBkb25lIGluIHRoZSBmdXR1cmUuXG4gICAgaWYgKHRoaXMubG9jYWxNZWRpYVN0cmVhbSkge1xuICAgICAgdGhpcy5sb2NhbE1lZGlhU3RyZWFtLmdldFRyYWNrcygpLmZvckVhY2godHJhY2sgPT4ge1xuICAgICAgICBjb25uLmFkZFRyYWNrKHRyYWNrLCB0aGlzLmxvY2FsTWVkaWFTdHJlYW0pO1xuICAgICAgfSk7XG4gICAgfVxuXG4gICAgLy8gSGFuZGxlIGFsbCBvZiB0aGUgam9pbiBhbmQgbGVhdmUgZXZlbnRzLlxuICAgIGhhbmRsZS5vbihcImV2ZW50XCIsIGV2ID0+IHtcbiAgICAgIHZhciBkYXRhID0gZXYucGx1Z2luZGF0YS5kYXRhO1xuICAgICAgaWYgKGRhdGEuZXZlbnQgPT0gXCJqb2luXCIgJiYgZGF0YS5yb29tX2lkID09IHRoaXMucm9vbSkge1xuICAgICAgICBpZiAodGhpcy5kZWxheWVkUmVjb25uZWN0VGltZW91dCkge1xuICAgICAgICAgIC8vIERvbid0IGNyZWF0ZSBhIG5ldyBSVENQZWVyQ29ubmVjdGlvbiwgYWxsIFJUQ1BlZXJDb25uZWN0aW9uIHdpbGwgYmUgY2xvc2VkIGluIGxlc3MgdGhhbiAxMHMuXG4gICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHRoaXMuYWRkQXZhaWxhYmxlT2NjdXBhbnQoZGF0YS51c2VyX2lkKTtcbiAgICAgICAgdGhpcy5zeW5jT2NjdXBhbnRzKCk7XG4gICAgICB9IGVsc2UgaWYgKGRhdGEuZXZlbnQgPT0gXCJsZWF2ZVwiICYmIGRhdGEucm9vbV9pZCA9PSB0aGlzLnJvb20pIHtcbiAgICAgICAgdGhpcy5yZW1vdmVBdmFpbGFibGVPY2N1cGFudChkYXRhLnVzZXJfaWQpO1xuICAgICAgICB0aGlzLnJlbW92ZU9jY3VwYW50KGRhdGEudXNlcl9pZCk7XG4gICAgICB9IGVsc2UgaWYgKGRhdGEuZXZlbnQgPT0gXCJibG9ja2VkXCIpIHtcbiAgICAgICAgZG9jdW1lbnQuYm9keS5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudChcImJsb2NrZWRcIiwgeyBkZXRhaWw6IHsgY2xpZW50SWQ6IGRhdGEuYnkgfSB9KSk7XG4gICAgICB9IGVsc2UgaWYgKGRhdGEuZXZlbnQgPT0gXCJ1bmJsb2NrZWRcIikge1xuICAgICAgICBkb2N1bWVudC5ib2R5LmRpc3BhdGNoRXZlbnQobmV3IEN1c3RvbUV2ZW50KFwidW5ibG9ja2VkXCIsIHsgZGV0YWlsOiB7IGNsaWVudElkOiBkYXRhLmJ5IH0gfSkpO1xuICAgICAgfSBlbHNlIGlmIChkYXRhLmV2ZW50ID09PSBcImRhdGFcIikge1xuICAgICAgICB0aGlzLm9uRGF0YShKU09OLnBhcnNlKGRhdGEuYm9keSksIFwiamFudXMtZXZlbnRcIik7XG4gICAgICB9XG4gICAgfSk7XG5cbiAgICBkZWJ1ZyhcInB1YiB3YWl0aW5nIGZvciBqb2luXCIpO1xuXG4gICAgLy8gU2VuZCBqb2luIG1lc3NhZ2UgdG8gamFudXMuIExpc3RlbiBmb3Igam9pbi9sZWF2ZSBtZXNzYWdlcy4gQXV0b21hdGljYWxseSBzdWJzY3JpYmUgdG8gYWxsIHVzZXJzJyBXZWJSVEMgZGF0YS5cbiAgICB2YXIgbWVzc2FnZSA9IGF3YWl0IHRoaXMuc2VuZEpvaW4oaGFuZGxlLCB7XG4gICAgICBub3RpZmljYXRpb25zOiB0cnVlLFxuICAgICAgZGF0YTogdHJ1ZVxuICAgIH0pO1xuXG4gICAgaWYgKCFtZXNzYWdlLnBsdWdpbmRhdGEuZGF0YS5zdWNjZXNzKSB7XG4gICAgICBjb25zdCBlcnIgPSBtZXNzYWdlLnBsdWdpbmRhdGEuZGF0YS5lcnJvcjtcbiAgICAgIGNvbnNvbGUuZXJyb3IoZXJyKTtcbiAgICAgIC8vIFdlIG1heSBnZXQgaGVyZSBiZWNhdXNlIG9mIGFuIGV4cGlyZWQgSldULlxuICAgICAgLy8gQ2xvc2UgdGhlIGNvbm5lY3Rpb24gb3Vyc2VsZiBvdGhlcndpc2UgamFudXMgd2lsbCBjbG9zZSBpdCBhZnRlclxuICAgICAgLy8gc2Vzc2lvbl90aW1lb3V0IGJlY2F1c2Ugd2UgZGlkbid0IHNlbmQgYW55IGtlZXBhbGl2ZSBhbmQgdGhpcyB3aWxsXG4gICAgICAvLyB0cmlnZ2VyIGEgZGVsYXllZCByZWNvbm5lY3QgYmVjYXVzZSBvZiB0aGUgaWNlY29ubmVjdGlvbnN0YXRlY2hhbmdlXG4gICAgICAvLyBsaXN0ZW5lciBmb3IgZmFpbHVyZSBzdGF0ZS5cbiAgICAgIC8vIEV2ZW4gaWYgdGhlIGFwcCBjb2RlIGNhbGxzIGRpc2Nvbm5lY3QgaW4gY2FzZSBvZiBlcnJvciwgZGlzY29ubmVjdFxuICAgICAgLy8gd29uJ3QgY2xvc2UgdGhlIHBlZXIgY29ubmVjdGlvbiBiZWNhdXNlIHRoaXMucHVibGlzaGVyIGlzIG5vdCBzZXQuXG4gICAgICBjb25uLmNsb3NlKCk7XG4gICAgICB0aHJvdyBlcnI7XG4gICAgfVxuXG4gICAgdmFyIGluaXRpYWxPY2N1cGFudHMgPSBtZXNzYWdlLnBsdWdpbmRhdGEuZGF0YS5yZXNwb25zZS51c2Vyc1t0aGlzLnJvb21dIHx8IFtdO1xuXG4gICAgaWYgKGluaXRpYWxPY2N1cGFudHMuaW5jbHVkZXModGhpcy5jbGllbnRJZCkpIHtcbiAgICAgIGNvbnNvbGUud2FybihcIkphbnVzIHN0aWxsIGhhcyBwcmV2aW91cyBzZXNzaW9uIGZvciB0aGlzIGNsaWVudC4gUmVjb25uZWN0aW5nIGluIDEwcy5cIik7XG4gICAgICB0aGlzLnBlcmZvcm1EZWxheWVkUmVjb25uZWN0KCk7XG4gICAgfVxuXG4gICAgZGVidWcoXCJwdWJsaXNoZXIgcmVhZHlcIik7XG4gICAgcmV0dXJuIHtcbiAgICAgIGhhbmRsZSxcbiAgICAgIGluaXRpYWxPY2N1cGFudHMsXG4gICAgICByZWxpYWJsZUNoYW5uZWwsXG4gICAgICB1bnJlbGlhYmxlQ2hhbm5lbCxcbiAgICAgIGNvbm5cbiAgICB9O1xuICB9XG5cbiAgY29uZmlndXJlUHVibGlzaGVyU2RwKGpzZXApIHtcbiAgICBqc2VwLnNkcCA9IGpzZXAuc2RwLnJlcGxhY2UoL2E9Zm10cDooMTA5fDExMSkuKlxcclxcbi9nLCAobGluZSwgcHQpID0+IHtcbiAgICAgIGNvbnN0IHBhcmFtZXRlcnMgPSBPYmplY3QuYXNzaWduKHNkcFV0aWxzLnBhcnNlRm10cChsaW5lKSwgT1BVU19QQVJBTUVURVJTKTtcbiAgICAgIHJldHVybiBzZHBVdGlscy53cml0ZUZtdHAoeyBwYXlsb2FkVHlwZTogcHQsIHBhcmFtZXRlcnM6IHBhcmFtZXRlcnMgfSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIGpzZXA7XG4gIH1cblxuICBjb25maWd1cmVTdWJzY3JpYmVyU2RwKGpzZXApIHtcbiAgICAvLyB0b2RvOiBjb25zaWRlciBjbGVhbmluZyB1cCB0aGVzZSBoYWNrcyB0byB1c2Ugc2RwdXRpbHNcbiAgICBpZiAoIWlzSDI2NFZpZGVvU3VwcG9ydGVkKSB7XG4gICAgICBpZiAobmF2aWdhdG9yLnVzZXJBZ2VudC5pbmRleE9mKFwiSGVhZGxlc3NDaHJvbWVcIikgIT09IC0xKSB7XG4gICAgICAgIC8vIEhlYWRsZXNzQ2hyb21lIChlLmcuIHB1cHBldGVlcikgZG9lc24ndCBzdXBwb3J0IHdlYnJ0YyB2aWRlbyBzdHJlYW1zLCBzbyB3ZSByZW1vdmUgdGhvc2UgbGluZXMgZnJvbSB0aGUgU0RQLlxuICAgICAgICBqc2VwLnNkcCA9IGpzZXAuc2RwLnJlcGxhY2UoL209dmlkZW9bXl0qbT0vLCBcIm09XCIpO1xuICAgICAgfVxuICAgIH1cblxuICAgIC8vIFRPRE86IEhhY2sgdG8gZ2V0IHZpZGVvIHdvcmtpbmcgb24gQ2hyb21lIGZvciBBbmRyb2lkLiBodHRwczovL2dyb3Vwcy5nb29nbGUuY29tL2ZvcnVtLyMhdG9waWMvbW96aWxsYS5kZXYubWVkaWEvWWUyOXZ1TVRwbzhcbiAgICBpZiAobmF2aWdhdG9yLnVzZXJBZ2VudC5pbmRleE9mKFwiQW5kcm9pZFwiKSA9PT0gLTEpIHtcbiAgICAgIGpzZXAuc2RwID0ganNlcC5zZHAucmVwbGFjZShcbiAgICAgICAgXCJhPXJ0Y3AtZmI6MTA3IGdvb2ctcmVtYlxcclxcblwiLFxuICAgICAgICBcImE9cnRjcC1mYjoxMDcgZ29vZy1yZW1iXFxyXFxuYT1ydGNwLWZiOjEwNyB0cmFuc3BvcnQtY2NcXHJcXG5hPWZtdHA6MTA3IGxldmVsLWFzeW1tZXRyeS1hbGxvd2VkPTE7cGFja2V0aXphdGlvbi1tb2RlPTE7cHJvZmlsZS1sZXZlbC1pZD00MmUwMWZcXHJcXG5cIlxuICAgICAgKTtcbiAgICB9IGVsc2Uge1xuICAgICAganNlcC5zZHAgPSBqc2VwLnNkcC5yZXBsYWNlKFxuICAgICAgICBcImE9cnRjcC1mYjoxMDcgZ29vZy1yZW1iXFxyXFxuXCIsXG4gICAgICAgIFwiYT1ydGNwLWZiOjEwNyBnb29nLXJlbWJcXHJcXG5hPXJ0Y3AtZmI6MTA3IHRyYW5zcG9ydC1jY1xcclxcbmE9Zm10cDoxMDcgbGV2ZWwtYXN5bW1ldHJ5LWFsbG93ZWQ9MTtwYWNrZXRpemF0aW9uLW1vZGU9MTtwcm9maWxlLWxldmVsLWlkPTQyMDAxZlxcclxcblwiXG4gICAgICApO1xuICAgIH1cbiAgICByZXR1cm4ganNlcDtcbiAgfVxuXG4gIGFzeW5jIGZpeFNhZmFyaUljZVVGcmFnKGpzZXApIHtcbiAgICAvLyBTYWZhcmkgcHJvZHVjZXMgYSBcXG4gaW5zdGVhZCBvZiBhbiBcXHJcXG4gZm9yIHRoZSBpY2UtdWZyYWcuIFNlZSBodHRwczovL2dpdGh1Yi5jb20vbWVldGVjaG8vamFudXMtZ2F0ZXdheS9pc3N1ZXMvMTgxOFxuICAgIGpzZXAuc2RwID0ganNlcC5zZHAucmVwbGFjZSgvW15cXHJdXFxuYT1pY2UtdWZyYWcvZywgXCJcXHJcXG5hPWljZS11ZnJhZ1wiKTtcbiAgICByZXR1cm4ganNlcFxuICB9XG5cbiAgYXN5bmMgY3JlYXRlU3Vic2NyaWJlcihvY2N1cGFudElkLCBtYXhSZXRyaWVzID0gNSkge1xuICAgIGlmICh0aGlzLmF2YWlsYWJsZU9jY3VwYW50cy5pbmRleE9mKG9jY3VwYW50SWQpID09PSAtMSkge1xuICAgICAgY29uc29sZS53YXJuKG9jY3VwYW50SWQgKyBcIjogY2FuY2VsbGVkIG9jY3VwYW50IGNvbm5lY3Rpb24sIG9jY3VwYW50IGxlZnQgYmVmb3JlIHN1YnNjcmlwdGlvbiBuZWdvdGF0aW9uLlwiKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIHZhciBoYW5kbGUgPSBuZXcgbWouSmFudXNQbHVnaW5IYW5kbGUodGhpcy5zZXNzaW9uKTtcbiAgICB2YXIgY29ubiA9IG5ldyBSVENQZWVyQ29ubmVjdGlvbih0aGlzLnBlZXJDb25uZWN0aW9uQ29uZmlnIHx8IERFRkFVTFRfUEVFUl9DT05ORUNUSU9OX0NPTkZJRyk7XG5cbiAgICBkZWJ1ZyhvY2N1cGFudElkICsgXCI6IHN1YiB3YWl0aW5nIGZvciBzZnVcIik7XG4gICAgYXdhaXQgaGFuZGxlLmF0dGFjaChcImphbnVzLnBsdWdpbi5zZnVcIiwgdGhpcy5sb29wcyA/IHBhcnNlSW50KG9jY3VwYW50SWQpICUgdGhpcy5sb29wcyA6IHVuZGVmaW5lZCk7XG5cbiAgICB0aGlzLmFzc29jaWF0ZShjb25uLCBoYW5kbGUpO1xuXG4gICAgZGVidWcob2NjdXBhbnRJZCArIFwiOiBzdWIgd2FpdGluZyBmb3Igam9pblwiKTtcblxuICAgIGlmICh0aGlzLmF2YWlsYWJsZU9jY3VwYW50cy5pbmRleE9mKG9jY3VwYW50SWQpID09PSAtMSkge1xuICAgICAgY29ubi5jbG9zZSgpO1xuICAgICAgY29uc29sZS53YXJuKG9jY3VwYW50SWQgKyBcIjogY2FuY2VsbGVkIG9jY3VwYW50IGNvbm5lY3Rpb24sIG9jY3VwYW50IGxlZnQgYWZ0ZXIgYXR0YWNoXCIpO1xuICAgICAgcmV0dXJuIG51bGw7XG4gICAgfVxuXG4gICAgbGV0IHdlYnJ0Y0ZhaWxlZCA9IGZhbHNlO1xuXG4gICAgY29uc3Qgd2VicnRjdXAgPSBuZXcgUHJvbWlzZShyZXNvbHZlID0+IHtcbiAgICAgIGNvbnN0IGxlZnRJbnRlcnZhbCA9IHNldEludGVydmFsKCgpID0+IHtcbiAgICAgICAgaWYgKHRoaXMuYXZhaWxhYmxlT2NjdXBhbnRzLmluZGV4T2Yob2NjdXBhbnRJZCkgPT09IC0xKSB7XG4gICAgICAgICAgY2xlYXJJbnRlcnZhbChsZWZ0SW50ZXJ2YWwpO1xuICAgICAgICAgIHJlc29sdmUoKTtcbiAgICAgICAgfVxuICAgICAgfSwgMTAwMCk7XG5cbiAgICAgIGNvbnN0IHRpbWVvdXQgPSBzZXRUaW1lb3V0KCgpID0+IHtcbiAgICAgICAgY2xlYXJJbnRlcnZhbChsZWZ0SW50ZXJ2YWwpO1xuICAgICAgICB3ZWJydGNGYWlsZWQgPSB0cnVlO1xuICAgICAgICByZXNvbHZlKCk7XG4gICAgICB9LCBTVUJTQ1JJQkVfVElNRU9VVF9NUyk7XG5cbiAgICAgIGhhbmRsZS5vbihcIndlYnJ0Y3VwXCIsICgpID0+IHtcbiAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xuICAgICAgICBjbGVhckludGVydmFsKGxlZnRJbnRlcnZhbCk7XG4gICAgICAgIHJlc29sdmUoKTtcbiAgICAgIH0pO1xuICAgIH0pO1xuXG4gICAgLy8gU2VuZCBqb2luIG1lc3NhZ2UgdG8gamFudXMuIERvbid0IGxpc3RlbiBmb3Igam9pbi9sZWF2ZSBtZXNzYWdlcy4gU3Vic2NyaWJlIHRvIHRoZSBvY2N1cGFudCdzIG1lZGlhLlxuICAgIC8vIEphbnVzIHNob3VsZCBzZW5kIHVzIGFuIG9mZmVyIGZvciB0aGlzIG9jY3VwYW50J3MgbWVkaWEgaW4gcmVzcG9uc2UgdG8gdGhpcy5cbiAgICBhd2FpdCB0aGlzLnNlbmRKb2luKGhhbmRsZSwgeyBtZWRpYTogb2NjdXBhbnRJZCB9KTtcblxuICAgIGlmICh0aGlzLmF2YWlsYWJsZU9jY3VwYW50cy5pbmRleE9mKG9jY3VwYW50SWQpID09PSAtMSkge1xuICAgICAgY29ubi5jbG9zZSgpO1xuICAgICAgY29uc29sZS53YXJuKG9jY3VwYW50SWQgKyBcIjogY2FuY2VsbGVkIG9jY3VwYW50IGNvbm5lY3Rpb24sIG9jY3VwYW50IGxlZnQgYWZ0ZXIgam9pblwiKTtcbiAgICAgIHJldHVybiBudWxsO1xuICAgIH1cblxuICAgIGRlYnVnKG9jY3VwYW50SWQgKyBcIjogc3ViIHdhaXRpbmcgZm9yIHdlYnJ0Y3VwXCIpO1xuICAgIGF3YWl0IHdlYnJ0Y3VwO1xuXG4gICAgaWYgKHRoaXMuYXZhaWxhYmxlT2NjdXBhbnRzLmluZGV4T2Yob2NjdXBhbnRJZCkgPT09IC0xKSB7XG4gICAgICBjb25uLmNsb3NlKCk7XG4gICAgICBjb25zb2xlLndhcm4ob2NjdXBhbnRJZCArIFwiOiBjYW5jZWwgb2NjdXBhbnQgY29ubmVjdGlvbiwgb2NjdXBhbnQgbGVmdCBkdXJpbmcgb3IgYWZ0ZXIgd2VicnRjdXBcIik7XG4gICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG5cbiAgICBpZiAod2VicnRjRmFpbGVkKSB7XG4gICAgICBjb25uLmNsb3NlKCk7XG4gICAgICBpZiAobWF4UmV0cmllcyA+IDApIHtcbiAgICAgICAgY29uc29sZS53YXJuKG9jY3VwYW50SWQgKyBcIjogd2VicnRjIHVwIHRpbWVkIG91dCwgcmV0cnlpbmdcIik7XG4gICAgICAgIHJldHVybiB0aGlzLmNyZWF0ZVN1YnNjcmliZXIob2NjdXBhbnRJZCwgbWF4UmV0cmllcyAtIDEpO1xuICAgICAgfSBlbHNlIHtcbiAgICAgICAgY29uc29sZS53YXJuKG9jY3VwYW50SWQgKyBcIjogd2VicnRjIHVwIHRpbWVkIG91dFwiKTtcbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGlzU2FmYXJpICYmICF0aGlzLl9pT1NIYWNrRGVsYXllZEluaXRpYWxQZWVyKSB7XG4gICAgICAvLyBIQUNLOiB0aGUgZmlyc3QgcGVlciBvbiBTYWZhcmkgZHVyaW5nIHBhZ2UgbG9hZCBjYW4gZmFpbCB0byB3b3JrIGlmIHdlIGRvbid0XG4gICAgICAvLyB3YWl0IHNvbWUgdGltZSBiZWZvcmUgY29udGludWluZyBoZXJlLiBTZWU6IGh0dHBzOi8vZ2l0aHViLmNvbS9tb3ppbGxhL2h1YnMvcHVsbC8xNjkyXG4gICAgICBhd2FpdCAobmV3IFByb21pc2UoKHJlc29sdmUpID0+IHNldFRpbWVvdXQocmVzb2x2ZSwgMzAwMCkpKTtcbiAgICAgIHRoaXMuX2lPU0hhY2tEZWxheWVkSW5pdGlhbFBlZXIgPSB0cnVlO1xuICAgIH1cblxuICAgIHZhciBtZWRpYVN0cmVhbSA9IG5ldyBNZWRpYVN0cmVhbSgpO1xuICAgIHZhciByZWNlaXZlcnMgPSBjb25uLmdldFJlY2VpdmVycygpO1xuICAgIHJlY2VpdmVycy5mb3JFYWNoKHJlY2VpdmVyID0+IHtcbiAgICAgIGlmIChyZWNlaXZlci50cmFjaykge1xuICAgICAgICBtZWRpYVN0cmVhbS5hZGRUcmFjayhyZWNlaXZlci50cmFjayk7XG4gICAgICB9XG4gICAgfSk7XG4gICAgaWYgKG1lZGlhU3RyZWFtLmdldFRyYWNrcygpLmxlbmd0aCA9PT0gMCkge1xuICAgICAgbWVkaWFTdHJlYW0gPSBudWxsO1xuICAgIH1cblxuICAgIGRlYnVnKG9jY3VwYW50SWQgKyBcIjogc3Vic2NyaWJlciByZWFkeVwiKTtcbiAgICByZXR1cm4ge1xuICAgICAgaGFuZGxlLFxuICAgICAgbWVkaWFTdHJlYW0sXG4gICAgICBjb25uXG4gICAgfTtcbiAgfVxuXG4gIHNlbmRKb2luKGhhbmRsZSwgc3Vic2NyaWJlKSB7XG4gICAgcmV0dXJuIGhhbmRsZS5zZW5kTWVzc2FnZSh7XG4gICAgICBraW5kOiBcImpvaW5cIixcbiAgICAgIHJvb21faWQ6IHRoaXMucm9vbSxcbiAgICAgIHVzZXJfaWQ6IHRoaXMuY2xpZW50SWQsXG4gICAgICBzdWJzY3JpYmUsXG4gICAgICB0b2tlbjogdGhpcy5qb2luVG9rZW5cbiAgICB9KTtcbiAgfVxuXG4gIHRvZ2dsZUZyZWV6ZSgpIHtcbiAgICBpZiAodGhpcy5mcm96ZW4pIHtcbiAgICAgIHRoaXMudW5mcmVlemUoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5mcmVlemUoKTtcbiAgICB9XG4gIH1cblxuICBmcmVlemUoKSB7XG4gICAgdGhpcy5mcm96ZW4gPSB0cnVlO1xuICB9XG5cbiAgdW5mcmVlemUoKSB7XG4gICAgdGhpcy5mcm96ZW4gPSBmYWxzZTtcbiAgICB0aGlzLmZsdXNoUGVuZGluZ1VwZGF0ZXMoKTtcbiAgfVxuXG4gIGRhdGFGb3JVcGRhdGVNdWx0aU1lc3NhZ2UobmV0d29ya0lkLCBtZXNzYWdlKSB7XG4gICAgLy8gXCJkXCIgaXMgYW4gYXJyYXkgb2YgZW50aXR5IGRhdGFzLCB3aGVyZSBlYWNoIGl0ZW0gaW4gdGhlIGFycmF5IHJlcHJlc2VudHMgYSB1bmlxdWUgZW50aXR5IGFuZCBjb250YWluc1xuICAgIC8vIG1ldGFkYXRhIGZvciB0aGUgZW50aXR5LCBhbmQgYW4gYXJyYXkgb2YgY29tcG9uZW50cyB0aGF0IGhhdmUgYmVlbiB1cGRhdGVkIG9uIHRoZSBlbnRpdHkuXG4gICAgLy8gVGhpcyBtZXRob2QgZmluZHMgdGhlIGRhdGEgY29ycmVzcG9uZGluZyB0byB0aGUgZ2l2ZW4gbmV0d29ya0lkLlxuICAgIGZvciAobGV0IGkgPSAwLCBsID0gbWVzc2FnZS5kYXRhLmQubGVuZ3RoOyBpIDwgbDsgaSsrKSB7XG4gICAgICBjb25zdCBkYXRhID0gbWVzc2FnZS5kYXRhLmRbaV07XG5cbiAgICAgIGlmIChkYXRhLm5ldHdvcmtJZCA9PT0gbmV0d29ya0lkKSB7XG4gICAgICAgIHJldHVybiBkYXRhO1xuICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBudWxsO1xuICB9XG5cbiAgZ2V0UGVuZGluZ0RhdGEobmV0d29ya0lkLCBtZXNzYWdlKSB7XG4gICAgaWYgKCFtZXNzYWdlKSByZXR1cm4gbnVsbDtcblxuICAgIGxldCBkYXRhID0gbWVzc2FnZS5kYXRhVHlwZSA9PT0gXCJ1bVwiID8gdGhpcy5kYXRhRm9yVXBkYXRlTXVsdGlNZXNzYWdlKG5ldHdvcmtJZCwgbWVzc2FnZSkgOiBtZXNzYWdlLmRhdGE7XG5cbiAgICAvLyBJZ25vcmUgbWVzc2FnZXMgcmVsYXRpbmcgdG8gdXNlcnMgd2hvIGhhdmUgZGlzY29ubmVjdGVkIHNpbmNlIGZyZWV6aW5nLCB0aGVpciBlbnRpdGllc1xuICAgIC8vIHdpbGwgaGF2ZSBhbGVhZHkgYmVlbiByZW1vdmVkIGJ5IE5BRi5cbiAgICAvLyBOb3RlIHRoYXQgZGVsZXRlIG1lc3NhZ2VzIGhhdmUgbm8gXCJvd25lclwiIHNvIHdlIGhhdmUgdG8gY2hlY2sgZm9yIHRoYXQgYXMgd2VsbC5cbiAgICBpZiAoZGF0YS5vd25lciAmJiAhdGhpcy5vY2N1cGFudHNbZGF0YS5vd25lcl0pIHJldHVybiBudWxsO1xuXG4gICAgLy8gSWdub3JlIG1lc3NhZ2VzIGZyb20gdXNlcnMgdGhhdCB3ZSBtYXkgaGF2ZSBibG9ja2VkIHdoaWxlIGZyb3plbi5cbiAgICBpZiAoZGF0YS5vd25lciAmJiB0aGlzLmJsb2NrZWRDbGllbnRzLmhhcyhkYXRhLm93bmVyKSkgcmV0dXJuIG51bGw7XG5cbiAgICByZXR1cm4gZGF0YVxuICB9XG5cbiAgLy8gVXNlZCBleHRlcm5hbGx5XG4gIGdldFBlbmRpbmdEYXRhRm9yTmV0d29ya0lkKG5ldHdvcmtJZCkge1xuICAgIHJldHVybiB0aGlzLmdldFBlbmRpbmdEYXRhKG5ldHdvcmtJZCwgdGhpcy5mcm96ZW5VcGRhdGVzLmdldChuZXR3b3JrSWQpKTtcbiAgfVxuXG4gIGZsdXNoUGVuZGluZ1VwZGF0ZXMoKSB7XG4gICAgZm9yIChjb25zdCBbbmV0d29ya0lkLCBtZXNzYWdlXSBvZiB0aGlzLmZyb3plblVwZGF0ZXMpIHtcbiAgICAgIGxldCBkYXRhID0gdGhpcy5nZXRQZW5kaW5nRGF0YShuZXR3b3JrSWQsIG1lc3NhZ2UpO1xuICAgICAgaWYgKCFkYXRhKSBjb250aW51ZTtcblxuICAgICAgLy8gT3ZlcnJpZGUgdGhlIGRhdGEgdHlwZSBvbiBcInVtXCIgbWVzc2FnZXMgdHlwZXMsIHNpbmNlIHdlIGV4dHJhY3QgZW50aXR5IHVwZGF0ZXMgZnJvbSBcInVtXCIgbWVzc2FnZXMgaW50b1xuICAgICAgLy8gaW5kaXZpZHVhbCBmcm96ZW5VcGRhdGVzIGluIHN0b3JlU2luZ2xlTWVzc2FnZS5cbiAgICAgIGNvbnN0IGRhdGFUeXBlID0gbWVzc2FnZS5kYXRhVHlwZSA9PT0gXCJ1bVwiID8gXCJ1XCIgOiBtZXNzYWdlLmRhdGFUeXBlO1xuXG4gICAgICB0aGlzLm9uT2NjdXBhbnRNZXNzYWdlKG51bGwsIGRhdGFUeXBlLCBkYXRhLCBtZXNzYWdlLnNvdXJjZSk7XG4gICAgfVxuICAgIHRoaXMuZnJvemVuVXBkYXRlcy5jbGVhcigpO1xuICB9XG5cbiAgc3RvcmVNZXNzYWdlKG1lc3NhZ2UpIHtcbiAgICBpZiAobWVzc2FnZS5kYXRhVHlwZSA9PT0gXCJ1bVwiKSB7IC8vIFVwZGF0ZU11bHRpXG4gICAgICBmb3IgKGxldCBpID0gMCwgbCA9IG1lc3NhZ2UuZGF0YS5kLmxlbmd0aDsgaSA8IGw7IGkrKykge1xuICAgICAgICB0aGlzLnN0b3JlU2luZ2xlTWVzc2FnZShtZXNzYWdlLCBpKTtcbiAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy5zdG9yZVNpbmdsZU1lc3NhZ2UobWVzc2FnZSk7XG4gICAgfVxuICB9XG5cbiAgc3RvcmVTaW5nbGVNZXNzYWdlKG1lc3NhZ2UsIGluZGV4KSB7XG4gICAgY29uc3QgZGF0YSA9IGluZGV4ICE9PSB1bmRlZmluZWQgPyBtZXNzYWdlLmRhdGEuZFtpbmRleF0gOiBtZXNzYWdlLmRhdGE7XG4gICAgY29uc3QgZGF0YVR5cGUgPSBtZXNzYWdlLmRhdGFUeXBlO1xuICAgIGNvbnN0IHNvdXJjZSA9IG1lc3NhZ2Uuc291cmNlO1xuXG4gICAgY29uc3QgbmV0d29ya0lkID0gZGF0YS5uZXR3b3JrSWQ7XG5cbiAgICBpZiAoIXRoaXMuZnJvemVuVXBkYXRlcy5oYXMobmV0d29ya0lkKSkge1xuICAgICAgdGhpcy5mcm96ZW5VcGRhdGVzLnNldChuZXR3b3JrSWQsIG1lc3NhZ2UpO1xuICAgIH0gZWxzZSB7XG4gICAgICBjb25zdCBzdG9yZWRNZXNzYWdlID0gdGhpcy5mcm96ZW5VcGRhdGVzLmdldChuZXR3b3JrSWQpO1xuICAgICAgY29uc3Qgc3RvcmVkRGF0YSA9IHN0b3JlZE1lc3NhZ2UuZGF0YVR5cGUgPT09IFwidW1cIiA/IHRoaXMuZGF0YUZvclVwZGF0ZU11bHRpTWVzc2FnZShuZXR3b3JrSWQsIHN0b3JlZE1lc3NhZ2UpIDogc3RvcmVkTWVzc2FnZS5kYXRhO1xuXG4gICAgICAvLyBBdm9pZCB1cGRhdGluZyBjb21wb25lbnRzIGlmIHRoZSBlbnRpdHkgZGF0YSByZWNlaXZlZCBkaWQgbm90IGNvbWUgZnJvbSB0aGUgY3VycmVudCBvd25lci5cbiAgICAgIGNvbnN0IGlzT3V0ZGF0ZWRNZXNzYWdlID0gZGF0YS5sYXN0T3duZXJUaW1lIDwgc3RvcmVkRGF0YS5sYXN0T3duZXJUaW1lO1xuICAgICAgY29uc3QgaXNDb250ZW1wb3JhbmVvdXNNZXNzYWdlID0gZGF0YS5sYXN0T3duZXJUaW1lID09PSBzdG9yZWREYXRhLmxhc3RPd25lclRpbWU7XG4gICAgICBpZiAoaXNPdXRkYXRlZE1lc3NhZ2UgfHwgKGlzQ29udGVtcG9yYW5lb3VzTWVzc2FnZSAmJiBzdG9yZWREYXRhLm93bmVyID4gZGF0YS5vd25lcikpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgICAgfVxuXG4gICAgICBpZiAoZGF0YVR5cGUgPT09IFwiclwiKSB7XG4gICAgICAgIGNvbnN0IGNyZWF0ZWRXaGlsZUZyb3plbiA9IHN0b3JlZERhdGEgJiYgc3RvcmVkRGF0YS5pc0ZpcnN0U3luYztcbiAgICAgICAgaWYgKGNyZWF0ZWRXaGlsZUZyb3plbikge1xuICAgICAgICAgIC8vIElmIHRoZSBlbnRpdHkgd2FzIGNyZWF0ZWQgYW5kIGRlbGV0ZWQgd2hpbGUgZnJvemVuLCBkb24ndCBib3RoZXIgY29udmV5aW5nIGFueXRoaW5nIHRvIHRoZSBjb25zdW1lci5cbiAgICAgICAgICB0aGlzLmZyb3plblVwZGF0ZXMuZGVsZXRlKG5ldHdvcmtJZCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgLy8gRGVsZXRlIG1lc3NhZ2VzIG92ZXJyaWRlIGFueSBvdGhlciBtZXNzYWdlcyBmb3IgdGhpcyBlbnRpdHlcbiAgICAgICAgICB0aGlzLmZyb3plblVwZGF0ZXMuc2V0KG5ldHdvcmtJZCwgbWVzc2FnZSk7XG4gICAgICAgIH1cbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIC8vIG1lcmdlIGluIGNvbXBvbmVudCB1cGRhdGVzXG4gICAgICAgIGlmIChzdG9yZWREYXRhLmNvbXBvbmVudHMgJiYgZGF0YS5jb21wb25lbnRzKSB7XG4gICAgICAgICAgT2JqZWN0LmFzc2lnbihzdG9yZWREYXRhLmNvbXBvbmVudHMsIGRhdGEuY29tcG9uZW50cyk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBvbkRhdGFDaGFubmVsTWVzc2FnZShlLCBzb3VyY2UpIHtcbiAgICB0aGlzLm9uRGF0YShKU09OLnBhcnNlKGUuZGF0YSksIHNvdXJjZSk7XG4gIH1cblxuICBvbkRhdGEobWVzc2FnZSwgc291cmNlKSB7XG4gICAgaWYgKGRlYnVnLmVuYWJsZWQpIHtcbiAgICAgIGRlYnVnKGBEQyBpbjogJHttZXNzYWdlfWApO1xuICAgIH1cblxuICAgIGlmICghbWVzc2FnZS5kYXRhVHlwZSkgcmV0dXJuO1xuXG4gICAgbWVzc2FnZS5zb3VyY2UgPSBzb3VyY2U7XG5cbiAgICBpZiAodGhpcy5mcm96ZW4pIHtcbiAgICAgIHRoaXMuc3RvcmVNZXNzYWdlKG1lc3NhZ2UpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLm9uT2NjdXBhbnRNZXNzYWdlKG51bGwsIG1lc3NhZ2UuZGF0YVR5cGUsIG1lc3NhZ2UuZGF0YSwgbWVzc2FnZS5zb3VyY2UpO1xuICAgIH1cbiAgfVxuXG4gIHNob3VsZFN0YXJ0Q29ubmVjdGlvblRvKGNsaWVudCkge1xuICAgIHJldHVybiB0cnVlO1xuICB9XG5cbiAgc3RhcnRTdHJlYW1Db25uZWN0aW9uKGNsaWVudCkge31cblxuICBjbG9zZVN0cmVhbUNvbm5lY3Rpb24oY2xpZW50KSB7fVxuXG4gIGdldENvbm5lY3RTdGF0dXMoY2xpZW50SWQpIHtcbiAgICByZXR1cm4gdGhpcy5vY2N1cGFudHNbY2xpZW50SWRdID8gTkFGLmFkYXB0ZXJzLklTX0NPTk5FQ1RFRCA6IE5BRi5hZGFwdGVycy5OT1RfQ09OTkVDVEVEO1xuICB9XG5cbiAgYXN5bmMgdXBkYXRlVGltZU9mZnNldCgpIHtcbiAgICBpZiAodGhpcy5pc0Rpc2Nvbm5lY3RlZCgpKSByZXR1cm47XG5cbiAgICBjb25zdCBjbGllbnRTZW50VGltZSA9IERhdGUubm93KCk7XG5cbiAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChkb2N1bWVudC5sb2NhdGlvbi5ocmVmLCB7XG4gICAgICBtZXRob2Q6IFwiSEVBRFwiLFxuICAgICAgY2FjaGU6IFwibm8tY2FjaGVcIlxuICAgIH0pO1xuXG4gICAgY29uc3QgcHJlY2lzaW9uID0gMTAwMDtcbiAgICBjb25zdCBzZXJ2ZXJSZWNlaXZlZFRpbWUgPSBuZXcgRGF0ZShyZXMuaGVhZGVycy5nZXQoXCJEYXRlXCIpKS5nZXRUaW1lKCkgKyBwcmVjaXNpb24gLyAyO1xuICAgIGNvbnN0IGNsaWVudFJlY2VpdmVkVGltZSA9IERhdGUubm93KCk7XG4gICAgY29uc3Qgc2VydmVyVGltZSA9IHNlcnZlclJlY2VpdmVkVGltZSArIChjbGllbnRSZWNlaXZlZFRpbWUgLSBjbGllbnRTZW50VGltZSkgLyAyO1xuICAgIGNvbnN0IHRpbWVPZmZzZXQgPSBzZXJ2ZXJUaW1lIC0gY2xpZW50UmVjZWl2ZWRUaW1lO1xuXG4gICAgdGhpcy5zZXJ2ZXJUaW1lUmVxdWVzdHMrKztcblxuICAgIGlmICh0aGlzLnNlcnZlclRpbWVSZXF1ZXN0cyA8PSAxMCkge1xuICAgICAgdGhpcy50aW1lT2Zmc2V0cy5wdXNoKHRpbWVPZmZzZXQpO1xuICAgIH0gZWxzZSB7XG4gICAgICB0aGlzLnRpbWVPZmZzZXRzW3RoaXMuc2VydmVyVGltZVJlcXVlc3RzICUgMTBdID0gdGltZU9mZnNldDtcbiAgICB9XG5cbiAgICB0aGlzLmF2Z1RpbWVPZmZzZXQgPSB0aGlzLnRpbWVPZmZzZXRzLnJlZHVjZSgoYWNjLCBvZmZzZXQpID0+IChhY2MgKz0gb2Zmc2V0KSwgMCkgLyB0aGlzLnRpbWVPZmZzZXRzLmxlbmd0aDtcblxuICAgIGlmICh0aGlzLnNlcnZlclRpbWVSZXF1ZXN0cyA+IDEwKSB7XG4gICAgICBkZWJ1ZyhgbmV3IHNlcnZlciB0aW1lIG9mZnNldDogJHt0aGlzLmF2Z1RpbWVPZmZzZXR9bXNgKTtcbiAgICAgIHNldFRpbWVvdXQoKCkgPT4gdGhpcy51cGRhdGVUaW1lT2Zmc2V0KCksIDUgKiA2MCAqIDEwMDApOyAvLyBTeW5jIGNsb2NrIGV2ZXJ5IDUgbWludXRlcy5cbiAgICB9IGVsc2Uge1xuICAgICAgdGhpcy51cGRhdGVUaW1lT2Zmc2V0KCk7XG4gICAgfVxuICB9XG5cbiAgZ2V0U2VydmVyVGltZSgpIHtcbiAgICByZXR1cm4gRGF0ZS5ub3coKSArIHRoaXMuYXZnVGltZU9mZnNldDtcbiAgfVxuXG4gIGdldE1lZGlhU3RyZWFtKGNsaWVudElkLCB0eXBlID0gXCJhdWRpb1wiKSB7XG4gICAgaWYgKHRoaXMubWVkaWFTdHJlYW1zW2NsaWVudElkXSkge1xuICAgICAgZGVidWcoYEFscmVhZHkgaGFkICR7dHlwZX0gZm9yICR7Y2xpZW50SWR9YCk7XG4gICAgICByZXR1cm4gUHJvbWlzZS5yZXNvbHZlKHRoaXMubWVkaWFTdHJlYW1zW2NsaWVudElkXVt0eXBlXSk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGRlYnVnKGBXYWl0aW5nIG9uICR7dHlwZX0gZm9yICR7Y2xpZW50SWR9YCk7XG4gICAgICBpZiAoIXRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuaGFzKGNsaWVudElkKSkge1xuICAgICAgICB0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLnNldChjbGllbnRJZCwge30pO1xuXG4gICAgICAgIGNvbnN0IGF1ZGlvUHJvbWlzZSA9IG5ldyBQcm9taXNlKChyZXNvbHZlLCByZWplY3QpID0+IHtcbiAgICAgICAgICB0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLmdldChjbGllbnRJZCkuYXVkaW8gPSB7IHJlc29sdmUsIHJlamVjdCB9O1xuICAgICAgICB9KTtcbiAgICAgICAgY29uc3QgdmlkZW9Qcm9taXNlID0gbmV3IFByb21pc2UoKHJlc29sdmUsIHJlamVjdCkgPT4ge1xuICAgICAgICAgIHRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuZ2V0KGNsaWVudElkKS52aWRlbyA9IHsgcmVzb2x2ZSwgcmVqZWN0IH07XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuZ2V0KGNsaWVudElkKS5hdWRpby5wcm9taXNlID0gYXVkaW9Qcm9taXNlO1xuICAgICAgICB0aGlzLnBlbmRpbmdNZWRpYVJlcXVlc3RzLmdldChjbGllbnRJZCkudmlkZW8ucHJvbWlzZSA9IHZpZGVvUHJvbWlzZTtcblxuICAgICAgICBhdWRpb1Byb21pc2UuY2F0Y2goZSA9PiBjb25zb2xlLndhcm4oYCR7Y2xpZW50SWR9IGdldE1lZGlhU3RyZWFtIEF1ZGlvIEVycm9yYCwgZSkpO1xuICAgICAgICB2aWRlb1Byb21pc2UuY2F0Y2goZSA9PiBjb25zb2xlLndhcm4oYCR7Y2xpZW50SWR9IGdldE1lZGlhU3RyZWFtIFZpZGVvIEVycm9yYCwgZSkpO1xuICAgICAgfVxuICAgICAgcmV0dXJuIHRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuZ2V0KGNsaWVudElkKVt0eXBlXS5wcm9taXNlO1xuICAgIH1cbiAgfVxuXG4gIHNldE1lZGlhU3RyZWFtKGNsaWVudElkLCBzdHJlYW0pIHtcbiAgICAvLyBTYWZhcmkgZG9lc24ndCBsaWtlIGl0IHdoZW4geW91IHVzZSBzaW5nbGUgYSBtaXhlZCBtZWRpYSBzdHJlYW0gd2hlcmUgb25lIG9mIHRoZSB0cmFja3MgaXMgaW5hY3RpdmUsIHNvIHdlXG4gICAgLy8gc3BsaXQgdGhlIHRyYWNrcyBpbnRvIHR3byBzdHJlYW1zLlxuICAgIGNvbnN0IGF1ZGlvU3RyZWFtID0gbmV3IE1lZGlhU3RyZWFtKCk7XG4gICAgdHJ5IHtcbiAgICBzdHJlYW0uZ2V0QXVkaW9UcmFja3MoKS5mb3JFYWNoKHRyYWNrID0+IGF1ZGlvU3RyZWFtLmFkZFRyYWNrKHRyYWNrKSk7XG5cbiAgICB9IGNhdGNoKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybihgJHtjbGllbnRJZH0gc2V0TWVkaWFTdHJlYW0gQXVkaW8gRXJyb3JgLCBlKTtcbiAgICB9XG4gICAgY29uc3QgdmlkZW9TdHJlYW0gPSBuZXcgTWVkaWFTdHJlYW0oKTtcbiAgICB0cnkge1xuICAgIHN0cmVhbS5nZXRWaWRlb1RyYWNrcygpLmZvckVhY2godHJhY2sgPT4gdmlkZW9TdHJlYW0uYWRkVHJhY2sodHJhY2spKTtcblxuICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgIGNvbnNvbGUud2FybihgJHtjbGllbnRJZH0gc2V0TWVkaWFTdHJlYW0gVmlkZW8gRXJyb3JgLCBlKTtcbiAgICB9XG5cbiAgICB0aGlzLm1lZGlhU3RyZWFtc1tjbGllbnRJZF0gPSB7IGF1ZGlvOiBhdWRpb1N0cmVhbSwgdmlkZW86IHZpZGVvU3RyZWFtIH07XG5cbiAgICAvLyBSZXNvbHZlIHRoZSBwcm9taXNlIGZvciB0aGUgdXNlcidzIG1lZGlhIHN0cmVhbSBpZiBpdCBleGlzdHMuXG4gICAgaWYgKHRoaXMucGVuZGluZ01lZGlhUmVxdWVzdHMuaGFzKGNsaWVudElkKSkge1xuICAgICAgdGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cy5nZXQoY2xpZW50SWQpLmF1ZGlvLnJlc29sdmUoYXVkaW9TdHJlYW0pO1xuICAgICAgdGhpcy5wZW5kaW5nTWVkaWFSZXF1ZXN0cy5nZXQoY2xpZW50SWQpLnZpZGVvLnJlc29sdmUodmlkZW9TdHJlYW0pO1xuICAgIH1cbiAgfVxuXG4gIGFzeW5jIHNldExvY2FsTWVkaWFTdHJlYW0oc3RyZWFtKSB7XG4gICAgLy8gb3VyIGpvYiBoZXJlIGlzIHRvIG1ha2Ugc3VyZSB0aGUgY29ubmVjdGlvbiB3aW5kcyB1cCB3aXRoIFJUUCBzZW5kZXJzIHNlbmRpbmcgdGhlIHN0dWZmIGluIHRoaXMgc3RyZWFtLFxuICAgIC8vIGFuZCBub3QgdGhlIHN0dWZmIHRoYXQgaXNuJ3QgaW4gdGhpcyBzdHJlYW0uIHN0cmF0ZWd5IGlzIHRvIHJlcGxhY2UgZXhpc3RpbmcgdHJhY2tzIGlmIHdlIGNhbiwgYWRkIHRyYWNrc1xuICAgIC8vIHRoYXQgd2UgY2FuJ3QgcmVwbGFjZSwgYW5kIGRpc2FibGUgdHJhY2tzIHRoYXQgZG9uJ3QgZXhpc3QgYW55bW9yZS5cblxuICAgIC8vIG5vdGUgdGhhdCB3ZSBkb24ndCBldmVyIHJlbW92ZSBhIHRyYWNrIGZyb20gdGhlIHN0cmVhbSAtLSBzaW5jZSBKYW51cyBkb2Vzbid0IHN1cHBvcnQgVW5pZmllZCBQbGFuLCB3ZSBhYnNvbHV0ZWx5XG4gICAgLy8gY2FuJ3Qgd2luZCB1cCB3aXRoIGEgU0RQIHRoYXQgaGFzID4xIGF1ZGlvIG9yID4xIHZpZGVvIHRyYWNrcywgZXZlbiBpZiBvbmUgb2YgdGhlbSBpcyBpbmFjdGl2ZSAod2hhdCB5b3UgZ2V0IGlmXG4gICAgLy8geW91IHJlbW92ZSBhIHRyYWNrIGZyb20gYW4gZXhpc3Rpbmcgc3RyZWFtLilcbiAgICBpZiAodGhpcy5wdWJsaXNoZXIgJiYgdGhpcy5wdWJsaXNoZXIuY29ubikge1xuICAgICAgY29uc3QgZXhpc3RpbmdTZW5kZXJzID0gdGhpcy5wdWJsaXNoZXIuY29ubi5nZXRTZW5kZXJzKCk7XG4gICAgICBjb25zdCBuZXdTZW5kZXJzID0gW107XG4gICAgICBjb25zdCB0cmFja3MgPSBzdHJlYW0uZ2V0VHJhY2tzKCk7XG5cbiAgICAgIGZvciAobGV0IGkgPSAwOyBpIDwgdHJhY2tzLmxlbmd0aDsgaSsrKSB7XG4gICAgICAgIGNvbnN0IHQgPSB0cmFja3NbaV07XG4gICAgICAgIGNvbnN0IHNlbmRlciA9IGV4aXN0aW5nU2VuZGVycy5maW5kKHMgPT4gcy50cmFjayAhPSBudWxsICYmIHMudHJhY2sua2luZCA9PSB0LmtpbmQpO1xuXG4gICAgICAgIGlmIChzZW5kZXIgIT0gbnVsbCkge1xuICAgICAgICAgIGlmIChzZW5kZXIucmVwbGFjZVRyYWNrKSB7XG4gICAgICAgICAgICBhd2FpdCBzZW5kZXIucmVwbGFjZVRyYWNrKHQpO1xuXG4gICAgICAgICAgICAvLyBXb3JrYXJvdW5kIGh0dHBzOi8vYnVnemlsbGEubW96aWxsYS5vcmcvc2hvd19idWcuY2dpP2lkPTE1NzY3NzFcbiAgICAgICAgICAgIGlmICh0LmtpbmQgPT09IFwidmlkZW9cIiAmJiB0LmVuYWJsZWQgJiYgbmF2aWdhdG9yLnVzZXJBZ2VudC50b0xvd2VyQ2FzZSgpLmluZGV4T2YoJ2ZpcmVmb3gnKSA+IC0xKSB7XG4gICAgICAgICAgICAgIHQuZW5hYmxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICBzZXRUaW1lb3V0KCgpID0+IHQuZW5hYmxlZCA9IHRydWUsIDEwMDApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAvLyBGYWxsYmFjayBmb3IgYnJvd3NlcnMgdGhhdCBkb24ndCBzdXBwb3J0IHJlcGxhY2VUcmFjay4gQXQgdGhpcyB0aW1lIG9mIHRoaXMgd3JpdGluZ1xuICAgICAgICAgICAgLy8gbW9zdCBicm93c2VycyBzdXBwb3J0IGl0LCBhbmQgdGVzdGluZyB0aGlzIGNvZGUgcGF0aCBzZWVtcyB0byBub3Qgd29yayBwcm9wZXJseVxuICAgICAgICAgICAgLy8gaW4gQ2hyb21lIGFueW1vcmUuXG4gICAgICAgICAgICBzdHJlYW0ucmVtb3ZlVHJhY2soc2VuZGVyLnRyYWNrKTtcbiAgICAgICAgICAgIHN0cmVhbS5hZGRUcmFjayh0KTtcbiAgICAgICAgICB9XG4gICAgICAgICAgbmV3U2VuZGVycy5wdXNoKHNlbmRlcik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgbmV3U2VuZGVycy5wdXNoKHRoaXMucHVibGlzaGVyLmNvbm4uYWRkVHJhY2sodCwgc3RyZWFtKSk7XG4gICAgICAgIH1cbiAgICAgIH1cbiAgICAgIGV4aXN0aW5nU2VuZGVycy5mb3JFYWNoKHMgPT4ge1xuICAgICAgICBpZiAoIW5ld1NlbmRlcnMuaW5jbHVkZXMocykpIHtcbiAgICAgICAgICBzLnRyYWNrLmVuYWJsZWQgPSBmYWxzZTtcbiAgICAgICAgfVxuICAgICAgfSk7XG4gICAgfVxuICAgIHRoaXMubG9jYWxNZWRpYVN0cmVhbSA9IHN0cmVhbTtcbiAgICB0aGlzLnNldE1lZGlhU3RyZWFtKHRoaXMuY2xpZW50SWQsIHN0cmVhbSk7XG4gIH1cblxuICBlbmFibGVNaWNyb3Bob25lKGVuYWJsZWQpIHtcbiAgICBpZiAodGhpcy5wdWJsaXNoZXIgJiYgdGhpcy5wdWJsaXNoZXIuY29ubikge1xuICAgICAgdGhpcy5wdWJsaXNoZXIuY29ubi5nZXRTZW5kZXJzKCkuZm9yRWFjaChzID0+IHtcbiAgICAgICAgaWYgKHMudHJhY2sua2luZCA9PSBcImF1ZGlvXCIpIHtcbiAgICAgICAgICBzLnRyYWNrLmVuYWJsZWQgPSBlbmFibGVkO1xuICAgICAgICB9XG4gICAgICB9KTtcbiAgICB9XG4gIH1cblxuICBzZW5kRGF0YShjbGllbnRJZCwgZGF0YVR5cGUsIGRhdGEpIHtcbiAgICBpZiAoIXRoaXMucHVibGlzaGVyKSB7XG4gICAgICBjb25zb2xlLndhcm4oXCJzZW5kRGF0YSBjYWxsZWQgd2l0aG91dCBhIHB1Ymxpc2hlclwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3dpdGNoICh0aGlzLnVucmVsaWFibGVUcmFuc3BvcnQpIHtcbiAgICAgICAgY2FzZSBcIndlYnNvY2tldFwiOlxuICAgICAgICAgIHRoaXMucHVibGlzaGVyLmhhbmRsZS5zZW5kTWVzc2FnZSh7IGtpbmQ6IFwiZGF0YVwiLCBib2R5OiBKU09OLnN0cmluZ2lmeSh7IGRhdGFUeXBlLCBkYXRhIH0pLCB3aG9tOiBjbGllbnRJZCB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBcImRhdGFjaGFubmVsXCI6XG4gICAgICAgICAgdGhpcy5wdWJsaXNoZXIudW5yZWxpYWJsZUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeSh7IGNsaWVudElkLCBkYXRhVHlwZSwgZGF0YSB9KSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhpcy51bnJlbGlhYmxlVHJhbnNwb3J0KGNsaWVudElkLCBkYXRhVHlwZSwgZGF0YSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgc2VuZERhdGFHdWFyYW50ZWVkKGNsaWVudElkLCBkYXRhVHlwZSwgZGF0YSkge1xuICAgIGlmICghdGhpcy5wdWJsaXNoZXIpIHtcbiAgICAgIGNvbnNvbGUud2FybihcInNlbmREYXRhR3VhcmFudGVlZCBjYWxsZWQgd2l0aG91dCBhIHB1Ymxpc2hlclwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3dpdGNoICh0aGlzLnJlbGlhYmxlVHJhbnNwb3J0KSB7XG4gICAgICAgIGNhc2UgXCJ3ZWJzb2NrZXRcIjpcbiAgICAgICAgICB0aGlzLnB1Ymxpc2hlci5oYW5kbGUuc2VuZE1lc3NhZ2UoeyBraW5kOiBcImRhdGFcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBkYXRhVHlwZSwgZGF0YSB9KSwgd2hvbTogY2xpZW50SWQgfSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGNhc2UgXCJkYXRhY2hhbm5lbFwiOlxuICAgICAgICAgIHRoaXMucHVibGlzaGVyLnJlbGlhYmxlQ2hhbm5lbC5zZW5kKEpTT04uc3RyaW5naWZ5KHsgY2xpZW50SWQsIGRhdGFUeXBlLCBkYXRhIH0pKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aGlzLnJlbGlhYmxlVHJhbnNwb3J0KGNsaWVudElkLCBkYXRhVHlwZSwgZGF0YSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYnJvYWRjYXN0RGF0YShkYXRhVHlwZSwgZGF0YSkge1xuICAgIGlmICghdGhpcy5wdWJsaXNoZXIpIHtcbiAgICAgIGNvbnNvbGUud2FybihcImJyb2FkY2FzdERhdGEgY2FsbGVkIHdpdGhvdXQgYSBwdWJsaXNoZXJcIik7XG4gICAgfSBlbHNlIHtcbiAgICAgIHN3aXRjaCAodGhpcy51bnJlbGlhYmxlVHJhbnNwb3J0KSB7XG4gICAgICAgIGNhc2UgXCJ3ZWJzb2NrZXRcIjpcbiAgICAgICAgICB0aGlzLnB1Ymxpc2hlci5oYW5kbGUuc2VuZE1lc3NhZ2UoeyBraW5kOiBcImRhdGFcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBkYXRhVHlwZSwgZGF0YSB9KSB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBcImRhdGFjaGFubmVsXCI6XG4gICAgICAgICAgdGhpcy5wdWJsaXNoZXIudW5yZWxpYWJsZUNoYW5uZWwuc2VuZChKU09OLnN0cmluZ2lmeSh7IGRhdGFUeXBlLCBkYXRhIH0pKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICB0aGlzLnVucmVsaWFibGVUcmFuc3BvcnQodW5kZWZpbmVkLCBkYXRhVHlwZSwgZGF0YSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICB9XG4gICAgfVxuICB9XG5cbiAgYnJvYWRjYXN0RGF0YUd1YXJhbnRlZWQoZGF0YVR5cGUsIGRhdGEpIHtcbiAgICBpZiAoIXRoaXMucHVibGlzaGVyKSB7XG4gICAgICBjb25zb2xlLndhcm4oXCJicm9hZGNhc3REYXRhR3VhcmFudGVlZCBjYWxsZWQgd2l0aG91dCBhIHB1Ymxpc2hlclwiKTtcbiAgICB9IGVsc2Uge1xuICAgICAgc3dpdGNoICh0aGlzLnJlbGlhYmxlVHJhbnNwb3J0KSB7XG4gICAgICAgIGNhc2UgXCJ3ZWJzb2NrZXRcIjpcbiAgICAgICAgICB0aGlzLnB1Ymxpc2hlci5oYW5kbGUuc2VuZE1lc3NhZ2UoeyBraW5kOiBcImRhdGFcIiwgYm9keTogSlNPTi5zdHJpbmdpZnkoeyBkYXRhVHlwZSwgZGF0YSB9KSB9KTtcbiAgICAgICAgICBicmVhaztcbiAgICAgICAgY2FzZSBcImRhdGFjaGFubmVsXCI6XG4gICAgICAgICAgdGhpcy5wdWJsaXNoZXIucmVsaWFibGVDaGFubmVsLnNlbmQoSlNPTi5zdHJpbmdpZnkoeyBkYXRhVHlwZSwgZGF0YSB9KSk7XG4gICAgICAgICAgYnJlYWs7XG4gICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgdGhpcy5yZWxpYWJsZVRyYW5zcG9ydCh1bmRlZmluZWQsIGRhdGFUeXBlLCBkYXRhKTtcbiAgICAgICAgICBicmVhaztcbiAgICAgIH1cbiAgICB9XG4gIH1cblxuICBraWNrKGNsaWVudElkLCBwZXJtc1Rva2VuKSB7XG4gICAgcmV0dXJuIHRoaXMucHVibGlzaGVyLmhhbmRsZS5zZW5kTWVzc2FnZSh7IGtpbmQ6IFwia2lja1wiLCByb29tX2lkOiB0aGlzLnJvb20sIHVzZXJfaWQ6IGNsaWVudElkLCB0b2tlbjogcGVybXNUb2tlbiB9KS50aGVuKCgpID0+IHtcbiAgICAgIGRvY3VtZW50LmJvZHkuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoXCJraWNrZWRcIiwgeyBkZXRhaWw6IHsgY2xpZW50SWQ6IGNsaWVudElkIH0gfSkpO1xuICAgIH0pO1xuICB9XG5cbiAgYmxvY2soY2xpZW50SWQpIHtcbiAgICByZXR1cm4gdGhpcy5wdWJsaXNoZXIuaGFuZGxlLnNlbmRNZXNzYWdlKHsga2luZDogXCJibG9ja1wiLCB3aG9tOiBjbGllbnRJZCB9KS50aGVuKCgpID0+IHtcbiAgICAgIHRoaXMuYmxvY2tlZENsaWVudHMuc2V0KGNsaWVudElkLCB0cnVlKTtcbiAgICAgIGRvY3VtZW50LmJvZHkuZGlzcGF0Y2hFdmVudChuZXcgQ3VzdG9tRXZlbnQoXCJibG9ja2VkXCIsIHsgZGV0YWlsOiB7IGNsaWVudElkOiBjbGllbnRJZCB9IH0pKTtcbiAgICB9KTtcbiAgfVxuXG4gIHVuYmxvY2soY2xpZW50SWQpIHtcbiAgICByZXR1cm4gdGhpcy5wdWJsaXNoZXIuaGFuZGxlLnNlbmRNZXNzYWdlKHsga2luZDogXCJ1bmJsb2NrXCIsIHdob206IGNsaWVudElkIH0pLnRoZW4oKCkgPT4ge1xuICAgICAgdGhpcy5ibG9ja2VkQ2xpZW50cy5kZWxldGUoY2xpZW50SWQpO1xuICAgICAgZG9jdW1lbnQuYm9keS5kaXNwYXRjaEV2ZW50KG5ldyBDdXN0b21FdmVudChcInVuYmxvY2tlZFwiLCB7IGRldGFpbDogeyBjbGllbnRJZDogY2xpZW50SWQgfSB9KSk7XG4gICAgfSk7XG4gIH1cbn1cblxuTkFGLmFkYXB0ZXJzLnJlZ2lzdGVyKFwiamFudXNcIiwgSmFudXNBZGFwdGVyKTtcblxubW9kdWxlLmV4cG9ydHMgPSBKYW51c0FkYXB0ZXI7XG4iLCIvKiBlc2xpbnQtZW52IGJyb3dzZXIgKi9cblxuLyoqXG4gKiBUaGlzIGlzIHRoZSB3ZWIgYnJvd3NlciBpbXBsZW1lbnRhdGlvbiBvZiBgZGVidWcoKWAuXG4gKi9cblxuZXhwb3J0cy5mb3JtYXRBcmdzID0gZm9ybWF0QXJncztcbmV4cG9ydHMuc2F2ZSA9IHNhdmU7XG5leHBvcnRzLmxvYWQgPSBsb2FkO1xuZXhwb3J0cy51c2VDb2xvcnMgPSB1c2VDb2xvcnM7XG5leHBvcnRzLnN0b3JhZ2UgPSBsb2NhbHN0b3JhZ2UoKTtcbmV4cG9ydHMuZGVzdHJveSA9ICgoKSA9PiB7XG5cdGxldCB3YXJuZWQgPSBmYWxzZTtcblxuXHRyZXR1cm4gKCkgPT4ge1xuXHRcdGlmICghd2FybmVkKSB7XG5cdFx0XHR3YXJuZWQgPSB0cnVlO1xuXHRcdFx0Y29uc29sZS53YXJuKCdJbnN0YW5jZSBtZXRob2QgYGRlYnVnLmRlc3Ryb3koKWAgaXMgZGVwcmVjYXRlZCBhbmQgbm8gbG9uZ2VyIGRvZXMgYW55dGhpbmcuIEl0IHdpbGwgYmUgcmVtb3ZlZCBpbiB0aGUgbmV4dCBtYWpvciB2ZXJzaW9uIG9mIGBkZWJ1Z2AuJyk7XG5cdFx0fVxuXHR9O1xufSkoKTtcblxuLyoqXG4gKiBDb2xvcnMuXG4gKi9cblxuZXhwb3J0cy5jb2xvcnMgPSBbXG5cdCcjMDAwMENDJyxcblx0JyMwMDAwRkYnLFxuXHQnIzAwMzNDQycsXG5cdCcjMDAzM0ZGJyxcblx0JyMwMDY2Q0MnLFxuXHQnIzAwNjZGRicsXG5cdCcjMDA5OUNDJyxcblx0JyMwMDk5RkYnLFxuXHQnIzAwQ0MwMCcsXG5cdCcjMDBDQzMzJyxcblx0JyMwMENDNjYnLFxuXHQnIzAwQ0M5OScsXG5cdCcjMDBDQ0NDJyxcblx0JyMwMENDRkYnLFxuXHQnIzMzMDBDQycsXG5cdCcjMzMwMEZGJyxcblx0JyMzMzMzQ0MnLFxuXHQnIzMzMzNGRicsXG5cdCcjMzM2NkNDJyxcblx0JyMzMzY2RkYnLFxuXHQnIzMzOTlDQycsXG5cdCcjMzM5OUZGJyxcblx0JyMzM0NDMDAnLFxuXHQnIzMzQ0MzMycsXG5cdCcjMzNDQzY2Jyxcblx0JyMzM0NDOTknLFxuXHQnIzMzQ0NDQycsXG5cdCcjMzNDQ0ZGJyxcblx0JyM2NjAwQ0MnLFxuXHQnIzY2MDBGRicsXG5cdCcjNjYzM0NDJyxcblx0JyM2NjMzRkYnLFxuXHQnIzY2Q0MwMCcsXG5cdCcjNjZDQzMzJyxcblx0JyM5OTAwQ0MnLFxuXHQnIzk5MDBGRicsXG5cdCcjOTkzM0NDJyxcblx0JyM5OTMzRkYnLFxuXHQnIzk5Q0MwMCcsXG5cdCcjOTlDQzMzJyxcblx0JyNDQzAwMDAnLFxuXHQnI0NDMDAzMycsXG5cdCcjQ0MwMDY2Jyxcblx0JyNDQzAwOTknLFxuXHQnI0NDMDBDQycsXG5cdCcjQ0MwMEZGJyxcblx0JyNDQzMzMDAnLFxuXHQnI0NDMzMzMycsXG5cdCcjQ0MzMzY2Jyxcblx0JyNDQzMzOTknLFxuXHQnI0NDMzNDQycsXG5cdCcjQ0MzM0ZGJyxcblx0JyNDQzY2MDAnLFxuXHQnI0NDNjYzMycsXG5cdCcjQ0M5OTAwJyxcblx0JyNDQzk5MzMnLFxuXHQnI0NDQ0MwMCcsXG5cdCcjQ0NDQzMzJyxcblx0JyNGRjAwMDAnLFxuXHQnI0ZGMDAzMycsXG5cdCcjRkYwMDY2Jyxcblx0JyNGRjAwOTknLFxuXHQnI0ZGMDBDQycsXG5cdCcjRkYwMEZGJyxcblx0JyNGRjMzMDAnLFxuXHQnI0ZGMzMzMycsXG5cdCcjRkYzMzY2Jyxcblx0JyNGRjMzOTknLFxuXHQnI0ZGMzNDQycsXG5cdCcjRkYzM0ZGJyxcblx0JyNGRjY2MDAnLFxuXHQnI0ZGNjYzMycsXG5cdCcjRkY5OTAwJyxcblx0JyNGRjk5MzMnLFxuXHQnI0ZGQ0MwMCcsXG5cdCcjRkZDQzMzJ1xuXTtcblxuLyoqXG4gKiBDdXJyZW50bHkgb25seSBXZWJLaXQtYmFzZWQgV2ViIEluc3BlY3RvcnMsIEZpcmVmb3ggPj0gdjMxLFxuICogYW5kIHRoZSBGaXJlYnVnIGV4dGVuc2lvbiAoYW55IEZpcmVmb3ggdmVyc2lvbikgYXJlIGtub3duXG4gKiB0byBzdXBwb3J0IFwiJWNcIiBDU1MgY3VzdG9taXphdGlvbnMuXG4gKlxuICogVE9ETzogYWRkIGEgYGxvY2FsU3RvcmFnZWAgdmFyaWFibGUgdG8gZXhwbGljaXRseSBlbmFibGUvZGlzYWJsZSBjb2xvcnNcbiAqL1xuXG4vLyBlc2xpbnQtZGlzYWJsZS1uZXh0LWxpbmUgY29tcGxleGl0eVxuZnVuY3Rpb24gdXNlQ29sb3JzKCkge1xuXHQvLyBOQjogSW4gYW4gRWxlY3Ryb24gcHJlbG9hZCBzY3JpcHQsIGRvY3VtZW50IHdpbGwgYmUgZGVmaW5lZCBidXQgbm90IGZ1bGx5XG5cdC8vIGluaXRpYWxpemVkLiBTaW5jZSB3ZSBrbm93IHdlJ3JlIGluIENocm9tZSwgd2UnbGwganVzdCBkZXRlY3QgdGhpcyBjYXNlXG5cdC8vIGV4cGxpY2l0bHlcblx0aWYgKHR5cGVvZiB3aW5kb3cgIT09ICd1bmRlZmluZWQnICYmIHdpbmRvdy5wcm9jZXNzICYmICh3aW5kb3cucHJvY2Vzcy50eXBlID09PSAncmVuZGVyZXInIHx8IHdpbmRvdy5wcm9jZXNzLl9fbndqcykpIHtcblx0XHRyZXR1cm4gdHJ1ZTtcblx0fVxuXG5cdC8vIEludGVybmV0IEV4cGxvcmVyIGFuZCBFZGdlIGRvIG5vdCBzdXBwb3J0IGNvbG9ycy5cblx0aWYgKHR5cGVvZiBuYXZpZ2F0b3IgIT09ICd1bmRlZmluZWQnICYmIG5hdmlnYXRvci51c2VyQWdlbnQgJiYgbmF2aWdhdG9yLnVzZXJBZ2VudC50b0xvd2VyQ2FzZSgpLm1hdGNoKC8oZWRnZXx0cmlkZW50KVxcLyhcXGQrKS8pKSB7XG5cdFx0cmV0dXJuIGZhbHNlO1xuXHR9XG5cblx0Ly8gSXMgd2Via2l0PyBodHRwOi8vc3RhY2tvdmVyZmxvdy5jb20vYS8xNjQ1OTYwNi8zNzY3NzNcblx0Ly8gZG9jdW1lbnQgaXMgdW5kZWZpbmVkIGluIHJlYWN0LW5hdGl2ZTogaHR0cHM6Ly9naXRodWIuY29tL2ZhY2Vib29rL3JlYWN0LW5hdGl2ZS9wdWxsLzE2MzJcblx0cmV0dXJuICh0eXBlb2YgZG9jdW1lbnQgIT09ICd1bmRlZmluZWQnICYmIGRvY3VtZW50LmRvY3VtZW50RWxlbWVudCAmJiBkb2N1bWVudC5kb2N1bWVudEVsZW1lbnQuc3R5bGUgJiYgZG9jdW1lbnQuZG9jdW1lbnRFbGVtZW50LnN0eWxlLldlYmtpdEFwcGVhcmFuY2UpIHx8XG5cdFx0Ly8gSXMgZmlyZWJ1Zz8gaHR0cDovL3N0YWNrb3ZlcmZsb3cuY29tL2EvMzk4MTIwLzM3Njc3M1xuXHRcdCh0eXBlb2Ygd2luZG93ICE9PSAndW5kZWZpbmVkJyAmJiB3aW5kb3cuY29uc29sZSAmJiAod2luZG93LmNvbnNvbGUuZmlyZWJ1ZyB8fCAod2luZG93LmNvbnNvbGUuZXhjZXB0aW9uICYmIHdpbmRvdy5jb25zb2xlLnRhYmxlKSkpIHx8XG5cdFx0Ly8gSXMgZmlyZWZveCA+PSB2MzE/XG5cdFx0Ly8gaHR0cHM6Ly9kZXZlbG9wZXIubW96aWxsYS5vcmcvZW4tVVMvZG9jcy9Ub29scy9XZWJfQ29uc29sZSNTdHlsaW5nX21lc3NhZ2VzXG5cdFx0KHR5cGVvZiBuYXZpZ2F0b3IgIT09ICd1bmRlZmluZWQnICYmIG5hdmlnYXRvci51c2VyQWdlbnQgJiYgbmF2aWdhdG9yLnVzZXJBZ2VudC50b0xvd2VyQ2FzZSgpLm1hdGNoKC9maXJlZm94XFwvKFxcZCspLykgJiYgcGFyc2VJbnQoUmVnRXhwLiQxLCAxMCkgPj0gMzEpIHx8XG5cdFx0Ly8gRG91YmxlIGNoZWNrIHdlYmtpdCBpbiB1c2VyQWdlbnQganVzdCBpbiBjYXNlIHdlIGFyZSBpbiBhIHdvcmtlclxuXHRcdCh0eXBlb2YgbmF2aWdhdG9yICE9PSAndW5kZWZpbmVkJyAmJiBuYXZpZ2F0b3IudXNlckFnZW50ICYmIG5hdmlnYXRvci51c2VyQWdlbnQudG9Mb3dlckNhc2UoKS5tYXRjaCgvYXBwbGV3ZWJraXRcXC8oXFxkKykvKSk7XG59XG5cbi8qKlxuICogQ29sb3JpemUgbG9nIGFyZ3VtZW50cyBpZiBlbmFibGVkLlxuICpcbiAqIEBhcGkgcHVibGljXG4gKi9cblxuZnVuY3Rpb24gZm9ybWF0QXJncyhhcmdzKSB7XG5cdGFyZ3NbMF0gPSAodGhpcy51c2VDb2xvcnMgPyAnJWMnIDogJycpICtcblx0XHR0aGlzLm5hbWVzcGFjZSArXG5cdFx0KHRoaXMudXNlQ29sb3JzID8gJyAlYycgOiAnICcpICtcblx0XHRhcmdzWzBdICtcblx0XHQodGhpcy51c2VDb2xvcnMgPyAnJWMgJyA6ICcgJykgK1xuXHRcdCcrJyArIG1vZHVsZS5leHBvcnRzLmh1bWFuaXplKHRoaXMuZGlmZik7XG5cblx0aWYgKCF0aGlzLnVzZUNvbG9ycykge1xuXHRcdHJldHVybjtcblx0fVxuXG5cdGNvbnN0IGMgPSAnY29sb3I6ICcgKyB0aGlzLmNvbG9yO1xuXHRhcmdzLnNwbGljZSgxLCAwLCBjLCAnY29sb3I6IGluaGVyaXQnKTtcblxuXHQvLyBUaGUgZmluYWwgXCIlY1wiIGlzIHNvbWV3aGF0IHRyaWNreSwgYmVjYXVzZSB0aGVyZSBjb3VsZCBiZSBvdGhlclxuXHQvLyBhcmd1bWVudHMgcGFzc2VkIGVpdGhlciBiZWZvcmUgb3IgYWZ0ZXIgdGhlICVjLCBzbyB3ZSBuZWVkIHRvXG5cdC8vIGZpZ3VyZSBvdXQgdGhlIGNvcnJlY3QgaW5kZXggdG8gaW5zZXJ0IHRoZSBDU1MgaW50b1xuXHRsZXQgaW5kZXggPSAwO1xuXHRsZXQgbGFzdEMgPSAwO1xuXHRhcmdzWzBdLnJlcGxhY2UoLyVbYS16QS1aJV0vZywgbWF0Y2ggPT4ge1xuXHRcdGlmIChtYXRjaCA9PT0gJyUlJykge1xuXHRcdFx0cmV0dXJuO1xuXHRcdH1cblx0XHRpbmRleCsrO1xuXHRcdGlmIChtYXRjaCA9PT0gJyVjJykge1xuXHRcdFx0Ly8gV2Ugb25seSBhcmUgaW50ZXJlc3RlZCBpbiB0aGUgKmxhc3QqICVjXG5cdFx0XHQvLyAodGhlIHVzZXIgbWF5IGhhdmUgcHJvdmlkZWQgdGhlaXIgb3duKVxuXHRcdFx0bGFzdEMgPSBpbmRleDtcblx0XHR9XG5cdH0pO1xuXG5cdGFyZ3Muc3BsaWNlKGxhc3RDLCAwLCBjKTtcbn1cblxuLyoqXG4gKiBJbnZva2VzIGBjb25zb2xlLmRlYnVnKClgIHdoZW4gYXZhaWxhYmxlLlxuICogTm8tb3Agd2hlbiBgY29uc29sZS5kZWJ1Z2AgaXMgbm90IGEgXCJmdW5jdGlvblwiLlxuICogSWYgYGNvbnNvbGUuZGVidWdgIGlzIG5vdCBhdmFpbGFibGUsIGZhbGxzIGJhY2tcbiAqIHRvIGBjb25zb2xlLmxvZ2AuXG4gKlxuICogQGFwaSBwdWJsaWNcbiAqL1xuZXhwb3J0cy5sb2cgPSBjb25zb2xlLmRlYnVnIHx8IGNvbnNvbGUubG9nIHx8ICgoKSA9PiB7fSk7XG5cbi8qKlxuICogU2F2ZSBgbmFtZXNwYWNlc2AuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IG5hbWVzcGFjZXNcbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5mdW5jdGlvbiBzYXZlKG5hbWVzcGFjZXMpIHtcblx0dHJ5IHtcblx0XHRpZiAobmFtZXNwYWNlcykge1xuXHRcdFx0ZXhwb3J0cy5zdG9yYWdlLnNldEl0ZW0oJ2RlYnVnJywgbmFtZXNwYWNlcyk7XG5cdFx0fSBlbHNlIHtcblx0XHRcdGV4cG9ydHMuc3RvcmFnZS5yZW1vdmVJdGVtKCdkZWJ1ZycpO1xuXHRcdH1cblx0fSBjYXRjaCAoZXJyb3IpIHtcblx0XHQvLyBTd2FsbG93XG5cdFx0Ly8gWFhYIChAUWl4LSkgc2hvdWxkIHdlIGJlIGxvZ2dpbmcgdGhlc2U/XG5cdH1cbn1cblxuLyoqXG4gKiBMb2FkIGBuYW1lc3BhY2VzYC5cbiAqXG4gKiBAcmV0dXJuIHtTdHJpbmd9IHJldHVybnMgdGhlIHByZXZpb3VzbHkgcGVyc2lzdGVkIGRlYnVnIG1vZGVzXG4gKiBAYXBpIHByaXZhdGVcbiAqL1xuZnVuY3Rpb24gbG9hZCgpIHtcblx0bGV0IHI7XG5cdHRyeSB7XG5cdFx0ciA9IGV4cG9ydHMuc3RvcmFnZS5nZXRJdGVtKCdkZWJ1ZycpO1xuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdC8vIFN3YWxsb3dcblx0XHQvLyBYWFggKEBRaXgtKSBzaG91bGQgd2UgYmUgbG9nZ2luZyB0aGVzZT9cblx0fVxuXG5cdC8vIElmIGRlYnVnIGlzbid0IHNldCBpbiBMUywgYW5kIHdlJ3JlIGluIEVsZWN0cm9uLCB0cnkgdG8gbG9hZCAkREVCVUdcblx0aWYgKCFyICYmIHR5cGVvZiBwcm9jZXNzICE9PSAndW5kZWZpbmVkJyAmJiAnZW52JyBpbiBwcm9jZXNzKSB7XG5cdFx0ciA9IHByb2Nlc3MuZW52LkRFQlVHO1xuXHR9XG5cblx0cmV0dXJuIHI7XG59XG5cbi8qKlxuICogTG9jYWxzdG9yYWdlIGF0dGVtcHRzIHRvIHJldHVybiB0aGUgbG9jYWxzdG9yYWdlLlxuICpcbiAqIFRoaXMgaXMgbmVjZXNzYXJ5IGJlY2F1c2Ugc2FmYXJpIHRocm93c1xuICogd2hlbiBhIHVzZXIgZGlzYWJsZXMgY29va2llcy9sb2NhbHN0b3JhZ2VcbiAqIGFuZCB5b3UgYXR0ZW1wdCB0byBhY2Nlc3MgaXQuXG4gKlxuICogQHJldHVybiB7TG9jYWxTdG9yYWdlfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gbG9jYWxzdG9yYWdlKCkge1xuXHR0cnkge1xuXHRcdC8vIFRWTUxLaXQgKEFwcGxlIFRWIEpTIFJ1bnRpbWUpIGRvZXMgbm90IGhhdmUgYSB3aW5kb3cgb2JqZWN0LCBqdXN0IGxvY2FsU3RvcmFnZSBpbiB0aGUgZ2xvYmFsIGNvbnRleHRcblx0XHQvLyBUaGUgQnJvd3NlciBhbHNvIGhhcyBsb2NhbFN0b3JhZ2UgaW4gdGhlIGdsb2JhbCBjb250ZXh0LlxuXHRcdHJldHVybiBsb2NhbFN0b3JhZ2U7XG5cdH0gY2F0Y2ggKGVycm9yKSB7XG5cdFx0Ly8gU3dhbGxvd1xuXHRcdC8vIFhYWCAoQFFpeC0pIHNob3VsZCB3ZSBiZSBsb2dnaW5nIHRoZXNlP1xuXHR9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gcmVxdWlyZSgnLi9jb21tb24nKShleHBvcnRzKTtcblxuY29uc3Qge2Zvcm1hdHRlcnN9ID0gbW9kdWxlLmV4cG9ydHM7XG5cbi8qKlxuICogTWFwICVqIHRvIGBKU09OLnN0cmluZ2lmeSgpYCwgc2luY2Ugbm8gV2ViIEluc3BlY3RvcnMgZG8gdGhhdCBieSBkZWZhdWx0LlxuICovXG5cbmZvcm1hdHRlcnMuaiA9IGZ1bmN0aW9uICh2KSB7XG5cdHRyeSB7XG5cdFx0cmV0dXJuIEpTT04uc3RyaW5naWZ5KHYpO1xuXHR9IGNhdGNoIChlcnJvcikge1xuXHRcdHJldHVybiAnW1VuZXhwZWN0ZWRKU09OUGFyc2VFcnJvcl06ICcgKyBlcnJvci5tZXNzYWdlO1xuXHR9XG59O1xuIiwiXG4vKipcbiAqIFRoaXMgaXMgdGhlIGNvbW1vbiBsb2dpYyBmb3IgYm90aCB0aGUgTm9kZS5qcyBhbmQgd2ViIGJyb3dzZXJcbiAqIGltcGxlbWVudGF0aW9ucyBvZiBgZGVidWcoKWAuXG4gKi9cblxuZnVuY3Rpb24gc2V0dXAoZW52KSB7XG5cdGNyZWF0ZURlYnVnLmRlYnVnID0gY3JlYXRlRGVidWc7XG5cdGNyZWF0ZURlYnVnLmRlZmF1bHQgPSBjcmVhdGVEZWJ1Zztcblx0Y3JlYXRlRGVidWcuY29lcmNlID0gY29lcmNlO1xuXHRjcmVhdGVEZWJ1Zy5kaXNhYmxlID0gZGlzYWJsZTtcblx0Y3JlYXRlRGVidWcuZW5hYmxlID0gZW5hYmxlO1xuXHRjcmVhdGVEZWJ1Zy5lbmFibGVkID0gZW5hYmxlZDtcblx0Y3JlYXRlRGVidWcuaHVtYW5pemUgPSByZXF1aXJlKCdtcycpO1xuXHRjcmVhdGVEZWJ1Zy5kZXN0cm95ID0gZGVzdHJveTtcblxuXHRPYmplY3Qua2V5cyhlbnYpLmZvckVhY2goa2V5ID0+IHtcblx0XHRjcmVhdGVEZWJ1Z1trZXldID0gZW52W2tleV07XG5cdH0pO1xuXG5cdC8qKlxuXHQqIFRoZSBjdXJyZW50bHkgYWN0aXZlIGRlYnVnIG1vZGUgbmFtZXMsIGFuZCBuYW1lcyB0byBza2lwLlxuXHQqL1xuXG5cdGNyZWF0ZURlYnVnLm5hbWVzID0gW107XG5cdGNyZWF0ZURlYnVnLnNraXBzID0gW107XG5cblx0LyoqXG5cdCogTWFwIG9mIHNwZWNpYWwgXCIlblwiIGhhbmRsaW5nIGZ1bmN0aW9ucywgZm9yIHRoZSBkZWJ1ZyBcImZvcm1hdFwiIGFyZ3VtZW50LlxuXHQqXG5cdCogVmFsaWQga2V5IG5hbWVzIGFyZSBhIHNpbmdsZSwgbG93ZXIgb3IgdXBwZXItY2FzZSBsZXR0ZXIsIGkuZS4gXCJuXCIgYW5kIFwiTlwiLlxuXHQqL1xuXHRjcmVhdGVEZWJ1Zy5mb3JtYXR0ZXJzID0ge307XG5cblx0LyoqXG5cdCogU2VsZWN0cyBhIGNvbG9yIGZvciBhIGRlYnVnIG5hbWVzcGFjZVxuXHQqIEBwYXJhbSB7U3RyaW5nfSBuYW1lc3BhY2UgVGhlIG5hbWVzcGFjZSBzdHJpbmcgZm9yIHRoZSBkZWJ1ZyBpbnN0YW5jZSB0byBiZSBjb2xvcmVkXG5cdCogQHJldHVybiB7TnVtYmVyfFN0cmluZ30gQW4gQU5TSSBjb2xvciBjb2RlIGZvciB0aGUgZ2l2ZW4gbmFtZXNwYWNlXG5cdCogQGFwaSBwcml2YXRlXG5cdCovXG5cdGZ1bmN0aW9uIHNlbGVjdENvbG9yKG5hbWVzcGFjZSkge1xuXHRcdGxldCBoYXNoID0gMDtcblxuXHRcdGZvciAobGV0IGkgPSAwOyBpIDwgbmFtZXNwYWNlLmxlbmd0aDsgaSsrKSB7XG5cdFx0XHRoYXNoID0gKChoYXNoIDw8IDUpIC0gaGFzaCkgKyBuYW1lc3BhY2UuY2hhckNvZGVBdChpKTtcblx0XHRcdGhhc2ggfD0gMDsgLy8gQ29udmVydCB0byAzMmJpdCBpbnRlZ2VyXG5cdFx0fVxuXG5cdFx0cmV0dXJuIGNyZWF0ZURlYnVnLmNvbG9yc1tNYXRoLmFicyhoYXNoKSAlIGNyZWF0ZURlYnVnLmNvbG9ycy5sZW5ndGhdO1xuXHR9XG5cdGNyZWF0ZURlYnVnLnNlbGVjdENvbG9yID0gc2VsZWN0Q29sb3I7XG5cblx0LyoqXG5cdCogQ3JlYXRlIGEgZGVidWdnZXIgd2l0aCB0aGUgZ2l2ZW4gYG5hbWVzcGFjZWAuXG5cdCpcblx0KiBAcGFyYW0ge1N0cmluZ30gbmFtZXNwYWNlXG5cdCogQHJldHVybiB7RnVuY3Rpb259XG5cdCogQGFwaSBwdWJsaWNcblx0Ki9cblx0ZnVuY3Rpb24gY3JlYXRlRGVidWcobmFtZXNwYWNlKSB7XG5cdFx0bGV0IHByZXZUaW1lO1xuXHRcdGxldCBlbmFibGVPdmVycmlkZSA9IG51bGw7XG5cdFx0bGV0IG5hbWVzcGFjZXNDYWNoZTtcblx0XHRsZXQgZW5hYmxlZENhY2hlO1xuXG5cdFx0ZnVuY3Rpb24gZGVidWcoLi4uYXJncykge1xuXHRcdFx0Ly8gRGlzYWJsZWQ/XG5cdFx0XHRpZiAoIWRlYnVnLmVuYWJsZWQpIHtcblx0XHRcdFx0cmV0dXJuO1xuXHRcdFx0fVxuXG5cdFx0XHRjb25zdCBzZWxmID0gZGVidWc7XG5cblx0XHRcdC8vIFNldCBgZGlmZmAgdGltZXN0YW1wXG5cdFx0XHRjb25zdCBjdXJyID0gTnVtYmVyKG5ldyBEYXRlKCkpO1xuXHRcdFx0Y29uc3QgbXMgPSBjdXJyIC0gKHByZXZUaW1lIHx8IGN1cnIpO1xuXHRcdFx0c2VsZi5kaWZmID0gbXM7XG5cdFx0XHRzZWxmLnByZXYgPSBwcmV2VGltZTtcblx0XHRcdHNlbGYuY3VyciA9IGN1cnI7XG5cdFx0XHRwcmV2VGltZSA9IGN1cnI7XG5cblx0XHRcdGFyZ3NbMF0gPSBjcmVhdGVEZWJ1Zy5jb2VyY2UoYXJnc1swXSk7XG5cblx0XHRcdGlmICh0eXBlb2YgYXJnc1swXSAhPT0gJ3N0cmluZycpIHtcblx0XHRcdFx0Ly8gQW55dGhpbmcgZWxzZSBsZXQncyBpbnNwZWN0IHdpdGggJU9cblx0XHRcdFx0YXJncy51bnNoaWZ0KCclTycpO1xuXHRcdFx0fVxuXG5cdFx0XHQvLyBBcHBseSBhbnkgYGZvcm1hdHRlcnNgIHRyYW5zZm9ybWF0aW9uc1xuXHRcdFx0bGV0IGluZGV4ID0gMDtcblx0XHRcdGFyZ3NbMF0gPSBhcmdzWzBdLnJlcGxhY2UoLyUoW2EtekEtWiVdKS9nLCAobWF0Y2gsIGZvcm1hdCkgPT4ge1xuXHRcdFx0XHQvLyBJZiB3ZSBlbmNvdW50ZXIgYW4gZXNjYXBlZCAlIHRoZW4gZG9uJ3QgaW5jcmVhc2UgdGhlIGFycmF5IGluZGV4XG5cdFx0XHRcdGlmIChtYXRjaCA9PT0gJyUlJykge1xuXHRcdFx0XHRcdHJldHVybiAnJSc7XG5cdFx0XHRcdH1cblx0XHRcdFx0aW5kZXgrKztcblx0XHRcdFx0Y29uc3QgZm9ybWF0dGVyID0gY3JlYXRlRGVidWcuZm9ybWF0dGVyc1tmb3JtYXRdO1xuXHRcdFx0XHRpZiAodHlwZW9mIGZvcm1hdHRlciA9PT0gJ2Z1bmN0aW9uJykge1xuXHRcdFx0XHRcdGNvbnN0IHZhbCA9IGFyZ3NbaW5kZXhdO1xuXHRcdFx0XHRcdG1hdGNoID0gZm9ybWF0dGVyLmNhbGwoc2VsZiwgdmFsKTtcblxuXHRcdFx0XHRcdC8vIE5vdyB3ZSBuZWVkIHRvIHJlbW92ZSBgYXJnc1tpbmRleF1gIHNpbmNlIGl0J3MgaW5saW5lZCBpbiB0aGUgYGZvcm1hdGBcblx0XHRcdFx0XHRhcmdzLnNwbGljZShpbmRleCwgMSk7XG5cdFx0XHRcdFx0aW5kZXgtLTtcblx0XHRcdFx0fVxuXHRcdFx0XHRyZXR1cm4gbWF0Y2g7XG5cdFx0XHR9KTtcblxuXHRcdFx0Ly8gQXBwbHkgZW52LXNwZWNpZmljIGZvcm1hdHRpbmcgKGNvbG9ycywgZXRjLilcblx0XHRcdGNyZWF0ZURlYnVnLmZvcm1hdEFyZ3MuY2FsbChzZWxmLCBhcmdzKTtcblxuXHRcdFx0Y29uc3QgbG9nRm4gPSBzZWxmLmxvZyB8fCBjcmVhdGVEZWJ1Zy5sb2c7XG5cdFx0XHRsb2dGbi5hcHBseShzZWxmLCBhcmdzKTtcblx0XHR9XG5cblx0XHRkZWJ1Zy5uYW1lc3BhY2UgPSBuYW1lc3BhY2U7XG5cdFx0ZGVidWcudXNlQ29sb3JzID0gY3JlYXRlRGVidWcudXNlQ29sb3JzKCk7XG5cdFx0ZGVidWcuY29sb3IgPSBjcmVhdGVEZWJ1Zy5zZWxlY3RDb2xvcihuYW1lc3BhY2UpO1xuXHRcdGRlYnVnLmV4dGVuZCA9IGV4dGVuZDtcblx0XHRkZWJ1Zy5kZXN0cm95ID0gY3JlYXRlRGVidWcuZGVzdHJveTsgLy8gWFhYIFRlbXBvcmFyeS4gV2lsbCBiZSByZW1vdmVkIGluIHRoZSBuZXh0IG1ham9yIHJlbGVhc2UuXG5cblx0XHRPYmplY3QuZGVmaW5lUHJvcGVydHkoZGVidWcsICdlbmFibGVkJywge1xuXHRcdFx0ZW51bWVyYWJsZTogdHJ1ZSxcblx0XHRcdGNvbmZpZ3VyYWJsZTogZmFsc2UsXG5cdFx0XHRnZXQ6ICgpID0+IHtcblx0XHRcdFx0aWYgKGVuYWJsZU92ZXJyaWRlICE9PSBudWxsKSB7XG5cdFx0XHRcdFx0cmV0dXJuIGVuYWJsZU92ZXJyaWRlO1xuXHRcdFx0XHR9XG5cdFx0XHRcdGlmIChuYW1lc3BhY2VzQ2FjaGUgIT09IGNyZWF0ZURlYnVnLm5hbWVzcGFjZXMpIHtcblx0XHRcdFx0XHRuYW1lc3BhY2VzQ2FjaGUgPSBjcmVhdGVEZWJ1Zy5uYW1lc3BhY2VzO1xuXHRcdFx0XHRcdGVuYWJsZWRDYWNoZSA9IGNyZWF0ZURlYnVnLmVuYWJsZWQobmFtZXNwYWNlKTtcblx0XHRcdFx0fVxuXG5cdFx0XHRcdHJldHVybiBlbmFibGVkQ2FjaGU7XG5cdFx0XHR9LFxuXHRcdFx0c2V0OiB2ID0+IHtcblx0XHRcdFx0ZW5hYmxlT3ZlcnJpZGUgPSB2O1xuXHRcdFx0fVxuXHRcdH0pO1xuXG5cdFx0Ly8gRW52LXNwZWNpZmljIGluaXRpYWxpemF0aW9uIGxvZ2ljIGZvciBkZWJ1ZyBpbnN0YW5jZXNcblx0XHRpZiAodHlwZW9mIGNyZWF0ZURlYnVnLmluaXQgPT09ICdmdW5jdGlvbicpIHtcblx0XHRcdGNyZWF0ZURlYnVnLmluaXQoZGVidWcpO1xuXHRcdH1cblxuXHRcdHJldHVybiBkZWJ1Zztcblx0fVxuXG5cdGZ1bmN0aW9uIGV4dGVuZChuYW1lc3BhY2UsIGRlbGltaXRlcikge1xuXHRcdGNvbnN0IG5ld0RlYnVnID0gY3JlYXRlRGVidWcodGhpcy5uYW1lc3BhY2UgKyAodHlwZW9mIGRlbGltaXRlciA9PT0gJ3VuZGVmaW5lZCcgPyAnOicgOiBkZWxpbWl0ZXIpICsgbmFtZXNwYWNlKTtcblx0XHRuZXdEZWJ1Zy5sb2cgPSB0aGlzLmxvZztcblx0XHRyZXR1cm4gbmV3RGVidWc7XG5cdH1cblxuXHQvKipcblx0KiBFbmFibGVzIGEgZGVidWcgbW9kZSBieSBuYW1lc3BhY2VzLiBUaGlzIGNhbiBpbmNsdWRlIG1vZGVzXG5cdCogc2VwYXJhdGVkIGJ5IGEgY29sb24gYW5kIHdpbGRjYXJkcy5cblx0KlxuXHQqIEBwYXJhbSB7U3RyaW5nfSBuYW1lc3BhY2VzXG5cdCogQGFwaSBwdWJsaWNcblx0Ki9cblx0ZnVuY3Rpb24gZW5hYmxlKG5hbWVzcGFjZXMpIHtcblx0XHRjcmVhdGVEZWJ1Zy5zYXZlKG5hbWVzcGFjZXMpO1xuXHRcdGNyZWF0ZURlYnVnLm5hbWVzcGFjZXMgPSBuYW1lc3BhY2VzO1xuXG5cdFx0Y3JlYXRlRGVidWcubmFtZXMgPSBbXTtcblx0XHRjcmVhdGVEZWJ1Zy5za2lwcyA9IFtdO1xuXG5cdFx0bGV0IGk7XG5cdFx0Y29uc3Qgc3BsaXQgPSAodHlwZW9mIG5hbWVzcGFjZXMgPT09ICdzdHJpbmcnID8gbmFtZXNwYWNlcyA6ICcnKS5zcGxpdCgvW1xccyxdKy8pO1xuXHRcdGNvbnN0IGxlbiA9IHNwbGl0Lmxlbmd0aDtcblxuXHRcdGZvciAoaSA9IDA7IGkgPCBsZW47IGkrKykge1xuXHRcdFx0aWYgKCFzcGxpdFtpXSkge1xuXHRcdFx0XHQvLyBpZ25vcmUgZW1wdHkgc3RyaW5nc1xuXHRcdFx0XHRjb250aW51ZTtcblx0XHRcdH1cblxuXHRcdFx0bmFtZXNwYWNlcyA9IHNwbGl0W2ldLnJlcGxhY2UoL1xcKi9nLCAnLio/Jyk7XG5cblx0XHRcdGlmIChuYW1lc3BhY2VzWzBdID09PSAnLScpIHtcblx0XHRcdFx0Y3JlYXRlRGVidWcuc2tpcHMucHVzaChuZXcgUmVnRXhwKCdeJyArIG5hbWVzcGFjZXMuc2xpY2UoMSkgKyAnJCcpKTtcblx0XHRcdH0gZWxzZSB7XG5cdFx0XHRcdGNyZWF0ZURlYnVnLm5hbWVzLnB1c2gobmV3IFJlZ0V4cCgnXicgKyBuYW1lc3BhY2VzICsgJyQnKSk7XG5cdFx0XHR9XG5cdFx0fVxuXHR9XG5cblx0LyoqXG5cdCogRGlzYWJsZSBkZWJ1ZyBvdXRwdXQuXG5cdCpcblx0KiBAcmV0dXJuIHtTdHJpbmd9IG5hbWVzcGFjZXNcblx0KiBAYXBpIHB1YmxpY1xuXHQqL1xuXHRmdW5jdGlvbiBkaXNhYmxlKCkge1xuXHRcdGNvbnN0IG5hbWVzcGFjZXMgPSBbXG5cdFx0XHQuLi5jcmVhdGVEZWJ1Zy5uYW1lcy5tYXAodG9OYW1lc3BhY2UpLFxuXHRcdFx0Li4uY3JlYXRlRGVidWcuc2tpcHMubWFwKHRvTmFtZXNwYWNlKS5tYXAobmFtZXNwYWNlID0+ICctJyArIG5hbWVzcGFjZSlcblx0XHRdLmpvaW4oJywnKTtcblx0XHRjcmVhdGVEZWJ1Zy5lbmFibGUoJycpO1xuXHRcdHJldHVybiBuYW1lc3BhY2VzO1xuXHR9XG5cblx0LyoqXG5cdCogUmV0dXJucyB0cnVlIGlmIHRoZSBnaXZlbiBtb2RlIG5hbWUgaXMgZW5hYmxlZCwgZmFsc2Ugb3RoZXJ3aXNlLlxuXHQqXG5cdCogQHBhcmFtIHtTdHJpbmd9IG5hbWVcblx0KiBAcmV0dXJuIHtCb29sZWFufVxuXHQqIEBhcGkgcHVibGljXG5cdCovXG5cdGZ1bmN0aW9uIGVuYWJsZWQobmFtZSkge1xuXHRcdGlmIChuYW1lW25hbWUubGVuZ3RoIC0gMV0gPT09ICcqJykge1xuXHRcdFx0cmV0dXJuIHRydWU7XG5cdFx0fVxuXG5cdFx0bGV0IGk7XG5cdFx0bGV0IGxlbjtcblxuXHRcdGZvciAoaSA9IDAsIGxlbiA9IGNyZWF0ZURlYnVnLnNraXBzLmxlbmd0aDsgaSA8IGxlbjsgaSsrKSB7XG5cdFx0XHRpZiAoY3JlYXRlRGVidWcuc2tpcHNbaV0udGVzdChuYW1lKSkge1xuXHRcdFx0XHRyZXR1cm4gZmFsc2U7XG5cdFx0XHR9XG5cdFx0fVxuXG5cdFx0Zm9yIChpID0gMCwgbGVuID0gY3JlYXRlRGVidWcubmFtZXMubGVuZ3RoOyBpIDwgbGVuOyBpKyspIHtcblx0XHRcdGlmIChjcmVhdGVEZWJ1Zy5uYW1lc1tpXS50ZXN0KG5hbWUpKSB7XG5cdFx0XHRcdHJldHVybiB0cnVlO1xuXHRcdFx0fVxuXHRcdH1cblxuXHRcdHJldHVybiBmYWxzZTtcblx0fVxuXG5cdC8qKlxuXHQqIENvbnZlcnQgcmVnZXhwIHRvIG5hbWVzcGFjZVxuXHQqXG5cdCogQHBhcmFtIHtSZWdFeHB9IHJlZ3hlcFxuXHQqIEByZXR1cm4ge1N0cmluZ30gbmFtZXNwYWNlXG5cdCogQGFwaSBwcml2YXRlXG5cdCovXG5cdGZ1bmN0aW9uIHRvTmFtZXNwYWNlKHJlZ2V4cCkge1xuXHRcdHJldHVybiByZWdleHAudG9TdHJpbmcoKVxuXHRcdFx0LnN1YnN0cmluZygyLCByZWdleHAudG9TdHJpbmcoKS5sZW5ndGggLSAyKVxuXHRcdFx0LnJlcGxhY2UoL1xcLlxcKlxcPyQvLCAnKicpO1xuXHR9XG5cblx0LyoqXG5cdCogQ29lcmNlIGB2YWxgLlxuXHQqXG5cdCogQHBhcmFtIHtNaXhlZH0gdmFsXG5cdCogQHJldHVybiB7TWl4ZWR9XG5cdCogQGFwaSBwcml2YXRlXG5cdCovXG5cdGZ1bmN0aW9uIGNvZXJjZSh2YWwpIHtcblx0XHRpZiAodmFsIGluc3RhbmNlb2YgRXJyb3IpIHtcblx0XHRcdHJldHVybiB2YWwuc3RhY2sgfHwgdmFsLm1lc3NhZ2U7XG5cdFx0fVxuXHRcdHJldHVybiB2YWw7XG5cdH1cblxuXHQvKipcblx0KiBYWFggRE8gTk9UIFVTRS4gVGhpcyBpcyBhIHRlbXBvcmFyeSBzdHViIGZ1bmN0aW9uLlxuXHQqIFhYWCBJdCBXSUxMIGJlIHJlbW92ZWQgaW4gdGhlIG5leHQgbWFqb3IgcmVsZWFzZS5cblx0Ki9cblx0ZnVuY3Rpb24gZGVzdHJveSgpIHtcblx0XHRjb25zb2xlLndhcm4oJ0luc3RhbmNlIG1ldGhvZCBgZGVidWcuZGVzdHJveSgpYCBpcyBkZXByZWNhdGVkIGFuZCBubyBsb25nZXIgZG9lcyBhbnl0aGluZy4gSXQgd2lsbCBiZSByZW1vdmVkIGluIHRoZSBuZXh0IG1ham9yIHZlcnNpb24gb2YgYGRlYnVnYC4nKTtcblx0fVxuXG5cdGNyZWF0ZURlYnVnLmVuYWJsZShjcmVhdGVEZWJ1Zy5sb2FkKCkpO1xuXG5cdHJldHVybiBjcmVhdGVEZWJ1Zztcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBzZXR1cDtcbiIsIi8qKlxuICogSGVscGVycy5cbiAqL1xuXG52YXIgcyA9IDEwMDA7XG52YXIgbSA9IHMgKiA2MDtcbnZhciBoID0gbSAqIDYwO1xudmFyIGQgPSBoICogMjQ7XG52YXIgdyA9IGQgKiA3O1xudmFyIHkgPSBkICogMzY1LjI1O1xuXG4vKipcbiAqIFBhcnNlIG9yIGZvcm1hdCB0aGUgZ2l2ZW4gYHZhbGAuXG4gKlxuICogT3B0aW9uczpcbiAqXG4gKiAgLSBgbG9uZ2AgdmVyYm9zZSBmb3JtYXR0aW5nIFtmYWxzZV1cbiAqXG4gKiBAcGFyYW0ge1N0cmluZ3xOdW1iZXJ9IHZhbFxuICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXVxuICogQHRocm93cyB7RXJyb3J9IHRocm93IGFuIGVycm9yIGlmIHZhbCBpcyBub3QgYSBub24tZW1wdHkgc3RyaW5nIG9yIGEgbnVtYmVyXG4gKiBAcmV0dXJuIHtTdHJpbmd8TnVtYmVyfVxuICogQGFwaSBwdWJsaWNcbiAqL1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKHZhbCwgb3B0aW9ucykge1xuICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgdmFyIHR5cGUgPSB0eXBlb2YgdmFsO1xuICBpZiAodHlwZSA9PT0gJ3N0cmluZycgJiYgdmFsLmxlbmd0aCA+IDApIHtcbiAgICByZXR1cm4gcGFyc2UodmFsKTtcbiAgfSBlbHNlIGlmICh0eXBlID09PSAnbnVtYmVyJyAmJiBpc0Zpbml0ZSh2YWwpKSB7XG4gICAgcmV0dXJuIG9wdGlvbnMubG9uZyA/IGZtdExvbmcodmFsKSA6IGZtdFNob3J0KHZhbCk7XG4gIH1cbiAgdGhyb3cgbmV3IEVycm9yKFxuICAgICd2YWwgaXMgbm90IGEgbm9uLWVtcHR5IHN0cmluZyBvciBhIHZhbGlkIG51bWJlci4gdmFsPScgK1xuICAgICAgSlNPTi5zdHJpbmdpZnkodmFsKVxuICApO1xufTtcblxuLyoqXG4gKiBQYXJzZSB0aGUgZ2l2ZW4gYHN0cmAgYW5kIHJldHVybiBtaWxsaXNlY29uZHMuXG4gKlxuICogQHBhcmFtIHtTdHJpbmd9IHN0clxuICogQHJldHVybiB7TnVtYmVyfVxuICogQGFwaSBwcml2YXRlXG4gKi9cblxuZnVuY3Rpb24gcGFyc2Uoc3RyKSB7XG4gIHN0ciA9IFN0cmluZyhzdHIpO1xuICBpZiAoc3RyLmxlbmd0aCA+IDEwMCkge1xuICAgIHJldHVybjtcbiAgfVxuICB2YXIgbWF0Y2ggPSAvXigtPyg/OlxcZCspP1xcLj9cXGQrKSAqKG1pbGxpc2Vjb25kcz98bXNlY3M/fG1zfHNlY29uZHM/fHNlY3M/fHN8bWludXRlcz98bWlucz98bXxob3Vycz98aHJzP3xofGRheXM/fGR8d2Vla3M/fHd8eWVhcnM/fHlycz98eSk/JC9pLmV4ZWMoXG4gICAgc3RyXG4gICk7XG4gIGlmICghbWF0Y2gpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgdmFyIG4gPSBwYXJzZUZsb2F0KG1hdGNoWzFdKTtcbiAgdmFyIHR5cGUgPSAobWF0Y2hbMl0gfHwgJ21zJykudG9Mb3dlckNhc2UoKTtcbiAgc3dpdGNoICh0eXBlKSB7XG4gICAgY2FzZSAneWVhcnMnOlxuICAgIGNhc2UgJ3llYXInOlxuICAgIGNhc2UgJ3lycyc6XG4gICAgY2FzZSAneXInOlxuICAgIGNhc2UgJ3knOlxuICAgICAgcmV0dXJuIG4gKiB5O1xuICAgIGNhc2UgJ3dlZWtzJzpcbiAgICBjYXNlICd3ZWVrJzpcbiAgICBjYXNlICd3JzpcbiAgICAgIHJldHVybiBuICogdztcbiAgICBjYXNlICdkYXlzJzpcbiAgICBjYXNlICdkYXknOlxuICAgIGNhc2UgJ2QnOlxuICAgICAgcmV0dXJuIG4gKiBkO1xuICAgIGNhc2UgJ2hvdXJzJzpcbiAgICBjYXNlICdob3VyJzpcbiAgICBjYXNlICdocnMnOlxuICAgIGNhc2UgJ2hyJzpcbiAgICBjYXNlICdoJzpcbiAgICAgIHJldHVybiBuICogaDtcbiAgICBjYXNlICdtaW51dGVzJzpcbiAgICBjYXNlICdtaW51dGUnOlxuICAgIGNhc2UgJ21pbnMnOlxuICAgIGNhc2UgJ21pbic6XG4gICAgY2FzZSAnbSc6XG4gICAgICByZXR1cm4gbiAqIG07XG4gICAgY2FzZSAnc2Vjb25kcyc6XG4gICAgY2FzZSAnc2Vjb25kJzpcbiAgICBjYXNlICdzZWNzJzpcbiAgICBjYXNlICdzZWMnOlxuICAgIGNhc2UgJ3MnOlxuICAgICAgcmV0dXJuIG4gKiBzO1xuICAgIGNhc2UgJ21pbGxpc2Vjb25kcyc6XG4gICAgY2FzZSAnbWlsbGlzZWNvbmQnOlxuICAgIGNhc2UgJ21zZWNzJzpcbiAgICBjYXNlICdtc2VjJzpcbiAgICBjYXNlICdtcyc6XG4gICAgICByZXR1cm4gbjtcbiAgICBkZWZhdWx0OlxuICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgfVxufVxuXG4vKipcbiAqIFNob3J0IGZvcm1hdCBmb3IgYG1zYC5cbiAqXG4gKiBAcGFyYW0ge051bWJlcn0gbXNcbiAqIEByZXR1cm4ge1N0cmluZ31cbiAqIEBhcGkgcHJpdmF0ZVxuICovXG5cbmZ1bmN0aW9uIGZtdFNob3J0KG1zKSB7XG4gIHZhciBtc0FicyA9IE1hdGguYWJzKG1zKTtcbiAgaWYgKG1zQWJzID49IGQpIHtcbiAgICByZXR1cm4gTWF0aC5yb3VuZChtcyAvIGQpICsgJ2QnO1xuICB9XG4gIGlmIChtc0FicyA+PSBoKSB7XG4gICAgcmV0dXJuIE1hdGgucm91bmQobXMgLyBoKSArICdoJztcbiAgfVxuICBpZiAobXNBYnMgPj0gbSkge1xuICAgIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gbSkgKyAnbSc7XG4gIH1cbiAgaWYgKG1zQWJzID49IHMpIHtcbiAgICByZXR1cm4gTWF0aC5yb3VuZChtcyAvIHMpICsgJ3MnO1xuICB9XG4gIHJldHVybiBtcyArICdtcyc7XG59XG5cbi8qKlxuICogTG9uZyBmb3JtYXQgZm9yIGBtc2AuXG4gKlxuICogQHBhcmFtIHtOdW1iZXJ9IG1zXG4gKiBAcmV0dXJuIHtTdHJpbmd9XG4gKiBAYXBpIHByaXZhdGVcbiAqL1xuXG5mdW5jdGlvbiBmbXRMb25nKG1zKSB7XG4gIHZhciBtc0FicyA9IE1hdGguYWJzKG1zKTtcbiAgaWYgKG1zQWJzID49IGQpIHtcbiAgICByZXR1cm4gcGx1cmFsKG1zLCBtc0FicywgZCwgJ2RheScpO1xuICB9XG4gIGlmIChtc0FicyA+PSBoKSB7XG4gICAgcmV0dXJuIHBsdXJhbChtcywgbXNBYnMsIGgsICdob3VyJyk7XG4gIH1cbiAgaWYgKG1zQWJzID49IG0pIHtcbiAgICByZXR1cm4gcGx1cmFsKG1zLCBtc0FicywgbSwgJ21pbnV0ZScpO1xuICB9XG4gIGlmIChtc0FicyA+PSBzKSB7XG4gICAgcmV0dXJuIHBsdXJhbChtcywgbXNBYnMsIHMsICdzZWNvbmQnKTtcbiAgfVxuICByZXR1cm4gbXMgKyAnIG1zJztcbn1cblxuLyoqXG4gKiBQbHVyYWxpemF0aW9uIGhlbHBlci5cbiAqL1xuXG5mdW5jdGlvbiBwbHVyYWwobXMsIG1zQWJzLCBuLCBuYW1lKSB7XG4gIHZhciBpc1BsdXJhbCA9IG1zQWJzID49IG4gKiAxLjU7XG4gIHJldHVybiBNYXRoLnJvdW5kKG1zIC8gbikgKyAnICcgKyBuYW1lICsgKGlzUGx1cmFsID8gJ3MnIDogJycpO1xufVxuIiwiLyogZXNsaW50LWVudiBub2RlICovXG4ndXNlIHN0cmljdCc7XG5cbi8vIFNEUCBoZWxwZXJzLlxuY29uc3QgU0RQVXRpbHMgPSB7fTtcblxuLy8gR2VuZXJhdGUgYW4gYWxwaGFudW1lcmljIGlkZW50aWZpZXIgZm9yIGNuYW1lIG9yIG1pZHMuXG4vLyBUT0RPOiB1c2UgVVVJRHMgaW5zdGVhZD8gaHR0cHM6Ly9naXN0LmdpdGh1Yi5jb20vamVkLzk4Mjg4M1xuU0RQVXRpbHMuZ2VuZXJhdGVJZGVudGlmaWVyID0gZnVuY3Rpb24oKSB7XG4gIHJldHVybiBNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zdWJzdHJpbmcoMiwgMTIpO1xufTtcblxuLy8gVGhlIFJUQ1AgQ05BTUUgdXNlZCBieSBhbGwgcGVlcmNvbm5lY3Rpb25zIGZyb20gdGhlIHNhbWUgSlMuXG5TRFBVdGlscy5sb2NhbENOYW1lID0gU0RQVXRpbHMuZ2VuZXJhdGVJZGVudGlmaWVyKCk7XG5cbi8vIFNwbGl0cyBTRFAgaW50byBsaW5lcywgZGVhbGluZyB3aXRoIGJvdGggQ1JMRiBhbmQgTEYuXG5TRFBVdGlscy5zcGxpdExpbmVzID0gZnVuY3Rpb24oYmxvYikge1xuICByZXR1cm4gYmxvYi50cmltKCkuc3BsaXQoJ1xcbicpLm1hcChsaW5lID0+IGxpbmUudHJpbSgpKTtcbn07XG4vLyBTcGxpdHMgU0RQIGludG8gc2Vzc2lvbnBhcnQgYW5kIG1lZGlhc2VjdGlvbnMuIEVuc3VyZXMgQ1JMRi5cblNEUFV0aWxzLnNwbGl0U2VjdGlvbnMgPSBmdW5jdGlvbihibG9iKSB7XG4gIGNvbnN0IHBhcnRzID0gYmxvYi5zcGxpdCgnXFxubT0nKTtcbiAgcmV0dXJuIHBhcnRzLm1hcCgocGFydCwgaW5kZXgpID0+IChpbmRleCA+IDAgP1xuICAgICdtPScgKyBwYXJ0IDogcGFydCkudHJpbSgpICsgJ1xcclxcbicpO1xufTtcblxuLy8gUmV0dXJucyB0aGUgc2Vzc2lvbiBkZXNjcmlwdGlvbi5cblNEUFV0aWxzLmdldERlc2NyaXB0aW9uID0gZnVuY3Rpb24oYmxvYikge1xuICBjb25zdCBzZWN0aW9ucyA9IFNEUFV0aWxzLnNwbGl0U2VjdGlvbnMoYmxvYik7XG4gIHJldHVybiBzZWN0aW9ucyAmJiBzZWN0aW9uc1swXTtcbn07XG5cbi8vIFJldHVybnMgdGhlIGluZGl2aWR1YWwgbWVkaWEgc2VjdGlvbnMuXG5TRFBVdGlscy5nZXRNZWRpYVNlY3Rpb25zID0gZnVuY3Rpb24oYmxvYikge1xuICBjb25zdCBzZWN0aW9ucyA9IFNEUFV0aWxzLnNwbGl0U2VjdGlvbnMoYmxvYik7XG4gIHNlY3Rpb25zLnNoaWZ0KCk7XG4gIHJldHVybiBzZWN0aW9ucztcbn07XG5cbi8vIFJldHVybnMgbGluZXMgdGhhdCBzdGFydCB3aXRoIGEgY2VydGFpbiBwcmVmaXguXG5TRFBVdGlscy5tYXRjaFByZWZpeCA9IGZ1bmN0aW9uKGJsb2IsIHByZWZpeCkge1xuICByZXR1cm4gU0RQVXRpbHMuc3BsaXRMaW5lcyhibG9iKS5maWx0ZXIobGluZSA9PiBsaW5lLmluZGV4T2YocHJlZml4KSA9PT0gMCk7XG59O1xuXG4vLyBQYXJzZXMgYW4gSUNFIGNhbmRpZGF0ZSBsaW5lLiBTYW1wbGUgaW5wdXQ6XG4vLyBjYW5kaWRhdGU6NzAyNzg2MzUwIDIgdWRwIDQxODE5OTAyIDguOC44LjggNjA3NjkgdHlwIHJlbGF5IHJhZGRyIDguOC44Ljhcbi8vIHJwb3J0IDU1OTk2XCJcbi8vIElucHV0IGNhbiBiZSBwcmVmaXhlZCB3aXRoIGE9LlxuU0RQVXRpbHMucGFyc2VDYW5kaWRhdGUgPSBmdW5jdGlvbihsaW5lKSB7XG4gIGxldCBwYXJ0cztcbiAgLy8gUGFyc2UgYm90aCB2YXJpYW50cy5cbiAgaWYgKGxpbmUuaW5kZXhPZignYT1jYW5kaWRhdGU6JykgPT09IDApIHtcbiAgICBwYXJ0cyA9IGxpbmUuc3Vic3RyaW5nKDEyKS5zcGxpdCgnICcpO1xuICB9IGVsc2Uge1xuICAgIHBhcnRzID0gbGluZS5zdWJzdHJpbmcoMTApLnNwbGl0KCcgJyk7XG4gIH1cblxuICBjb25zdCBjYW5kaWRhdGUgPSB7XG4gICAgZm91bmRhdGlvbjogcGFydHNbMF0sXG4gICAgY29tcG9uZW50OiB7MTogJ3J0cCcsIDI6ICdydGNwJ31bcGFydHNbMV1dIHx8IHBhcnRzWzFdLFxuICAgIHByb3RvY29sOiBwYXJ0c1syXS50b0xvd2VyQ2FzZSgpLFxuICAgIHByaW9yaXR5OiBwYXJzZUludChwYXJ0c1szXSwgMTApLFxuICAgIGlwOiBwYXJ0c1s0XSxcbiAgICBhZGRyZXNzOiBwYXJ0c1s0XSwgLy8gYWRkcmVzcyBpcyBhbiBhbGlhcyBmb3IgaXAuXG4gICAgcG9ydDogcGFyc2VJbnQocGFydHNbNV0sIDEwKSxcbiAgICAvLyBza2lwIHBhcnRzWzZdID09ICd0eXAnXG4gICAgdHlwZTogcGFydHNbN10sXG4gIH07XG5cbiAgZm9yIChsZXQgaSA9IDg7IGkgPCBwYXJ0cy5sZW5ndGg7IGkgKz0gMikge1xuICAgIHN3aXRjaCAocGFydHNbaV0pIHtcbiAgICAgIGNhc2UgJ3JhZGRyJzpcbiAgICAgICAgY2FuZGlkYXRlLnJlbGF0ZWRBZGRyZXNzID0gcGFydHNbaSArIDFdO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ3Jwb3J0JzpcbiAgICAgICAgY2FuZGlkYXRlLnJlbGF0ZWRQb3J0ID0gcGFyc2VJbnQocGFydHNbaSArIDFdLCAxMCk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgY2FzZSAndGNwdHlwZSc6XG4gICAgICAgIGNhbmRpZGF0ZS50Y3BUeXBlID0gcGFydHNbaSArIDFdO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ3VmcmFnJzpcbiAgICAgICAgY2FuZGlkYXRlLnVmcmFnID0gcGFydHNbaSArIDFdOyAvLyBmb3IgYmFja3dhcmQgY29tcGF0aWJpbGl0eS5cbiAgICAgICAgY2FuZGlkYXRlLnVzZXJuYW1lRnJhZ21lbnQgPSBwYXJ0c1tpICsgMV07XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDogLy8gZXh0ZW5zaW9uIGhhbmRsaW5nLCBpbiBwYXJ0aWN1bGFyIHVmcmFnLiBEb24ndCBvdmVyd3JpdGUuXG4gICAgICAgIGlmIChjYW5kaWRhdGVbcGFydHNbaV1dID09PSB1bmRlZmluZWQpIHtcbiAgICAgICAgICBjYW5kaWRhdGVbcGFydHNbaV1dID0gcGFydHNbaSArIDFdO1xuICAgICAgICB9XG4gICAgICAgIGJyZWFrO1xuICAgIH1cbiAgfVxuICByZXR1cm4gY2FuZGlkYXRlO1xufTtcblxuLy8gVHJhbnNsYXRlcyBhIGNhbmRpZGF0ZSBvYmplY3QgaW50byBTRFAgY2FuZGlkYXRlIGF0dHJpYnV0ZS5cbi8vIFRoaXMgZG9lcyBub3QgaW5jbHVkZSB0aGUgYT0gcHJlZml4IVxuU0RQVXRpbHMud3JpdGVDYW5kaWRhdGUgPSBmdW5jdGlvbihjYW5kaWRhdGUpIHtcbiAgY29uc3Qgc2RwID0gW107XG4gIHNkcC5wdXNoKGNhbmRpZGF0ZS5mb3VuZGF0aW9uKTtcblxuICBjb25zdCBjb21wb25lbnQgPSBjYW5kaWRhdGUuY29tcG9uZW50O1xuICBpZiAoY29tcG9uZW50ID09PSAncnRwJykge1xuICAgIHNkcC5wdXNoKDEpO1xuICB9IGVsc2UgaWYgKGNvbXBvbmVudCA9PT0gJ3J0Y3AnKSB7XG4gICAgc2RwLnB1c2goMik7XG4gIH0gZWxzZSB7XG4gICAgc2RwLnB1c2goY29tcG9uZW50KTtcbiAgfVxuICBzZHAucHVzaChjYW5kaWRhdGUucHJvdG9jb2wudG9VcHBlckNhc2UoKSk7XG4gIHNkcC5wdXNoKGNhbmRpZGF0ZS5wcmlvcml0eSk7XG4gIHNkcC5wdXNoKGNhbmRpZGF0ZS5hZGRyZXNzIHx8IGNhbmRpZGF0ZS5pcCk7XG4gIHNkcC5wdXNoKGNhbmRpZGF0ZS5wb3J0KTtcblxuICBjb25zdCB0eXBlID0gY2FuZGlkYXRlLnR5cGU7XG4gIHNkcC5wdXNoKCd0eXAnKTtcbiAgc2RwLnB1c2godHlwZSk7XG4gIGlmICh0eXBlICE9PSAnaG9zdCcgJiYgY2FuZGlkYXRlLnJlbGF0ZWRBZGRyZXNzICYmXG4gICAgICBjYW5kaWRhdGUucmVsYXRlZFBvcnQpIHtcbiAgICBzZHAucHVzaCgncmFkZHInKTtcbiAgICBzZHAucHVzaChjYW5kaWRhdGUucmVsYXRlZEFkZHJlc3MpO1xuICAgIHNkcC5wdXNoKCdycG9ydCcpO1xuICAgIHNkcC5wdXNoKGNhbmRpZGF0ZS5yZWxhdGVkUG9ydCk7XG4gIH1cbiAgaWYgKGNhbmRpZGF0ZS50Y3BUeXBlICYmIGNhbmRpZGF0ZS5wcm90b2NvbC50b0xvd2VyQ2FzZSgpID09PSAndGNwJykge1xuICAgIHNkcC5wdXNoKCd0Y3B0eXBlJyk7XG4gICAgc2RwLnB1c2goY2FuZGlkYXRlLnRjcFR5cGUpO1xuICB9XG4gIGlmIChjYW5kaWRhdGUudXNlcm5hbWVGcmFnbWVudCB8fCBjYW5kaWRhdGUudWZyYWcpIHtcbiAgICBzZHAucHVzaCgndWZyYWcnKTtcbiAgICBzZHAucHVzaChjYW5kaWRhdGUudXNlcm5hbWVGcmFnbWVudCB8fCBjYW5kaWRhdGUudWZyYWcpO1xuICB9XG4gIHJldHVybiAnY2FuZGlkYXRlOicgKyBzZHAuam9pbignICcpO1xufTtcblxuLy8gUGFyc2VzIGFuIGljZS1vcHRpb25zIGxpbmUsIHJldHVybnMgYW4gYXJyYXkgb2Ygb3B0aW9uIHRhZ3MuXG4vLyBTYW1wbGUgaW5wdXQ6XG4vLyBhPWljZS1vcHRpb25zOmZvbyBiYXJcblNEUFV0aWxzLnBhcnNlSWNlT3B0aW9ucyA9IGZ1bmN0aW9uKGxpbmUpIHtcbiAgcmV0dXJuIGxpbmUuc3Vic3RyaW5nKDE0KS5zcGxpdCgnICcpO1xufTtcblxuLy8gUGFyc2VzIGEgcnRwbWFwIGxpbmUsIHJldHVybnMgUlRDUnRwQ29kZGVjUGFyYW1ldGVycy4gU2FtcGxlIGlucHV0OlxuLy8gYT1ydHBtYXA6MTExIG9wdXMvNDgwMDAvMlxuU0RQVXRpbHMucGFyc2VSdHBNYXAgPSBmdW5jdGlvbihsaW5lKSB7XG4gIGxldCBwYXJ0cyA9IGxpbmUuc3Vic3RyaW5nKDkpLnNwbGl0KCcgJyk7XG4gIGNvbnN0IHBhcnNlZCA9IHtcbiAgICBwYXlsb2FkVHlwZTogcGFyc2VJbnQocGFydHMuc2hpZnQoKSwgMTApLCAvLyB3YXM6IGlkXG4gIH07XG5cbiAgcGFydHMgPSBwYXJ0c1swXS5zcGxpdCgnLycpO1xuXG4gIHBhcnNlZC5uYW1lID0gcGFydHNbMF07XG4gIHBhcnNlZC5jbG9ja1JhdGUgPSBwYXJzZUludChwYXJ0c1sxXSwgMTApOyAvLyB3YXM6IGNsb2NrcmF0ZVxuICBwYXJzZWQuY2hhbm5lbHMgPSBwYXJ0cy5sZW5ndGggPT09IDMgPyBwYXJzZUludChwYXJ0c1syXSwgMTApIDogMTtcbiAgLy8gbGVnYWN5IGFsaWFzLCBnb3QgcmVuYW1lZCBiYWNrIHRvIGNoYW5uZWxzIGluIE9SVEMuXG4gIHBhcnNlZC5udW1DaGFubmVscyA9IHBhcnNlZC5jaGFubmVscztcbiAgcmV0dXJuIHBhcnNlZDtcbn07XG5cbi8vIEdlbmVyYXRlcyBhIHJ0cG1hcCBsaW5lIGZyb20gUlRDUnRwQ29kZWNDYXBhYmlsaXR5IG9yXG4vLyBSVENSdHBDb2RlY1BhcmFtZXRlcnMuXG5TRFBVdGlscy53cml0ZVJ0cE1hcCA9IGZ1bmN0aW9uKGNvZGVjKSB7XG4gIGxldCBwdCA9IGNvZGVjLnBheWxvYWRUeXBlO1xuICBpZiAoY29kZWMucHJlZmVycmVkUGF5bG9hZFR5cGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHB0ID0gY29kZWMucHJlZmVycmVkUGF5bG9hZFR5cGU7XG4gIH1cbiAgY29uc3QgY2hhbm5lbHMgPSBjb2RlYy5jaGFubmVscyB8fCBjb2RlYy5udW1DaGFubmVscyB8fCAxO1xuICByZXR1cm4gJ2E9cnRwbWFwOicgKyBwdCArICcgJyArIGNvZGVjLm5hbWUgKyAnLycgKyBjb2RlYy5jbG9ja1JhdGUgK1xuICAgICAgKGNoYW5uZWxzICE9PSAxID8gJy8nICsgY2hhbm5lbHMgOiAnJykgKyAnXFxyXFxuJztcbn07XG5cbi8vIFBhcnNlcyBhIGV4dG1hcCBsaW5lIChoZWFkZXJleHRlbnNpb24gZnJvbSBSRkMgNTI4NSkuIFNhbXBsZSBpbnB1dDpcbi8vIGE9ZXh0bWFwOjIgdXJuOmlldGY6cGFyYW1zOnJ0cC1oZHJleHQ6dG9mZnNldFxuLy8gYT1leHRtYXA6Mi9zZW5kb25seSB1cm46aWV0ZjpwYXJhbXM6cnRwLWhkcmV4dDp0b2Zmc2V0XG5TRFBVdGlscy5wYXJzZUV4dG1hcCA9IGZ1bmN0aW9uKGxpbmUpIHtcbiAgY29uc3QgcGFydHMgPSBsaW5lLnN1YnN0cmluZyg5KS5zcGxpdCgnICcpO1xuICByZXR1cm4ge1xuICAgIGlkOiBwYXJzZUludChwYXJ0c1swXSwgMTApLFxuICAgIGRpcmVjdGlvbjogcGFydHNbMF0uaW5kZXhPZignLycpID4gMCA/IHBhcnRzWzBdLnNwbGl0KCcvJylbMV0gOiAnc2VuZHJlY3YnLFxuICAgIHVyaTogcGFydHNbMV0sXG4gICAgYXR0cmlidXRlczogcGFydHMuc2xpY2UoMikuam9pbignICcpLFxuICB9O1xufTtcblxuLy8gR2VuZXJhdGVzIGFuIGV4dG1hcCBsaW5lIGZyb20gUlRDUnRwSGVhZGVyRXh0ZW5zaW9uUGFyYW1ldGVycyBvclxuLy8gUlRDUnRwSGVhZGVyRXh0ZW5zaW9uLlxuU0RQVXRpbHMud3JpdGVFeHRtYXAgPSBmdW5jdGlvbihoZWFkZXJFeHRlbnNpb24pIHtcbiAgcmV0dXJuICdhPWV4dG1hcDonICsgKGhlYWRlckV4dGVuc2lvbi5pZCB8fCBoZWFkZXJFeHRlbnNpb24ucHJlZmVycmVkSWQpICtcbiAgICAgIChoZWFkZXJFeHRlbnNpb24uZGlyZWN0aW9uICYmIGhlYWRlckV4dGVuc2lvbi5kaXJlY3Rpb24gIT09ICdzZW5kcmVjdidcbiAgICAgICAgPyAnLycgKyBoZWFkZXJFeHRlbnNpb24uZGlyZWN0aW9uXG4gICAgICAgIDogJycpICtcbiAgICAgICcgJyArIGhlYWRlckV4dGVuc2lvbi51cmkgK1xuICAgICAgKGhlYWRlckV4dGVuc2lvbi5hdHRyaWJ1dGVzID8gJyAnICsgaGVhZGVyRXh0ZW5zaW9uLmF0dHJpYnV0ZXMgOiAnJykgK1xuICAgICAgJ1xcclxcbic7XG59O1xuXG4vLyBQYXJzZXMgYSBmbXRwIGxpbmUsIHJldHVybnMgZGljdGlvbmFyeS4gU2FtcGxlIGlucHV0OlxuLy8gYT1mbXRwOjk2IHZicj1vbjtjbmc9b25cbi8vIEFsc28gZGVhbHMgd2l0aCB2YnI9b247IGNuZz1vblxuU0RQVXRpbHMucGFyc2VGbXRwID0gZnVuY3Rpb24obGluZSkge1xuICBjb25zdCBwYXJzZWQgPSB7fTtcbiAgbGV0IGt2O1xuICBjb25zdCBwYXJ0cyA9IGxpbmUuc3Vic3RyaW5nKGxpbmUuaW5kZXhPZignICcpICsgMSkuc3BsaXQoJzsnKTtcbiAgZm9yIChsZXQgaiA9IDA7IGogPCBwYXJ0cy5sZW5ndGg7IGorKykge1xuICAgIGt2ID0gcGFydHNbal0udHJpbSgpLnNwbGl0KCc9Jyk7XG4gICAgcGFyc2VkW2t2WzBdLnRyaW0oKV0gPSBrdlsxXTtcbiAgfVxuICByZXR1cm4gcGFyc2VkO1xufTtcblxuLy8gR2VuZXJhdGVzIGEgZm10cCBsaW5lIGZyb20gUlRDUnRwQ29kZWNDYXBhYmlsaXR5IG9yIFJUQ1J0cENvZGVjUGFyYW1ldGVycy5cblNEUFV0aWxzLndyaXRlRm10cCA9IGZ1bmN0aW9uKGNvZGVjKSB7XG4gIGxldCBsaW5lID0gJyc7XG4gIGxldCBwdCA9IGNvZGVjLnBheWxvYWRUeXBlO1xuICBpZiAoY29kZWMucHJlZmVycmVkUGF5bG9hZFR5cGUgIT09IHVuZGVmaW5lZCkge1xuICAgIHB0ID0gY29kZWMucHJlZmVycmVkUGF5bG9hZFR5cGU7XG4gIH1cbiAgaWYgKGNvZGVjLnBhcmFtZXRlcnMgJiYgT2JqZWN0LmtleXMoY29kZWMucGFyYW1ldGVycykubGVuZ3RoKSB7XG4gICAgY29uc3QgcGFyYW1zID0gW107XG4gICAgT2JqZWN0LmtleXMoY29kZWMucGFyYW1ldGVycykuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICBpZiAoY29kZWMucGFyYW1ldGVyc1twYXJhbV0gIT09IHVuZGVmaW5lZCkge1xuICAgICAgICBwYXJhbXMucHVzaChwYXJhbSArICc9JyArIGNvZGVjLnBhcmFtZXRlcnNbcGFyYW1dKTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIHBhcmFtcy5wdXNoKHBhcmFtKTtcbiAgICAgIH1cbiAgICB9KTtcbiAgICBsaW5lICs9ICdhPWZtdHA6JyArIHB0ICsgJyAnICsgcGFyYW1zLmpvaW4oJzsnKSArICdcXHJcXG4nO1xuICB9XG4gIHJldHVybiBsaW5lO1xufTtcblxuLy8gUGFyc2VzIGEgcnRjcC1mYiBsaW5lLCByZXR1cm5zIFJUQ1BSdGNwRmVlZGJhY2sgb2JqZWN0LiBTYW1wbGUgaW5wdXQ6XG4vLyBhPXJ0Y3AtZmI6OTggbmFjayBycHNpXG5TRFBVdGlscy5wYXJzZVJ0Y3BGYiA9IGZ1bmN0aW9uKGxpbmUpIHtcbiAgY29uc3QgcGFydHMgPSBsaW5lLnN1YnN0cmluZyhsaW5lLmluZGV4T2YoJyAnKSArIDEpLnNwbGl0KCcgJyk7XG4gIHJldHVybiB7XG4gICAgdHlwZTogcGFydHMuc2hpZnQoKSxcbiAgICBwYXJhbWV0ZXI6IHBhcnRzLmpvaW4oJyAnKSxcbiAgfTtcbn07XG5cbi8vIEdlbmVyYXRlIGE9cnRjcC1mYiBsaW5lcyBmcm9tIFJUQ1J0cENvZGVjQ2FwYWJpbGl0eSBvciBSVENSdHBDb2RlY1BhcmFtZXRlcnMuXG5TRFBVdGlscy53cml0ZVJ0Y3BGYiA9IGZ1bmN0aW9uKGNvZGVjKSB7XG4gIGxldCBsaW5lcyA9ICcnO1xuICBsZXQgcHQgPSBjb2RlYy5wYXlsb2FkVHlwZTtcbiAgaWYgKGNvZGVjLnByZWZlcnJlZFBheWxvYWRUeXBlICE9PSB1bmRlZmluZWQpIHtcbiAgICBwdCA9IGNvZGVjLnByZWZlcnJlZFBheWxvYWRUeXBlO1xuICB9XG4gIGlmIChjb2RlYy5ydGNwRmVlZGJhY2sgJiYgY29kZWMucnRjcEZlZWRiYWNrLmxlbmd0aCkge1xuICAgIC8vIEZJWE1FOiBzcGVjaWFsIGhhbmRsaW5nIGZvciB0cnItaW50P1xuICAgIGNvZGVjLnJ0Y3BGZWVkYmFjay5mb3JFYWNoKGZiID0+IHtcbiAgICAgIGxpbmVzICs9ICdhPXJ0Y3AtZmI6JyArIHB0ICsgJyAnICsgZmIudHlwZSArXG4gICAgICAoZmIucGFyYW1ldGVyICYmIGZiLnBhcmFtZXRlci5sZW5ndGggPyAnICcgKyBmYi5wYXJhbWV0ZXIgOiAnJykgK1xuICAgICAgICAgICdcXHJcXG4nO1xuICAgIH0pO1xuICB9XG4gIHJldHVybiBsaW5lcztcbn07XG5cbi8vIFBhcnNlcyBhIFJGQyA1NTc2IHNzcmMgbWVkaWEgYXR0cmlidXRlLiBTYW1wbGUgaW5wdXQ6XG4vLyBhPXNzcmM6MzczNTkyODU1OSBjbmFtZTpzb21ldGhpbmdcblNEUFV0aWxzLnBhcnNlU3NyY01lZGlhID0gZnVuY3Rpb24obGluZSkge1xuICBjb25zdCBzcCA9IGxpbmUuaW5kZXhPZignICcpO1xuICBjb25zdCBwYXJ0cyA9IHtcbiAgICBzc3JjOiBwYXJzZUludChsaW5lLnN1YnN0cmluZyg3LCBzcCksIDEwKSxcbiAgfTtcbiAgY29uc3QgY29sb24gPSBsaW5lLmluZGV4T2YoJzonLCBzcCk7XG4gIGlmIChjb2xvbiA+IC0xKSB7XG4gICAgcGFydHMuYXR0cmlidXRlID0gbGluZS5zdWJzdHJpbmcoc3AgKyAxLCBjb2xvbik7XG4gICAgcGFydHMudmFsdWUgPSBsaW5lLnN1YnN0cmluZyhjb2xvbiArIDEpO1xuICB9IGVsc2Uge1xuICAgIHBhcnRzLmF0dHJpYnV0ZSA9IGxpbmUuc3Vic3RyaW5nKHNwICsgMSk7XG4gIH1cbiAgcmV0dXJuIHBhcnRzO1xufTtcblxuLy8gUGFyc2UgYSBzc3JjLWdyb3VwIGxpbmUgKHNlZSBSRkMgNTU3NikuIFNhbXBsZSBpbnB1dDpcbi8vIGE9c3NyYy1ncm91cDpzZW1hbnRpY3MgMTIgMzRcblNEUFV0aWxzLnBhcnNlU3NyY0dyb3VwID0gZnVuY3Rpb24obGluZSkge1xuICBjb25zdCBwYXJ0cyA9IGxpbmUuc3Vic3RyaW5nKDEzKS5zcGxpdCgnICcpO1xuICByZXR1cm4ge1xuICAgIHNlbWFudGljczogcGFydHMuc2hpZnQoKSxcbiAgICBzc3JjczogcGFydHMubWFwKHNzcmMgPT4gcGFyc2VJbnQoc3NyYywgMTApKSxcbiAgfTtcbn07XG5cbi8vIEV4dHJhY3RzIHRoZSBNSUQgKFJGQyA1ODg4KSBmcm9tIGEgbWVkaWEgc2VjdGlvbi5cbi8vIFJldHVybnMgdGhlIE1JRCBvciB1bmRlZmluZWQgaWYgbm8gbWlkIGxpbmUgd2FzIGZvdW5kLlxuU0RQVXRpbHMuZ2V0TWlkID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uKSB7XG4gIGNvbnN0IG1pZCA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9bWlkOicpWzBdO1xuICBpZiAobWlkKSB7XG4gICAgcmV0dXJuIG1pZC5zdWJzdHJpbmcoNik7XG4gIH1cbn07XG5cbi8vIFBhcnNlcyBhIGZpbmdlcnByaW50IGxpbmUgZm9yIERUTFMtU1JUUC5cblNEUFV0aWxzLnBhcnNlRmluZ2VycHJpbnQgPSBmdW5jdGlvbihsaW5lKSB7XG4gIGNvbnN0IHBhcnRzID0gbGluZS5zdWJzdHJpbmcoMTQpLnNwbGl0KCcgJyk7XG4gIHJldHVybiB7XG4gICAgYWxnb3JpdGhtOiBwYXJ0c1swXS50b0xvd2VyQ2FzZSgpLCAvLyBhbGdvcml0aG0gaXMgY2FzZS1zZW5zaXRpdmUgaW4gRWRnZS5cbiAgICB2YWx1ZTogcGFydHNbMV0udG9VcHBlckNhc2UoKSwgLy8gdGhlIGRlZmluaXRpb24gaXMgdXBwZXItY2FzZSBpbiBSRkMgNDU3Mi5cbiAgfTtcbn07XG5cbi8vIEV4dHJhY3RzIERUTFMgcGFyYW1ldGVycyBmcm9tIFNEUCBtZWRpYSBzZWN0aW9uIG9yIHNlc3Npb25wYXJ0LlxuLy8gRklYTUU6IGZvciBjb25zaXN0ZW5jeSB3aXRoIG90aGVyIGZ1bmN0aW9ucyB0aGlzIHNob3VsZCBvbmx5XG4vLyAgIGdldCB0aGUgZmluZ2VycHJpbnQgbGluZSBhcyBpbnB1dC4gU2VlIGFsc28gZ2V0SWNlUGFyYW1ldGVycy5cblNEUFV0aWxzLmdldER0bHNQYXJhbWV0ZXJzID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uLCBzZXNzaW9ucGFydCkge1xuICBjb25zdCBsaW5lcyA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiArIHNlc3Npb25wYXJ0LFxuICAgICdhPWZpbmdlcnByaW50OicpO1xuICAvLyBOb3RlOiBhPXNldHVwIGxpbmUgaXMgaWdub3JlZCBzaW5jZSB3ZSB1c2UgdGhlICdhdXRvJyByb2xlIGluIEVkZ2UuXG4gIHJldHVybiB7XG4gICAgcm9sZTogJ2F1dG8nLFxuICAgIGZpbmdlcnByaW50czogbGluZXMubWFwKFNEUFV0aWxzLnBhcnNlRmluZ2VycHJpbnQpLFxuICB9O1xufTtcblxuLy8gU2VyaWFsaXplcyBEVExTIHBhcmFtZXRlcnMgdG8gU0RQLlxuU0RQVXRpbHMud3JpdGVEdGxzUGFyYW1ldGVycyA9IGZ1bmN0aW9uKHBhcmFtcywgc2V0dXBUeXBlKSB7XG4gIGxldCBzZHAgPSAnYT1zZXR1cDonICsgc2V0dXBUeXBlICsgJ1xcclxcbic7XG4gIHBhcmFtcy5maW5nZXJwcmludHMuZm9yRWFjaChmcCA9PiB7XG4gICAgc2RwICs9ICdhPWZpbmdlcnByaW50OicgKyBmcC5hbGdvcml0aG0gKyAnICcgKyBmcC52YWx1ZSArICdcXHJcXG4nO1xuICB9KTtcbiAgcmV0dXJuIHNkcDtcbn07XG5cbi8vIFBhcnNlcyBhPWNyeXB0byBsaW5lcyBpbnRvXG4vLyAgIGh0dHBzOi8vcmF3Z2l0LmNvbS9hYm9iYS9lZGdlcnRjL21hc3Rlci9tc29ydGMtcnM0Lmh0bWwjZGljdGlvbmFyeS1ydGNzcnRwc2Rlc3BhcmFtZXRlcnMtbWVtYmVyc1xuU0RQVXRpbHMucGFyc2VDcnlwdG9MaW5lID0gZnVuY3Rpb24obGluZSkge1xuICBjb25zdCBwYXJ0cyA9IGxpbmUuc3Vic3RyaW5nKDkpLnNwbGl0KCcgJyk7XG4gIHJldHVybiB7XG4gICAgdGFnOiBwYXJzZUludChwYXJ0c1swXSwgMTApLFxuICAgIGNyeXB0b1N1aXRlOiBwYXJ0c1sxXSxcbiAgICBrZXlQYXJhbXM6IHBhcnRzWzJdLFxuICAgIHNlc3Npb25QYXJhbXM6IHBhcnRzLnNsaWNlKDMpLFxuICB9O1xufTtcblxuU0RQVXRpbHMud3JpdGVDcnlwdG9MaW5lID0gZnVuY3Rpb24ocGFyYW1ldGVycykge1xuICByZXR1cm4gJ2E9Y3J5cHRvOicgKyBwYXJhbWV0ZXJzLnRhZyArICcgJyArXG4gICAgcGFyYW1ldGVycy5jcnlwdG9TdWl0ZSArICcgJyArXG4gICAgKHR5cGVvZiBwYXJhbWV0ZXJzLmtleVBhcmFtcyA9PT0gJ29iamVjdCdcbiAgICAgID8gU0RQVXRpbHMud3JpdGVDcnlwdG9LZXlQYXJhbXMocGFyYW1ldGVycy5rZXlQYXJhbXMpXG4gICAgICA6IHBhcmFtZXRlcnMua2V5UGFyYW1zKSArXG4gICAgKHBhcmFtZXRlcnMuc2Vzc2lvblBhcmFtcyA/ICcgJyArIHBhcmFtZXRlcnMuc2Vzc2lvblBhcmFtcy5qb2luKCcgJykgOiAnJykgK1xuICAgICdcXHJcXG4nO1xufTtcblxuLy8gUGFyc2VzIHRoZSBjcnlwdG8ga2V5IHBhcmFtZXRlcnMgaW50b1xuLy8gICBodHRwczovL3Jhd2dpdC5jb20vYWJvYmEvZWRnZXJ0Yy9tYXN0ZXIvbXNvcnRjLXJzNC5odG1sI3J0Y3NydHBrZXlwYXJhbSpcblNEUFV0aWxzLnBhcnNlQ3J5cHRvS2V5UGFyYW1zID0gZnVuY3Rpb24oa2V5UGFyYW1zKSB7XG4gIGlmIChrZXlQYXJhbXMuaW5kZXhPZignaW5saW5lOicpICE9PSAwKSB7XG4gICAgcmV0dXJuIG51bGw7XG4gIH1cbiAgY29uc3QgcGFydHMgPSBrZXlQYXJhbXMuc3Vic3RyaW5nKDcpLnNwbGl0KCd8Jyk7XG4gIHJldHVybiB7XG4gICAga2V5TWV0aG9kOiAnaW5saW5lJyxcbiAgICBrZXlTYWx0OiBwYXJ0c1swXSxcbiAgICBsaWZlVGltZTogcGFydHNbMV0sXG4gICAgbWtpVmFsdWU6IHBhcnRzWzJdID8gcGFydHNbMl0uc3BsaXQoJzonKVswXSA6IHVuZGVmaW5lZCxcbiAgICBta2lMZW5ndGg6IHBhcnRzWzJdID8gcGFydHNbMl0uc3BsaXQoJzonKVsxXSA6IHVuZGVmaW5lZCxcbiAgfTtcbn07XG5cblNEUFV0aWxzLndyaXRlQ3J5cHRvS2V5UGFyYW1zID0gZnVuY3Rpb24oa2V5UGFyYW1zKSB7XG4gIHJldHVybiBrZXlQYXJhbXMua2V5TWV0aG9kICsgJzonXG4gICAgKyBrZXlQYXJhbXMua2V5U2FsdCArXG4gICAgKGtleVBhcmFtcy5saWZlVGltZSA/ICd8JyArIGtleVBhcmFtcy5saWZlVGltZSA6ICcnKSArXG4gICAgKGtleVBhcmFtcy5ta2lWYWx1ZSAmJiBrZXlQYXJhbXMubWtpTGVuZ3RoXG4gICAgICA/ICd8JyArIGtleVBhcmFtcy5ta2lWYWx1ZSArICc6JyArIGtleVBhcmFtcy5ta2lMZW5ndGhcbiAgICAgIDogJycpO1xufTtcblxuLy8gRXh0cmFjdHMgYWxsIFNERVMgcGFyYW1ldGVycy5cblNEUFV0aWxzLmdldENyeXB0b1BhcmFtZXRlcnMgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24sIHNlc3Npb25wYXJ0KSB7XG4gIGNvbnN0IGxpbmVzID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uICsgc2Vzc2lvbnBhcnQsXG4gICAgJ2E9Y3J5cHRvOicpO1xuICByZXR1cm4gbGluZXMubWFwKFNEUFV0aWxzLnBhcnNlQ3J5cHRvTGluZSk7XG59O1xuXG4vLyBQYXJzZXMgSUNFIGluZm9ybWF0aW9uIGZyb20gU0RQIG1lZGlhIHNlY3Rpb24gb3Igc2Vzc2lvbnBhcnQuXG4vLyBGSVhNRTogZm9yIGNvbnNpc3RlbmN5IHdpdGggb3RoZXIgZnVuY3Rpb25zIHRoaXMgc2hvdWxkIG9ubHlcbi8vICAgZ2V0IHRoZSBpY2UtdWZyYWcgYW5kIGljZS1wd2QgbGluZXMgYXMgaW5wdXQuXG5TRFBVdGlscy5nZXRJY2VQYXJhbWV0ZXJzID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uLCBzZXNzaW9ucGFydCkge1xuICBjb25zdCB1ZnJhZyA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiArIHNlc3Npb25wYXJ0LFxuICAgICdhPWljZS11ZnJhZzonKVswXTtcbiAgY29uc3QgcHdkID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uICsgc2Vzc2lvbnBhcnQsXG4gICAgJ2E9aWNlLXB3ZDonKVswXTtcbiAgaWYgKCEodWZyYWcgJiYgcHdkKSkge1xuICAgIHJldHVybiBudWxsO1xuICB9XG4gIHJldHVybiB7XG4gICAgdXNlcm5hbWVGcmFnbWVudDogdWZyYWcuc3Vic3RyaW5nKDEyKSxcbiAgICBwYXNzd29yZDogcHdkLnN1YnN0cmluZygxMCksXG4gIH07XG59O1xuXG4vLyBTZXJpYWxpemVzIElDRSBwYXJhbWV0ZXJzIHRvIFNEUC5cblNEUFV0aWxzLndyaXRlSWNlUGFyYW1ldGVycyA9IGZ1bmN0aW9uKHBhcmFtcykge1xuICBsZXQgc2RwID0gJ2E9aWNlLXVmcmFnOicgKyBwYXJhbXMudXNlcm5hbWVGcmFnbWVudCArICdcXHJcXG4nICtcbiAgICAgICdhPWljZS1wd2Q6JyArIHBhcmFtcy5wYXNzd29yZCArICdcXHJcXG4nO1xuICBpZiAocGFyYW1zLmljZUxpdGUpIHtcbiAgICBzZHAgKz0gJ2E9aWNlLWxpdGVcXHJcXG4nO1xuICB9XG4gIHJldHVybiBzZHA7XG59O1xuXG4vLyBQYXJzZXMgdGhlIFNEUCBtZWRpYSBzZWN0aW9uIGFuZCByZXR1cm5zIFJUQ1J0cFBhcmFtZXRlcnMuXG5TRFBVdGlscy5wYXJzZVJ0cFBhcmFtZXRlcnMgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24pIHtcbiAgY29uc3QgZGVzY3JpcHRpb24gPSB7XG4gICAgY29kZWNzOiBbXSxcbiAgICBoZWFkZXJFeHRlbnNpb25zOiBbXSxcbiAgICBmZWNNZWNoYW5pc21zOiBbXSxcbiAgICBydGNwOiBbXSxcbiAgfTtcbiAgY29uc3QgbGluZXMgPSBTRFBVdGlscy5zcGxpdExpbmVzKG1lZGlhU2VjdGlvbik7XG4gIGNvbnN0IG1saW5lID0gbGluZXNbMF0uc3BsaXQoJyAnKTtcbiAgZGVzY3JpcHRpb24ucHJvZmlsZSA9IG1saW5lWzJdO1xuICBmb3IgKGxldCBpID0gMzsgaSA8IG1saW5lLmxlbmd0aDsgaSsrKSB7IC8vIGZpbmQgYWxsIGNvZGVjcyBmcm9tIG1saW5lWzMuLl1cbiAgICBjb25zdCBwdCA9IG1saW5lW2ldO1xuICAgIGNvbnN0IHJ0cG1hcGxpbmUgPSBTRFBVdGlscy5tYXRjaFByZWZpeChcbiAgICAgIG1lZGlhU2VjdGlvbiwgJ2E9cnRwbWFwOicgKyBwdCArICcgJylbMF07XG4gICAgaWYgKHJ0cG1hcGxpbmUpIHtcbiAgICAgIGNvbnN0IGNvZGVjID0gU0RQVXRpbHMucGFyc2VSdHBNYXAocnRwbWFwbGluZSk7XG4gICAgICBjb25zdCBmbXRwcyA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KFxuICAgICAgICBtZWRpYVNlY3Rpb24sICdhPWZtdHA6JyArIHB0ICsgJyAnKTtcbiAgICAgIC8vIE9ubHkgdGhlIGZpcnN0IGE9Zm10cDo8cHQ+IGlzIGNvbnNpZGVyZWQuXG4gICAgICBjb2RlYy5wYXJhbWV0ZXJzID0gZm10cHMubGVuZ3RoID8gU0RQVXRpbHMucGFyc2VGbXRwKGZtdHBzWzBdKSA6IHt9O1xuICAgICAgY29kZWMucnRjcEZlZWRiYWNrID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgoXG4gICAgICAgIG1lZGlhU2VjdGlvbiwgJ2E9cnRjcC1mYjonICsgcHQgKyAnICcpXG4gICAgICAgIC5tYXAoU0RQVXRpbHMucGFyc2VSdGNwRmIpO1xuICAgICAgZGVzY3JpcHRpb24uY29kZWNzLnB1c2goY29kZWMpO1xuICAgICAgLy8gcGFyc2UgRkVDIG1lY2hhbmlzbXMgZnJvbSBydHBtYXAgbGluZXMuXG4gICAgICBzd2l0Y2ggKGNvZGVjLm5hbWUudG9VcHBlckNhc2UoKSkge1xuICAgICAgICBjYXNlICdSRUQnOlxuICAgICAgICBjYXNlICdVTFBGRUMnOlxuICAgICAgICAgIGRlc2NyaXB0aW9uLmZlY01lY2hhbmlzbXMucHVzaChjb2RlYy5uYW1lLnRvVXBwZXJDYXNlKCkpO1xuICAgICAgICAgIGJyZWFrO1xuICAgICAgICBkZWZhdWx0OiAvLyBvbmx5IFJFRCBhbmQgVUxQRkVDIGFyZSByZWNvZ25pemVkIGFzIEZFQyBtZWNoYW5pc21zLlxuICAgICAgICAgIGJyZWFrO1xuICAgICAgfVxuICAgIH1cbiAgfVxuICBTRFBVdGlscy5tYXRjaFByZWZpeChtZWRpYVNlY3Rpb24sICdhPWV4dG1hcDonKS5mb3JFYWNoKGxpbmUgPT4ge1xuICAgIGRlc2NyaXB0aW9uLmhlYWRlckV4dGVuc2lvbnMucHVzaChTRFBVdGlscy5wYXJzZUV4dG1hcChsaW5lKSk7XG4gIH0pO1xuICBjb25zdCB3aWxkY2FyZFJ0Y3BGYiA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9cnRjcC1mYjoqICcpXG4gICAgLm1hcChTRFBVdGlscy5wYXJzZVJ0Y3BGYik7XG4gIGRlc2NyaXB0aW9uLmNvZGVjcy5mb3JFYWNoKGNvZGVjID0+IHtcbiAgICB3aWxkY2FyZFJ0Y3BGYi5mb3JFYWNoKGZiPT4ge1xuICAgICAgY29uc3QgZHVwbGljYXRlID0gY29kZWMucnRjcEZlZWRiYWNrLmZpbmQoZXhpc3RpbmdGZWVkYmFjayA9PiB7XG4gICAgICAgIHJldHVybiBleGlzdGluZ0ZlZWRiYWNrLnR5cGUgPT09IGZiLnR5cGUgJiZcbiAgICAgICAgICBleGlzdGluZ0ZlZWRiYWNrLnBhcmFtZXRlciA9PT0gZmIucGFyYW1ldGVyO1xuICAgICAgfSk7XG4gICAgICBpZiAoIWR1cGxpY2F0ZSkge1xuICAgICAgICBjb2RlYy5ydGNwRmVlZGJhY2sucHVzaChmYik7XG4gICAgICB9XG4gICAgfSk7XG4gIH0pO1xuICAvLyBGSVhNRTogcGFyc2UgcnRjcC5cbiAgcmV0dXJuIGRlc2NyaXB0aW9uO1xufTtcblxuLy8gR2VuZXJhdGVzIHBhcnRzIG9mIHRoZSBTRFAgbWVkaWEgc2VjdGlvbiBkZXNjcmliaW5nIHRoZSBjYXBhYmlsaXRpZXMgL1xuLy8gcGFyYW1ldGVycy5cblNEUFV0aWxzLndyaXRlUnRwRGVzY3JpcHRpb24gPSBmdW5jdGlvbihraW5kLCBjYXBzKSB7XG4gIGxldCBzZHAgPSAnJztcblxuICAvLyBCdWlsZCB0aGUgbWxpbmUuXG4gIHNkcCArPSAnbT0nICsga2luZCArICcgJztcbiAgc2RwICs9IGNhcHMuY29kZWNzLmxlbmd0aCA+IDAgPyAnOScgOiAnMCc7IC8vIHJlamVjdCBpZiBubyBjb2RlY3MuXG4gIHNkcCArPSAnICcgKyAoY2Fwcy5wcm9maWxlIHx8ICdVRFAvVExTL1JUUC9TQVZQRicpICsgJyAnO1xuICBzZHAgKz0gY2Fwcy5jb2RlY3MubWFwKGNvZGVjID0+IHtcbiAgICBpZiAoY29kZWMucHJlZmVycmVkUGF5bG9hZFR5cGUgIT09IHVuZGVmaW5lZCkge1xuICAgICAgcmV0dXJuIGNvZGVjLnByZWZlcnJlZFBheWxvYWRUeXBlO1xuICAgIH1cbiAgICByZXR1cm4gY29kZWMucGF5bG9hZFR5cGU7XG4gIH0pLmpvaW4oJyAnKSArICdcXHJcXG4nO1xuXG4gIHNkcCArPSAnYz1JTiBJUDQgMC4wLjAuMFxcclxcbic7XG4gIHNkcCArPSAnYT1ydGNwOjkgSU4gSVA0IDAuMC4wLjBcXHJcXG4nO1xuXG4gIC8vIEFkZCBhPXJ0cG1hcCBsaW5lcyBmb3IgZWFjaCBjb2RlYy4gQWxzbyBmbXRwIGFuZCBydGNwLWZiLlxuICBjYXBzLmNvZGVjcy5mb3JFYWNoKGNvZGVjID0+IHtcbiAgICBzZHAgKz0gU0RQVXRpbHMud3JpdGVSdHBNYXAoY29kZWMpO1xuICAgIHNkcCArPSBTRFBVdGlscy53cml0ZUZtdHAoY29kZWMpO1xuICAgIHNkcCArPSBTRFBVdGlscy53cml0ZVJ0Y3BGYihjb2RlYyk7XG4gIH0pO1xuICBsZXQgbWF4cHRpbWUgPSAwO1xuICBjYXBzLmNvZGVjcy5mb3JFYWNoKGNvZGVjID0+IHtcbiAgICBpZiAoY29kZWMubWF4cHRpbWUgPiBtYXhwdGltZSkge1xuICAgICAgbWF4cHRpbWUgPSBjb2RlYy5tYXhwdGltZTtcbiAgICB9XG4gIH0pO1xuICBpZiAobWF4cHRpbWUgPiAwKSB7XG4gICAgc2RwICs9ICdhPW1heHB0aW1lOicgKyBtYXhwdGltZSArICdcXHJcXG4nO1xuICB9XG5cbiAgaWYgKGNhcHMuaGVhZGVyRXh0ZW5zaW9ucykge1xuICAgIGNhcHMuaGVhZGVyRXh0ZW5zaW9ucy5mb3JFYWNoKGV4dGVuc2lvbiA9PiB7XG4gICAgICBzZHAgKz0gU0RQVXRpbHMud3JpdGVFeHRtYXAoZXh0ZW5zaW9uKTtcbiAgICB9KTtcbiAgfVxuICAvLyBGSVhNRTogd3JpdGUgZmVjTWVjaGFuaXNtcy5cbiAgcmV0dXJuIHNkcDtcbn07XG5cbi8vIFBhcnNlcyB0aGUgU0RQIG1lZGlhIHNlY3Rpb24gYW5kIHJldHVybnMgYW4gYXJyYXkgb2Zcbi8vIFJUQ1J0cEVuY29kaW5nUGFyYW1ldGVycy5cblNEUFV0aWxzLnBhcnNlUnRwRW5jb2RpbmdQYXJhbWV0ZXJzID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uKSB7XG4gIGNvbnN0IGVuY29kaW5nUGFyYW1ldGVycyA9IFtdO1xuICBjb25zdCBkZXNjcmlwdGlvbiA9IFNEUFV0aWxzLnBhcnNlUnRwUGFyYW1ldGVycyhtZWRpYVNlY3Rpb24pO1xuICBjb25zdCBoYXNSZWQgPSBkZXNjcmlwdGlvbi5mZWNNZWNoYW5pc21zLmluZGV4T2YoJ1JFRCcpICE9PSAtMTtcbiAgY29uc3QgaGFzVWxwZmVjID0gZGVzY3JpcHRpb24uZmVjTWVjaGFuaXNtcy5pbmRleE9mKCdVTFBGRUMnKSAhPT0gLTE7XG5cbiAgLy8gZmlsdGVyIGE9c3NyYzouLi4gY25hbWU6LCBpZ25vcmUgUGxhbkItbXNpZFxuICBjb25zdCBzc3JjcyA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9c3NyYzonKVxuICAgIC5tYXAobGluZSA9PiBTRFBVdGlscy5wYXJzZVNzcmNNZWRpYShsaW5lKSlcbiAgICAuZmlsdGVyKHBhcnRzID0+IHBhcnRzLmF0dHJpYnV0ZSA9PT0gJ2NuYW1lJyk7XG4gIGNvbnN0IHByaW1hcnlTc3JjID0gc3NyY3MubGVuZ3RoID4gMCAmJiBzc3Jjc1swXS5zc3JjO1xuICBsZXQgc2Vjb25kYXJ5U3NyYztcblxuICBjb25zdCBmbG93cyA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9c3NyYy1ncm91cDpGSUQnKVxuICAgIC5tYXAobGluZSA9PiB7XG4gICAgICBjb25zdCBwYXJ0cyA9IGxpbmUuc3Vic3RyaW5nKDE3KS5zcGxpdCgnICcpO1xuICAgICAgcmV0dXJuIHBhcnRzLm1hcChwYXJ0ID0+IHBhcnNlSW50KHBhcnQsIDEwKSk7XG4gICAgfSk7XG4gIGlmIChmbG93cy5sZW5ndGggPiAwICYmIGZsb3dzWzBdLmxlbmd0aCA+IDEgJiYgZmxvd3NbMF1bMF0gPT09IHByaW1hcnlTc3JjKSB7XG4gICAgc2Vjb25kYXJ5U3NyYyA9IGZsb3dzWzBdWzFdO1xuICB9XG5cbiAgZGVzY3JpcHRpb24uY29kZWNzLmZvckVhY2goY29kZWMgPT4ge1xuICAgIGlmIChjb2RlYy5uYW1lLnRvVXBwZXJDYXNlKCkgPT09ICdSVFgnICYmIGNvZGVjLnBhcmFtZXRlcnMuYXB0KSB7XG4gICAgICBsZXQgZW5jUGFyYW0gPSB7XG4gICAgICAgIHNzcmM6IHByaW1hcnlTc3JjLFxuICAgICAgICBjb2RlY1BheWxvYWRUeXBlOiBwYXJzZUludChjb2RlYy5wYXJhbWV0ZXJzLmFwdCwgMTApLFxuICAgICAgfTtcbiAgICAgIGlmIChwcmltYXJ5U3NyYyAmJiBzZWNvbmRhcnlTc3JjKSB7XG4gICAgICAgIGVuY1BhcmFtLnJ0eCA9IHtzc3JjOiBzZWNvbmRhcnlTc3JjfTtcbiAgICAgIH1cbiAgICAgIGVuY29kaW5nUGFyYW1ldGVycy5wdXNoKGVuY1BhcmFtKTtcbiAgICAgIGlmIChoYXNSZWQpIHtcbiAgICAgICAgZW5jUGFyYW0gPSBKU09OLnBhcnNlKEpTT04uc3RyaW5naWZ5KGVuY1BhcmFtKSk7XG4gICAgICAgIGVuY1BhcmFtLmZlYyA9IHtcbiAgICAgICAgICBzc3JjOiBwcmltYXJ5U3NyYyxcbiAgICAgICAgICBtZWNoYW5pc206IGhhc1VscGZlYyA/ICdyZWQrdWxwZmVjJyA6ICdyZWQnLFxuICAgICAgICB9O1xuICAgICAgICBlbmNvZGluZ1BhcmFtZXRlcnMucHVzaChlbmNQYXJhbSk7XG4gICAgICB9XG4gICAgfVxuICB9KTtcbiAgaWYgKGVuY29kaW5nUGFyYW1ldGVycy5sZW5ndGggPT09IDAgJiYgcHJpbWFyeVNzcmMpIHtcbiAgICBlbmNvZGluZ1BhcmFtZXRlcnMucHVzaCh7XG4gICAgICBzc3JjOiBwcmltYXJ5U3NyYyxcbiAgICB9KTtcbiAgfVxuXG4gIC8vIHdlIHN1cHBvcnQgYm90aCBiPUFTIGFuZCBiPVRJQVMgYnV0IGludGVycHJldCBBUyBhcyBUSUFTLlxuICBsZXQgYmFuZHdpZHRoID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYj0nKTtcbiAgaWYgKGJhbmR3aWR0aC5sZW5ndGgpIHtcbiAgICBpZiAoYmFuZHdpZHRoWzBdLmluZGV4T2YoJ2I9VElBUzonKSA9PT0gMCkge1xuICAgICAgYmFuZHdpZHRoID0gcGFyc2VJbnQoYmFuZHdpZHRoWzBdLnN1YnN0cmluZyg3KSwgMTApO1xuICAgIH0gZWxzZSBpZiAoYmFuZHdpZHRoWzBdLmluZGV4T2YoJ2I9QVM6JykgPT09IDApIHtcbiAgICAgIC8vIHVzZSBmb3JtdWxhIGZyb20gSlNFUCB0byBjb252ZXJ0IGI9QVMgdG8gVElBUyB2YWx1ZS5cbiAgICAgIGJhbmR3aWR0aCA9IHBhcnNlSW50KGJhbmR3aWR0aFswXS5zdWJzdHJpbmcoNSksIDEwKSAqIDEwMDAgKiAwLjk1XG4gICAgICAgICAgLSAoNTAgKiA0MCAqIDgpO1xuICAgIH0gZWxzZSB7XG4gICAgICBiYW5kd2lkdGggPSB1bmRlZmluZWQ7XG4gICAgfVxuICAgIGVuY29kaW5nUGFyYW1ldGVycy5mb3JFYWNoKHBhcmFtcyA9PiB7XG4gICAgICBwYXJhbXMubWF4Qml0cmF0ZSA9IGJhbmR3aWR0aDtcbiAgICB9KTtcbiAgfVxuICByZXR1cm4gZW5jb2RpbmdQYXJhbWV0ZXJzO1xufTtcblxuLy8gcGFyc2VzIGh0dHA6Ly9kcmFmdC5vcnRjLm9yZy8jcnRjcnRjcHBhcmFtZXRlcnMqXG5TRFBVdGlscy5wYXJzZVJ0Y3BQYXJhbWV0ZXJzID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uKSB7XG4gIGNvbnN0IHJ0Y3BQYXJhbWV0ZXJzID0ge307XG5cbiAgLy8gR2V0cyB0aGUgZmlyc3QgU1NSQy4gTm90ZSB0aGF0IHdpdGggUlRYIHRoZXJlIG1pZ2h0IGJlIG11bHRpcGxlXG4gIC8vIFNTUkNzLlxuICBjb25zdCByZW1vdGVTc3JjID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1zc3JjOicpXG4gICAgLm1hcChsaW5lID0+IFNEUFV0aWxzLnBhcnNlU3NyY01lZGlhKGxpbmUpKVxuICAgIC5maWx0ZXIob2JqID0+IG9iai5hdHRyaWJ1dGUgPT09ICdjbmFtZScpWzBdO1xuICBpZiAocmVtb3RlU3NyYykge1xuICAgIHJ0Y3BQYXJhbWV0ZXJzLmNuYW1lID0gcmVtb3RlU3NyYy52YWx1ZTtcbiAgICBydGNwUGFyYW1ldGVycy5zc3JjID0gcmVtb3RlU3NyYy5zc3JjO1xuICB9XG5cbiAgLy8gRWRnZSB1c2VzIHRoZSBjb21wb3VuZCBhdHRyaWJ1dGUgaW5zdGVhZCBvZiByZWR1Y2VkU2l6ZVxuICAvLyBjb21wb3VuZCBpcyAhcmVkdWNlZFNpemVcbiAgY29uc3QgcnNpemUgPSBTRFBVdGlscy5tYXRjaFByZWZpeChtZWRpYVNlY3Rpb24sICdhPXJ0Y3AtcnNpemUnKTtcbiAgcnRjcFBhcmFtZXRlcnMucmVkdWNlZFNpemUgPSByc2l6ZS5sZW5ndGggPiAwO1xuICBydGNwUGFyYW1ldGVycy5jb21wb3VuZCA9IHJzaXplLmxlbmd0aCA9PT0gMDtcblxuICAvLyBwYXJzZXMgdGhlIHJ0Y3AtbXV4IGF0dHLRlmJ1dGUuXG4gIC8vIE5vdGUgdGhhdCBFZGdlIGRvZXMgbm90IHN1cHBvcnQgdW5tdXhlZCBSVENQLlxuICBjb25zdCBtdXggPSBTRFBVdGlscy5tYXRjaFByZWZpeChtZWRpYVNlY3Rpb24sICdhPXJ0Y3AtbXV4Jyk7XG4gIHJ0Y3BQYXJhbWV0ZXJzLm11eCA9IG11eC5sZW5ndGggPiAwO1xuXG4gIHJldHVybiBydGNwUGFyYW1ldGVycztcbn07XG5cblNEUFV0aWxzLndyaXRlUnRjcFBhcmFtZXRlcnMgPSBmdW5jdGlvbihydGNwUGFyYW1ldGVycykge1xuICBsZXQgc2RwID0gJyc7XG4gIGlmIChydGNwUGFyYW1ldGVycy5yZWR1Y2VkU2l6ZSkge1xuICAgIHNkcCArPSAnYT1ydGNwLXJzaXplXFxyXFxuJztcbiAgfVxuICBpZiAocnRjcFBhcmFtZXRlcnMubXV4KSB7XG4gICAgc2RwICs9ICdhPXJ0Y3AtbXV4XFxyXFxuJztcbiAgfVxuICBpZiAocnRjcFBhcmFtZXRlcnMuc3NyYyAhPT0gdW5kZWZpbmVkICYmIHJ0Y3BQYXJhbWV0ZXJzLmNuYW1lKSB7XG4gICAgc2RwICs9ICdhPXNzcmM6JyArIHJ0Y3BQYXJhbWV0ZXJzLnNzcmMgK1xuICAgICAgJyBjbmFtZTonICsgcnRjcFBhcmFtZXRlcnMuY25hbWUgKyAnXFxyXFxuJztcbiAgfVxuICByZXR1cm4gc2RwO1xufTtcblxuXG4vLyBwYXJzZXMgZWl0aGVyIGE9bXNpZDogb3IgYT1zc3JjOi4uLiBtc2lkIGxpbmVzIGFuZCByZXR1cm5zXG4vLyB0aGUgaWQgb2YgdGhlIE1lZGlhU3RyZWFtIGFuZCBNZWRpYVN0cmVhbVRyYWNrLlxuU0RQVXRpbHMucGFyc2VNc2lkID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uKSB7XG4gIGxldCBwYXJ0cztcbiAgY29uc3Qgc3BlYyA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9bXNpZDonKTtcbiAgaWYgKHNwZWMubGVuZ3RoID09PSAxKSB7XG4gICAgcGFydHMgPSBzcGVjWzBdLnN1YnN0cmluZyg3KS5zcGxpdCgnICcpO1xuICAgIHJldHVybiB7c3RyZWFtOiBwYXJ0c1swXSwgdHJhY2s6IHBhcnRzWzFdfTtcbiAgfVxuICBjb25zdCBwbGFuQiA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9c3NyYzonKVxuICAgIC5tYXAobGluZSA9PiBTRFBVdGlscy5wYXJzZVNzcmNNZWRpYShsaW5lKSlcbiAgICAuZmlsdGVyKG1zaWRQYXJ0cyA9PiBtc2lkUGFydHMuYXR0cmlidXRlID09PSAnbXNpZCcpO1xuICBpZiAocGxhbkIubGVuZ3RoID4gMCkge1xuICAgIHBhcnRzID0gcGxhbkJbMF0udmFsdWUuc3BsaXQoJyAnKTtcbiAgICByZXR1cm4ge3N0cmVhbTogcGFydHNbMF0sIHRyYWNrOiBwYXJ0c1sxXX07XG4gIH1cbn07XG5cbi8vIFNDVFBcbi8vIHBhcnNlcyBkcmFmdC1pZXRmLW1tdXNpYy1zY3RwLXNkcC0yNiBmaXJzdCBhbmQgZmFsbHMgYmFja1xuLy8gdG8gZHJhZnQtaWV0Zi1tbXVzaWMtc2N0cC1zZHAtMDVcblNEUFV0aWxzLnBhcnNlU2N0cERlc2NyaXB0aW9uID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uKSB7XG4gIGNvbnN0IG1saW5lID0gU0RQVXRpbHMucGFyc2VNTGluZShtZWRpYVNlY3Rpb24pO1xuICBjb25zdCBtYXhTaXplTGluZSA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9bWF4LW1lc3NhZ2Utc2l6ZTonKTtcbiAgbGV0IG1heE1lc3NhZ2VTaXplO1xuICBpZiAobWF4U2l6ZUxpbmUubGVuZ3RoID4gMCkge1xuICAgIG1heE1lc3NhZ2VTaXplID0gcGFyc2VJbnQobWF4U2l6ZUxpbmVbMF0uc3Vic3RyaW5nKDE5KSwgMTApO1xuICB9XG4gIGlmIChpc05hTihtYXhNZXNzYWdlU2l6ZSkpIHtcbiAgICBtYXhNZXNzYWdlU2l6ZSA9IDY1NTM2O1xuICB9XG4gIGNvbnN0IHNjdHBQb3J0ID0gU0RQVXRpbHMubWF0Y2hQcmVmaXgobWVkaWFTZWN0aW9uLCAnYT1zY3RwLXBvcnQ6Jyk7XG4gIGlmIChzY3RwUG9ydC5sZW5ndGggPiAwKSB7XG4gICAgcmV0dXJuIHtcbiAgICAgIHBvcnQ6IHBhcnNlSW50KHNjdHBQb3J0WzBdLnN1YnN0cmluZygxMiksIDEwKSxcbiAgICAgIHByb3RvY29sOiBtbGluZS5mbXQsXG4gICAgICBtYXhNZXNzYWdlU2l6ZSxcbiAgICB9O1xuICB9XG4gIGNvbnN0IHNjdHBNYXBMaW5lcyA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ2E9c2N0cG1hcDonKTtcbiAgaWYgKHNjdHBNYXBMaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgY29uc3QgcGFydHMgPSBzY3RwTWFwTGluZXNbMF1cbiAgICAgIC5zdWJzdHJpbmcoMTApXG4gICAgICAuc3BsaXQoJyAnKTtcbiAgICByZXR1cm4ge1xuICAgICAgcG9ydDogcGFyc2VJbnQocGFydHNbMF0sIDEwKSxcbiAgICAgIHByb3RvY29sOiBwYXJ0c1sxXSxcbiAgICAgIG1heE1lc3NhZ2VTaXplLFxuICAgIH07XG4gIH1cbn07XG5cbi8vIFNDVFBcbi8vIG91dHB1dHMgdGhlIGRyYWZ0LWlldGYtbW11c2ljLXNjdHAtc2RwLTI2IHZlcnNpb24gdGhhdCBhbGwgYnJvd3NlcnNcbi8vIHN1cHBvcnQgYnkgbm93IHJlY2VpdmluZyBpbiB0aGlzIGZvcm1hdCwgdW5sZXNzIHdlIG9yaWdpbmFsbHkgcGFyc2VkXG4vLyBhcyB0aGUgZHJhZnQtaWV0Zi1tbXVzaWMtc2N0cC1zZHAtMDUgZm9ybWF0IChpbmRpY2F0ZWQgYnkgdGhlIG0tbGluZVxuLy8gcHJvdG9jb2wgb2YgRFRMUy9TQ1RQIC0tIHdpdGhvdXQgVURQLyBvciBUQ1AvKVxuU0RQVXRpbHMud3JpdGVTY3RwRGVzY3JpcHRpb24gPSBmdW5jdGlvbihtZWRpYSwgc2N0cCkge1xuICBsZXQgb3V0cHV0ID0gW107XG4gIGlmIChtZWRpYS5wcm90b2NvbCAhPT0gJ0RUTFMvU0NUUCcpIHtcbiAgICBvdXRwdXQgPSBbXG4gICAgICAnbT0nICsgbWVkaWEua2luZCArICcgOSAnICsgbWVkaWEucHJvdG9jb2wgKyAnICcgKyBzY3RwLnByb3RvY29sICsgJ1xcclxcbicsXG4gICAgICAnYz1JTiBJUDQgMC4wLjAuMFxcclxcbicsXG4gICAgICAnYT1zY3RwLXBvcnQ6JyArIHNjdHAucG9ydCArICdcXHJcXG4nLFxuICAgIF07XG4gIH0gZWxzZSB7XG4gICAgb3V0cHV0ID0gW1xuICAgICAgJ209JyArIG1lZGlhLmtpbmQgKyAnIDkgJyArIG1lZGlhLnByb3RvY29sICsgJyAnICsgc2N0cC5wb3J0ICsgJ1xcclxcbicsXG4gICAgICAnYz1JTiBJUDQgMC4wLjAuMFxcclxcbicsXG4gICAgICAnYT1zY3RwbWFwOicgKyBzY3RwLnBvcnQgKyAnICcgKyBzY3RwLnByb3RvY29sICsgJyA2NTUzNVxcclxcbicsXG4gICAgXTtcbiAgfVxuICBpZiAoc2N0cC5tYXhNZXNzYWdlU2l6ZSAhPT0gdW5kZWZpbmVkKSB7XG4gICAgb3V0cHV0LnB1c2goJ2E9bWF4LW1lc3NhZ2Utc2l6ZTonICsgc2N0cC5tYXhNZXNzYWdlU2l6ZSArICdcXHJcXG4nKTtcbiAgfVxuICByZXR1cm4gb3V0cHV0LmpvaW4oJycpO1xufTtcblxuLy8gR2VuZXJhdGUgYSBzZXNzaW9uIElEIGZvciBTRFAuXG4vLyBodHRwczovL3Rvb2xzLmlldGYub3JnL2h0bWwvZHJhZnQtaWV0Zi1ydGN3ZWItanNlcC0yMCNzZWN0aW9uLTUuMi4xXG4vLyByZWNvbW1lbmRzIHVzaW5nIGEgY3J5cHRvZ3JhcGhpY2FsbHkgcmFuZG9tICt2ZSA2NC1iaXQgdmFsdWVcbi8vIGJ1dCByaWdodCBub3cgdGhpcyBzaG91bGQgYmUgYWNjZXB0YWJsZSBhbmQgd2l0aGluIHRoZSByaWdodCByYW5nZVxuU0RQVXRpbHMuZ2VuZXJhdGVTZXNzaW9uSWQgPSBmdW5jdGlvbigpIHtcbiAgcmV0dXJuIE1hdGgucmFuZG9tKCkudG9TdHJpbmcoKS5zdWJzdHIoMiwgMjIpO1xufTtcblxuLy8gV3JpdGUgYm9pbGVyIHBsYXRlIGZvciBzdGFydCBvZiBTRFBcbi8vIHNlc3NJZCBhcmd1bWVudCBpcyBvcHRpb25hbCAtIGlmIG5vdCBzdXBwbGllZCBpdCB3aWxsXG4vLyBiZSBnZW5lcmF0ZWQgcmFuZG9tbHlcbi8vIHNlc3NWZXJzaW9uIGlzIG9wdGlvbmFsIGFuZCBkZWZhdWx0cyB0byAyXG4vLyBzZXNzVXNlciBpcyBvcHRpb25hbCBhbmQgZGVmYXVsdHMgdG8gJ3RoaXNpc2FkYXB0ZXJvcnRjJ1xuU0RQVXRpbHMud3JpdGVTZXNzaW9uQm9pbGVycGxhdGUgPSBmdW5jdGlvbihzZXNzSWQsIHNlc3NWZXIsIHNlc3NVc2VyKSB7XG4gIGxldCBzZXNzaW9uSWQ7XG4gIGNvbnN0IHZlcnNpb24gPSBzZXNzVmVyICE9PSB1bmRlZmluZWQgPyBzZXNzVmVyIDogMjtcbiAgaWYgKHNlc3NJZCkge1xuICAgIHNlc3Npb25JZCA9IHNlc3NJZDtcbiAgfSBlbHNlIHtcbiAgICBzZXNzaW9uSWQgPSBTRFBVdGlscy5nZW5lcmF0ZVNlc3Npb25JZCgpO1xuICB9XG4gIGNvbnN0IHVzZXIgPSBzZXNzVXNlciB8fCAndGhpc2lzYWRhcHRlcm9ydGMnO1xuICAvLyBGSVhNRTogc2Vzcy1pZCBzaG91bGQgYmUgYW4gTlRQIHRpbWVzdGFtcC5cbiAgcmV0dXJuICd2PTBcXHJcXG4nICtcbiAgICAgICdvPScgKyB1c2VyICsgJyAnICsgc2Vzc2lvbklkICsgJyAnICsgdmVyc2lvbiArXG4gICAgICAgICcgSU4gSVA0IDEyNy4wLjAuMVxcclxcbicgK1xuICAgICAgJ3M9LVxcclxcbicgK1xuICAgICAgJ3Q9MCAwXFxyXFxuJztcbn07XG5cbi8vIEdldHMgdGhlIGRpcmVjdGlvbiBmcm9tIHRoZSBtZWRpYVNlY3Rpb24gb3IgdGhlIHNlc3Npb25wYXJ0LlxuU0RQVXRpbHMuZ2V0RGlyZWN0aW9uID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uLCBzZXNzaW9ucGFydCkge1xuICAvLyBMb29rIGZvciBzZW5kcmVjdiwgc2VuZG9ubHksIHJlY3Zvbmx5LCBpbmFjdGl2ZSwgZGVmYXVsdCB0byBzZW5kcmVjdi5cbiAgY29uc3QgbGluZXMgPSBTRFBVdGlscy5zcGxpdExpbmVzKG1lZGlhU2VjdGlvbik7XG4gIGZvciAobGV0IGkgPSAwOyBpIDwgbGluZXMubGVuZ3RoOyBpKyspIHtcbiAgICBzd2l0Y2ggKGxpbmVzW2ldKSB7XG4gICAgICBjYXNlICdhPXNlbmRyZWN2JzpcbiAgICAgIGNhc2UgJ2E9c2VuZG9ubHknOlxuICAgICAgY2FzZSAnYT1yZWN2b25seSc6XG4gICAgICBjYXNlICdhPWluYWN0aXZlJzpcbiAgICAgICAgcmV0dXJuIGxpbmVzW2ldLnN1YnN0cmluZygyKTtcbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIC8vIEZJWE1FOiBXaGF0IHNob3VsZCBoYXBwZW4gaGVyZT9cbiAgICB9XG4gIH1cbiAgaWYgKHNlc3Npb25wYXJ0KSB7XG4gICAgcmV0dXJuIFNEUFV0aWxzLmdldERpcmVjdGlvbihzZXNzaW9ucGFydCk7XG4gIH1cbiAgcmV0dXJuICdzZW5kcmVjdic7XG59O1xuXG5TRFBVdGlscy5nZXRLaW5kID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uKSB7XG4gIGNvbnN0IGxpbmVzID0gU0RQVXRpbHMuc3BsaXRMaW5lcyhtZWRpYVNlY3Rpb24pO1xuICBjb25zdCBtbGluZSA9IGxpbmVzWzBdLnNwbGl0KCcgJyk7XG4gIHJldHVybiBtbGluZVswXS5zdWJzdHJpbmcoMik7XG59O1xuXG5TRFBVdGlscy5pc1JlamVjdGVkID0gZnVuY3Rpb24obWVkaWFTZWN0aW9uKSB7XG4gIHJldHVybiBtZWRpYVNlY3Rpb24uc3BsaXQoJyAnLCAyKVsxXSA9PT0gJzAnO1xufTtcblxuU0RQVXRpbHMucGFyc2VNTGluZSA9IGZ1bmN0aW9uKG1lZGlhU2VjdGlvbikge1xuICBjb25zdCBsaW5lcyA9IFNEUFV0aWxzLnNwbGl0TGluZXMobWVkaWFTZWN0aW9uKTtcbiAgY29uc3QgcGFydHMgPSBsaW5lc1swXS5zdWJzdHJpbmcoMikuc3BsaXQoJyAnKTtcbiAgcmV0dXJuIHtcbiAgICBraW5kOiBwYXJ0c1swXSxcbiAgICBwb3J0OiBwYXJzZUludChwYXJ0c1sxXSwgMTApLFxuICAgIHByb3RvY29sOiBwYXJ0c1syXSxcbiAgICBmbXQ6IHBhcnRzLnNsaWNlKDMpLmpvaW4oJyAnKSxcbiAgfTtcbn07XG5cblNEUFV0aWxzLnBhcnNlT0xpbmUgPSBmdW5jdGlvbihtZWRpYVNlY3Rpb24pIHtcbiAgY29uc3QgbGluZSA9IFNEUFV0aWxzLm1hdGNoUHJlZml4KG1lZGlhU2VjdGlvbiwgJ289JylbMF07XG4gIGNvbnN0IHBhcnRzID0gbGluZS5zdWJzdHJpbmcoMikuc3BsaXQoJyAnKTtcbiAgcmV0dXJuIHtcbiAgICB1c2VybmFtZTogcGFydHNbMF0sXG4gICAgc2Vzc2lvbklkOiBwYXJ0c1sxXSxcbiAgICBzZXNzaW9uVmVyc2lvbjogcGFyc2VJbnQocGFydHNbMl0sIDEwKSxcbiAgICBuZXRUeXBlOiBwYXJ0c1szXSxcbiAgICBhZGRyZXNzVHlwZTogcGFydHNbNF0sXG4gICAgYWRkcmVzczogcGFydHNbNV0sXG4gIH07XG59O1xuXG4vLyBhIHZlcnkgbmFpdmUgaW50ZXJwcmV0YXRpb24gb2YgYSB2YWxpZCBTRFAuXG5TRFBVdGlscy5pc1ZhbGlkU0RQID0gZnVuY3Rpb24oYmxvYikge1xuICBpZiAodHlwZW9mIGJsb2IgIT09ICdzdHJpbmcnIHx8IGJsb2IubGVuZ3RoID09PSAwKSB7XG4gICAgcmV0dXJuIGZhbHNlO1xuICB9XG4gIGNvbnN0IGxpbmVzID0gU0RQVXRpbHMuc3BsaXRMaW5lcyhibG9iKTtcbiAgZm9yIChsZXQgaSA9IDA7IGkgPCBsaW5lcy5sZW5ndGg7IGkrKykge1xuICAgIGlmIChsaW5lc1tpXS5sZW5ndGggPCAyIHx8IGxpbmVzW2ldLmNoYXJBdCgxKSAhPT0gJz0nKSB7XG4gICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuICAgIC8vIFRPRE86IGNoZWNrIHRoZSBtb2RpZmllciBhIGJpdCBtb3JlLlxuICB9XG4gIHJldHVybiB0cnVlO1xufTtcblxuLy8gRXhwb3NlIHB1YmxpYyBtZXRob2RzLlxuaWYgKHR5cGVvZiBtb2R1bGUgPT09ICdvYmplY3QnKSB7XG4gIG1vZHVsZS5leHBvcnRzID0gU0RQVXRpbHM7XG59XG4iLCIvLyBUaGUgbW9kdWxlIGNhY2hlXG52YXIgX193ZWJwYWNrX21vZHVsZV9jYWNoZV9fID0ge307XG5cbi8vIFRoZSByZXF1aXJlIGZ1bmN0aW9uXG5mdW5jdGlvbiBfX3dlYnBhY2tfcmVxdWlyZV9fKG1vZHVsZUlkKSB7XG5cdC8vIENoZWNrIGlmIG1vZHVsZSBpcyBpbiBjYWNoZVxuXHR2YXIgY2FjaGVkTW9kdWxlID0gX193ZWJwYWNrX21vZHVsZV9jYWNoZV9fW21vZHVsZUlkXTtcblx0aWYgKGNhY2hlZE1vZHVsZSAhPT0gdW5kZWZpbmVkKSB7XG5cdFx0cmV0dXJuIGNhY2hlZE1vZHVsZS5leHBvcnRzO1xuXHR9XG5cdC8vIENyZWF0ZSBhIG5ldyBtb2R1bGUgKGFuZCBwdXQgaXQgaW50byB0aGUgY2FjaGUpXG5cdHZhciBtb2R1bGUgPSBfX3dlYnBhY2tfbW9kdWxlX2NhY2hlX19bbW9kdWxlSWRdID0ge1xuXHRcdC8vIG5vIG1vZHVsZS5pZCBuZWVkZWRcblx0XHQvLyBubyBtb2R1bGUubG9hZGVkIG5lZWRlZFxuXHRcdGV4cG9ydHM6IHt9XG5cdH07XG5cblx0Ly8gRXhlY3V0ZSB0aGUgbW9kdWxlIGZ1bmN0aW9uXG5cdF9fd2VicGFja19tb2R1bGVzX19bbW9kdWxlSWRdKG1vZHVsZSwgbW9kdWxlLmV4cG9ydHMsIF9fd2VicGFja19yZXF1aXJlX18pO1xuXG5cdC8vIFJldHVybiB0aGUgZXhwb3J0cyBvZiB0aGUgbW9kdWxlXG5cdHJldHVybiBtb2R1bGUuZXhwb3J0cztcbn1cblxuIiwiIiwiLy8gc3RhcnR1cFxuLy8gTG9hZCBlbnRyeSBtb2R1bGUgYW5kIHJldHVybiBleHBvcnRzXG4vLyBUaGlzIGVudHJ5IG1vZHVsZSBpcyByZWZlcmVuY2VkIGJ5IG90aGVyIG1vZHVsZXMgc28gaXQgY2FuJ3QgYmUgaW5saW5lZFxudmFyIF9fd2VicGFja19leHBvcnRzX18gPSBfX3dlYnBhY2tfcmVxdWlyZV9fKFwiLi9zcmMvaW5kZXguanNcIik7XG4iLCIiXSwibmFtZXMiOlsiX3JlZ2VuZXJhdG9yUnVudGltZSIsImUiLCJ0IiwiciIsIk9iamVjdCIsInByb3RvdHlwZSIsIm4iLCJoYXNPd25Qcm9wZXJ0eSIsIm8iLCJkZWZpbmVQcm9wZXJ0eSIsInZhbHVlIiwiaSIsIlN5bWJvbCIsImEiLCJpdGVyYXRvciIsImMiLCJhc3luY0l0ZXJhdG9yIiwidSIsInRvU3RyaW5nVGFnIiwiZGVmaW5lIiwiZW51bWVyYWJsZSIsImNvbmZpZ3VyYWJsZSIsIndyaXRhYmxlIiwid3JhcCIsIkdlbmVyYXRvciIsImNyZWF0ZSIsIkNvbnRleHQiLCJtYWtlSW52b2tlTWV0aG9kIiwidHJ5Q2F0Y2giLCJ0eXBlIiwiYXJnIiwiY2FsbCIsImgiLCJsIiwiZiIsInMiLCJ5IiwiR2VuZXJhdG9yRnVuY3Rpb24iLCJHZW5lcmF0b3JGdW5jdGlvblByb3RvdHlwZSIsInAiLCJkIiwiZ2V0UHJvdG90eXBlT2YiLCJ2IiwidmFsdWVzIiwiZyIsImRlZmluZUl0ZXJhdG9yTWV0aG9kcyIsImZvckVhY2giLCJfaW52b2tlIiwiQXN5bmNJdGVyYXRvciIsImludm9rZSIsIl90eXBlb2YiLCJyZXNvbHZlIiwiX19hd2FpdCIsInRoZW4iLCJjYWxsSW52b2tlV2l0aE1ldGhvZEFuZEFyZyIsIkVycm9yIiwiZG9uZSIsIm1ldGhvZCIsImRlbGVnYXRlIiwibWF5YmVJbnZva2VEZWxlZ2F0ZSIsInNlbnQiLCJfc2VudCIsImRpc3BhdGNoRXhjZXB0aW9uIiwiYWJydXB0IiwiVHlwZUVycm9yIiwicmVzdWx0TmFtZSIsIm5leHQiLCJuZXh0TG9jIiwicHVzaFRyeUVudHJ5IiwidHJ5TG9jIiwiY2F0Y2hMb2MiLCJmaW5hbGx5TG9jIiwiYWZ0ZXJMb2MiLCJ0cnlFbnRyaWVzIiwicHVzaCIsInJlc2V0VHJ5RW50cnkiLCJjb21wbGV0aW9uIiwicmVzZXQiLCJpc05hTiIsImxlbmd0aCIsImRpc3BsYXlOYW1lIiwiaXNHZW5lcmF0b3JGdW5jdGlvbiIsImNvbnN0cnVjdG9yIiwibmFtZSIsIm1hcmsiLCJzZXRQcm90b3R5cGVPZiIsIl9fcHJvdG9fXyIsImF3cmFwIiwiYXN5bmMiLCJQcm9taXNlIiwia2V5cyIsInJldmVyc2UiLCJwb3AiLCJwcmV2IiwiY2hhckF0Iiwic2xpY2UiLCJzdG9wIiwicnZhbCIsImhhbmRsZSIsImNvbXBsZXRlIiwiZmluaXNoIiwiX2NhdGNoIiwiZGVsZWdhdGVZaWVsZCIsImFzeW5jR2VuZXJhdG9yU3RlcCIsImdlbiIsInJlamVjdCIsIl9uZXh0IiwiX3Rocm93Iiwia2V5IiwiaW5mbyIsImVycm9yIiwiX2FzeW5jVG9HZW5lcmF0b3IiLCJmbiIsInNlbGYiLCJhcmdzIiwiYXJndW1lbnRzIiwiYXBwbHkiLCJlcnIiLCJ1bmRlZmluZWQiLCJfY2xhc3NDYWxsQ2hlY2siLCJpbnN0YW5jZSIsIkNvbnN0cnVjdG9yIiwiX2RlZmluZVByb3BlcnRpZXMiLCJ0YXJnZXQiLCJwcm9wcyIsImRlc2NyaXB0b3IiLCJfdG9Qcm9wZXJ0eUtleSIsIl9jcmVhdGVDbGFzcyIsInByb3RvUHJvcHMiLCJzdGF0aWNQcm9wcyIsIl90b1ByaW1pdGl2ZSIsIlN0cmluZyIsInRvUHJpbWl0aXZlIiwiTnVtYmVyIiwibWoiLCJyZXF1aXJlIiwiSmFudXNTZXNzaW9uIiwic2VuZE9yaWdpbmFsIiwic2VuZCIsInNpZ25hbCIsIm1lc3NhZ2UiLCJpbmRleE9mIiwiY29uc29sZSIsIk5BRiIsImNvbm5lY3Rpb24iLCJhZGFwdGVyIiwicmVjb25uZWN0Iiwic2RwVXRpbHMiLCJkZWJ1ZyIsIndhcm4iLCJpc1NhZmFyaSIsInRlc3QiLCJuYXZpZ2F0b3IiLCJ1c2VyQWdlbnQiLCJTVUJTQ1JJQkVfVElNRU9VVF9NUyIsIkFWQUlMQUJMRV9PQ0NVUEFOVFNfVEhSRVNIT0xEIiwiTUFYX1NVQlNDUklCRV9ERUxBWSIsInJhbmRvbURlbGF5IiwibWluIiwibWF4IiwiZGVsYXkiLCJNYXRoIiwicmFuZG9tIiwic2V0VGltZW91dCIsImRlYm91bmNlIiwiY3VyciIsIl90aGlzIiwiQXJyYXkiLCJfIiwicmFuZG9tVWludCIsImZsb29yIiwiTUFYX1NBRkVfSU5URUdFUiIsInVudGlsRGF0YUNoYW5uZWxPcGVuIiwiZGF0YUNoYW5uZWwiLCJyZWFkeVN0YXRlIiwicmVzb2x2ZXIiLCJyZWplY3RvciIsImNsZWFyIiwicmVtb3ZlRXZlbnRMaXN0ZW5lciIsImFkZEV2ZW50TGlzdGVuZXIiLCJpc0gyNjRWaWRlb1N1cHBvcnRlZCIsInZpZGVvIiwiZG9jdW1lbnQiLCJjcmVhdGVFbGVtZW50IiwiY2FuUGxheVR5cGUiLCJPUFVTX1BBUkFNRVRFUlMiLCJ1c2VkdHgiLCJzdGVyZW8iLCJERUZBVUxUX1BFRVJfQ09OTkVDVElPTl9DT05GSUciLCJpY2VTZXJ2ZXJzIiwidXJscyIsIldTX05PUk1BTF9DTE9TVVJFIiwiSmFudXNBZGFwdGVyIiwicm9vbSIsImNsaWVudElkIiwiam9pblRva2VuIiwic2VydmVyVXJsIiwid2ViUnRjT3B0aW9ucyIsInBlZXJDb25uZWN0aW9uQ29uZmlnIiwid3MiLCJzZXNzaW9uIiwicmVsaWFibGVUcmFuc3BvcnQiLCJ1bnJlbGlhYmxlVHJhbnNwb3J0IiwiaW5pdGlhbFJlY29ubmVjdGlvbkRlbGF5IiwicmVjb25uZWN0aW9uRGVsYXkiLCJyZWNvbm5lY3Rpb25UaW1lb3V0IiwibWF4UmVjb25uZWN0aW9uQXR0ZW1wdHMiLCJyZWNvbm5lY3Rpb25BdHRlbXB0cyIsInB1Ymxpc2hlciIsIm9jY3VwYW50SWRzIiwib2NjdXBhbnRzIiwibWVkaWFTdHJlYW1zIiwibG9jYWxNZWRpYVN0cmVhbSIsInBlbmRpbmdNZWRpYVJlcXVlc3RzIiwiTWFwIiwicGVuZGluZ09jY3VwYW50cyIsIlNldCIsImF2YWlsYWJsZU9jY3VwYW50cyIsInJlcXVlc3RlZE9jY3VwYW50cyIsImJsb2NrZWRDbGllbnRzIiwiZnJvemVuVXBkYXRlcyIsInRpbWVPZmZzZXRzIiwic2VydmVyVGltZVJlcXVlc3RzIiwiYXZnVGltZU9mZnNldCIsIm9uV2Vic29ja2V0T3BlbiIsImJpbmQiLCJvbldlYnNvY2tldENsb3NlIiwib25XZWJzb2NrZXRNZXNzYWdlIiwib25EYXRhQ2hhbm5lbE1lc3NhZ2UiLCJvbkRhdGEiLCJzZXRTZXJ2ZXJVcmwiLCJ1cmwiLCJzZXRBcHAiLCJhcHAiLCJzZXRSb29tIiwicm9vbU5hbWUiLCJzZXRKb2luVG9rZW4iLCJzZXRDbGllbnRJZCIsInNldFdlYlJ0Y09wdGlvbnMiLCJvcHRpb25zIiwic2V0UGVlckNvbm5lY3Rpb25Db25maWciLCJzZXRTZXJ2ZXJDb25uZWN0TGlzdGVuZXJzIiwic3VjY2Vzc0xpc3RlbmVyIiwiZmFpbHVyZUxpc3RlbmVyIiwiY29ubmVjdFN1Y2Nlc3MiLCJjb25uZWN0RmFpbHVyZSIsInNldFJvb21PY2N1cGFudExpc3RlbmVyIiwib2NjdXBhbnRMaXN0ZW5lciIsIm9uT2NjdXBhbnRzQ2hhbmdlZCIsInNldERhdGFDaGFubmVsTGlzdGVuZXJzIiwib3Blbkxpc3RlbmVyIiwiY2xvc2VkTGlzdGVuZXIiLCJtZXNzYWdlTGlzdGVuZXIiLCJvbk9jY3VwYW50Q29ubmVjdGVkIiwib25PY2N1cGFudERpc2Nvbm5lY3RlZCIsIm9uT2NjdXBhbnRNZXNzYWdlIiwic2V0UmVjb25uZWN0aW9uTGlzdGVuZXJzIiwicmVjb25uZWN0aW5nTGlzdGVuZXIiLCJyZWNvbm5lY3RlZExpc3RlbmVyIiwicmVjb25uZWN0aW9uRXJyb3JMaXN0ZW5lciIsIm9uUmVjb25uZWN0aW5nIiwib25SZWNvbm5lY3RlZCIsIm9uUmVjb25uZWN0aW9uRXJyb3IiLCJzZXRFdmVudExvb3BzIiwibG9vcHMiLCJjb25uZWN0IiwiX3RoaXMyIiwiY29uY2F0Iiwid2Vic29ja2V0Q29ubmVjdGlvbiIsIldlYlNvY2tldCIsInRpbWVvdXRNcyIsIndzT25PcGVuIiwiYWxsIiwidXBkYXRlVGltZU9mZnNldCIsImRpc2Nvbm5lY3QiLCJjbGVhclRpbWVvdXQiLCJyZW1vdmVBbGxPY2N1cGFudHMiLCJjb25uIiwiY2xvc2UiLCJkaXNwb3NlIiwiZGVsYXllZFJlY29ubmVjdFRpbWVvdXQiLCJpc0Rpc2Nvbm5lY3RlZCIsIl9vbldlYnNvY2tldE9wZW4iLCJfY2FsbGVlIiwib2NjdXBhbnRJZCIsIl9jYWxsZWUkIiwiX2NvbnRleHQiLCJjcmVhdGVQdWJsaXNoZXIiLCJpbml0aWFsT2NjdXBhbnRzIiwiYWRkQXZhaWxhYmxlT2NjdXBhbnQiLCJzeW5jT2NjdXBhbnRzIiwiZXZlbnQiLCJfdGhpczMiLCJjb2RlIiwiX3RoaXM0IiwicGVyZm9ybURlbGF5ZWRSZWNvbm5lY3QiLCJfdGhpczUiLCJyZWNlaXZlIiwiSlNPTiIsInBhcnNlIiwiZGF0YSIsInJlbW92ZUF2YWlsYWJsZU9jY3VwYW50IiwiaWR4Iiwic3BsaWNlIiwiaGFzIiwiYWRkT2NjdXBhbnQiLCJqIiwicmVtb3ZlT2NjdXBhbnQiLCJfYWRkT2NjdXBhbnQiLCJfY2FsbGVlMiIsImF2YWlsYWJsZU9jY3VwYW50c0NvdW50Iiwic3Vic2NyaWJlciIsIl9jYWxsZWUyJCIsIl9jb250ZXh0MiIsImFkZCIsImNyZWF0ZVN1YnNjcmliZXIiLCJzZXRNZWRpYVN0cmVhbSIsIm1lZGlhU3RyZWFtIiwiX3giLCJtc2ciLCJnZXQiLCJhdWRpbyIsImFzc29jaWF0ZSIsIl90aGlzNiIsImV2Iiwic2VuZFRyaWNrbGUiLCJjYW5kaWRhdGUiLCJpY2VDb25uZWN0aW9uU3RhdGUiLCJsb2ciLCJvZmZlciIsImNyZWF0ZU9mZmVyIiwiY29uZmlndXJlUHVibGlzaGVyU2RwIiwiZml4U2FmYXJpSWNlVUZyYWciLCJsb2NhbCIsInNldExvY2FsRGVzY3JpcHRpb24iLCJyZW1vdGUiLCJzZW5kSnNlcCIsInNldFJlbW90ZURlc2NyaXB0aW9uIiwianNlcCIsIm9uIiwiYW5zd2VyIiwiY29uZmlndXJlU3Vic2NyaWJlclNkcCIsImNyZWF0ZUFuc3dlciIsIl9jcmVhdGVQdWJsaXNoZXIiLCJfY2FsbGVlMyIsIl90aGlzNyIsIndlYnJ0Y3VwIiwicmVsaWFibGVDaGFubmVsIiwidW5yZWxpYWJsZUNoYW5uZWwiLCJfY2FsbGVlMyQiLCJfY29udGV4dDMiLCJKYW51c1BsdWdpbkhhbmRsZSIsIlJUQ1BlZXJDb25uZWN0aW9uIiwiYXR0YWNoIiwicGFyc2VJbnQiLCJjcmVhdGVEYXRhQ2hhbm5lbCIsIm9yZGVyZWQiLCJtYXhSZXRyYW5zbWl0cyIsImdldFRyYWNrcyIsInRyYWNrIiwiYWRkVHJhY2siLCJwbHVnaW5kYXRhIiwicm9vbV9pZCIsInVzZXJfaWQiLCJib2R5IiwiZGlzcGF0Y2hFdmVudCIsIkN1c3RvbUV2ZW50IiwiZGV0YWlsIiwiYnkiLCJzZW5kSm9pbiIsIm5vdGlmaWNhdGlvbnMiLCJzdWNjZXNzIiwicmVzcG9uc2UiLCJ1c2VycyIsImluY2x1ZGVzIiwic2RwIiwicmVwbGFjZSIsImxpbmUiLCJwdCIsInBhcmFtZXRlcnMiLCJhc3NpZ24iLCJwYXJzZUZtdHAiLCJ3cml0ZUZtdHAiLCJwYXlsb2FkVHlwZSIsIl9maXhTYWZhcmlJY2VVRnJhZyIsIl9jYWxsZWU0IiwiX2NhbGxlZTQkIiwiX2NvbnRleHQ0IiwiX3gyIiwiX2NyZWF0ZVN1YnNjcmliZXIiLCJfY2FsbGVlNSIsIl90aGlzOCIsIm1heFJldHJpZXMiLCJ3ZWJydGNGYWlsZWQiLCJyZWNlaXZlcnMiLCJfYXJnczUiLCJfY2FsbGVlNSQiLCJfY29udGV4dDUiLCJsZWZ0SW50ZXJ2YWwiLCJzZXRJbnRlcnZhbCIsImNsZWFySW50ZXJ2YWwiLCJ0aW1lb3V0IiwibWVkaWEiLCJfaU9TSGFja0RlbGF5ZWRJbml0aWFsUGVlciIsIk1lZGlhU3RyZWFtIiwiZ2V0UmVjZWl2ZXJzIiwicmVjZWl2ZXIiLCJfeDMiLCJzdWJzY3JpYmUiLCJzZW5kTWVzc2FnZSIsImtpbmQiLCJ0b2tlbiIsInRvZ2dsZUZyZWV6ZSIsImZyb3plbiIsInVuZnJlZXplIiwiZnJlZXplIiwiZmx1c2hQZW5kaW5nVXBkYXRlcyIsImRhdGFGb3JVcGRhdGVNdWx0aU1lc3NhZ2UiLCJuZXR3b3JrSWQiLCJnZXRQZW5kaW5nRGF0YSIsImRhdGFUeXBlIiwib3duZXIiLCJnZXRQZW5kaW5nRGF0YUZvck5ldHdvcmtJZCIsIl9pdGVyYXRvciIsIl9jcmVhdGVGb3JPZkl0ZXJhdG9ySGVscGVyIiwiX3N0ZXAiLCJfc3RlcCR2YWx1ZSIsIl9zbGljZWRUb0FycmF5Iiwic291cmNlIiwic3RvcmVNZXNzYWdlIiwic3RvcmVTaW5nbGVNZXNzYWdlIiwiaW5kZXgiLCJzZXQiLCJzdG9yZWRNZXNzYWdlIiwic3RvcmVkRGF0YSIsImlzT3V0ZGF0ZWRNZXNzYWdlIiwibGFzdE93bmVyVGltZSIsImlzQ29udGVtcG9yYW5lb3VzTWVzc2FnZSIsImNyZWF0ZWRXaGlsZUZyb3plbiIsImlzRmlyc3RTeW5jIiwiY29tcG9uZW50cyIsImVuYWJsZWQiLCJzaG91bGRTdGFydENvbm5lY3Rpb25UbyIsImNsaWVudCIsInN0YXJ0U3RyZWFtQ29ubmVjdGlvbiIsImNsb3NlU3RyZWFtQ29ubmVjdGlvbiIsImdldENvbm5lY3RTdGF0dXMiLCJhZGFwdGVycyIsIklTX0NPTk5FQ1RFRCIsIk5PVF9DT05ORUNURUQiLCJfdXBkYXRlVGltZU9mZnNldCIsIl9jYWxsZWU2IiwiX3RoaXM5IiwiY2xpZW50U2VudFRpbWUiLCJyZXMiLCJwcmVjaXNpb24iLCJzZXJ2ZXJSZWNlaXZlZFRpbWUiLCJjbGllbnRSZWNlaXZlZFRpbWUiLCJzZXJ2ZXJUaW1lIiwidGltZU9mZnNldCIsIl9jYWxsZWU2JCIsIl9jb250ZXh0NiIsIkRhdGUiLCJub3ciLCJmZXRjaCIsImxvY2F0aW9uIiwiaHJlZiIsImNhY2hlIiwiaGVhZGVycyIsImdldFRpbWUiLCJyZWR1Y2UiLCJhY2MiLCJvZmZzZXQiLCJnZXRTZXJ2ZXJUaW1lIiwiZ2V0TWVkaWFTdHJlYW0iLCJfdGhpczEwIiwiYXVkaW9Qcm9taXNlIiwidmlkZW9Qcm9taXNlIiwicHJvbWlzZSIsInN0cmVhbSIsImF1ZGlvU3RyZWFtIiwiZ2V0QXVkaW9UcmFja3MiLCJ2aWRlb1N0cmVhbSIsImdldFZpZGVvVHJhY2tzIiwiX3NldExvY2FsTWVkaWFTdHJlYW0iLCJfY2FsbGVlNyIsIl90aGlzMTEiLCJleGlzdGluZ1NlbmRlcnMiLCJuZXdTZW5kZXJzIiwidHJhY2tzIiwiX2xvb3AiLCJfY2FsbGVlNyQiLCJfY29udGV4dDgiLCJnZXRTZW5kZXJzIiwic2VuZGVyIiwiX2xvb3AkIiwiX2NvbnRleHQ3IiwiZmluZCIsInJlcGxhY2VUcmFjayIsInRvTG93ZXJDYXNlIiwicmVtb3ZlVHJhY2siLCJzZXRMb2NhbE1lZGlhU3RyZWFtIiwiX3g0IiwiZW5hYmxlTWljcm9waG9uZSIsInNlbmREYXRhIiwic3RyaW5naWZ5Iiwid2hvbSIsInNlbmREYXRhR3VhcmFudGVlZCIsImJyb2FkY2FzdERhdGEiLCJicm9hZGNhc3REYXRhR3VhcmFudGVlZCIsImtpY2siLCJwZXJtc1Rva2VuIiwiYmxvY2siLCJfdGhpczEyIiwidW5ibG9jayIsIl90aGlzMTMiLCJyZWdpc3RlciIsIm1vZHVsZSIsImV4cG9ydHMiXSwic291cmNlUm9vdCI6IiJ9