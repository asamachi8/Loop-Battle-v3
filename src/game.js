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
    this.applyConfig(config);
  }

  /** 設定を差し替えて初期化し直す（デバッグ設定の適用用） */
  Game.prototype.applyConfig = function (config) {
    this.config = LB.cloneConfig(config);
    this.boardType = LB.getBoardType(this.config.BOARD_TYPE);
    this.board = LB.createBoard(this.config.BOARD_SIZE, this.boardType.arcs);
    this.reset();
  };

  /** RESTART（仕様書 §24）：HP全回復・撃破騎復活・初期位置・P1ターンへ */
  Game.prototype.reset = function () {
    var cfg = this.config;
    var knights = [];
    ['p1', 'p2'].forEach(function (owner) {
      var placement = cfg.INITIAL_PLACEMENT[owner] || [];
      placement.forEach(function (pos, i) {
        knights.push({
          id: owner + '-' + (i + 1),
          label: (owner === 'p1' ? 'A' : 'B') + (i + 1),
          owner: owner,
          r: pos[0],
          c: pos[1],
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
    this.pushLog('Player 1 のターンです。');
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
    return events;
  };

  Game.prototype.doLoopCharge = function (knight, charge) {
    var events = rules.resolveLoopCharge(this.state, this.board, this.config, knight, charge);
    this.logEvents(events, 'loop');
    this.endTurn();
    return events;
  };

  Game.prototype.pass = function () {
    this.pushLog(PLAYER_LABEL[this.state.currentPlayer] + ' は行動できる手が無いためパスしました。', 'warn');
    this.endTurn();
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
