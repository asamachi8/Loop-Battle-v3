/* =========================================================================
 * net.js
 * オンライン対戦の同期処理。通信手段そのものには依存しない。
 *
 * Session は「send(msg) を持ち、onMessage / onOpen / onClose を呼んでくる」
 * だけの transport を受け取る。実際の WebRTC 接続は online.js が担当する。
 * こうしておくと、ループバック transport を使ってブラウザ1枚で同期処理を
 * テストできる。
 *
 * 同期方式：
 *   手を指した側が「設定＋盤面の状態」をまるごと送り、受け取った側は
 *   それで置き換える。差分同期をしないぶん、ズレが原理的に起きない。
 *   1手あたり数KBだが、6駒のゲームなので問題にならない。
 *
 * 役割：
 *   部屋を作った側（host）が Player 1、参加した側（guest）が Player 2。
 *   設定（ルール・盤面の種類）は host のものを正とする。
 * ========================================================================= */
window.LB = window.LB || {};
(function (LB) {
  'use strict';

  var PROTOCOL_VERSION = 1;

  /**
   * @param {Object} deps
   *   game      : LB.Game
   *   transport : { send(msg), close() } / Session が onMessage 等を差し込む
   *   role      : 'host' | 'guest'
   *   onChange  : 状態が変わったときに呼ばれる（再描画用）
   *   onStatus  : 接続状態の通知 function(text, kind)
   */
  function Session(deps) {
    this.game = deps.game;
    this.transport = deps.transport;
    this.role = deps.role;
    this.onChange = deps.onChange || function () {};
    this.onStatus = deps.onStatus || function () {};
    this.player = this.role === 'host' ? 'p1' : 'p2';
    this.connected = false;

    var self = this;
    this.transport.onOpen = function () { self.handleOpen(); };
    this.transport.onMessage = function (msg) { self.handleMessage(msg); };
    this.transport.onClose = function (reason) { self.handleClose(reason); };
    this.transport.onError = function (err) { self.onStatus(err, 'error'); };
  }

  /** 自分が操作してよいプレイヤー */
  Session.prototype.localPlayer = function () {
    return this.player;
  };

  Session.prototype.isMyTurn = function () {
    return this.game.state.currentPlayer === this.player;
  };

  // ---- 送受信 -----------------------------------------------------------

  Session.prototype.snapshot = function () {
    return {
      t: 'sync',
      v: PROTOCOL_VERSION,
      config: this.game.config,
      state: this.game.state,
      log: this.game.log
    };
  };

  Session.prototype.send = function (msg) {
    try {
      this.transport.send(msg);
    } catch (e) {
      this.onStatus('送信に失敗しました: ' + e.message, 'error');
    }
  };

  Session.prototype.handleOpen = function () {
    this.connected = true;
    this.onStatus(this.role === 'host'
      ? '相手が接続しました。あなたは Player 1（青）です。'
      : '接続しました。あなたは Player 2（赤）です。', 'ok');
    // host が現在の設定と盤面を送って初期同期する
    if (this.role === 'host') this.send(this.snapshot());
    this.onChange();
  };

  Session.prototype.handleClose = function (reason) {
    this.connected = false;
    this.onStatus(reason || '接続が切れました。', 'warn');
    this.onChange();
  };

  Session.prototype.handleMessage = function (msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.v && msg.v !== PROTOCOL_VERSION) {
      this.onStatus('相手のバージョンが違います。同じURLを開き直してください。', 'error');
      return;
    }
    if (msg.t === 'sync') {
      var rebuilt = this.applySnapshot(msg);
      this.onChange({ boardRebuilt: rebuilt });
    } else if (msg.t === 'resign') {
      this.onStatus('相手が退出しました。', 'warn');
      this.connected = false;
      this.onChange();
    }
  };

  /** 受け取った盤面で自分の状態を置き換える。盤面を作り直したら true を返す。 */
  Session.prototype.applySnapshot = function (msg) {
    var game = this.game;
    var rebuilt = false;
    if (msg.config) {
      // 設定が変わっていれば盤面を作り直す（盤面の種類やHPの変更に追従する）
      if (JSON.stringify(game.config) !== JSON.stringify(msg.config)) {
        game.applyConfig(msg.config);
        rebuilt = true;
      }
    }
    if (msg.state) game.state = msg.state;
    if (msg.log) game.log = msg.log;
    return rebuilt;
  };

  /** 自分が1手指したあとに呼ぶ */
  Session.prototype.pushLocalMove = function () {
    if (!this.connected) return;
    this.send(this.snapshot());
  };

  /** host が RESTART や設定変更をしたときに呼ぶ */
  Session.prototype.pushConfig = function () {
    if (!this.connected) return;
    this.send(this.snapshot());
  };

  Session.prototype.leave = function () {
    if (this.connected) this.send({ t: 'resign', v: PROTOCOL_VERSION });
    this.connected = false;
    try { this.transport.close(); } catch (e) { /* 切断済み */ }
  };

  // ---- テスト用のループバック transport ---------------------------------
  /**
   * 2つの Session を直結する。ネットワーク無しで同期処理を確認できる。
   * @return [transportA, transportB]
   */
  LB.createLoopbackPair = function () {
    function make() {
      return {
        peer: null,
        onOpen: null, onMessage: null, onClose: null, onError: null,
        send: function (msg) {
          var clone = JSON.parse(JSON.stringify(msg));
          var target = this.peer;
          if (target && target.onMessage) target.onMessage(clone);
        },
        close: function () {
          if (this.peer && this.peer.onClose) this.peer.onClose('切断しました。');
        }
      };
    }
    var a = make(), b = make();
    a.peer = b; b.peer = a;
    return [a, b];
  };

  LB.Session = Session;
  LB.PROTOCOL_VERSION = PROTOCOL_VERSION;

})(window.LB);
