/* =========================================================================
 * npc.js
 * 一人で遊ぶための対戦相手（NPC）の思考ルーチン。強さは2種類（LB.NPC_LEVELS）。
 *   普通：ループバトル管理者 マイクロビアル
 *   強い：都市英雄 エルドレッド
 *
 * 考え方（思考そのものは共通で、下の3つの数値だけが強さで変わる）：
 *   1. 自分の合法手（通常移動・ループ突撃の全経路）をすべて挙げる
 *   2. 1手ずつ盤面を複製して指してみる
 *   3. READ_REPLY の確率で、その後の相手の最善の応手まで読む（2手先読み）
 *      … 普通は30%の手番だけ、強いは毎手番
 *   4. 盤面を点数化し、いちばん良い手を選ぶ
 *   5. 最善から MARGIN 点差までの手を「同じくらい良い手」としてランダムに選び、
 *      BLUNDER の確率でうっかりした手も指す（強いはどちらも小さい）。
 *      ただし勝ちが決まる手は必ず選ぶ
 *
 * ルール判定は rules.js の関数をそのまま使う（盤面を複製して呼ぶので、
 * 本物の対局の状態には一切触れない）。
 * ========================================================================= */
window.LB = window.LB || {};
(function (LB) {
  'use strict';

  var rules = LB.rules;

  // 点数の重み。数字を変えるとNPCの性格が変わる
  var W = {
    WIN: 100000,
    HP: 10,          // HP 1 の差
    ALIVE: 40,       // 生きている騎 1体の差
    MY_CHARGE: 6,    // 次の手番で自分が撃てるループ突撃 1本
    ON_ENTRY: 2,     // ループ入口に立っている自分の騎 1体
    CENTER: 0.6,     // 中央寄りにいるほど少し加点（動ける方向が多いため）
    DANGER: 5        // 危ないマス（外周）にいる騎 1体。有効で、始まる6手前から数える
  };
  /**
   * 対戦相手の一覧（強さ2種類）。対戦設定の「NPC」で選ぶ。
   *   READ_REPLY … 相手の応手まで読む確率（1 = 毎手読む）
   *   MARGIN     … 最善からこの点差までの手を「同じくらい良い手」とみなしてランダムに選ぶ
   *   BLUNDER    … 勝ちが決まる手以外で、候補を問わずランダムに指す確率（うっかり）
   */
  LB.NPC_LEVELS = [
    {
      id: 'normal',
      level: '普通',
      name: 'ループバトル管理者 マイクロビアル',
      display: 'ループバトル管理者\nマイクロビアル',   // 画面では2行で出す
      short: 'マイクロビアル',
      image: 'assets/pieces/boardgame/microbial.png',
      note: '勝ち負けよりも楽しみたいエンジョイ勢。よく考えて指せば、勝ち越せる。',
      // Ver.0.5 の検証で強すぎたため弱め、2026-09-22 にクローバー盤でこの値を確定（仕様書 §31.2）
      params: { READ_REPLY: 0.3, MARGIN: 10, BLUNDER: 0.1 }
    },
    {
      id: 'strong',
      level: '強い',
      name: '都市英雄 エルドレッド',
      short: 'エルドレッド',
      image: 'assets/pieces/boardgame/eldred.png',
      note: '人の情などない。勝ち負けにこだわるガチ勢。常に相手の先を読んでくる。',
      // 強さの変遷（仕様書 §31.3）：最初は READ_REPLY 1 / MARGIN 4 / BLUNDER 0（人がほぼ勝てない）
      // → 2026-09-27 に 0.5 / 7 / 0.05（人が約27%勝つ）→ 2026-10-03 に少し戻した（人が約14%勝つ）
      params: { READ_REPLY: 0.65, MARGIN: 7, BLUNDER: 0.05 }
    }
  ];

  function findLevel(id) {
    for (var i = 0; i < LB.NPC_LEVELS.length; i++) if (LB.NPC_LEVELS[i].id === id) return LB.NPC_LEVELS[i];
    return LB.NPC_LEVELS[0];
  }

  // 今選ばれている相手（既定は「普通」のマイクロビアル）
  var current = LB.NPC_LEVELS[0];
  var LEVEL = { READ_REPLY: 0.3, MARGIN: 10, BLUNDER: 0.1 };

  function other(p) { return p === 'p1' ? 'p2' : 'p1'; }
  function clone(state) { return JSON.parse(JSON.stringify(state)); }

  /** その手番のプレイヤーが取れる行動をすべて挙げる */
  function listActions(state, board, config, player) {
    var actions = [];
    rules.aliveKnights(state, player).forEach(function (k) {
      rules.getNormalMoves(state, board, k).forEach(function (dest) {
        actions.push({ type: 'move', knightId: k.id, dest: { r: dest.r, c: dest.c } });
      });
      rules.findLoopCharges(state, board, k, config).forEach(function (charge) {
        actions.push({ type: 'charge', knightId: k.id, charge: charge });
      });
    });
    return actions;
  }

  /** 複製した盤面で1手指し、その後の盤面を返す */
  function simulate(state, board, config, action) {
    var s = clone(state);
    var knight = rules.getKnight(s, action.knightId);
    if (action.type === 'move') rules.resolveNormalMove(s, board, config, knight, action.dest);
    else rules.resolveLoopCharge(s, board, config, knight, action.charge);
    s.winner = rules.checkWinner(s);
    return s;
  }

  /** 盤面の点数（me から見て高いほど良い） */
  function evaluate(state, board, config, me) {
    if (state.winner === me) return W.WIN;
    if (state.winner && state.winner !== 'draw') return -W.WIN;
    var foe = other(me);
    var mine = rules.aliveKnights(state, me);
    var theirs = rules.aliveKnights(state, foe);
    var hp = function (list) { return list.reduce(function (s, k) { return s + k.hp; }, 0); };

    var score = W.HP * (hp(mine) - hp(theirs)) + W.ALIVE * (mine.length - theirs.length);

    var mid = (board.size - 1) / 2;
    mine.forEach(function (k) {
      var charges = rules.findLoopCharges(state, board, k, config).length;
      score += W.MY_CHARGE * Math.min(charges, 2);
      if (charges > 0 || isEntry(board, k)) score += W.ON_ENTRY;
      score -= W.CENTER * (Math.abs(k.r - mid) + Math.abs(k.c - mid));
    });

    // 危ないマス：自分の騎は外周から離し、相手の騎が外周にいるのは歓迎する
    var zone = rules.dangerZoneInfo(state, config);
    if (zone.enabled && (zone.active || zone.movesLeft <= 6)) {
      mine.forEach(function (k) { if (rules.isDangerCell(board, k.r, k.c)) score -= W.DANGER; });
      theirs.forEach(function (k) { if (rules.isDangerCell(board, k.r, k.c)) score += W.DANGER / 2; });
    }
    return score;
  }

  // ループ入口の一覧は盤面ごとに変わらないので、盤面ごとに1回だけ求めておく
  function isEntry(board, k) {
    if (!board.__npcEntries) board.__npcEntries = board.entryPoints();
    return board.__npcEntries.some(function (e) { return e.r === k.r && e.c === k.c; });
  }

  /**
   * 次の一手を選ぶ。
   * @return { type: 'move' | 'charge' | 'pass', knightId, dest, charge }
   */
  function chooseAction(game, player) {
    var state = game.state, board = game.board, config = game.config;
    var foe = other(player);
    var actions = listActions(state, board, config, player);
    if (!actions.length) return { type: 'pass' };

    var readReply = Math.random() < LEVEL.READ_REPLY;   // この手番で相手の応手まで読むか
    var scored = actions.map(function (a) {
      var s1 = simulate(state, board, config, a);
      if (s1.winner || !readReply) return { action: a, score: evaluate(s1, board, config, player) };

      // 相手はこちらにとって最も痛い手を指してくると考える
      var replies = listActions(s1, board, config, foe);
      var worst = Infinity;
      if (!replies.length) {
        worst = evaluate(s1, board, config, player);
      } else {
        replies.forEach(function (b) {
          var s2 = simulate(s1, board, config, b);
          var v = evaluate(s2, board, config, player);
          if (v < worst) worst = v;
        });
      }
      return { action: a, score: worst };
    });

    var best = scored.reduce(function (m, x) { return x.score > m ? x.score : m; }, -Infinity);
    if (best >= W.WIN / 2) {
      // 勝てる手があれば迷わず選ぶ
      var wins = scored.filter(function (x) { return x.score >= best; });
      return wins[Math.floor(Math.random() * wins.length)].action;
    }
    if (Math.random() < LEVEL.BLUNDER) return actions[Math.floor(Math.random() * actions.length)];
    var margin = LEVEL.MARGIN;
    var pool = scored.filter(function (x) { return x.score >= best - margin; });
    return pool[Math.floor(Math.random() * pool.length)].action;
  }

  LB.NPC = {
    LEVELS: LB.NPC_LEVELS,
    /** 今の相手（{ id, level, name, short, image, note, params }） */
    current: function () { return current; },
    /** 対戦相手を選ぶ。id は 'normal' か 'strong' */
    setLevel: function (id) {
      current = findLevel(id);
      LEVEL.READ_REPLY = current.params.READ_REPLY;
      LEVEL.MARGIN = current.params.MARGIN;
      LEVEL.BLUNDER = current.params.BLUNDER;
      return current;
    },
    chooseAction: chooseAction,
    params: LEVEL,             // 強さの調整値（テスト用に外から変えられる）
    listActions: listActions   // テスト用
  };

  LB.NPC.setLevel('normal');

})(window.LB);
