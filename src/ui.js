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
        cx: p.x, cy: p.y, r: 30, 'class': 'node-entry loop-rank-' + e.rank
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

  // ---- 経路の描画 -------------------------------------------------------
  UI.prototype.drawPath = function (steps, cls) {
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
      }
    });
  };

  // ---- 全体描画 ---------------------------------------------------------
  UI.prototype.render = function () {
    this.refreshSelection();
    this.renderBoard();
    this.renderStatus();
    this.renderLog();
  };

  UI.prototype.renderBoard = function () {
    var self = this;
    var game = this.game;
    var board = game.board;
    var clear = function (g) { while (g.firstChild) g.removeChild(g.firstChild); };
    clear(this.layers.path);
    clear(this.layers.hint);
    clear(this.layers.pieces);

    // 経路ハイライト
    if (this.flashPath) this.drawPath(this.flashPath, 'path-flash');
    else if (this.hoverPath) this.drawPath(this.hoverPath, 'path-hover');

    if (this.sel) {
      // 選択中の騎
      var sp = board.pointXY(this.sel.knight.r, this.sel.knight.c);
      this.layers.hint.appendChild(svgEl('circle', {
        cx: sp.x, cy: sp.y, r: 28, 'class': 'mark-selected'
      }));
      // 移動可能地点
      this.sel.moves.forEach(function (m) {
        var p = board.pointXY(m.r, m.c);
        self.layers.hint.appendChild(svgEl('circle', {
          cx: p.x, cy: p.y, r: 11, 'class': 'mark-move'
        }));
      });
      // ループ突撃可能な敵
      Object.keys(this.sel.byTarget).forEach(function (tid) {
        var t = rules.getKnight(game.state, tid);
        var p = board.pointXY(t.r, t.c);
        self.layers.hint.appendChild(svgEl('circle', {
          cx: p.x, cy: p.y, r: 30, 'class': 'mark-charge'
        }));
      });
    }

    // 駒
    game.state.knights.forEach(function (k) {
      if (!k.alive) return;
      var p = board.pointXY(k.r, k.c);
      var g = svgEl('g', { 'class': 'piece piece-' + k.owner });
      g.appendChild(svgEl('circle', { cx: p.x, cy: p.y, r: 22, 'class': 'piece-body' }));
      var hp = svgEl('text', { x: p.x, y: p.y + 7, 'class': 'piece-hp' });
      hp.textContent = k.hp;
      g.appendChild(hp);
      var lb = svgEl('text', { x: p.x, y: p.y + 36, 'class': 'piece-label' });
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
    var game = this.game;
    var state = game.state;
    var dom = this.dom;

    // ターン表示 / 勝敗表示
    dom.turn.className = 'turn turn-' + state.currentPlayer;
    if (state.winner) {
      dom.turn.className = 'turn turn-win';
      dom.turn.textContent = state.winner === 'draw'
        ? 'DRAW'
        : LB.PLAYER_LABEL[state.winner] + ' WIN!';
    } else {
      dom.turn.textContent = LB.PLAYER_LABEL[state.currentPlayer] + ' のターン（Turn '
        + state.turnCount + '）';
    }

    // 各騎のHP
    ['p1', 'p2'].forEach(function (owner) {
      var box = dom.roster[owner];
      box.innerHTML = '';
      state.knights.filter(function (k) { return k.owner === owner; }).forEach(function (k) {
        var row = document.createElement('div');
        row.className = 'knight-row' + (k.alive ? '' : ' dead');
        var name = document.createElement('span');
        name.className = 'knight-name';
        name.textContent = '騎' + k.label;
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
        row.appendChild(name);
        row.appendChild(bar);
        row.appendChild(num);
        box.appendChild(row);
      });
    });

    // 選択中の騎の情報
    if (state.winner) {
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

    // 手詰まり時のパス
    dom.pass.style.display = (!state.winner && this.canAct() && !game.hasAnyAction()) ? 'block' : 'none';
  };

  UI.prototype.renderLog = function () {
    var box = this.dom.log;
    box.innerHTML = '';
    this.game.log.slice(-40).forEach(function (entry) {
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
