/* =========================================================================
 * rules.js
 * ゲームルールの純粋な判定・処理をまとめる（仕様書 §26）。
 * UI（描画）には一切依存しない。処理結果は「イベント配列」で返し、
 * 表示のしかたは ui.js 側の責任とする。
 *
 * 各処理は独立した関数として実装している：
 *   通常移動判定      : getNormalMoves()
 *   通常接近攻撃判定  : getNewlyAdjacentEnemies()
 *   ループ経路探索    : traceRay()
 *   ループ突撃成立判定: findLoopCharges()
 *   ダメージ処理      : applyDamage()
 *   ノックバック処理  : resolveKnockback()
 *   撃破処理          : applyDamage() 内の KO 判定
 *   勝利判定          : checkWinner()
 * ========================================================================= */
window.LB = window.LB || {};
(function (LB) {
  'use strict';

  var rules = {};

  // ---- 参照系ヘルパ -----------------------------------------------------

  rules.knightAt = function (state, r, c) {
    for (var i = 0; i < state.knights.length; i++) {
      var k = state.knights[i];
      if (k.alive && k.r === r && k.c === c) return k;
    }
    return null;
  };

  rules.getKnight = function (state, id) {
    for (var i = 0; i < state.knights.length; i++) {
      if (state.knights[i].id === id) return state.knights[i];
    }
    return null;
  };

  rules.aliveKnights = function (state, owner) {
    return state.knights.filter(function (k) {
      return k.alive && (!owner || k.owner === owner);
    });
  };

  // ---- 通常移動判定（仕様書 §9）----------------------------------------
  // 通常経路（縦横のグリッド線）で隣接する「空き交点」へ1マス。
  // 他の駒がいる地点へは移動できず、飛び越えもできない。
  // ループ弧は通常移動には使わない。
  rules.getNormalMoves = function (state, board, knight) {
    var out = [];
    var nb = board.orthogonalNeighbors(knight.r, knight.c);
    for (var i = 0; i < nb.length; i++) {
      if (!rules.knightAt(state, nb[i].r, nb[i].c)) {
        out.push({ r: nb[i].r, c: nb[i].c, dir: nb[i].dir });
      }
    }
    return out;
  };

  // ---- 通常接近攻撃判定（仕様書 §10）-----------------------------------
  // 「移動によって新しく隣接した」敵騎のみが攻撃対象。
  rules.adjacentEnemies = function (state, board, owner, r, c, ignoreId) {
    var out = [];
    var nb = board.orthogonalNeighbors(r, c);
    for (var i = 0; i < nb.length; i++) {
      var k = rules.knightAt(state, nb[i].r, nb[i].c);
      if (k && k.owner !== owner && k.id !== ignoreId) out.push(k);
    }
    return out;
  };

  rules.getNewlyAdjacentEnemies = function (state, board, knight, from, to) {
    var before = rules.adjacentEnemies(state, board, knight.owner, from.r, from.c, knight.id);
    var beforeIds = {};
    before.forEach(function (k) { beforeIds[k.id] = true; });
    var after = rules.adjacentEnemies(state, board, knight.owner, to.r, to.c, knight.id);
    return after.filter(function (k) { return !beforeIds[k.id]; });
  };

  // ---- ループ経路探索（仕様書 §11, §12）--------------------------------
  /**
   * knight から dir 方向へ経路をたどる。
   * 直進し、盤端に弧があれば弧を通って方向転換し、さらに進む。
   * 最初にぶつかった駒で停止する（駒は飛び越えられない）。
   *
   * @return {{steps, loops, hit, firstArcIndex}}
   *   steps         : [{from:{r,c}, to:{r,c}, dirIn, dirOut, arcId}]
   *   loops         : 通過したループ弧の数
   *   hit           : 最初にぶつかった騎（無ければ null）
   *   firstArcIndex : 最初にループ弧を通った歩数（0始まり / 通っていなければ -1）
   */
  rules.traceRay = function (state, board, knight, dir) {
    var steps = [];
    var loops = 0;
    var firstArcIndex = -1;
    var seen = {};
    var cur = { r: knight.r, c: knight.c, dir: dir };

    function result(hit) {
      return { steps: steps, loops: loops, hit: hit, firstArcIndex: firstArcIndex };
    }

    while (true) {
      var key = cur.r + ',' + cur.c + ',' + cur.dir.name;
      if (seen[key]) return result(null); // 一周して戻った
      seen[key] = true;

      var nxt = board.step(cur.r, cur.c, cur.dir);
      if (!nxt) return result(null); // 行き止まり

      if (nxt.arcId !== null) {
        loops++;
        if (firstArcIndex === -1) firstArcIndex = steps.length;
      }
      steps.push({
        from: { r: cur.r, c: cur.c },
        to:   { r: nxt.r, c: nxt.c },
        dirIn: cur.dir,
        dirOut: nxt.dir,
        arcId: nxt.arcId
      });

      // 突撃する騎自身の元位置は「空いた地点」として扱う
      var occ = rules.knightAt(state, nxt.r, nxt.c);
      if (occ && occ.id !== knight.id) return result(occ);
      cur = nxt;
    }
  };

  // ---- ループ突撃成立判定（仕様書 §12）--------------------------------
  /**
   * 成立条件：
   *   1. 経路が接続されている
   *   2. 経路上で最低1回ループ弧を通過する
   *   3・4. 対象より手前に他の駒が存在しない（traceRay が最初の駒で止まる）
   *   5. 最終地点に対象の敵騎が存在する
   *   6. ループ入口に隣接していること（Ver.0.2 追加）
   *      = LOOP_ENTRY_MAX_STEPS 歩目までにループ弧へ入ること
   * @return [{targetId, steps, loops, arrivalDir, startDir}]
   */
  rules.findLoopCharges = function (state, board, knight, config) {
    var out = [];
    var maxEntry = (config && config.LOOP_ENTRY_MAX_STEPS) || Infinity;
    for (var i = 0; i < board.DIR_LIST.length; i++) {
      var dir = board.DIR_LIST[i];
      var ray = rules.traceRay(state, board, knight, dir);
      if (!ray.hit) continue;
      if (ray.hit.owner === knight.owner) continue; // 味方に当たった
      if (ray.loops < 1) continue;                  // ループ未通過は突撃にならない
      if (ray.firstArcIndex >= maxEntry) continue;  // ループ入口から遠い
      var last = ray.steps[ray.steps.length - 1];
      out.push({
        targetId: ray.hit.id,
        steps: ray.steps,
        loops: ray.loops,
        arrivalDir: last.dirOut, // 対象に進入した向き＝ノックバック方向
        startDir: dir
      });
    }
    return out;
  };

  /** 同じ敵に複数経路がある場合をまとめる */
  rules.groupChargesByTarget = function (charges) {
    var map = {};
    charges.forEach(function (ch) {
      if (!map[ch.targetId]) map[ch.targetId] = [];
      map[ch.targetId].push(ch);
    });
    return map;
  };

  // ---- ダメージ処理・撃破処理（仕様書 §17）-----------------------------
  rules.applyDamage = function (state, target, amount, mode, events) {
    target.hp -= amount;
    events.push({
      type: 'damage', knightId: target.id, amount: amount, mode: mode,
      r: target.r, c: target.c, hp: Math.max(0, target.hp)
    });
    if (target.hp <= 0) {
      target.hp = 0;
      target.alive = false;
      events.push({ type: 'ko', knightId: target.id, r: target.r, c: target.c });
      return true; // 撃破
    }
    return false;
  };

  // ---- ノックバック処理（仕様書 §14〜§16）-----------------------------
  /**
   * 1マス分の押し出しを試みる。
   * 押し出し先に駒がある場合、CHAIN_KNOCKBACK が有効なら
   * その駒（および後ろに続く駒）をまとめて1マス押し出す（連鎖押し出し）。
   * 押し出す列の先が盤端で詰まっている場合は押し出せない。
   * @return {ok, reason}  reason: 'wall'（盤端で詰まり） / 'blocked'（連鎖無効で駒あり）
   */
  rules.pushChain = function (state, board, config, knight, dir, events) {
    var chain = [knight];
    var cur = knight;
    while (true) {
      var nr = cur.r + dir.dr;
      var nc = cur.c + dir.dc;
      if (!board.inBounds(nr, nc)) return { ok: false, reason: 'wall' }; // 盤外へは押し出さない
      var occ = rules.knightAt(state, nr, nc);
      if (!occ) break;                                                  // 空きが見つかった
      if (!config.CHAIN_KNOCKBACK) return { ok: false, reason: 'blocked' };
      chain.push(occ);
      cur = occ;
    }
    // 後ろの駒から順にずらす
    for (var i = chain.length - 1; i >= 0; i--) {
      var k = chain[i];
      var from = { r: k.r, c: k.c };
      k.r += dir.dr;
      k.c += dir.dc;
      events.push({
        type: 'knockback', knightId: k.id, from: from,
        to: { r: k.r, c: k.c }, chained: i > 0
      });
    }
    return { ok: true, count: chain.length };
  };

  /**
   * 突撃してきた向きへ最大 KNOCKBACK_DISTANCE マス押し出す。
   * 1マスも押し出せず、原因が盤端だった場合は壁激突ダメージを与える。
   * @return {moved, wall, killed}
   */
  rules.resolveKnockback = function (state, board, config, target, dir, events) {
    var moved = 0;
    var reason = null;
    for (var i = 0; i < config.KNOCKBACK_DISTANCE; i++) {
      var res = rules.pushChain(state, board, config, target, dir, events);
      if (!res.ok) { reason = res.reason; break; }
      moved++;
    }
    var killed = false;
    var wall = (moved === 0 && reason === 'wall' && config.WALL_DAMAGE > 0);
    if (wall) {
      events.push({ type: 'wall', knightId: target.id, r: target.r, c: target.c });
      killed = rules.applyDamage(state, target, config.WALL_DAMAGE, 'wall', events);
    }
    return { moved: moved, wall: wall, killed: killed };
  };

  // ---- 行動：通常移動＋通常接近攻撃 ------------------------------------
  rules.resolveNormalMove = function (state, board, config, knight, dest) {
    var events = [];
    var from = { r: knight.r, c: knight.c };
    var to   = { r: dest.r,   c: dest.c };

    var newlyAdjacent = rules.getNewlyAdjacentEnemies(state, board, knight, from, to);

    knight.r = to.r;
    knight.c = to.c;
    events.push({ type: 'move', knightId: knight.id, from: from, to: to });

    // 移動によって新しく隣接した敵全員に通常攻撃ダメージ
    newlyAdjacent.forEach(function (enemy) {
      rules.applyDamage(state, enemy, config.NORMAL_DAMAGE, 'normal', events);
    });

    return events;
  };

  // ---- 行動：ループ突撃 -------------------------------------------------
  /**
   * 処理順：ダメージ → 撃破判定 → ノックバック（＋壁激突） → 突撃側の移動
   * 突撃側の最終位置：
   *   - 対象が撃破された場合          … 対象の元の位置（§18）
   *   - 対象がノックバックした場合    … 対象の元の位置（§18）
   *   - 対象が生存しノックバック不可  … 経路上、対象の1つ手前の交点で停止
   */
  rules.resolveLoopCharge = function (state, board, config, knight, charge) {
    var events = [];
    var target = rules.getKnight(state, charge.targetId);
    var origin = { r: knight.r, c: knight.c };
    var targetOrigin = { r: target.r, c: target.c };

    events.push({
      type: 'charge', knightId: knight.id, targetId: target.id,
      steps: charge.steps, from: origin, to: targetOrigin
    });

    var killed = rules.applyDamage(state, target, config.LOOP_DAMAGE, 'loop', events);

    var pushed = 0;
    if (!killed) {
      var kb = rules.resolveKnockback(state, board, config, target, charge.arrivalDir, events);
      pushed = kb.moved;
      killed = kb.killed; // 壁激突ダメージで撃破された場合
    }

    var dest;
    if (killed || pushed > 0) {
      dest = targetOrigin;                     // 対象がいた地点を占有する
    } else {
      var steps = charge.steps;
      dest = steps.length >= 2
        ? { r: steps[steps.length - 2].to.r, c: steps[steps.length - 2].to.c }
        : origin;                              // 手前の交点が無い＝その場に留まる
    }

    knight.r = dest.r;
    knight.c = dest.c;
    events.push({ type: 'move', knightId: knight.id, from: origin, to: dest, charge: true });

    return events;
  };

  // ---- 勝利判定（仕様書 §4）-------------------------------------------
  // Ver.0.1 は「相手を全滅させたら勝ち」。ここを差し替えるだけで
  // 到達勝利・拠点制圧などの別条件に変更できる。
  rules.checkWinner = function (state) {
    var p1 = rules.aliveKnights(state, 'p1').length;
    var p2 = rules.aliveKnights(state, 'p2').length;
    if (p2 === 0 && p1 > 0) return 'p1';
    if (p1 === 0 && p2 > 0) return 'p2';
    if (p1 === 0 && p2 === 0) return 'draw';
    return null;
  };

  LB.rules = rules;

})(window.LB);
