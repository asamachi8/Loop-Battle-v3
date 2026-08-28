/* =========================================================================
 * ui.js
 * 描画と入力処理のみを担当する（仕様書 §20〜§22）。
 * ルール判定はすべて rules.js / game.js に任せ、ここでは行わない。
 * ========================================================================= */
window.LB = window.LB || {};
(function (LB) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var rules = LB.rules;

  // 駒の寸法（SVGユニット）。1ユニットは PC の盤面で約1px。
  //   PIECE_ART_R  … 絵柄の半径。メダリオンはこの 91% ほどを占める
  //   PIECE_RING_R … 陣営の色のフチを描く円の半径（メダリオンの縁のすぐ内側）
  //   PIECE_RING   … フチの線の太さ。ぼかしをかけるので細くてよい
  //   PIECE_R      … 画像が読めないときの代替の円の半径
  //   MARK_SEL_R   … 選択中の騎を囲む破線リングの半径
  //   MARK_CHARGE_R… ループ突撃できる敵を囲むリングの半径
  // 交点の間隔は70ユニットなので、半径35を超えると隣の駒と重なる。
  var PIECE_ART_R = 32;
  var PIECE_RING_R = 29.6;
  var PIECE_RING = 2.8;
  var PIECE_R = 31;
  var MARK_SEL_R = 33;
  var MARK_CHARGE_R = 34.5;
  var ENTRY_R = 28;      // ループ入口の輪。駒より内側なので、駒が乗ると隠れる

  // ループ突撃のきらきら。1粒の形（4方向にとがった星）と、散らばりの範囲・時間。
  var SPARKLE_D = 'M 0 -6.5 C 0.9 -2.4 2.4 -0.9 6.5 0 C 2.4 0.9 0.9 2.4 0 6.5'
                + ' C -0.9 2.4 -2.4 0.9 -6.5 0 C -2.4 -0.9 -0.9 -2.4 0 -6.5 Z';
  var SPARKLE_COUNT = 14;
  var SPARKLE_MIN_R = 34;   // 駒（半径29.1）の外から散り始める
  var SPARKLE_MAX_R = 58;
  var SPARKLE_MS = 1500;    // 1.5秒（CSS の fx-sparkle と合わせること）

  // HPの絵筆バッジ。駒の右下に斜めに置く。斜めなので隣の交点とはぶつからない
  var HP_BADGE = { x: 18, y: 18, angle: -28, scale: 1.3 };
  // 絵筆のひと塗り（左右に細り、縁が不揃い）
  var BRUSH_D = 'M -9.4 -0.6 C -7.6 -3.7 -4.2 -4.9 -0.4 -4.5'
              + ' C 3.4 -4.1 7.3 -3.5 9.5 -1.8 C 10.4 -1.1 10.0 0.7 8.6 2.0'
              + ' C 6.4 3.9 2.6 4.9 -1.4 4.6 C -5.0 4.4 -8.3 3.4 -9.4 1.7'
              + ' C -10.0 0.9 -9.9 0.1 -9.4 -0.6 Z';
  // 塗り重ねの明るいスジ（筆の毛の跡）
  var BRUSH_HL_D = 'M -7.2 -1.9 C -4.4 -3.3 0.6 -3.5 5.6 -2.5'
                 + ' C 3.0 -1.2 -3.4 -0.6 -7.2 -1.9 Z';
  // かすれ（毛の間が抜けた線）。細い線を数本引いて、絵の具のムラに見せる
  var BRUSH_STREAKS = [
    'M -8.2 -2.2 C -4.6 -3.4 1.2 -3.6 7.4 -2.6',
    'M -7.6 0.4 C -3.0 -0.4 3.2 -0.6 8.8 0.2',
    'M -6.4 2.6 C -2.2 3.4 2.6 3.6 6.8 2.4',
    'M -2.8 -3.6 C -1.6 -1.0 -1.2 1.8 -2.0 4.2'
  ];

  function svgEl(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  function UI(game, dom) {
    this.game = game;
    this.dom = dom;
    this.selectedId = null;   // 選択中の自軍騎
    this.routeChoice = null;  // 複数経路がある場合の経路選択状態
    this.hoverPath = null;    // ハイライト表示する経路
    this.flashPath = null;    // 突撃実行直後に一時表示する経路
    this.flashTimer = null;
    this.showCoords = true;   // 座標の透かしを表示するか
    this.localPlayer = null;  // オンライン対戦時に操作できる側（null = 同じPCで2人）
    this.onAction = null;     // 1手指したあとに呼ばれる（オンライン同期用）
    this.pathArcKeys = {};    // 経路ハイライトで方向▲を描いた弧
    this.replay = null;       // リプレイ再生中の状態
    this.replayTimer = null;
    this.onReplayUpdate = null; // 再描画のたびに呼ばれる（リプレイ操作パネル更新用）
    this.buildBoard();
  }

  // ---- 盤面の骨組み（線・弧・交点・当たり判定）を作る -------------------
  UI.prototype.buildBoard = function () {
    var self = this;
    var board = this.game.board;
    var svg = this.dom.board;

    // 盤面のジオメトリが変わると、以前の経路データ（弧のID）は無効になるので捨てる
    this.hoverPath = null;
    this.flashPath = null;
    this.routeChoice = null;
    if (this.flashTimer) { clearTimeout(this.flashTimer); this.flashTimer = null; }

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.setAttribute('viewBox', board.viewBox());

    // 陣営の色のフチをぼかすためのフィルタ。stdDeviation はSVGユニット。
    var defs = svgEl('defs');
    var blur = svgEl('filter', {
      id: 'lb-rim-blur', x: '-40%', y: '-40%', width: '180%', height: '180%'
    });
    blur.appendChild(svgEl('feGaussianBlur', { stdDeviation: 1.2 }));
    defs.appendChild(blur);

    // HPの絵筆バッジの輪郭をガサガサにするフィルタ。
    // ノイズ（feTurbulence）で画素をずらし、絵の具がかすれた縁に見せる。
    var rough = svgEl('filter', {
      id: 'lb-brush-rough', x: '-45%', y: '-70%', width: '190%', height: '240%'
    });
    rough.appendChild(svgEl('feTurbulence', {
      type: 'fractalNoise', baseFrequency: '0.5', numOctaves: 3, seed: 11, result: 'lbNoise'
    }));
    rough.appendChild(svgEl('feDisplacementMap', {
      'in': 'SourceGraphic', in2: 'lbNoise', scale: 2.4,
      xChannelSelector: 'R', yChannelSelector: 'G'
    }));
    defs.appendChild(rough);
    svg.appendChild(defs);

    var gStatic = svgEl('g', { 'class': 'layer-static' });
    // 通常経路（グリッド線）
    board.gridLines().forEach(function (ln) {
      gStatic.appendChild(svgEl('line', {
        x1: ln.x1, y1: ln.y1, x2: ln.x2, y2: ln.y2, 'class': 'grid-line'
      }));
    });
    // ループ弧（回路ごとに色分け）
    board.arcs.forEach(function (arc) {
      gStatic.appendChild(svgEl('path', {
        d: board.arcPathD(arc), 'class': 'loop-arc loop-rank-' + arc.rank
      }));
    });
    // 交点
    for (var r = 0; r < board.size; r++) {
      for (var c = 0; c < board.size; c++) {
        var p = board.pointXY(r, c);
        gStatic.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 3.5, 'class': 'node' }));
        // 交点の通し番号（左上から1〜N²）の透かし。駒に隠れないよう少し右上へずらす
        var coordLabel = svgEl('text', { x: p.x + 27, y: p.y - 21, 'class': 'coord-label' });
        coordLabel.textContent = r * board.size + c + 1;
        gStatic.appendChild(coordLabel);
      }
    }
    // ループ入口（ここに立つとループ突撃を開始できる）
    board.entryPoints().forEach(function (e) {
      var p = board.pointXY(e.r, e.c);
      gStatic.appendChild(svgEl('circle', {
        cx: p.x, cy: p.y, r: ENTRY_R, 'class': 'node-entry loop-rank-' + e.rank
      }));
    });
    svg.appendChild(gStatic);

    this.layers = {
      path:   svgEl('g', { 'class': 'layer-path' }),
      hint:   svgEl('g', { 'class': 'layer-hint' }),
      pieces: svgEl('g', { 'class': 'layer-pieces' }),
      hit:    svgEl('g', { 'class': 'layer-hit' }),
      fx:     svgEl('g', { 'class': 'layer-fx' })
    };
    ['path', 'hint', 'pieces', 'hit', 'fx'].forEach(function (k) {
      svg.appendChild(self.layers[k]);
    });

    // 交点ごとの透明な当たり判定
    for (var r2 = 0; r2 < board.size; r2++) {
      for (var c2 = 0; c2 < board.size; c2++) {
        (function (r, c) {
          var p = board.pointXY(r, c);
          var hit = svgEl('circle', { cx: p.x, cy: p.y, r: board.STEP * 0.42, 'class': 'hit' });
          hit.addEventListener('click', function () { self.handleClick(r, c); });
          hit.addEventListener('mouseenter', function () { self.handleHover(r, c); });
          hit.addEventListener('mouseleave', function () { self.handleHover(null); });
          self.layers.hit.appendChild(hit);
        })(r2, c2);
      }
    }
  };

  // ---- 選択状態の再計算 -------------------------------------------------
  UI.prototype.refreshSelection = function () {
    var game = this.game;
    var knight = this.selectedId ? rules.getKnight(game.state, this.selectedId) : null;
    if (!knight || !game.isOwnKnight(knight)) {
      this.selectedId = null;
      this.sel = null;
      return;
    }
    var charges = game.getLoopCharges(knight);
    this.sel = {
      knight: knight,
      moves: game.getNormalMoves(knight),
      charges: charges,
      byTarget: rules.groupChargesByTarget(charges)
    };
  };

  UI.prototype.select = function (id) {
    this.selectedId = id;
    this.routeChoice = null;
    this.hoverPath = null;
    this.refreshSelection();
    this.render();
  };

  // ---- 入力処理（仕様書 §21）-------------------------------------------
  UI.prototype.handleClick = function (r, c) {
    var game = this.game;
    if (game.state.winner) return;
    if (!this.canAct()) return; // オンライン対戦で相手の手番のあいだは操作させない

    // 経路選択モード：経路の1歩目をクリックして突撃実行
    if (this.routeChoice) {
      var chosen = this.routeChoice.options.filter(function (op) {
        return op.steps[0].to.r === r && op.steps[0].to.c === c;
      })[0];
      if (chosen) { this.executeCharge(chosen); return; }
      this.routeChoice = null; // 選択解除して通常処理へ
    }

    var target = rules.knightAt(game.state, r, c);

    // 自軍騎をクリック＝選択・選択し直し（仕様書 §21 誤操作防止）
    if (target && game.isOwnKnight(target)) {
      this.select(target.id === this.selectedId ? null : target.id);
      return;
    }

    if (!this.sel) return;

    // 通常移動
    var move = this.sel.moves.filter(function (m) { return m.r === r && m.c === c; })[0];
    if (move) {
      var knight = this.sel.knight;
      var events = game.doNormalMove(knight, move);
      this.afterAction(events);
      return;
    }

    // ループ突撃
    if (target && target.owner !== this.sel.knight.owner) {
      var options = this.sel.byTarget[target.id];
      if (!options) return; // 突撃できない敵：誤操作防止のため選択は保持する
      if (options.length === 1) { this.executeCharge(options[0]); return; }
      if (options.length > 1) {
        // 経路によってノックバック方向が変わるため、プレイヤーに選ばせる
        this.routeChoice = { targetId: target.id, options: options };
        this.hoverPath = null;
        this.render();
        return;
      }
    }

    // それ以外は選択解除
    this.select(null);
  };

  UI.prototype.executeCharge = function (charge) {
    var events = this.game.doLoopCharge(this.sel.knight, charge);
    this.routeChoice = null;
    this.showPathFlash(charge.steps);
    this.afterAction(events);
  };

  UI.prototype.handleHover = function (r, c) {
    if (!this.sel || this.game.state.winner) return;
    var newPath = null;
    if (r !== null) {
      if (this.routeChoice) {
        var op = this.routeChoice.options.filter(function (o) {
          return o.steps[0].to.r === r && o.steps[0].to.c === c;
        })[0];
        if (op) newPath = op.steps;
      } else {
        var target = rules.knightAt(this.game.state, r, c);
        if (target && this.sel.byTarget[target.id]) {
          newPath = this.sel.byTarget[target.id][0].steps;
        }
      }
    }
    if (newPath === this.hoverPath) return;
    this.hoverPath = newPath;
    this.render();
  };

  UI.prototype.afterAction = function (events) {
    this.selectedId = null;
    this.sel = null;
    this.hoverPath = null;
    this.render();
    this.playFx(events);
    if (this.onAction) this.onAction(events);
  };

  /** 今このブラウザで操作してよいか（オンライン対戦の手番制御）*/
  UI.prototype.canAct = function () {
    if (this.replay) return false; // リプレイ中は操作させない
    if (!this.localPlayer) return true;
    return this.game.state.currentPlayer === this.localPlayer;
  };

  // ---- 視覚的フィードバック（仕様書 §22）------------------------------
  UI.prototype.playFx = function (events) {
    var self = this;
    var delay = 0;
    events.forEach(function (ev) {
      if (ev.type === 'damage') {
        var cls = ev.mode === 'loop' ? 'fx-loop' : ev.mode === 'wall' ? 'fx-wall' : 'fx-normal';
        self.floatText(ev.r, ev.c, '-' + ev.amount, cls, delay);
        // ループを通った突撃のときだけ、撃たれた側の陣営の色できらきらを散らす
        if (ev.mode === 'loop') {
          var hit = self.game.state.knights.filter(function (k) {
            return k.id === ev.knightId;
          })[0];
          if (hit) self.sparkleBurst(ev.r, ev.c, hit.owner, delay);
        }
        delay += 120;
      } else if (ev.type === 'wall') {
        self.floatText(ev.r, ev.c, 'WALL', 'fx-wall', delay);
        delay += 120;
      } else if (ev.type === 'knockback') {
        self.floatText(ev.to.r, ev.to.c, ev.chained ? 'PUSH!' : 'PUSH', 'fx-push', delay);
        delay += 120;
      } else if (ev.type === 'ko') {
        self.floatText(ev.r, ev.c, 'KO', 'fx-ko', delay);
        delay += 120;
      }
    });
  };

  // ループ突撃で撃たれた駒のまわりに、その陣営の色のきらきらを散らす。
  // 1.5秒かけて外へ広がりながら消える。CSS変数で1粒ずつ向き・距離・回転を変えている。
  UI.prototype.sparkleBurst = function (r, c, owner, delay) {
    var self = this;
    setTimeout(function () {
      var p = self.game.board.pointXY(r, c);
      var g = svgEl('g', {
        'class': 'fx-sparkles fx-sparkles-' + owner,
        transform: 'translate(' + p.x + ',' + p.y + ')'
      });
      for (var i = 0; i < SPARKLE_COUNT; i++) {
        // 均等に散らしたうえで少しだけ角度と距離を揺らす
        var ang = (Math.PI * 2 * i) / SPARKLE_COUNT + (Math.random() - 0.5) * 0.6;
        var dist = SPARKLE_MIN_R + Math.random() * (SPARKLE_MAX_R - SPARKLE_MIN_R);
        var s = svgEl('path', { d: SPARKLE_D, 'class': 'sparkle' });
        s.style.setProperty('--dx', (Math.cos(ang) * dist).toFixed(1) + 'px');
        s.style.setProperty('--dy', (Math.sin(ang) * dist).toFixed(1) + 'px');
        s.style.setProperty('--rot', Math.round((Math.random() - 0.5) * 360) + 'deg');
        s.style.setProperty('--scale', (0.55 + Math.random() * 0.75).toFixed(2));
        s.style.setProperty('--delay', (Math.random() * 0.28).toFixed(2) + 's');
        g.appendChild(s);
      }
      self.layers.fx.appendChild(g);
      setTimeout(function () {
        if (g.parentNode) g.parentNode.removeChild(g);
      }, SPARKLE_MS + 400);
    }, delay || 0);
  };

  UI.prototype.floatText = function (r, c, text, cls, delay) {
    var self = this;
    setTimeout(function () {
      var p = self.game.board.pointXY(r, c);
      var t = svgEl('text', { x: p.x, y: p.y - 26, 'class': 'fx-text ' + cls });
      t.textContent = text;
      self.layers.fx.appendChild(t);
      setTimeout(function () {
        if (t.parentNode) t.parentNode.removeChild(t);
      }, 1100);
    }, delay || 0);
  };

  UI.prototype.showPathFlash = function (steps) {
    var self = this;
    this.flashPath = steps;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(function () {
      self.flashPath = null;
      self.render();
    }, 900);
  };

  /**
   * ループ弧の上に、進む向きを示す小さな▲を作る。
   * @param arc     board.arcs の要素
   * @param forward true なら a→b の向き
   */
  UI.prototype.arcArrow = function (arc, forward, cls) {
    var m = this.game.board.arcMarker(arc, forward);
    var g = svgEl('g', {
      'class': cls,
      transform: 'translate(' + m.x.toFixed(1) + ',' + m.y.toFixed(1) + ') rotate(' + m.angle.toFixed(1) + ')'
    });
    g.appendChild(svgEl('polygon', { points: '-5,-6 7,0 -5,6' }));
    return g;
  };

  /** 経路の1ステップが弧を a→b の向きに通るかどうか */
  UI.prototype.stepIsForward = function (step, arc) {
    var board = this.game.board;
    var exit = board.exitPort(step.from.r, step.from.c, step.dirIn);
    return board.samePort(exit, arc.a);
  };

  // ---- 経路の描画 -------------------------------------------------------
  UI.prototype.drawPath = function (steps, cls) {
    var self = this;
    var board = this.game.board;
    var layer = this.layers.path;
    steps.forEach(function (st) {
      var from = board.pointXY(st.from.r, st.from.c);
      var to   = board.pointXY(st.to.r, st.to.c);
      if (st.arcId === null) {
        layer.appendChild(svgEl('line', {
          x1: from.x, y1: from.y, x2: to.x, y2: to.y, 'class': cls
        }));
      } else {
        // 弧を通るステップ：出口ポートまでの直線＋弧＋入口ポートからの直線
        var arc = board.arcs[st.arcId];
        if (!arc) return; // 盤面が変わって弧が存在しない場合は描かない
        var exit = board.exitPort(st.from.r, st.from.c, st.dirIn);
        var entry = board.otherPort(arc, exit);
        var exitXY = board.portXY(exit);
        var entryXY = board.portXY(entry);
        layer.appendChild(svgEl('line', {
          x1: from.x, y1: from.y, x2: exitXY.x, y2: exitXY.y, 'class': cls
        }));
        layer.appendChild(svgEl('path', { d: board.arcPathD(arc), 'class': cls }));
        layer.appendChild(svgEl('line', {
          x1: entryXY.x, y1: entryXY.y, x2: to.x, y2: to.y, 'class': cls
        }));
        // どちら回りに通るかを▲で示す
        var fwd = board.samePort(exit, arc.a);
        self.pathArcKeys[st.arcId + (fwd ? 'F' : 'B')] = true;
        layer.appendChild(self.arcArrow(arc, fwd, 'arc-dir arc-dir-path'));
      }
    });
  };

  // ---- リプレイ ---------------------------------------------------------
  // 記録した対局のコマを順に表示する。リプレイ中は盤面を操作できない。

  var REPLAY_INTERVAL = 700; // 1コマあたりの再生間隔(ms)

  /** 表示に使う盤面（リプレイ中は記録されたコマ） */
  UI.prototype.viewState = function () {
    if (!this.replay) return this.game.state;
    var f = this.replay.frames[this.replay.index];
    if (!f) return this.game.state;
    if (!f.parsed) f.parsed = JSON.parse(f.snap);
    return f.parsed;
  };

  /** 表示に使うログ（リプレイ中はそのコマまで） */
  UI.prototype.viewLog = function () {
    if (!this.replay) return this.game.log;
    var f = this.replay.frames[this.replay.index];
    return this.replay.log.slice(0, f ? f.logLen : 0);
  };

  UI.prototype.isReplaying = function () { return !!this.replay; };

  UI.prototype.startReplay = function (source) {
    if (!source || !source.frames || source.frames.length === 0) return false;
    this.pauseReplay();
    this.selectedId = null;
    this.sel = null;
    this.routeChoice = null;
    this.hoverPath = null;
    this.flashPath = null;
    this.replay = {
      frames: source.frames, log: source.log,
      label: source.label, key: source.key,
      index: 0, playing: false
    };
    this.render();
    return true;
  };

  UI.prototype.stopReplay = function () {
    this.pauseReplay();
    this.replay = null;
    this.render();
  };

  UI.prototype.playReplay = function () {
    if (!this.replay) return;
    var self = this;
    // 最後まで見終わっていたら頭から
    if (this.replay.index >= this.replay.frames.length - 1) this.replay.index = 0;
    this.replay.playing = true;
    this.replayTimer = setInterval(function () {
      if (!self.replay) return self.pauseReplay();
      if (self.replay.index >= self.replay.frames.length - 1) {
        self.pauseReplay();
        self.render();
        return;
      }
      self.replay.index++;
      self.render();
    }, REPLAY_INTERVAL);
    this.render();
  };

  UI.prototype.pauseReplay = function () {
    if (this.replayTimer) { clearInterval(this.replayTimer); this.replayTimer = null; }
    if (this.replay) this.replay.playing = false;
  };

  UI.prototype.seekReplay = function (delta) {
    if (!this.replay) return;
    this.pauseReplay();
    var i = this.replay.index + delta;
    this.replay.index = Math.max(0, Math.min(this.replay.frames.length - 1, i));
    this.render();
  };

  // ---- 全体描画 ---------------------------------------------------------
  UI.prototype.render = function () {
    this.refreshSelection();
    this.renderBoard();
    this.renderStatus();
    this.renderLog();
    if (this.onReplayUpdate) this.onReplayUpdate();
  };

  UI.prototype.renderBoard = function () {
    var self = this;
    var game = this.game;
    var board = game.board;
    var clear = function (g) { while (g.firstChild) g.removeChild(g.firstChild); };
    clear(this.layers.path);
    clear(this.layers.hint);
    clear(this.layers.pieces);
    // 経路ハイライトで▲を描いた弧。選択ガイド側で二重に描かないよう控える
    this.pathArcKeys = {};

    // 経路ハイライト
    if (this.flashPath) this.drawPath(this.flashPath, 'path-flash');
    else if (this.hoverPath) this.drawPath(this.hoverPath, 'path-hover');

    if (this.sel) {
      // 選択中の騎
      var sp = board.pointXY(this.sel.knight.r, this.sel.knight.c);
      this.layers.hint.appendChild(svgEl('circle', {
        cx: sp.x, cy: sp.y, r: MARK_SEL_R, 'class': 'mark-selected'
      }));
      // 移動可能地点
      this.sel.moves.forEach(function (m) {
        var p = board.pointXY(m.r, m.c);
        self.layers.hint.appendChild(svgEl('circle', {
          cx: p.x, cy: p.y, r: 11, 'class': 'mark-move'
        }));
      });
      // ループ突撃で通る弧に、進む向きの▲を出す（同じ弧・同じ向きは1つだけ）
      var arrowSeen = {};
      this.sel.charges.forEach(function (ch) {
        ch.steps.forEach(function (st) {
          if (st.arcId === null) return;
          var arc = board.arcs[st.arcId];
          if (!arc) return;
          var forward = self.stepIsForward(st, arc);
          var key = st.arcId + (forward ? 'F' : 'B');
          if (arrowSeen[key] || self.pathArcKeys[key]) return; // 経路側で描いた分は省く
          arrowSeen[key] = true;
          self.layers.hint.appendChild(
            self.arcArrow(arc, forward, 'arc-dir loop-rank-' + arc.rank));
        });
      });
      // ループ突撃可能な敵
      Object.keys(this.sel.byTarget).forEach(function (tid) {
        var t = rules.getKnight(game.state, tid);
        var p = board.pointXY(t.r, t.c);
        self.layers.hint.appendChild(svgEl('circle', {
          cx: p.x, cy: p.y, r: MARK_CHARGE_R, 'class': 'mark-charge'
        }));
      });
    }

    // 駒（リプレイ中は記録されたコマの盤面）
    this.viewState().knights.forEach(function (k) {
      if (!k.alive) return;
      var p = board.pointXY(k.r, k.c);
      var g = svgEl('g', { 'class': 'piece piece-' + k.owner });

      // 絵柄。割り当てが無ければ従来どおり色の円を描く。
      // 先に陣営の色のフチを敷き、その上に絵柄を重ねる。フチはぼかしてあるので
      // メダリオンの縁の外側にだけ、色の分かる淡い縁取りとして残る。
      var art = LB.characterFor && LB.characterFor(k.id);
      if (art) {
        g.appendChild(svgEl('circle', {
          cx: p.x, cy: p.y, r: PIECE_RING_R,
          'stroke-width': PIECE_RING, 'class': 'piece-ring'
        }));
        var img = svgEl('image', {
          x: p.x - PIECE_ART_R, y: p.y - PIECE_ART_R,
          width: PIECE_ART_R * 2, height: PIECE_ART_R * 2,
          href: art.src, 'class': 'piece-art'
        });
        var ttl = svgEl('title');
        ttl.textContent = art.name;
        img.appendChild(ttl);
        // 画像が読めない環境（ファイル欠品など）では従来の色の円に戻す
        (function (group, image, pt) {
          image.addEventListener('error', function () {
            group.insertBefore(
              svgEl('circle', { cx: pt.x, cy: pt.y, r: PIECE_R, 'class': 'piece-body' }),
              group.firstChild
            );
            if (image.parentNode) image.parentNode.removeChild(image);
          });
        }(g, img, p));
        g.appendChild(img);
      } else {
        g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: PIECE_R, 'class': 'piece-body' }));
        g.appendChild(svgEl('circle', {
          cx: p.x, cy: p.y, r: PIECE_RING_R,
          'stroke-width': PIECE_RING, 'class': 'piece-ring'
        }));
      }

      // HPは駒の右下。絵筆で斜めにひと塗りした上に数字を置く
      var bx = p.x + HP_BADGE.x, by = p.y + HP_BADGE.y;
      var brush = svgEl('g', {
        'class': 'piece-hp-brush',
        transform: 'translate(' + bx + ',' + by + ') rotate(' + HP_BADGE.angle + ')'
                 + ' scale(' + HP_BADGE.scale + ')'
      });
      brush.appendChild(svgEl('path', { d: BRUSH_D, 'class': 'brush-body' }));
      brush.appendChild(svgEl('path', { d: BRUSH_HL_D, 'class': 'brush-highlight' }));
      BRUSH_STREAKS.forEach(function (d) {
        brush.appendChild(svgEl('path', { d: d, 'class': 'brush-streak' }));
      });
      g.appendChild(brush);
      var hp = svgEl('text', { x: bx, y: by + 5.2, 'class': 'piece-hp' });
      hp.textContent = k.hp;
      g.appendChild(hp);
      var lb = svgEl('text', { x: p.x, y: p.y + 37.5, 'class': 'piece-label' });
      lb.textContent = k.label;
      g.appendChild(lb);
      self.layers.pieces.appendChild(g);
    });

    // 経路選択モードの番号バッジ
    if (this.routeChoice) {
      this.routeChoice.options.forEach(function (op, i) {
        var p = board.pointXY(op.steps[0].to.r, op.steps[0].to.c);
        var g = svgEl('g', { 'class': 'route-badge' });
        g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 14 }));
        var t = svgEl('text', { x: p.x, y: p.y + 5 });
        t.textContent = String(i + 1);
        g.appendChild(t);
        self.layers.hint.appendChild(g);
      });
    }
  };

  UI.prototype.renderStatus = function () {
    var self = this;
    var game = this.game;
    var state = this.viewState();
    var dom = this.dom;
    var replaying = this.isReplaying();

    // リプレイ中は盤面に印を付ける
    if (replaying) dom.board.classList.add('is-replay');
    else dom.board.classList.remove('is-replay');

    // 手番表示 / 勝敗表示
    // 手番の中身（色駒アイコン・プレイヤー名・Turn数）は renderTurnSide が担当し、
    // ここでは枠の色と、リプレイ・決着といった特別な状態の文言だけを出す。
    dom.turn.className = 'turn turn-' + state.currentPlayer + (replaying ? ' turn-replay' : '');
    if (state.winner) {
      dom.turn.className = 'turn turn-win';
      // 勝者の名前は手番表示の側が出すので、ここは短い一言だけにする
      dom.turnText.textContent = state.winner === 'draw' ? 'DRAW' : 'WIN!';
    } else {
      dom.turnText.textContent = replaying ? '▶ リプレイ再生中' : '';
    }

    this.renderTurnSide();

    // 各騎のHP
    ['p1', 'p2'].forEach(function (owner) {
      var box = dom.roster[owner];
      box.innerHTML = '';
      state.knights.filter(function (k) { return k.owner === owner; }).forEach(function (k) {
        var row = document.createElement('div');
        row.className = 'knight-row' + (k.alive ? '' : ' dead');

        // 騎の記号（A1 など）と、絵柄を選ぶドロップダウン。
        // 6種類のどれを何騎に使ってもよい（相手と同じ絵柄でも構わない）。
        var code = document.createElement('span');
        code.className = 'knight-code';
        code.textContent = k.label;

        var name = document.createElement('select');
        name.className = 'knight-name knight-pick';
        name.title = '騎' + k.label + ' の絵柄を選びます';
        (LB.PIECE_CHARACTERS || []).forEach(function (ch) {
          var op = document.createElement('option');
          op.value = ch.key;
          op.textContent = ch.name;
          name.appendChild(op);
        });
        name.value = LB.pieceArt[k.id] || '';
        (function (knightId) {
          name.addEventListener('change', function () {
            if (self.onPieceArtChange) self.onPieceArtChange(knightId, this.value);
          });
        }(k.id));
        var bar = document.createElement('span');
        bar.className = 'hp-bar';
        for (var i = 0; i < k.maxHp; i++) {
          var pip = document.createElement('i');
          pip.className = 'hp-pip' + (i < k.hp ? ' on' : '');
          bar.appendChild(pip);
        }
        var num = document.createElement('span');
        num.className = 'knight-hp';
        num.textContent = k.alive ? (k.hp + ' / ' + k.maxHp) : 'KO';
        row.appendChild(code);
        row.appendChild(name);
        row.appendChild(bar);
        row.appendChild(num);
        box.appendChild(row);
      });
    });

    // 選択中の騎の情報
    if (replaying) {
      dom.hint.textContent = 'リプレイ再生中：' + this.replay.label
        + '（' + (this.replay.index + 1) + ' / ' + this.replay.frames.length + ' コマ）'
        + ' — 「停止」で対局に戻ります。';
    } else if (state.winner) {
      dom.hint.textContent = 'RESTART で再戦できます。';
    } else if (!this.canAct()) {
      dom.hint.textContent = '相手の手番です。相手が指すまでお待ちください。';
    } else if (this.routeChoice) {
      dom.hint.textContent = '突撃経路が複数あります。番号バッジをクリックして経路を選んでください（ノックバック方向が変わります）。';
    } else if (this.sel) {
      dom.hint.textContent = '騎' + this.sel.knight.label + ' を選択中：移動可能 '
        + this.sel.moves.length + ' か所 / ループ突撃可能な敵 '
        + Object.keys(this.sel.byTarget).length + ' 騎';
    } else {
      dom.hint.textContent = '自軍の騎をクリックして選択してください。';
    }

    // 降参ボタン（決着後・リプレイ中は押せない）
    if (dom.resign) dom.resign.disabled = replaying || !!state.winner;

    // 手詰まり時のパス
    dom.pass.style.display = (!replaying && !state.winner && this.canAct() && !game.hasAnyAction())
      ? 'block' : 'none';
  };

  /**
   * 盤面左の手番表示。
   * 「今どちらの番か」を色と文字で示し、オンライン対戦では
   * それが自分か相手かも出す。
   */
  UI.prototype.renderTurnSide = function () {
    var dom = this.dom;
    if (!dom.turnSide) return;
    var state = this.viewState();
    var cls = 'turn-side';

    if (state.winner) {
      dom.turnSideName.textContent = state.winner === 'draw'
        ? 'DRAW' : LB.PLAYER_LABEL[state.winner];
      dom.turnSideWho.textContent = state.winner === 'draw' ? '引き分け'
        : (this.localPlayer
            ? (state.winner === this.localPlayer ? 'あなたの勝ち' : 'あなたの負け')
            : 'の勝利');
      dom.turnSideLabel.textContent = '決着';
      cls += ' turn-side-win';
    } else {
      dom.turnSideLabel.textContent = '手番';
      dom.turnSideName.textContent = LB.PLAYER_LABEL[state.currentPlayer];
      cls += ' turn-side-' + state.currentPlayer;
      if (this.localPlayer) {
        var mine = state.currentPlayer === this.localPlayer;
        dom.turnSideWho.textContent = mine ? 'あなたの番' : '相手の番';
        if (mine) cls += ' turn-side-mine';
      } else {
        dom.turnSideWho.textContent = state.currentPlayer === 'p1' ? '青・下側' : '赤・上側';
      }
    }
    dom.turnSideCount.textContent = 'Turn ' + state.turnCount;
    dom.turnSide.className = cls;
  };

  UI.prototype.renderLog = function () {
    var box = this.dom.log;
    box.innerHTML = '';
    this.viewLog().slice(-40).forEach(function (entry) {
      var div = document.createElement('div');
      div.className = 'log-line log-' + entry.tone;
      div.textContent = entry.text;
      box.appendChild(div);
    });
    box.scrollTop = box.scrollHeight;
  };

  // ---- 座標の透かし表示（仕様書 §20 / デバッグ支援）--------------------
  UI.prototype.setCoordsVisible = function (visible) {
    this.showCoords = !!visible;
    if (this.showCoords) this.dom.board.classList.remove('hide-coords');
    else this.dom.board.classList.add('hide-coords');
    return this.showCoords;
  };

  UI.prototype.toggleCoords = function () {
    return this.setCoordsVisible(!this.showCoords);
  };

  LB.UI = UI;

})(window.LB);
