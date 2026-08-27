/* =========================================================================
 * board.js
 * 盤面ジオメトリ（交点・通常経路・ループ弧）と経路の1ステップ移動を扱う。
 * ルール判定（rules.js）と描画（ui.js）の両方がここを参照するが、
 * このファイル自体はゲーム状態（駒・HP・ターン）を一切知らない。
 *
 * ■ ループ経路の構造（Surakarta 型 / 仕様書 §5）
 *   N×N の交点盤。最外周の線（行0・行(N-1)・列0・列(N-1)）には弧を付けず、
 *   内側の行/列の線の端どうしを盤の隅で弧によって接続する。
 *   どの端どうしを繋ぐかは arcSpec で指定する（config.js の BOARD_TYPES）。
 *   指定は盤面に表示される交点の通し番号のペア。例) [[13, 33], [4, 24]]
 *   同じ隅に複数の弧がある場合は、小さいものから rank 1, 2, ... とし、
 *   rank が大きいほど外側を回り込むように描画する。
 *   駒は弧を通ることでのみ進行方向を変えられる。
 * ========================================================================= */
window.LB = window.LB || {};
(function (LB) {
  'use strict';

  // ---- 方向 -------------------------------------------------------------
  var DIRS = {
    UP:    { name: 'UP',    dr: -1, dc:  0 },
    DOWN:  { name: 'DOWN',  dr:  1, dc:  0 },
    LEFT:  { name: 'LEFT',  dr:  0, dc: -1 },
    RIGHT: { name: 'RIGHT', dr:  0, dc:  1 }
  };
  var DIR_LIST = [DIRS.UP, DIRS.RIGHT, DIRS.DOWN, DIRS.LEFT];

  // ---- 描画用の寸法 -----------------------------------------------------
  var STEP  = 70; // 交点間の距離(px)
  var EXT   = 25; // 弧に繋がる線の盤外への延長量(px)
  var BULGE = 22; // 弧が盤の隅の外側をどれだけ回り込むか(px / 同じ隅で1段ごと)

  function portKey(port) { return port.type + port.line + port.side; }

  /** 通し番号（左上から 1〜N²）を交点座標に変換する */
  function numberToPoint(n, N) {
    return { r: Math.floor((n - 1) / N), c: (n - 1) % N };
  }

  /**
   * 通し番号で示した盤端の交点を、そこから盤外へ出る線の端（ポート）に変換する。
   * 最外周の線（行0・行N-1・列0・列N-1）には弧を繋げないので、その場合は null。
   */
  function numberToPort(n, N) {
    var p = numberToPoint(n, N);
    var innerRow = p.r > 0 && p.r < N - 1;
    var innerCol = p.c > 0 && p.c < N - 1;
    if (p.c === 0)     return innerRow ? { type: 'r', line: p.r, side: 'L' } : null;
    if (p.c === N - 1) return innerRow ? { type: 'r', line: p.r, side: 'R' } : null;
    if (p.r === 0)     return innerCol ? { type: 'c', line: p.c, side: 'T' } : null;
    if (p.r === N - 1) return innerCol ? { type: 'c', line: p.c, side: 'B' } : null;
    return null; // 盤端の交点ではない
  }

  /**
   * size × size の盤面を生成する。
   * arcSpec はループ弧の一覧で、盤面に表示される通し番号のペアで指定する。
   *   例) [[13, 33], [4, 24]]
   * 各ペアは「行の端」と「列の端」を1本ずつ繋ぐ。同じ端に2本は繋げない。
   */
  function createBoard(size, arcSpec) {
    var N = size;
    var spec = arcSpec || [];
    var arcs = [];
    var arcByPort = {};

    function addArc(pa, pb) {
      var rowPort = pa.type === 'r' ? pa : pb;
      var colPort = pa.type === 'c' ? pa : pb;
      if (rowPort.type !== 'r' || colPort.type !== 'c') return; // 行の端と列の端の組でなければ無視
      if (arcByPort[portKey(rowPort)] || arcByPort[portKey(colPort)]) return; // 既に使われている端
      var arc = { id: arcs.length, a: rowPort, b: colPort, rank: 1, span: 0, corner: '' };
      arcs.push(arc);
      arcByPort[portKey(rowPort)] = arc;
      arcByPort[portKey(colPort)] = arc;
    }

    spec.forEach(function (pair) {
      var pa = numberToPort(pair[0], N);
      var pb = numberToPort(pair[1], N);
      if (pa && pb) addArc(pa, pb);
    });

    // 弧が回り込む隅と、その隅から見た弧の大きさを求める
    arcs.forEach(function (arc) {
      arc.corner = (arc.b.side === 'T' ? 'T' : 'B') + (arc.a.side === 'L' ? 'L' : 'R');
      var cornerRow = arc.b.side === 'T' ? 0 : N - 1;
      var cornerCol = arc.a.side === 'L' ? 0 : N - 1;
      arc.span = Math.max(Math.abs(arc.a.line - cornerRow), Math.abs(arc.b.line - cornerCol)) * STEP;
    });

    // 同じ隅にある弧は、小さいものから順に内側とする（描画の重なりと色分けに使う）
    var byCorner = {};
    arcs.forEach(function (a) { (byCorner[a.corner] = byCorner[a.corner] || []).push(a); });
    Object.keys(byCorner).forEach(function (key) {
      byCorner[key].sort(function (x, y) { return x.span - y.span; })
                   .forEach(function (a, i) { a.rank = i + 1; });
    });

    function inBounds(r, c) {
      return r >= 0 && r < N && c >= 0 && c < N;
    }

    /**
     * (r,c) から dir 方向へ盤外に出るときに通過するポート（線の端）を返す。
     */
    function exitPort(r, c, dir) {
      if (dir.dc === -1) return { type: 'r', line: r, side: 'L' };
      if (dir.dc ===  1) return { type: 'r', line: r, side: 'R' };
      if (dir.dr === -1) return { type: 'c', line: c, side: 'T' };
      return { type: 'c', line: c, side: 'B' };
    }

    /**
     * ポートに接続された弧を返す（無ければ null = 行き止まり）。
     */
    function arcAtPort(port) {
      return arcByPort[portKey(port)] || null;
    }

    /**
     * 弧のもう一方のポートを返す。
     */
    function otherPort(arc, port) {
      var k = portKey(port);
      return portKey(arc.a) === k ? arc.b : arc.a;
    }

    /**
     * 経路上を1ステップ進む。
     * 盤内なら直進、盤端で弧があれば弧を通って新しい線へ進入する。
     * @return {{r,c,dir,arcId}} | null（行き止まり）
     */
    function step(r, c, dir) {
      var nr = r + dir.dr;
      var nc = c + dir.dc;
      if (inBounds(nr, nc)) {
        return { r: nr, c: nc, dir: dir, arcId: null };
      }
      var port = exitPort(r, c, dir);
      var arc = arcAtPort(port);
      if (!arc) return null; // 弧が無い＝盤外で行き止まり

      var dest = otherPort(arc, port);
      if (dest.type === 'r') {
        // 行へ進入：左端からなら右向き、右端からなら左向き
        return dest.side === 'L'
          ? { r: dest.line, c: 0,     dir: DIRS.RIGHT, arcId: arc.id }
          : { r: dest.line, c: N - 1, dir: DIRS.LEFT,  arcId: arc.id };
      }
      // 列へ進入：上端からなら下向き、下端からなら上向き
      return dest.side === 'T'
        ? { r: 0,     c: dest.line, dir: DIRS.DOWN, arcId: arc.id }
        : { r: N - 1, c: dest.line, dir: DIRS.UP,   arcId: arc.id };
    }

    /**
     * 通常経路（縦横のグリッド線）で隣接する交点。ループ弧は含まない。
     */
    function orthogonalNeighbors(r, c) {
      var out = [];
      for (var i = 0; i < DIR_LIST.length; i++) {
        var d = DIR_LIST[i];
        var nr = r + d.dr, nc = c + d.dc;
        if (inBounds(nr, nc)) out.push({ r: nr, c: nc, dir: d });
      }
      return out;
    }

    /**
     * ループ入口：そこから1歩進むとループ弧へ入る交点の一覧。
     * Ver.0.2 のループ突撃はこの地点から開始する必要がある。
     * @return [{r, c, dir, rank}]
     */
    function entryPoints() {
      var out = [];
      arcs.forEach(function (arc) {
        [arc.a, arc.b].forEach(function (port) {
          if (port.type === 'r') {
            out.push(port.side === 'L'
              ? { r: port.line, c: 0,     dir: DIRS.LEFT,  rank: arc.rank }
              : { r: port.line, c: N - 1, dir: DIRS.RIGHT, rank: arc.rank });
          } else {
            out.push(port.side === 'T'
              ? { r: 0,     c: port.line, dir: DIRS.UP,   rank: arc.rank }
              : { r: N - 1, c: port.line, dir: DIRS.DOWN, rank: arc.rank });
          }
        });
      });
      return out;
    }

    // ---- 以下、描画用のジオメトリ ---------------------------------------

    var END = (N - 1) * STEP;

    function pointXY(r, c) {
      return { x: c * STEP, y: r * STEP };
    }

    function portXY(port) {
      if (port.type === 'r') {
        return { x: port.side === 'L' ? -EXT : END + EXT, y: port.line * STEP };
      }
      return { x: port.line * STEP, y: port.side === 'T' ? -EXT : END + EXT };
    }

    // ポートから盤外へ向かう向き（線の延長方向）
    function outward(port) {
      if (port.type === 'r') return port.side === 'L' ? { x: -1, y: 0 } : { x: 1, y: 0 };
      return port.side === 'T' ? { x: 0, y: -1 } : { x: 0, y: 1 };
    }

    /**
     * 弧の制御点。線の延長方向へ滑らかに繋がり、盤の隅の「外側」を回り込む
     * 3次ベジェ曲線として描く。
     */
    function arcControlLength(arc) {
      // 隅からの大きさ(span)ぶん外へ回り込ませ、同じ隅の弧どうしが交差しないよう
      // 内側から順(rank)に外側へずらす
      return (4 * arc.span + 8 * BULGE * arc.rank - 4 * EXT) / 3;
    }

    function arcPoints(arc) {
      var p1 = portXY(arc.a);
      var p2 = portXY(arc.b);
      var o1 = outward(arc.a);
      var o2 = outward(arc.b);
      var k = arcControlLength(arc);
      return {
        p1: p1, p2: p2,
        c1: { x: p1.x + o1.x * k, y: p1.y + o1.y * k },
        c2: { x: p2.x + o2.x * k, y: p2.y + o2.y * k }
      };
    }

    function arcPathD(arc) {
      var a = arcPoints(arc);
      return 'M ' + a.p1.x + ' ' + a.p1.y +
             ' C ' + a.c1.x + ' ' + a.c1.y +
             ' '   + a.c2.x + ' ' + a.c2.y +
             ' '   + a.p2.x + ' ' + a.p2.y;
    }

    /**
     * 弧の中央の座標と、そこを通るときの進行方向（度）を返す。
     * 「ループをどちら回りに進むか」を示す▲の配置に使う。
     * @param forward true なら a→b の向き、false なら b→a の向き
     */
    function arcMarker(arc, forward) {
      var a = arcPoints(arc);
      var t = 0.5, u = 1 - t;
      var x = u * u * u * a.p1.x + 3 * u * u * t * a.c1.x + 3 * u * t * t * a.c2.x + t * t * t * a.p2.x;
      var y = u * u * u * a.p1.y + 3 * u * u * t * a.c1.y + 3 * u * t * t * a.c2.y + t * t * t * a.p2.y;
      // ベジェ曲線の接線から向きを求める
      var dx = 3 * u * u * (a.c1.x - a.p1.x) + 6 * u * t * (a.c2.x - a.c1.x) + 3 * t * t * (a.p2.x - a.c2.x);
      var dy = 3 * u * u * (a.c1.y - a.p1.y) + 6 * u * t * (a.c2.y - a.c1.y) + 3 * t * t * (a.p2.y - a.c2.y);
      var angle = Math.atan2(dy, dx) * 180 / Math.PI;
      if (!forward) angle += 180;
      return { x: x, y: y, angle: angle };
    }

    /** 2つのポート（線の端）が同じかどうか */
    function samePort(p, q) {
      return !!p && !!q && p.type === q.type && p.line === q.line && p.side === q.side;
    }

    /** 全ての弧を含む描画範囲を求める（ベジェ曲線をサンプリング） */
    function contentBounds() {
      var min = { x: 0, y: 0 }, max = { x: END, y: END };
      arcs.forEach(function (arc) {
        var a = arcPoints(arc);
        for (var t = 0; t <= 1.0001; t += 0.05) {
          var u = 1 - t;
          var x = u * u * u * a.p1.x + 3 * u * u * t * a.c1.x + 3 * u * t * t * a.c2.x + t * t * t * a.p2.x;
          var y = u * u * u * a.p1.y + 3 * u * u * t * a.c1.y + 3 * u * t * t * a.c2.y + t * t * t * a.p2.y;
          min.x = Math.min(min.x, x); min.y = Math.min(min.y, y);
          max.x = Math.max(max.x, x); max.y = Math.max(max.y, y);
        }
      });
      return { min: min, max: max };
    }

    /**
     * 各線の描画範囲。弧を持つ線だけ盤外へ延長する。
     */
    function gridLines() {
      var lines = [];
      for (var i = 0; i < N; i++) {
        var rowHasArc = !!arcAtPort({ type: 'r', line: i, side: 'L' });
        var colHasArc = !!arcAtPort({ type: 'c', line: i, side: 'T' });
        lines.push({
          kind: 'row', index: i,
          x1: rowHasArc ? -EXT : 0, y1: i * STEP,
          x2: rowHasArc ? END + EXT : END, y2: i * STEP
        });
        lines.push({
          kind: 'col', index: i,
          x1: i * STEP, y1: colHasArc ? -EXT : 0,
          x2: i * STEP, y2: colHasArc ? END + EXT : END
        });
      }
      return lines;
    }

    return {
      size: N,
      DIRS: DIRS,
      DIR_LIST: DIR_LIST,
      STEP: STEP,
      EXT: EXT,
      END: END,
      arcs: arcs,
      arcSpec: spec,
      entryPoints: entryPoints,
      inBounds: inBounds,
      step: step,
      exitPort: exitPort,
      arcAtPort: arcAtPort,
      otherPort: otherPort,
      orthogonalNeighbors: orthogonalNeighbors,
      pointXY: pointXY,
      portXY: portXY,
      arcPathD: arcPathD,
      arcMarker: arcMarker,
      samePort: samePort,
      gridLines: gridLines,
      arcPoints: arcPoints,
      viewBox: function () {
        var b = contentBounds();
        var m = 16; // 線幅ぶんの余白
        return (b.min.x - m) + ' ' + (b.min.y - m) + ' ' +
               (b.max.x - b.min.x + m * 2) + ' ' + (b.max.y - b.min.y + m * 2);
      }
    };
  }

  LB.DIRS = DIRS;
  LB.DIR_LIST = DIR_LIST;
  LB.createBoard = createBoard;

})(window.LB);
