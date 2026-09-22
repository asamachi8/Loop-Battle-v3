/**
 * Loop Battle - 戦闘BGM
 *
 * 負荷を抑えるための方針：
 *  - ページを開いた時点では1曲も読み込まない（preload="none"）
 *  - バトルが始まったときに、選ばれた1曲だけをストリーミング再生する
 *  - 音量0（消音）のあいだは読み込み自体をしない。タブを裏にしたら一時停止する
 *  - オンライン対戦の通信（盤面の同期）とは無関係。音源は公開ページから各自が取得する
 *
 * 選曲と音量は、この端末のブラウザにだけ保存する（相手には影響しない）。
 */
(function (LB) {
  'use strict';

  LB.BGM_TRACKS = [
    { id: 'vs-hero-party', title: 'VS勇者一行',       file: 'assets/bgm/vs-hero-party.mp3' },
    { id: 'poison-battle', title: 'ポイズンバトル',   file: 'assets/bgm/poison-battle.mp3' },
    { id: 'viking-march',  title: 'ヴァイキング進行', file: 'assets/bgm/viking-march.mp3' }
  ];

  var DEFAULT_VOLUME = 60;   // 音量スライダーの初期値（0〜100。60 で audio の音量 0.36）
  var FADE_MS = 700;

  function load(key, fallback) {
    try {
      var v = window.localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { window.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 保存できなくても動く */ }
  }

  function findTrack(id) {
    for (var i = 0; i < LB.BGM_TRACKS.length; i++) if (LB.BGM_TRACKS[i].id === id) return LB.BGM_TRACKS[i];
    return null;
  }

  function BGM() {
    this.audio = null;          // 最初に鳴らすときに作る
    this.choice = load('lb.bgm.choice', 'random');   // 'random' か 曲の id
    if (this.choice !== 'random' && !findTrack(this.choice)) this.choice = 'random';
    var v = load('lb.bgm.volume', null);
    if (typeof v !== 'number' || isNaN(v)) v = load('lb.bgm.muted', false) ? 0 : DEFAULT_VOLUME;  // 旧ミュート設定を引き継ぐ
    this.volume = Math.max(0, Math.min(100, Math.round(v)));   // 0〜100。0 は消音
    this.battleKey = null;      // 今鳴らしているバトルの識別子（round）
    this.current = null;        // 今のバトルで選ばれた曲
    this.wanted = false;        // バトル中で鳴らすべき状態か
    this.fadeTimer = null;
    var self = this;
    document.addEventListener('visibilitychange', function () { self.apply(); });
  }

  BGM.prototype.ensureAudio = function () {
    if (this.audio) return this.audio;
    var a = new Audio();
    a.preload = 'none';
    a.loop = true;
    a.volume = this.level();
    this.audio = a;
    return a;
  };

  /** ランダムなら前回と違う曲を選ぶ */
  BGM.prototype.pickTrack = function () {
    if (this.choice !== 'random') return findTrack(this.choice);
    var prev = this.current;
    var pool = LB.BGM_TRACKS.filter(function (t) { return t !== prev; });
    return pool[Math.floor(Math.random() * pool.length)];
  };

  /**
   * 描画のたびに呼ぶ。inBattle が true のあいだ鳴らし、false になったら止める。
   * battleKey が変わったら（RESTARTなどで次のバトル）曲を選び直す。
   */
  BGM.prototype.sync = function (inBattle, battleKey) {
    if (inBattle && battleKey !== this.battleKey) {
      this.battleKey = battleKey;
      this.current = this.pickTrack();
      if (this.audio && this.audio.src) this.audio.currentTime = 0;
      this.loaded = null;
    }
    if (!inBattle && this.wanted) this.battleKey = null;
    this.wanted = inBattle;
    this.apply();
  };

  /** スライダーの値（0〜100）を audio の音量（0〜1）にする。耳の感じ方に合わせて2乗で効かせる */
  BGM.prototype.level = function () {
    var x = this.volume / 100;
    return x * x;
  };

  /** 今の状態（バトル中か・音量0か・タブが見えているか）に合わせて再生／停止する */
  BGM.prototype.apply = function () {
    var play = this.shouldPlay();
    if (play) {
      var a = this.ensureAudio();
      if (this.loaded !== this.current.file) {
        a.src = this.current.file;       // ここで初めて読み込みが始まる
        this.loaded = this.current.file;
      }
      this.fadeTo(this.level());
      if (a.paused) {
        var p = a.play();
        if (p && p.catch) p.catch(function () { /* 自動再生が拒否された場合は、次の操作で再挑戦する */ });
      }
    } else if (this.audio && !this.audio.paused) {
      var self = this;
      this.fadeTo(0, function () { if (!self.shouldPlay()) self.audio.pause(); });
    }
  };

  BGM.prototype.shouldPlay = function () {
    return this.wanted && this.volume > 0 && !document.hidden && !!this.current;
  };

  BGM.prototype.fadeTo = function (target, done) {
    var a = this.audio;
    if (!a) return;
    clearInterval(this.fadeTimer);
    var start = a.volume, t0 = Date.now();
    if (target > 0 && a.paused) { a.volume = target; if (done) done(); return; }
    this.fadeTimer = setInterval(function () {
      var k = Math.min(1, (Date.now() - t0) / FADE_MS);
      a.volume = start + (target - start) * k;
      if (k >= 1) { clearInterval(this.fadeTimer); if (done) done(); }
    }.bind(this), 40);
  };

  /** 音量を変える（0〜100）。鳴っている最中ならその場で反映する */
  BGM.prototype.setVolume = function (value) {
    var v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    this.volume = v;
    save('lb.bgm.volume', v);
    if (this.audio && !this.audio.paused && v > 0) {
      clearInterval(this.fadeTimer);
      this.audio.volume = this.level();
    }
    this.apply();
  };

  /**
   * 選曲を変える。曲を指定したらバトル中でもその場で切り替える。
   * ランダムにした場合は今の曲のまま続け、次のバトル開始時に抽選する。
   */
  BGM.prototype.setChoice = function (choice) {
    this.choice = (choice === 'random' || findTrack(choice)) ? choice : 'random';
    save('lb.bgm.choice', this.choice);
    if (this.wanted && this.choice !== 'random') {
      var next = this.pickTrack();
      if (next !== this.current) {
        this.current = next;
        if (this.audio) this.audio.pause();
        this.apply();
      }
    }
  };

  /** 今のバトルで流す曲名（音量0でも決まっていれば返す）。バトル外は null */
  BGM.prototype.nowPlaying = function () {
    return (this.wanted && this.current) ? this.current.title : null;
  };

  LB.BGM = BGM;

})(window.LB);
