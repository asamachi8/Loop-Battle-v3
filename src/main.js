/* =========================================================================
 * main.js
 * 起動処理と、画面上のデバッグ設定パネル（仕様書 §23）・RESTART（§24）。
 * ========================================================================= */
(function (LB) {
  'use strict';

  var game, ui;

  function $(id) { return document.getElementById(id); }

  var dom = {};

  /**
   * 初期配置テキストを [[row, col], ...] に変換する。
   * 「行,列」形式（例: 4,1）と、盤面に表示される通し番号（例: 26）の両方を受け付ける。
   */
  function parsePlacement(text, size) {
    var tokens = text.split(/[\s;]+/).filter(function (t) { return t.length > 0; });
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      var pair = tokens[i].match(/^(\d+),(\d+)$/);
      var num = tokens[i].match(/^(\d+)$/);
      var r, c;
      if (pair) {
        r = parseInt(pair[1], 10);
        c = parseInt(pair[2], 10);
      } else if (num) {
        var n = parseInt(num[1], 10);
        if (n < 1 || n > size * size) {
          throw new Error('通し番号が盤外です: ' + tokens[i] + '（1〜' + size * size + '）');
        }
        r = Math.floor((n - 1) / size);
        c = (n - 1) % size;
      } else {
        throw new Error('初期配置の書式が不正です: "' + tokens[i]
          + '"（例: 4,1 4,2 4,3 / 通し番号なら 26 27 28）');
      }
      if (r < 0 || r >= size || c < 0 || c >= size) {
        throw new Error('初期配置が盤外です: ' + tokens[i]);
      }
      out.push([r, c]);
    }
    if (out.length === 0) throw new Error('初期配置が空です。');
    return out;
  }

  function formatPlacement(list) {
    return list.map(function (p) { return p[0] + ',' + p[1]; }).join(' ');
  }

  function fillDebugForm(config) {
    dom.maxHp.value = config.MAX_HP;
    dom.normalDamage.value = config.NORMAL_DAMAGE;
    dom.loopDamage.value = config.LOOP_DAMAGE;
    dom.knockback.value = config.KNOCKBACK_DISTANCE;
    dom.wallDamage.value = config.WALL_DAMAGE;
    dom.boardType.value = String(config.BOARD_TYPE);
    dom.loopEntry.value = config.LOOP_ENTRY_MAX_STEPS;
    dom.chain.checked = !!config.CHAIN_KNOCKBACK;
    dom.placeP1.value = formatPlacement(config.INITIAL_PLACEMENT.p1);
    dom.placeP2.value = formatPlacement(config.INITIAL_PLACEMENT.p2);
    dom.debugError.textContent = '';
  }

  function readDebugForm(base) {
    var cfg = LB.cloneConfig(base);
    var num = function (input, label, min) {
      var v = parseInt(input.value, 10);
      if (isNaN(v) || v < min) throw new Error(label + ' には ' + min + ' 以上の整数を入力してください。');
      return v;
    };
    cfg.MAX_HP = num(dom.maxHp, '最大HP', 1);
    cfg.NORMAL_DAMAGE = num(dom.normalDamage, '通常攻撃ダメージ', 0);
    cfg.LOOP_DAMAGE = num(dom.loopDamage, 'ループ突撃ダメージ', 0);
    cfg.KNOCKBACK_DISTANCE = num(dom.knockback, 'ノックバック距離', 0);
    cfg.WALL_DAMAGE = num(dom.wallDamage, '壁激突ダメージ', 0);
    cfg.LOOP_ENTRY_MAX_STEPS = num(dom.loopEntry, 'ループ入口までの歩数', 1);
    cfg.CHAIN_KNOCKBACK = dom.chain.checked;

    cfg.BOARD_TYPE = num(dom.boardType, '盤面の種類', 1);
    var size = cfg.BOARD_SIZE;
    var p1 = parsePlacement(dom.placeP1.value, size);
    var p2 = parsePlacement(dom.placeP2.value, size);
    var seen = {};
    p1.concat(p2).forEach(function (p) {
      var key = p[0] + ',' + p[1];
      if (seen[key]) throw new Error('初期配置が重複しています: ' + key);
      seen[key] = true;
    });
    cfg.INITIAL_PLACEMENT = { p1: p1, p2: p2 };
    return cfg;
  }

  /** 盤面の種類のプルダウンを作る */
  function fillBoardTypeOptions() {
    dom.boardType.innerHTML = '';
    LB.BOARD_TYPES.forEach(function (t) {
      var op = document.createElement('option');
      op.value = String(t.id);
      op.textContent = '種類' + t.id + '：' + t.name;
      op.title = t.summary;
      dom.boardType.appendChild(op);
    });
  }

  /** 盤面の下に現在の盤面の種類を表示する */
  function showBoardName() {
    var t = game.boardType;
    dom.boardName.textContent = '盤面：種類' + t.id + '　' + t.name
      + '（' + t.summary + '／ループ入口 ' + game.board.entryPoints().length + ' 地点）';
  }

  // ---- オンライン対戦 ---------------------------------------------------

  var online = null;

  function isOnline() { return !!(online && online.session && online.session.connected); }

  function setOnlineStatus(text, kind) {
    dom.onlineStatus.textContent = text;
    dom.onlineStatus.className = 'online-status online-' + (kind || 'info');
  }

  /** 接続状態に合わせて画面を作り直す */
  function refreshOnlineUi() {
    var active = isOnline();
    ui.localPlayer = active ? online.session.localPlayer() : null;
    dom.onlineHost.style.display = (online && online.peer) ? 'none' : 'inline-block';
    dom.onlineLeave.style.display = (online && online.peer) ? 'inline-block' : 'none';
    // 対戦中は設定変更を host 側だけに許す（ルールがズレないようにする）
    var lockConfig = active && online.role === 'guest';
    dom.debugFields.forEach(function (el) { el.disabled = lockConfig; });
    $('debug-apply').disabled = lockConfig;
    $('debug-reset').disabled = lockConfig;
    $('quick-hp5').disabled = lockConfig;
    $('quick-hp6').disabled = lockConfig;
    $('restart').disabled = lockConfig;
    dom.roleNote.textContent = active
      ? 'あなたは ' + (ui.localPlayer === 'p1' ? 'Player 1（青・下側）' : 'Player 2（赤・上側）') + ' です。'
      : '';
    ui.render();
  }

  function initOnline() {
    online = new LB.Online({
      game: game,
      onStatus: setOnlineStatus,
      onSession: function (session, info) {
        // 相手から届いた設定で盤面が作り直された場合は、描画も作り直す
        if (info && info.boardRebuilt) {
          ui.buildBoard();
          showBoardName();
          fillDebugForm(game.config);
        }
        refreshOnlineUi();
      },
      onRoom: function (roomId, url) {
        dom.onlineLinkRow.style.display = 'flex';
        dom.onlineLink.value = url;
      }
    });

    // 1手指すたびに相手へ盤面を送る
    ui.onAction = function () {
      if (isOnline()) online.session.pushLocalMove();
    };

    dom.onlineHost.addEventListener('click', function () {
      if (location.protocol === 'file:') {
        setOnlineStatus('オンライン対戦は公開したURL上でのみ使えます（file:// では相手が開けません）。', 'error');
        return;
      }
      online.host();
      refreshOnlineUi();
    });

    dom.onlineLeave.addEventListener('click', function () {
      online.leave();
      dom.onlineLinkRow.style.display = 'none';
      refreshOnlineUi();
    });

    dom.onlineCopy.addEventListener('click', function () {
      dom.onlineLink.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      if (!ok && navigator.clipboard) navigator.clipboard.writeText(dom.onlineLink.value);
      this.textContent = 'コピー済';
      var btn = this;
      setTimeout(function () { btn.textContent = 'コピー'; }, 1500);
    });

    // URL に部屋IDが付いていれば参加側として自動接続する
    var room = LB.roomFromUrl();
    if (room) {
      dom.onlineLinkRow.style.display = 'none';
      online.join(room);
      refreshOnlineUi();
    }
  }

  function init() {
    dom = {
      board: $('board'),
      turn: $('turn'),
      hint: $('hint'),
      log: $('log'),
      pass: $('pass'),
      roster: { p1: $('roster-p1'), p2: $('roster-p2') },
      maxHp: $('cfg-max-hp'),
      normalDamage: $('cfg-normal-damage'),
      loopDamage: $('cfg-loop-damage'),
      knockback: $('cfg-knockback'),
      wallDamage: $('cfg-wall-damage'),
      boardType: $('cfg-board-type'),
      boardName: $('board-name'),
      loopEntry: $('cfg-loop-entry'),
      chain: $('cfg-chain'),
      placeP1: $('cfg-place-p1'),
      placeP2: $('cfg-place-p2'),
      debugError: $('debug-error'),
      onlineStatus: $('online-status'),
      onlineHost: $('online-host'),
      onlineLeave: $('online-leave'),
      onlineLinkRow: $('online-link-row'),
      onlineLink: $('online-link'),
      onlineCopy: $('online-copy'),
      roleNote: $('role-note')
    };

    game = new LB.Game(LB.config);
    ui = new LB.UI(game, dom);
    fillBoardTypeOptions();
    fillDebugForm(game.config);
    showBoardName();
    ui.render();

    // デバッグ用：ブラウザのコンソールから状態を触れるようにしておく
    // 例) LB.app.game.state.knights[0].hp = 1; LB.app.ui.render();
    dom.debugFields = [dom.maxHp, dom.normalDamage, dom.loopDamage, dom.knockback,
      dom.wallDamage, dom.boardType, dom.loopEntry, dom.chain, dom.placeP1, dom.placeP2];

    initOnline();

    LB.app = { game: game, ui: ui, online: function () { return online; } };

    $('restart').addEventListener('click', function () {
      game.reset();
      ui.selectedId = null;
      ui.routeChoice = null;
      ui.hoverPath = null;
      ui.flashPath = null;
      ui.render();
      if (isOnline()) online.session.pushConfig(); // 相手の盤面もリセットする
    });

    $('toggle-coords').addEventListener('click', function () {
      this.textContent = ui.toggleCoords() ? '座標を隠す' : '座標を表示';
    });

    dom.pass.addEventListener('click', function () {
      game.pass();
      ui.selectedId = null;
      ui.render();
    });

    function applyFromForm() {
      try {
        var cfg = readDebugForm(game.config);
        LB.config = cfg;
        game.applyConfig(cfg);
        ui.selectedId = null;
        ui.routeChoice = null;
        ui.hoverPath = null;
        ui.buildBoard();
        showBoardName();
        ui.render();
        dom.debugError.textContent = '';
        if (isOnline()) online.session.pushConfig(); // 設定変更を相手にも反映する
      } catch (e) {
        dom.debugError.textContent = e.message;
      }
    }

    $('debug-apply').addEventListener('click', applyFromForm);

    // 盤面の種類は選んだ時点で切り替える
    dom.boardType.addEventListener('change', applyFromForm);

    // HP5 / HP6 の比較用ショートカット（仕様書 §27 D）
    $('quick-hp5').addEventListener('click', function () { dom.maxHp.value = 5; applyFromForm(); });
    $('quick-hp6').addEventListener('click', function () { dom.maxHp.value = 6; applyFromForm(); });

    $('debug-reset').addEventListener('click', function () {
      LB.config = LB.cloneConfig(LB.DEFAULT_CONFIG);
      game.applyConfig(LB.config);
      fillDebugForm(game.config);
      ui.selectedId = null;
      ui.routeChoice = null;
      ui.buildBoard();
      showBoardName();
      ui.render();
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') ui.select(null);
    });
  }

  document.addEventListener('DOMContentLoaded', init);

})(window.LB);
