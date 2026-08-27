/* =========================================================================
 * game.js
 * ゲーム状態の保持とターン管理（仕様書 §8）。
 * ルール判定そのものは rules.js に置き、ここでは
 * 「状態 → 行動適用 → イベント → ターン交代 → 勝敗判定」の流れだけを扱う。
 * ========================================================================= */
window.LB = window.LB || {};
(function (LB) {
  'use strict';

  var rules = LB.rules;

  var PLAYER_LABEL = { p1: 'Player 1', p2: 'Player 2' };

  function Game(config) {
    this.history = []; // 直近の対局の記録（リプレイ用）
    this.frames = [];  // 進行中の対局の1手ごとのスナップショット
    this.applyConfig(config);
  }

  /** 設定を差し替えて初期化し直す（デバッグ設定の適用用） */
  Game.prototype.applyConfig = function (config) {
    this.config = LB.cloneConfig(config);
    this.boardType = LB.getBoardType(this.config.BOARD_TYPE);
    this.board = LB.createBoard(this.config.BOARD_SIZE, this.boardType.arcs);
    this.reset();
  };

  /**
   * 初期配置の1件を盤面座標に変換する。
   * 盤面の通し番号（26）と「行,列」形式（[4, 1]）の両方を受け付ける。
   */
  function toRowCol(pos, size) {
    if (Array.isArray(pos)) return { r: pos[0], c: pos[1] };
    var n = pos | 0;
    return { r: Math.floor((n - 1) / size), c: (n - 1) % size };
  }

  /** RESTART（仕様書 §24）：HP全回復・撃破騎復活・初期位置・P1ターンへ */
  Game.prototype.reset = function () {
    this.archiveCurrentGame(); // 進行中だった対局を戦歴へ残す
    var cfg = this.config;
    var knights = [];
    ['p1', 'p2'].forEach(function (owner) {
      var placement = cfg.INITIAL_PLACEMENT[owner] || [];
      placement.forEach(function (pos, i) {
        var rc = toRowCol(pos, cfg.BOARD_SIZE);
        knights.push({
          id: owner + '-' + (i + 1),
          label: (owner === 'p1' ? 'A' : 'B') + (i + 1),
          owner: owner,
          r: rc.r,
          c: rc.c,
          hp: cfg.MAX_HP,
          maxHp: cfg.MAX_HP,
          alive: true
        });
      });
    });

    this.state = {
      knights: knights,
      currentPlayer: 'p1',
      turnCount: 1,
      winner: null
    };
    this.log = [];
    this.frames = [];
    this.pushLog('Player 1 のターンです。');
    this.recordFrame();
  };

  Game.prototype.pushLog = function (text, tone) {
    this.log.push({ text: text, tone: tone || 'info' });
    if (this.log.length > 200) this.log.shift();
  };

  Game.prototype.knightName = function (id) {
    var k = rules.getKnight(this.state, id);
    return PLAYER_LABEL[k.owner] + ' 騎' + k.label;
  };

  // ---- 選択中の騎に対する合法手 ---------------------------------------

  Game.prototype.isOwnKnight = function (knight) {
    return knight && knight.alive && knight.owner === this.state.currentPlayer;
  };

  Game.prototype.getNormalMoves = function (knight) {
    if (this.state.winner || !this.isOwnKnight(knight)) return [];
    return rules.getNormalMoves(this.state, this.board, knight);
  };

  Game.prototype.getLoopCharges = function (knight) {
    if (this.state.winner || !this.isOwnKnight(knight)) return [];
    return rules.findLoopCharges(this.state, this.board, knight, this.config);
  };

  /** 現在のプレイヤーに合法手が1つでもあるか */
  Game.prototype.hasAnyAction = function () {
    var self = this;
    return rules.aliveKnights(this.state, this.state.currentPlayer).some(function (k) {
      return self.getNormalMoves(k).length > 0 || self.getLoopCharges(k).length > 0;
    });
  };

  // ---- 行動の実行 ------------------------------------------------------

  Game.prototype.doNormalMove = function (knight, dest) {
    var events = rules.resolveNormalMove(this.state, this.board, this.config, knight, dest);
    this.logEvents(events, 'normal');
    this.endTurn();
    this.recordFrame();
    return events;
  };

  Game.prototype.doLoopCharge = function (knight, charge) {
    var events = rules.resolveLoopCharge(this.state, this.board, this.config, knight, charge);
    this.logEvents(events, 'loop');
    this.endTurn();
    this.recordFrame();
    return events;
  };

  /**
   * 降参（投了）。手詰まりで続ける意味が無いときに使う。
   * 相手の勝ちとして即座に決着させる。
   * @param player 降参する側（省略時は現在の手番）
   */
  Game.prototype.resign = function (player) {
    if (this.state.winner) return [];
    var loser = player || this.state.currentPlayer;
    var winner = loser === 'p1' ? 'p2' : 'p1';
    this.state.winner = winner;
    this.pushLog(PLAYER_LABEL[loser] + ' が降参しました。', 'warn');
    this.pushLog(PLAYER_LABEL[winner] + ' の勝利！', 'win');
    this.recordFrame();
    return [{ type: 'resign', loser: loser, winner: winner }];
  };

  Game.prototype.pass = function () {
    this.pushLog(PLAYER_LABEL[this.state.currentPlayer] + ' は行動できる手が無いためパスしました。', 'warn');
    this.endTurn();
    this.recordFrame();
    return [];
  };

  Game.prototype.logEvents = function (events, kind) {
    var self = this;
    events.forEach(function (ev) {
      if (ev.type === 'move' && ev.charge) {
        self.pushLog(self.knightName(ev.knightId) + ' が突撃後 ('
          + ev.to.r + ',' + ev.to.c + ') へ移動。', 'move');
      } else if (ev.type === 'move') {
        self.pushLog(self.knightName(ev.knightId) + ' が ('
          + ev.to.r + ',' + ev.to.c + ') へ通常移動。', 'move');
      } else if (ev.type === 'charge') {
        self.pushLog('★ ' + self.knightName(ev.knightId) + ' がループ突撃！ 対象: '
          + self.knightName(ev.targetId), 'loop');
      } else if (ev.type === 'damage') {
        var label = ev.mode === 'loop' ? 'ループ突撃'
                  : ev.mode === 'wall' ? '壁激突'
                  : '通常接近攻撃';
        self.pushLog(self.knightName(ev.knightId) + ' に ' + label + ' -' + ev.amount
          + '（残りHP ' + ev.hp + '）', ev.mode === 'loop' ? 'loop' : 'hit');
      } else if (ev.type === 'wall') {
        self.pushLog(self.knightName(ev.knightId) + ' は盤端に押し付けられた！', 'push');
      } else if (ev.type === 'knockback') {
        self.pushLog(self.knightName(ev.knightId) + ' が ('
          + ev.to.r + ',' + ev.to.c + ') へ'
          + (ev.chained ? '巻き込まれて押し出された。' : 'ノックバック。'), 'push');
      } else if (ev.type === 'ko') {
        self.pushLog('KO! ' + self.knightName(ev.knightId) + ' 撃破。', 'ko');
      }
    });
  };

  // ---- 対局の記録（リプレイ用）-----------------------------------------
  // 1手ごとに盤面のスナップショットを残し、対局が終わる／やり直されるときに
  // 「戦歴」として最大 HISTORY_LIMIT 件まで保存する。

  var HISTORY_LIMIT = 3;

  /** 現在の盤面を1コマとして記録する */
  Game.prototype.recordFrame = function () {
    var snap = JSON.stringify(this.state);
    var last = this.frames[this.frames.length - 1];
    if (last && last.snap === snap && last.logLen === this.log.length) return;
    this.frames.push({ snap: snap, logLen: this.log.length });
  };

  /** 進行中の対局を戦歴へ移す（1手も指していない対局は残さない） */
  Game.prototype.archiveCurrentGame = function () {
    if (!this.frames || this.frames.length < 2) return;
    var last = JSON.parse(this.frames[this.frames.length - 1].snap);
    this.history.unshift({
      frames: this.frames,
      log: this.log.slice(),
      winner: last.winner,
      turns: last.turnCount,
      board: this.boardType ? this.boardType.name : '',
      at: new Date()
    });
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  };

  /**
   * 相手から届いた盤面を取り込む直前に呼ぶ。
   * 相手がリスタートした場合はそこで対局の区切りとし、戦歴へ移す。
   */
  Game.prototype.noteIncomingState = function (incoming) {
    var last = this.frames[this.frames.length - 1];
    if (!last || !incoming) return;
    var prev = JSON.parse(last.snap);
    if (incoming.turnCount === 1 && (prev.turnCount > 1 || prev.winner)) {
      this.archiveCurrentGame();
      this.frames = [];
    }
  };

  /**
   * リプレイで選べる対局の一覧。
   * @return [{key, label, frames, log}]
   */
  Game.prototype.replaySources = function () {
    var out = [];
    if (this.frames.length >= 2) {
      out.push({
        key: 'current',
        label: '現在の対局（' + (this.frames.length - 1) + '手）',
        frames: this.frames,
        log: this.log
      });
    }
    this.history.forEach(function (h, i) {
      var result = h.winner === 'draw' ? '引き分け'
                 : h.winner ? PLAYER_LABEL[h.winner] + ' 勝利'
                 : '未決着';
      out.push({
        key: 'h' + i,
        label: (i === 0 ? '直近' : (i + 1) + 'つ前') + 'の対局（' + result + '・' + h.turns + '手）',
        frames: h.frames,
        log: h.log
      });
    });
    return out;
  };

  Game.prototype.findReplaySource = function (key) {
    return this.replaySources().filter(function (s) { return s.key === key; })[0] || null;
  };

  // ---- ターン管理・勝敗判定 -------------------------------------------

  Game.prototype.endTurn = function () {
    var winner = rules.checkWinner(this.state);
    if (winner) {
      this.state.winner = winner;
      this.pushLog(winner === 'draw'
        ? '引き分け。'
        : PLAYER_LABEL[winner] + ' の勝利！ 相手を全滅させました。', 'win');
      return;
    }
    this.state.currentPlayer = this.state.currentPlayer === 'p1' ? 'p2' : 'p1';
    this.state.turnCount++;
    this.pushLog('— ' + PLAYER_LABEL[this.state.currentPlayer] + ' のターン —');
  };

  LB.Game = Game;
  LB.PLAYER_LABEL = PLAYER_LABEL;

})(window.LB);
