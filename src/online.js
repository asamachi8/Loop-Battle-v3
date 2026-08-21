/* =========================================================================
 * online.js
 * オンライン対戦の接続まわり（WebRTC / PeerJS）と、部屋のURLの扱い。
 *
 * 通信の中身は net.js の Session が担当し、ここは「繋ぐ」ことだけを行う。
 *
 * 仕組み：
 *   部屋を作った側が固有のIDを持ち、そのIDを ?room= に載せたURLを共有する。
 *   参加側はそのIDへ直接つなぎ、以後は2台のブラウザ同士（P2P）で通信する。
 *   接続の仲介にだけ PeerJS の公開ブローカーを使う（対局データは経由しない）。
 * ========================================================================= */
window.LB = window.LB || {};
(function (LB) {
  'use strict';

  var PEER_LIB = 'src/vendor/peerjs.min.js';
  var ID_PREFIX = 'loopbattle-';
  var ROOM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 紛らわしい文字は除く
  var libPromise = null;

  function loadPeerLib() {
    if (window.Peer) return Promise.resolve(window.Peer);
    if (libPromise) return libPromise;
    libPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PEER_LIB;
      s.onload = function () {
        window.Peer ? resolve(window.Peer) : reject(new Error('PeerJS を読み込めませんでした。'));
      };
      s.onerror = function () {
        reject(new Error('通信ライブラリ (' + PEER_LIB + ') を読み込めませんでした。'));
      };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function randomRoomId(len) {
    var out = '';
    var buf = new Uint8Array(len);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    for (var i = 0; i < len; i++) out += ROOM_CHARS[buf[i] % ROOM_CHARS.length];
    return out;
  }

  function roomFromUrl() {
    var m = location.search.match(/[?&]room=([A-Za-z0-9]+)/);
    return m ? m[1].toUpperCase() : null;
  }

  function roomUrl(roomId) {
    return location.origin + location.pathname + '?room=' + roomId;
  }

  /**
   * PeerJS の DataConnection を net.js の transport 形に包む。
   */
  function wrapConnection(conn) {
    var transport = {
      onOpen: null, onMessage: null, onClose: null, onError: null,
      send: function (msg) { conn.send(msg); },
      close: function () { try { conn.close(); } catch (e) { /* already closed */ } }
    };
    conn.on('data', function (data) { if (transport.onMessage) transport.onMessage(data); });
    conn.on('close', function () { if (transport.onClose) transport.onClose('相手との接続が切れました。'); });
    conn.on('error', function (e) { if (transport.onError) transport.onError('通信エラー: ' + e.message); });
    return transport;
  }

  /**
   * オンライン対戦の管理。
   * @param {Object} deps { game, onSession, onStatus, onRoom }
   */
  function Online(deps) {
    this.game = deps.game;
    this.onSession = deps.onSession || function () {};
    this.onStatus = deps.onStatus || function () {};
    this.onRoom = deps.onRoom || function () {};
    this.peer = null;
    this.session = null;
    this.roomId = null;
    this.role = null;
  }

  Online.prototype.status = function (text, kind) {
    this.onStatus(text, kind || 'info');
  };

  /** 部屋を作る（Player 1 側） */
  Online.prototype.host = function () {
    var self = this;
    if (this.peer) this.leave();
    this.role = 'host';
    this.roomId = randomRoomId(6);
    this.status('部屋を準備しています…', 'info');

    loadPeerLib().then(function (Peer) {
      self.peer = new Peer(ID_PREFIX + self.roomId, { debug: 0 });

      self.peer.on('open', function () {
        self.onRoom(self.roomId, roomUrl(self.roomId));
        self.status('URLを相手に送ってください。参加を待っています…', 'wait');
      });

      self.peer.on('connection', function (conn) {
        if (self.session && self.session.connected) {
          // 既に対戦中なら、後から来た接続は断る
          conn.on('open', function () { conn.close(); });
          return;
        }
        conn.on('open', function () { self.attach(conn); });
      });

      self.peer.on('error', function (err) { self.handlePeerError(err); });
      self.peer.on('disconnected', function () {
        self.status('仲介サーバーとの接続が切れました。対戦中の通信は続きます。', 'warn');
      });
    }).catch(function (e) { self.status(e.message, 'error'); });
  };

  /** 部屋に参加する（Player 2 側） */
  Online.prototype.join = function (roomId) {
    var self = this;
    if (this.peer) this.leave();
    this.role = 'guest';
    this.roomId = roomId;
    this.status('部屋 ' + roomId + ' に接続しています…', 'info');

    loadPeerLib().then(function (Peer) {
      self.peer = new Peer({ debug: 0 });

      self.peer.on('open', function () {
        var conn = self.peer.connect(ID_PREFIX + roomId, { reliable: true });
        var timer = setTimeout(function () {
          if (!self.session || !self.session.connected) {
            self.status('接続できませんでした。相手が部屋を開いているか確認してください。', 'error');
          }
        }, 12000);
        conn.on('open', function () { clearTimeout(timer); self.attach(conn); });
        conn.on('error', function (e) { clearTimeout(timer); self.status('接続エラー: ' + e.message, 'error'); });
      });

      self.peer.on('error', function (err) { self.handlePeerError(err); });
    }).catch(function (e) { self.status(e.message, 'error'); });
  };

  Online.prototype.handlePeerError = function (err) {
    var type = err && err.type;
    if (type === 'unavailable-id') {
      this.status('この部屋IDは使用中です。もう一度「対戦部屋を作る」を押してください。', 'error');
    } else if (type === 'peer-unavailable') {
      this.status('相手が見つかりません。部屋が閉じられたか、URLが古い可能性があります。', 'error');
    } else if (type === 'network' || type === 'server-error' || type === 'socket-error') {
      this.status('仲介サーバーに接続できませんでした。時間をおいて試してください。', 'error');
    } else if (type === 'browser-incompatible') {
      this.status('このブラウザは WebRTC に対応していません。', 'error');
    } else {
      this.status('接続エラー' + (type ? '（' + type + '）' : '') + '。', 'error');
    }
  };

  Online.prototype.attach = function (conn) {
    var self = this;
    this.conn = conn;
    this.session = new LB.Session({
      game: this.game,
      transport: wrapConnection(conn),
      role: this.role,
      onChange: function (info) { self.onSession(self.session, info); },
      onStatus: function (text, kind) { self.status(text, kind); }
    });
    this.session.handleOpen();
    this.onSession(this.session);
  };

  Online.prototype.leave = function () {
    if (this.session) this.session.leave();
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* noop */ } }
    this.peer = null;
    this.session = null;
    this.conn = null;
    this.roomId = null;
    this.role = null;
    this.onSession(null);
    this.status('ローカル対戦に戻りました（同じPCで2人）。', 'info');
  };

  LB.Online = Online;
  LB.roomFromUrl = roomFromUrl;
  LB.roomUrl = roomUrl;

})(window.LB);
