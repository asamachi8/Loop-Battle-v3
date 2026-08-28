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
   * 初期配置テキストを盤面の通し番号の配列に変換する。
   * 盤面に表示される通し番号（例: 26）と、従来の「行,列」形式（例: 4,1）の
   * 両方を受け付ける。内部では通し番号で持つ。
   */
  function parsePlacement(text, size) {
    var tokens = text.split(/[\s;、]+/).filter(function (t) { return t.length > 0; });
    var out = [];
    for (var i = 0; i < tokens.length; i++) {
      var pair = tokens[i].match(/^(\d+),(\d+)$/);
      var num = tokens[i].match(/^(\d+)$/);
      var n;
      if (pair) {
        var r = parseInt(pair[1], 10);
        var c = parseInt(pair[2], 10);
        if (r < 0 || r >= size || c < 0 || c >= size) {
          throw new Error('初期配置が盤外です: ' + tokens[i]);
        }
        n = r * size + c + 1;
      } else if (num) {
        n = parseInt(num[1], 10);
      } else {
        throw new Error('初期配置の書式が不正です: "' + tokens[i]
          + '"（盤面の番号なら 26 27 28 / 行,列 なら 4,1 4,2 4,3）');
      }
      if (n < 1 || n > size * size) {
        throw new Error('盤面の番号が範囲外です: ' + n + '（1〜' + size * size + '）');
      }
      out.push(n);
    }
    if (out.length === 0) throw new Error('初期配置が空です。');
    return out;
  }

  /** 盤面の通し番号の並びとして表示する */
  function formatPlacement(list) {
    var size = (LB.config && LB.config.BOARD_SIZE) || 6;
    return list.map(function (p) {
      return Array.isArray(p) ? (p[0] * size + p[1] + 1) : p;
    }).join(' ');
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
    p1.concat(p2).forEach(function (n) {
      if (seen[n]) throw new Error('初期配置が重複しています: ' + n + ' 番');
      seen[n] = true;
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
    var waiting = !!(online && online.peer && !active);
    ui.localPlayer = active ? online.session.localPlayer() : null;

    dom.onlineHost.style.display = (online && online.peer) ? 'none' : 'inline-block';
    dom.onlineLeave.style.display = (online && online.peer) ? 'inline-block' : 'none';
    dom.onlineSync.style.display = active ? 'inline-block' : 'none';
    dom.onlineShareRow.style.display = (waiting || active) && online.role === 'host' ? 'flex' : 'none';

    // 先攻・後攻を選べるのは部屋主のみ（参加側は相手の指定に従う）
    var canChooseSide = !online || online.role !== 'guest';
    ['p1', 'p2', 'random'].forEach(function (k) {
      dom.sideButtons[k].disabled = !canChooseSide;
    });
    markSideButton();

    // 対戦中は設定変更を部屋主だけに許す（ルールがズレないようにする）
    var lockConfig = active && online.role === 'guest';
    dom.debugFields.forEach(function (el) { el.disabled = lockConfig; });
    $('debug-apply').disabled = lockConfig;
    $('debug-reset').disabled = lockConfig;
    $('quick-hp5').disabled = lockConfig;
    $('quick-hp6').disabled = lockConfig;
    $('restart').disabled = lockConfig;

    // 降参できるのは対局中だけ。オンラインでは自分が参加している対局のみ
    dom.resign.disabled = !!game.state.winner;

    dom.roleNote.textContent = active
      ? 'あなたは ' + (ui.localPlayer === 'p1' ? 'Player 1（青・先攻・下側）' : 'Player 2（赤・後攻・上側）') + ' です。'
      : '';
    ui.render();
  }

  /** 選択中の担当ボタンに印を付ける */
  function markSideButton() {
    var current = online ? online.hostPlayer : 'p1';
    dom.sideButtons.p1.classList.toggle('is-active', sideChoice === 'p1');
    dom.sideButtons.p2.classList.toggle('is-active', sideChoice === 'p2');
    dom.sideButtons.random.classList.toggle('is-active', sideChoice === 'random');
    dom.sideButtons.random.textContent = (sideChoice === 'random')
      ? 'ランダム（' + (current === 'p1' ? '先攻' : '後攻') + '）'
      : 'ランダム';
  }

  /** 先攻・後攻を決める。ランダム指定ならその場で抽選する。 */
  var sideChoice = 'p1'; // 'p1' | 'p2' | 'random'

  function applySideChoice(choice) {
    sideChoice = choice;
    var player = choice === 'random'
      ? (Math.random() < 0.5 ? 'p1' : 'p2')
      : choice;

    if (isOnline() && game.state.turnCount > 1 &&
        !window.confirm('先攻・後攻を変更すると対局を最初からやり直します。よろしいですか？')) {
      return;
    }
    if (online) online.setHostPlayer(player);

    if (isOnline()) {
      // 担当が変わったので対局を仕切り直す
      game.reset();
      ui.selectedId = null;
      ui.render();
      online.session.pushConfig();
      setOnlineStatus('担当を変更しました。あなたは '
        + (online.session.localPlayer() === 'p1' ? 'Player 1（青・先攻）' : 'Player 2（赤・後攻）')
        + ' です。対局は最初から始まります。', 'ok');
    } else {
      setOnlineStatus('次に作る部屋では '
        + (player === 'p1' ? 'Player 1（青・先攻）' : 'Player 2（赤・後攻）')
        + ' を担当します。', 'info');
    }
    refreshOnlineUi();
  }

  /** 対戦URLの共有リンクを更新する（すべて新しいタブで開く） */
  function updateShareLinks(url) {
    var text = 'Loop Battle で対戦しよう！ このURLを開くと対戦が始まります。';
    var eu = encodeURIComponent(url);
    var et = encodeURIComponent(text);
    dom.shareLine.href = 'https://social-plugins.line.me/lineit/share?url=' + eu;
    dom.shareX.href = 'https://twitter.com/intent/tweet?text=' + et + '&url=' + eu;
    dom.shareMail.href = 'mailto:?subject=' + encodeURIComponent('Loop Battle の対戦URL')
      + '&body=' + encodeURIComponent(text + '\n\n' + url);
    dom.shareNative.style.display = navigator.share ? 'inline-block' : 'none';
    dom.shareNative.onclick = function () {
      // 共有シートを開くだけでページ遷移しないので、対戦は途切れない
      navigator.share({ title: 'Loop Battle', text: text, url: url })
        .catch(function () { /* ユーザーがキャンセルした場合など */ });
    };
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
        updateShareLinks(url);
        refreshOnlineUi();
      }
    });

    // 1手指すたびに相手へ盤面を送る
    ui.onAction = function () {
      if (isOnline()) online.session.pushLocalMove();
    };

    // ① 盤面を最新に更新（通信が一瞬途切れたときの復旧用）
    dom.onlineSync.addEventListener('click', function () {
      if (!isOnline()) return;
      online.session.requestSync();   // 相手に最新の盤面を要求
      online.session.pushConfig();    // 自分の盤面も送る
      setOnlineStatus('盤面の同期を要求しました。', 'info');
      var btn = this;
      btn.textContent = '同期中…';
      setTimeout(function () { btn.textContent = '盤面を最新に更新'; }, 1200);
    });

    // ③ 先攻・後攻の選択（部屋主のみ）
    dom.sideButtons.p1.addEventListener('click', function () { applySideChoice('p1'); });
    dom.sideButtons.p2.addEventListener('click', function () { applySideChoice('p2'); });
    dom.sideButtons.random.addEventListener('click', function () { applySideChoice('random'); });

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

  // ---- サイドパネルの左右切り替えと開閉 ---------------------------------
  // ルール早見表・ログ／リプレイ・駒のHP・デバッグ設定などの枠は1つのパネルに
  // まとめてあり、盤面の左右どちらへでもまとめて移動できる。
  // 位置と各枠の開閉状態はブラウザに覚えさせ、次に開いたときも同じ見た目にする。

  var PANEL_SIDE_KEY = 'loopbattle.panelSide';
  var PANEL_OPEN_KEY = 'loopbattle.panelOpen';

  function loadPref(key, fallback) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) {
      return fallback; // localStorage が使えない環境では既定値で動く
    }
  }

  function savePref(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できなくても動作に影響しない */ }
  }

  /** パネルを指定の側へ移す */
  function applyPanelSide(side) {
    var slot = side === 'left' ? dom.panelSlotLeft : dom.panelSlotRight;
    if (dom.sidePanel.parentNode !== slot) slot.appendChild(dom.sidePanel);
    dom.panelSideToggle.textContent = side === 'left' ? '右へ ▶' : '◀ 左へ';
    dom.panelSideToggle.title = side === 'left'
      ? '4つの枠をまとめて盤面の右側へ戻します'
      : '4つの枠をまとめて盤面の左側へ移します';
    dom.log.scrollTop = dom.log.scrollHeight; // 移動後もログの最新行を見せる
  }

  function initPanelSide() {
    var side = loadPref(PANEL_SIDE_KEY, 'right') === 'left' ? 'left' : 'right';
    applyPanelSide(side);
    dom.panelSideToggle.addEventListener('click', function () {
      side = (side === 'left') ? 'right' : 'left';
      applyPanelSide(side);
      savePref(PANEL_SIDE_KEY, side);
    });
  }

  // ---- 駒の絵柄の割り当て -----------------------------------------------
  // 駒HP枠のドロップダウンで、どの騎にどの絵柄を使うかを選べる。
  // 6種類のどれを何騎に使ってもよい（相手と同じ絵柄でも構わない）。
  // 相手側の3騎も同じように選べる。
  // 見た目だけの設定なのでブラウザに保存し、対戦相手へは送らない。

  var PIECE_ART_KEY = 'loopbattle.pieceArt';

  /** 保存された割り当てが「6騎ぶん・実在するキー」かを確かめる（重複は許す） */
  function validPieceArt(map) {
    if (!map || typeof map !== 'object') return false;
    var ids = Object.keys(LB.DEFAULT_PIECE_ART);
    for (var i = 0; i < ids.length; i++) {
      if (!LB.getCharacter(map[ids[i]])) return false;
    }
    return true;
  }

  function initPieceArt() {
    var saved = loadPref(PIECE_ART_KEY, null);
    if (validPieceArt(saved)) {
      Object.keys(LB.DEFAULT_PIECE_ART).forEach(function (id) { LB.pieceArt[id] = saved[id]; });
      ui.render();   // 初回描画はこの前に走っているので、読み込んだ割り当てを反映し直す
    }
    ui.onPieceArtChange = function (knightId, key) {
      if (!LB.getCharacter(key) || LB.pieceArt[knightId] === key) return;
      LB.pieceArt[knightId] = key;   // 重複は許す（同じ絵柄を何騎でも使える）
      savePref(PIECE_ART_KEY, LB.pieceArt);
      ui.render();
    };
  }

  /** 各枠の開閉状態を覚えておく */
  function initPanelToggles() {
    var saved = loadPref(PANEL_OPEN_KEY, {}) || {};
    var cards = dom.sidePanel.querySelectorAll('details.card');
    Array.prototype.forEach.call(cards, function (card) {
      if (!card.id) return;
      if (Object.prototype.hasOwnProperty.call(saved, card.id)) card.open = !!saved[card.id];
      card.addEventListener('toggle', function () {
        saved[card.id] = card.open;
        savePref(PANEL_OPEN_KEY, saved);
      });
    });
  }

  // ---- リプレイ操作 -----------------------------------------------------

  var replaySig = null; // まだ一覧を作っていないことを表す

  /** 選べる対局の一覧を作り直す（内容が変わったときだけ） */
  function fillReplaySources() {
    var sources = game.replaySources();
    var sig = sources.map(function (s) { return s.key + '|' + s.label; }).join(',');
    if (sig === replaySig) return;
    replaySig = sig;

    var keep = dom.replaySource.value;
    dom.replaySource.innerHTML = '';
    if (sources.length === 0) {
      var none = document.createElement('option');
      none.textContent = '記録された対局はまだありません';
      none.value = '';
      dom.replaySource.appendChild(none);
    } else {
      sources.forEach(function (s) {
        var op = document.createElement('option');
        op.value = s.key;
        op.textContent = s.label;
        dom.replaySource.appendChild(op);
      });
      if (keep && sources.some(function (s) { return s.key === keep; })) {
        dom.replaySource.value = keep;
      }
    }
    dom.replaySource.disabled = sources.length === 0;
  }

  /** 再生ボタンなどの表示を現在の状態に合わせる */
  function updateReplayUi() {
    fillReplaySources();
    var rp = ui.replay;
    var has = !!dom.replaySource.value;
    dom.replayPlay.textContent = (rp && rp.playing) ? '⏸ 一時停止' : '▶ 再生';
    dom.replayPlay.disabled = !has;
    dom.replayStop.disabled = !rp;
    dom.replayPrev.disabled = !has;
    dom.replayNext.disabled = !has;
    dom.replayPos.textContent = rp
      ? (rp.index + 1) + ' / ' + rp.frames.length + ' コマ'
      : '—';
    // リプレイ中は対局側の操作を止める
    dom.replaySource.disabled = !has || !!(rp && rp.playing);
  }

  /** 選択中の対局でリプレイを開始する（すでに開始済みならそのまま） */
  function ensureReplay() {
    var key = dom.replaySource.value;
    if (!key) return false;
    if (ui.replay && ui.replay.key === key) return true;
    var source = game.findReplaySource(key);
    return source ? ui.startReplay(source) : false;
  }

  function initReplay() {
    dom.replayPlay.addEventListener('click', function () {
      if (ui.replay && ui.replay.playing) { ui.pauseReplay(); ui.render(); return; }
      if (!ensureReplay()) return;
      ui.playReplay();
    });
    dom.replayStop.addEventListener('click', function () { ui.stopReplay(); });
    dom.replayPrev.addEventListener('click', function () {
      if (!ensureReplay()) return;
      ui.seekReplay(-1);
    });
    dom.replayNext.addEventListener('click', function () {
      if (!ensureReplay()) return;
      ui.seekReplay(1);
    });
    dom.replaySource.addEventListener('change', function () {
      if (ui.replay) { ui.stopReplay(); }   // 別の対局を選んだら一度戻す
      updateReplayUi();
    });
    ui.onReplayUpdate = updateReplayUi;
    updateReplayUi();
  }

  function init() {
    dom = {
      board: $('board'),
      turn: $('turn'),
      turnText: $('turn-text'),
      hint: $('hint'),
      log: $('log'),
      pass: $('pass'),
      resign: $('resign'),
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
      roleNote: $('role-note'),
      onlineSync: $('online-sync'),
      onlineShareRow: $('online-share-row'),
      shareNative: $('share-native'),
      shareLine: $('share-line'),
      shareX: $('share-x'),
      shareMail: $('share-mail'),
      sideButtons: { p1: $('side-p1'), p2: $('side-p2'), random: $('side-random') },
      turnSide: $('turn-side'),
      turnSideLabel: document.querySelector('#turn-side .turn-side-label'),
      turnSideName: $('turn-side-name'),
      turnSideWho: $('turn-side-who'),
      turnSideCount: $('turn-side-count'),
      replaySource: $('replay-source'),
      replayPlay: $('replay-play'),
      replayStop: $('replay-stop'),
      replayPrev: $('replay-prev'),
      replayNext: $('replay-next'),
      replayPos: $('replay-pos'),
      logCard: $('log-card'),
      sidePanel: $('side-panel'),
      panelSlotLeft: $('panel-slot-left'),
      panelSlotRight: $('panel-slot-right'),
      panelSideToggle: $('panel-side-toggle')
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

    initPanelSide();
    initPieceArt();
    initPanelToggles();
    initReplay();
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

    // ③ 降参（手詰まりで続ける意味が無いとき）
    dom.resign.addEventListener('click', function () {
      if (game.state.winner) return;
      var loser = isOnline() ? ui.localPlayer : game.state.currentPlayer;
      var label = LB.PLAYER_LABEL[loser];
      if (!window.confirm(label + ' の負けとして対局を終了します。降参しますか？')) return;
      game.resign(loser);
      ui.selectedId = null;
      ui.render();
      if (isOnline()) {
        online.session.pushConfig();
        setOnlineStatus('降参しました。RESTART で再戦できます。', 'warn');
        refreshOnlineUi();
      }
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
