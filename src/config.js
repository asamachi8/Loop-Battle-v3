/* =========================================================================
 * config.js
 * ゲームバランス調整用の数値をここに集約する（仕様書 §23）。
 * ここを書き換えるだけで、ゲーム本体のコードを触らずに調整できる。
 * 画面右の「デバッグ設定」からも同じ値を変更できる。
 * ========================================================================= */
window.LB = window.LB || {};
(function (LB) {
  'use strict';

  /* -------------------------------------------------------------------------
   * 盤面の種類（ループ弧の配置）
   * 弧は「盤面に表示される交点の通し番号のペア」で指定する。
   * 通し番号は左上が 1、右下が 36（n = 行 × 6 + 列 + 1）。
   * 盤端の交点だけが指定でき、最外周の線（行0・行5・列0・列5）には弧を繋げない。
   * 新しい盤面を試したい場合は、ここに1件追加するだけでよい。
   * ----------------------------------------------------------------------- */
  LB.BOARD_TYPES = [
    {
      id: 1,
      name: 'クローバー盤',
      summary: '弧8本 / 四隅に2本ずつ。一周する回路が2つできる',
      arcs: [
        [7, 2], [12, 5], [25, 32], [30, 35],   // 黄（内側）：行1・行4 / 列1・列4 の回路
        [13, 3], [18, 4], [19, 33], [24, 34]   // 青（外側）：行2・行3 / 列2・列3 の回路
      ]
    },
    {
      id: 2,
      name: 'ツインループ盤',
      summary: '弧2本 / 右上・左下に1本ずつ。経路は一周せず行き止まりで終わる',
      arcs: [
        [4, 24],   // 右上：列3の上端 ←→ 行3の右端
        [13, 33]   // 左下：行2の左端 ←→ 列2の下端
      ]
    },
    {
      id: 3,
      name: 'バタフライ盤',
      summary: '弧4本 / 右上・左下に2本ずつ。4本とも一周せず行き止まりで終わる',
      arcs: [
        [12, 5], [25, 32],   // 黄（内側）：行1→列4 / 行4→列1。どちらも行き止まりで終わる
        [3, 18], [19, 34]    // 青（外側）：右上 行2の右端←→列2の上端 / 左下 行3の左端←→列3の下端
      ]
    }
  ];

  // 駒の絵柄（キャラクター）の一覧。assets/pieces/ の Web用ファイルを指す。
  // 元画像（1254px の PNG）は同じフォルダに日本語ファイル名のまま置いてある。
  LB.PIECE_CHARACTERS = [
    { key: 'amerigo',    name: 'アメリゴ船長',         src: 'assets/pieces/amerigo.png' },
    { key: 'aosuke',     name: 'シンガーアオスケ',      src: 'assets/pieces/aosuke.png' },
    { key: 'marguerite', name: 'マルグリットメイド長',   src: 'assets/pieces/marguerite.png' },
    { key: 'jane-doe',   name: 'ジェーンドゥ',         src: 'assets/pieces/jane-doe.png' },
    { key: 'tsuzumi',    name: 'ツヅミサロン長',        src: 'assets/pieces/tsuzumi.png' },
    { key: 'asamachi',   name: 'ガイドあさまち',        src: 'assets/pieces/asamachi.png' }
  ];

  // 既定の割り当て（騎のID → キャラクターのキー）。
  // 実際の割り当ては LB.pieceArt が持ち、駒HP枠のドロップダウンで入れ替えられる。
  LB.DEFAULT_PIECE_ART = {
    'p1-1': 'amerigo',  'p1-2': 'aosuke',  'p1-3': 'marguerite',
    'p2-1': 'jane-doe', 'p2-2': 'tsuzumi', 'p2-3': 'asamachi'
  };

  LB.pieceArt = {};
  Object.keys(LB.DEFAULT_PIECE_ART).forEach(function (id) {
    LB.pieceArt[id] = LB.DEFAULT_PIECE_ART[id];
  });

  /** キャラクターのキーから定義を引く */
  LB.getCharacter = function (key) {
    return LB.PIECE_CHARACTERS.filter(function (c) { return c.key === key; })[0] || null;
  };

  /** 騎のIDから、いま割り当てられている絵柄を引く */
  LB.characterFor = function (knightId) {
    return LB.getCharacter(LB.pieceArt[knightId]);
  };
  LB.getBoardType = function (id) {
    var found = LB.BOARD_TYPES.filter(function (t) { return t.id === id; })[0];
    return found || LB.BOARD_TYPES[0];
  };

  LB.DEFAULT_CONFIG = {
    // 盤面サイズ（N×N の交点盤）
    BOARD_SIZE: 6,

    // 盤面の種類（LB.BOARD_TYPES の id）
    //   1 = クローバー盤（弧8本） / 2 = ツインループ盤（弧2本） / 3 = バタフライ盤（弧4本）
    BOARD_TYPE: 1,

    // 騎の最大HP
    MAX_HP: 5,

    // 通常接近攻撃のダメージ
    NORMAL_DAMAGE: 1,

    // ループ突撃のダメージ
    LOOP_DAMAGE: 3,

    // ループ突撃を開始できる条件：
    // 経路の何歩目までにループ弧へ入らなければならないか。
    //   1 = 弧の直前の交点（ループ入口）に立っている必要がある（Ver.0.2）
    //   2 = 入口の1つ手前からでも可
    //   99 = どこからでも可（Ver.0.1 の挙動）
    LOOP_ENTRY_MAX_STEPS: 1,

    // ループ突撃成功時のノックバック距離（マス数）
    KNOCKBACK_DISTANCE: 1,

    // 押し出し先に駒がある場合、その駒ごと押し出すか（連鎖押し出し）
    CHAIN_KNOCKBACK: true,

    // 盤端で押し出せなかった場合の壁激突ダメージ
    WALL_DAMAGE: 1,

    // 初期配置：盤面に表示される通し番号（左上が1、右下が36）で指定する
    // 「行,列」形式の [[4,1],[4,2],[4,3]] も引き続き受け付ける
    INITIAL_PLACEMENT: {
      p1: [26, 27, 28],
      p2: [9, 10, 11]
    }
  };

  // 数値だけを持つ単純な構造なのでディープコピーはこれで足りる
  LB.cloneConfig = function (config) {
    return JSON.parse(JSON.stringify(config));
  };

  // 実行中に参照される現在の設定
  LB.config = LB.cloneConfig(LB.DEFAULT_CONFIG);

})(window.LB);
