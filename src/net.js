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
 *   部屋を作った側が host、参加した側が guest。
 *   どちらが先攻（Player 1）になるかは host が決め、snapshot で相手に伝える。
 *   設定（ルール・盤面の種類）も host のものを正とする。
 * ========================================================================= */
window.LB = window.LB || {};
(function (LB) {
  'use strict';

  var PROTOCOL_VERSION = 2;

  function other(player) { return player === 'p1' ? 'p2' : 'p1'; }

  /**
   * @param {Object} deps
   *   game       : LB.Game
   *   transport  : { send(msg), close() } / Session が onMessage 等を差し込む
   *   role       : 'host' | 'guest'
   *   hostPlayer : host が担当する側（'p1' = 先攻 / 'p2' = 後攻）
   *   onChange   : 状態が変わったときに呼ばれる（再描画用）
   *   onStatus   : 接続状態の通知 function(text, kind)
   */
  function Session(deps) {
    this.game = deps.game;
    this.transport = deps.transport;
    this.role = deps.role;
    this.hostPlayer = deps.hostPlayer || 'p1';
    this.onChange = deps.onChange || function () {};
    this.onStatus = deps.onStatus || function () {};
    this.connected = false;

    var self = this;
    this.transport.onOpen = function () { self.handleOpen(); };
    this.transport.onMessage = function (msg) { self.handleMessage(msg); };
    this.transport.onClose = function (reason) { self.handleClose(reason); };
    this.transport.onError = function (err) { self.onStatus(err, 'error'); };
  }

  /** 自分が操作してよいプレイヤー */
  Session.prototype.localPlayer = function () {
    return this.role === 'host' ? this.hostPlayer : other(this.hostPlayer);
  };

  Session.prototype.isMyTurn = function () {
    return this.game.state.currentPlayer === this.localPlayer();
  };

  /** host が先攻・後攻を変更する */
  Session.prototype.setHostPlayer = function (player) {
    this.hostPlayer = player === 'p2' ? 'p2' : 'p1';
    this.pushConfig();
    this.onChange({ sideChanged: true });
  };

  // ---- 送受信 -----------------------------------------------------------

  Session.prototype.snapshot = function () {
    return {
      t: 'sync',
      v: PROTOCOL_VERSION,
      hostPlayer: this.hostPlayer,
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
    this.onStatus('接続しました。' + this.playerLabel() + ' として対戦します。', 'ok');
    // host が現在の設定・担当・盤面を送って初期同期する
    if (this.role === 'host') this.send(this.snapshot());
    this.onChange();
  };

  Session.prototype.playerLabel = function () {
    return this.localPlayer() === 'p1' ? 'Player 1（青・先攻）' : 'Player 2（赤・後攻）';
  };

  Session.prototype.handleClose = function (reason) {
    this.connected = false;
    this.onStatus(reason || '接続が切れました。', 'warn');
    this.onChange();
  };

  Session.prototype.handleMessage = function (msg) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.v && msg.v !== PROTOCOL_VERSION) {
      this.onStatus('相手のバージョンが違います。両者ともページを開き直してください。', 'error');
      return;
    }
    if (msg.t === 'sync') {
      var applied = this.applySnapshot(msg);
      // 担当が入れ替わったら表示を訂正する（接続直後に host の指定が届く場合を含む）
      if (applied.sideChanged && this.connected) {
        this.onStatus('あなたは ' + this.playerLabel() + ' です。', 'ok');
      }
      this.onChange({ boardRebuilt: applied.boardRebuilt, sideChanged: applied.sideChanged });
    } else if (msg.t === 'request-sync') {
      // 相手から「盤面を最新にしてほしい」と言われたので送り返す
      this.send(this.snapshot());
      this.onStatus('相手の要求で盤面を送信しました。', 'info');
    } else if (msg.t === 'leave') {
      this.onStatus('相手が退出しました。', 'warn');
      this.connected = false;
      this.onChange();
    }
  };

  /** 受け取った内容で自分の状態を置き換える */
  Session.prototype.applySnapshot = function (msg) {
    var game = this.game;
    var result = { boardRebuilt: false, sideChanged: false };
    if (msg.hostPlayer && msg.hostPlayer !== this.hostPlayer) {
      this.hostPlayer = msg.hostPlayer;
      result.sideChanged = true;
    }
    if (msg.config) {
      // 設定が変わっていれば盤面を作り直す（盤面の種類やHPの変更に追従する）
      if (JSON.stringify(game.config) !== JSON.stringify(msg.config)) {
        game.applyConfig(msg.config);
        result.boardRebuilt = true;
      }
    }
    // 相手がリスタートしていれば、ここで対局の区切りとして戦歴へ移す
    if (msg.state) game.noteIncomingState(msg.state);
    if (msg.state) game.state = msg.state;
    if (msg.log) game.log = msg.log;
    if (msg.state) game.recordFrame();
    return result;
  };

  /** 自分が1手指したあとに呼ぶ */
  Session.prototype.pushLocalMove = function () {
    if (!this.connected) return;
    this.send(this.snapshot());
  };

  /** RESTART・設定変更・降参のあとに呼ぶ */
  Session.prototype.pushConfig = function () {
    if (!this.connected) return;
    this.send(this.snapshot());
  };

  /**
   * 盤面を最新に更新する。
   * 相手に snapshot を要求すると同時に、自分の状態も送る。
   * 通信が一瞬途切れて手が届かなかった場合の復旧用。
   */
  Session.prototype.requestSync = function () {
    if (!this.connected) return false;
    this.send({ t: 'request-sync', v: PROTOCOL_VERSION });
    return true;
  };

  Session.prototype.leave = function () {
    if (this.connected) this.send({ t: 'leave', v: PROTOCOL_VERSION });
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
  LB.otherPlayer = other;

})(window.LB);
