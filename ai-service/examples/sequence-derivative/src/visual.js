/* 二维讲解图：等差点图、系数与导数对应、错位相减两行错位与逐项抵消。
   浅色纸面、深色正文，低饱和蓝/琥珀/绿/紫标记数学含义。所有坐标来自 lesson.json 的 model。 */
(() => {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const BLUE = '#2F6690', YELLOW = '#A66B12', GREEN = '#4F7A55', PURPLE = '#785A96', GRAY = '#7A776D';
  const COLOR_MAP = {'#58c4dd': BLUE, '#ffff00': YELLOW, '#83c167': GREEN, '#c77dff': PURPLE, '#9a9a9a': GRAY};

  const STAGES = {
    setup: ['pt:given', 'pt:an', 'pt:an1', 'pt:one', 'ln:arrow', 'pt:goal1', 'pt:goal2'],
    transform: ['pt:l_an1', 'pt:l_an', 'pt:l_one', 'pt:r_an1', 'pt:r_an', 'pt:r_one', 'ln:x1', 'ln:x2', 'ln:x3'],
    newseq: ['pt:nbdef', 'pt:b1', 'pt:b2', 'pt:b3', 'pt:bn', 'pt:anf', 'pt:bsch_cur', 'pt:bsch_next',
             'ln:bstep', 'ln:bstair', 'ln:bstair2'],
    plots: ['ln:bx', 'ln:by', 'pt:pb1', 'pt:pb2', 'pt:pb3', 'pt:pb4', 'pt:pb5', 'ln:fitb',
            'ln:ax', 'ln:ay', 'pt:pa1', 'pt:pa2', 'pt:pa3', 'pt:pa4', 'pt:pa5', 'ln:lim'],
    deriv: ['pt:src1', 'pt:src2', 'pt:src3', 'pt:srcg', 'pt:dst1', 'pt:dst2', 'pt:dst3', 'pt:dstg',
            'ln:m1', 'ln:m2', 'ln:m3', 'ln:m4', 'pt:neg2'],
    split: ['cell:s1', 'cell:s2', 'cell:s3', 'cell:s4', 'cell:s5',
            'cell:t1', 'cell:t2', 'cell:t3', 'cell:t4', 'cell:t5',
            'cell:u1', 'cell:u2', 'cell:u3', 'cell:u4', 'cell:u5',
            'ln:row1', 'ln:row2', 'ln:row3'],
    subtract: ['cell:v11', 'cell:v12', 'cell:v13', 'cell:v14', 'cell:v15', 'cell:v16',
               'cell:v22', 'cell:v23', 'cell:v24', 'cell:v25', 'cell:v26', 'cell:v27',
               'cell:v31', 'cell:v32', 'cell:v33', 'cell:v34', 'cell:v35', 'cell:v36', 'cell:v37',
               'ln:v1', 'ln:v2', 'ln:v3', 'arrow:shift', 'pt:rdef', 'pt:sform'],
    combine: ['pt:geom', 'pt:tclosed', 'pt:comb', 'pt:fin', 'ln:gt', 'ln:ct', 'ln:cf'],
    check: ['chk1', 'chk2', 'chk3', 'pt:ans']
  };

  // 标签摆放：up = 点的上方，left = 线的左端，mid = 线的中点上方，above = 线的 28% 处上方，end = 轴末端
  const PLACE = {
    'pt:an': 'up', 'pt:an1': 'up',
    'pt:l_an1': 'up', 'pt:l_an': 'up', 'pt:l_one': 'up',
    'pt:r_an1': 'up', 'pt:r_an': 'up', 'pt:r_one': 'up',
    'pt:b1': 'up', 'pt:b2': 'up', 'pt:b3': 'up',
    'pt:bsch_cur': 'up', 'pt:bsch_next': 'up',
    'pt:pb1': 'up', 'pt:pb2': 'up', 'pt:pb3': 'up', 'pt:pb4': 'up', 'pt:pb5': 'up',
    'pt:pa1': 'up', 'pt:pa2': 'up', 'pt:pa3': 'up', 'pt:pa4': 'up', 'pt:pa5': 'up',
    'pt:src1': 'up', 'pt:src2': 'up', 'pt:src3': 'up', 'pt:srcg': 'up',
    'pt:dst1': 'up', 'pt:dst2': 'up', 'pt:dst3': 'up', 'pt:dstg': 'up',
    'pt:geom': 'up', 'pt:tclosed': 'up',
    'chk1': 'up', 'chk2': 'up', 'chk3': 'up',
    'ln:arrow': 'mid', 'ln:x1': 'mid', 'ln:x2': 'mid', 'ln:x3': 'mid',
    'ln:m1': 'mid', 'ln:m2': 'mid', 'ln:m3': 'mid', 'ln:m4': 'mid',
    'arrow:shift': 'mid', 'ln:gt': 'mid', 'ln:ct': 'mid', 'ln:cf': 'mid',
    'ln:bstair': 'mid', 'ln:bstair2': 'mid', 'ln:bstep': 'below', 'ln:fitb': 'far-above',
    'ln:row1': 'left', 'ln:row2': 'left', 'ln:row3': 'left',
    'ln:v1': 'left', 'ln:v2': 'left', 'ln:v3': 'left', 'ln:lim': 'left',
    'ln:bx': 'end', 'ln:by': 'end', 'ln:ax': 'end', 'ln:ay': 'end'
  };

  // 未被 cue 直接点名、但要按讲解顺序出现的实体（首次出现的 beat）
  const FIRST_BEAT = {
    'pt:an': 1, 'pt:an1': 1, 'pt:one': 1, 'ln:arrow': 1, 'pt:goal1': 2, 'pt:goal2': 2,
    'pt:l_an1': 1, 'pt:r_an1': 1, 'pt:l_an': 2, 'pt:r_an': 2, 'pt:l_one': 2, 'pt:r_one': 2,
    'pt:b2': 1, 'pt:b3': 1, 'pt:b1': 3, 'pt:bn': 4, 'pt:anf': 4,
    'pt:bsch_cur': 1, 'pt:bsch_next': 1, 'ln:bstep': 1, 'ln:bstair2': 2,
    'pt:pb2': 1, 'pt:pb3': 1, 'pt:pb4': 1,
    'pt:pa1': 2, 'pt:pa2': 2, 'pt:pa3': 2, 'pt:pa4': 2, 'pt:pa5': 2,
    'pt:dst1': 2, 'pt:dst2': 2, 'pt:dst3': 2, 'pt:dstg': 1,
    'cell:s1': 3, 'cell:s2': 3, 'cell:s3': 3, 'cell:s4': 3, 'cell:s5': 3, 'cell:sm': 3,
    'cell:t1': 4, 'cell:t2': 4, 'cell:t3': 4, 'cell:t4': 4, 'cell:t5': 4, 'cell:tm': 4,
    'cell:u1': 5, 'cell:u2': 5, 'cell:u3': 5, 'cell:u4': 5, 'cell:u5': 5, 'cell:um': 5,
    'cell:v11': 0, 'cell:v12': 0, 'cell:v13': 0, 'cell:v14': 0, 'cell:v15': 0, 'cell:v16': 0,
    'cell:v22': 1, 'cell:v23': 1, 'cell:v24': 1, 'cell:v25': 1, 'cell:v26': 1, 'cell:v27': 1,
    'cell:v31': 2, 'cell:v32': 2, 'cell:v33': 2, 'cell:v34': 2, 'cell:v35': 2, 'cell:v36': 2, 'cell:v37': 2,
    'ln:row1': 3, 'ln:row2': 4, 'ln:row3': 5,
    'ln:v2': 1, 'arrow:shift': 1, 'ln:v3': 2, 'pt:sform': 4,
    'pt:geom': 0, 'ln:ct': 1, 'ln:cf': 2, 'pt:comb': 1, 'pt:fin': 2,
    'chk2': 1, 'chk3': 2, 'pt:ans': 3
  };

  // 错位相减：每列 = 上行一项 + 下行一项 → 差（结果行）
  const SUB_COLS = [
    { x: 110, top: 'cell:v11', bot: null, res: 'cell:v31' },
    { x: 220, top: 'cell:v12', bot: 'cell:v22', res: 'cell:v32' },
    { x: 330, top: 'cell:v13', bot: 'cell:v23', res: 'cell:v33' },
    { x: 440, top: 'cell:v14', bot: 'cell:v24', res: 'cell:v34' },
    { x: 550, top: 'cell:v15', bot: 'cell:v25', res: 'cell:v35' },
    { x: 660, top: 'cell:v16', bot: 'cell:v26', res: 'cell:v36' },
    { x: 790, top: null, bot: 'cell:v27', res: 'cell:v37' }
  ];
  const CELL_W = 110;

  const HIDE_LABEL = new Set(['ln:bstep', 'ln:bstair2', 'ln:fitb']);
  const fontOf = t => (t.length > 20 ? 20 : t.length > 12 ? 23 : 27);
  const textStyle = (color, size) => `fill:${color};font-size:${size}px;font-weight:700;`;

  function lineLabelPos(id, p, q) {
    const place = PLACE[id];
    const dx = q[0] - p[0], dy = q[1] - p[1];
    if (place === 'left') return { x: p[0] - 18, y: p[1] - 14, anchor: 'end' };
    if (place === 'end') {
      if (Math.abs(dx) >= Math.abs(dy)) return { x: q[0] + 20, y: q[1] + 9, anchor: 'start' };
      return { x: q[0] - 18, y: q[1] - 36, anchor: 'end' };
    }
    if (place === 'above') return { x: p[0] + 0.3 * dx, y: p[1] + 0.3 * dy - 26, anchor: 'middle' };
    if (place === 'far-above') return { x: p[0] + 0.3 * dx, y: p[1] + 0.3 * dy - 52, anchor: 'middle' };
    if (place === 'below') return { x: p[0] + 0.5 * dx, y: p[1] + 0.5 * dy + 22, anchor: 'middle' };
    return { x: p[0] + 0.5 * dx, y: p[1] + 0.5 * dy - 26, anchor: 'middle' };
  }

  function drawEntity(id, e, pts, active, hasFocus, opt) {
    opt = opt || {};
    const v = (e.vertices || []).map(k => pts[k]).filter(Boolean);
    if (!v.length) return '';
    const on = active.has(id);
    const dx = opt.dx || 0, dy = opt.dy || 0;
    const vv = v.map(p => [p[0] + dx, p[1] + dy]);
    let op = hasFocus ? (on ? 1 : 0.55) : 1;
    if (opt.fade != null) op = Math.min(op, opt.fade);
    if (on) op = 1;
    const common = `data-object="${esc(id)}" data-focus="${on ? '1' : '0'}" opacity="${op}"`;
    const fs = fontOf(e.label);
    const place = PLACE[id];

    if (id.indexOf('cell:') === 0) {
      const [x, y] = vv[0];
      const r = on ? 10 : 7;
      const strike = opt.strike
        ? `<line x1="${x - 13}" y1="${y - 13}" x2="${x + 13}" y2="${y + 13}" stroke="#20201C" stroke-width="2.5" stroke-opacity="0.9"/>`
        : '';
      return `<g ${common}>` +
        `<circle cx="${x}" cy="${y}" r="${r}" fill="${e.color}" fill-opacity="1" stroke="${e.color}" stroke-width="${on ? 3 : 1.5}"/>` +
        strike +
        `<text x="${x}" y="${y - 18}" text-anchor="middle" style="${textStyle(e.color, fs)}">${esc(e.label)}</text></g>`;
    }

    if (vv.length === 1) {
      const [x, y] = vv[0];
      let tx, anchor, ty = y + 9;
      if (place === 'up') { tx = x; anchor = 'middle'; ty = y - (id.indexOf('pt:bsch') === 0 ? 38 : 30); }
      else if (x > 690) { tx = x - 20; anchor = 'end'; }
      else { tx = x + 20; anchor = 'start'; }
      const r = on ? 11 : 8;
      return `<g ${common}>` +
        `<circle cx="${x}" cy="${y}" r="${r}" fill="${e.color}" fill-opacity="${on ? 0.95 : 0.7}" stroke="${e.color}" stroke-width="${on ? 3 : 1.5}"/>` +
        (on ? `<circle cx="${x}" cy="${y}" r="${r + 9}" fill="none" stroke="${e.color}" stroke-width="1.5" stroke-opacity="0.55"/>` : '') +
        `<text x="${tx}" y="${ty}" text-anchor="${anchor}" style="${textStyle(e.color, fs)}">${esc(e.label)}</text></g>`;
    }

    const [p, q] = vv;
    const lp = lineLabelPos(id, p, q);
    const arrow = id.indexOf('arrow:') === 0
      ? `<polygon points="${q[0]},${q[1]} ${q[0] - 13},${q[1] - 6} ${q[0] - 13},${q[1] + 6}" fill="${e.color}"/>` : '';
    return `<g ${common}>` +
      `<line x1="${p[0]}" y1="${p[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${e.color}" stroke-width="${on ? 5 : 2.5}" stroke-linecap="round" stroke-opacity="${on ? 1 : 0.85}"/>` +
      arrow +
      `${HIDE_LABEL.has(id) ? '' : `<text x="${lp.x}" y="${lp.y}" text-anchor="${lp.anchor}" style="${textStyle(e.color, Math.min(fs, 23))}">${esc(e.label)}</text>`}</g>`;
  }

  function decor(stage) {
    const gray = textStyle('#8B877C', 22);
    const t = (x, y, s) => `<text x="${x}" y="${y}" style="${gray}">${esc(s)}</text>`;
    if (stage === 'setup') return t(140, 96, '题设：递推关系') + t(170, 500, '原数列 {aₙ} 的项');
    if (stage === 'transform') return t(170, 70, '原式') + t(700, 70, '两边同乘 n(n+1)');
    if (stage === 'newseq') return t(200, 96, '把 n 与 aₙ 绑在一起');
    if (stage === 'plots') {
      let s = t(90, 120, 'bₙ = n + 2') + t(510, 120, 'aₙ = 1 + 2/n');
      [110, 180, 250, 320, 390].concat([530, 600, 670, 740, 810]).forEach((x, i) => {
        s += t(x, 588, String((i % 5) + 1));
      });
      // 纵轴刻度：两幅图同一比例，每单位 50 像素，零点在 y = 560
      const tick = (x, y, v) => `<text x="${x}" y="${y}" text-anchor="end" style="${gray}">${esc(v)}</text>`;
      for (let v = 0; v <= 7; v++) s += tick(68, 560 - 50 * v + 8, String(v));
      for (let v = 0; v <= 3; v++) s += tick(488, 560 - 50 * v + 8, String(v));
      return s;
    }
    if (stage === 'deriv') return t(150, 76, 'f(x) 的项') + t(560, 76, 'f′(x) 的项');
    if (stage === 'split') return t(150, 120, '示例 m = 5：两行相加得到 f′(−2) 的各项');
    if (stage === 'subtract') return t(140, 122, 'r = −2：第二行整体右移一格，再逐列相减，(1 − r)S = 3S');
    if (stage === 'combine') return t(180, 120, '等比和 → T → 合并');
    if (stage === 'check') return t(200, 100, '直接代入检验');
    return '';
  }

  // 某个 beat 的起始时间：优先用服务给出的 firstTimes，其次用当前拍已播放时长，最后按等分估计
  function beatStart(beat, context, time, nBeats, duration) {
    const start = context && context.beatStarts && context.beatStarts[beat];
    if (Number.isFinite(start)) return start;
    // Standalone previews may omit timing; production always supplies exact beatStarts.
    return Number.isFinite(duration) && nBeats > 0 ? duration * beat / nBeats : 0;
  }

  // 在目标拍内从 0 到 1 的确定性进度
  function phaseProgress(phase, target, context, time, duration, nBeats, span) {
    if (phase > target) return 1;
    if (phase < target) return 0;
    const t0 = beatStart(target, context, time, nBeats, duration);
    const t = Number.isFinite(time) ? time : t0;
    const p = (t - t0) / span;
    if (!Number.isFinite(p)) return 1;
    return Math.max(0, Math.min(1, p));
  }

  const ease = t => t * t * (3 - 2 * t);

  window.ReasonFrameVisual = {
    render({ scene, time, duration, phase, context }) {
      const data = window.LESSON_DATA || {};
      const model = data.model || {};
      const entities = Object.fromEntries(Object.entries(data.entities || {}).map(([k, e]) => [k, { ...e, color: COLOR_MAP[e.color] || e.color }]));
      const stage = scene && scene.stage;
      const ids = STAGES[stage];
      if (!ids) return '';
      const pts = {};
      Object.keys(model).forEach(k => {
        const v = model[k];
        if (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)) pts[k] = [v[0], v[1]];
      });
      const focus = new Set((context && context.active) || []);
      const hasFocus = focus.size > 0;
      const ph = Number.isFinite(phase)
        ? phase
        : (context && Number.isFinite(context.phase) ? context.phase : 0);
      const nBeats = (scene.beats || []).length || 1;

      // 每个实体的出现拍：cue 中第一次点名的拍，或 FIRST_BEAT 中的约定
      const reveal = {};
      ids.forEach(id => {
        let b = FIRST_BEAT[id];
        (scene.cues || []).forEach(c => {
          if ((c.objects || []).indexOf(id) >= 0) b = (b == null) ? c.beat : Math.min(b, c.beat);
        });
        reveal[id] = (b == null || !Number.isFinite(b)) ? 0 : b;
      });

      const opts = {};
      ids.forEach(id => {
        if (ph < reveal[id]) opts[id] = Object.assign({}, opts[id], { fade: 0.2 });
      });

      let extra = '';

      if (stage === 'subtract') {
        // 第二行整体右移一格，再逐列相减：全部由 time 决定，任意 seek 结果一致
        const pShift = phaseProgress(ph, 1, context, time, duration, nBeats, 1.6);
        const pCol = phaseProgress(ph, 2, context, time, duration, nBeats, 3.6);
        const dx = -CELL_W * (1 - ease(pShift));
        const done = Math.min(SUB_COLS.length - 1, Math.floor(pCol * SUB_COLS.length));
        SUB_COLS.forEach((c, i) => {
          const finished = ph >= 2 && i < done;
          if (c.top) {
            opts[c.top] = Object.assign(opts[c.top] || {}, finished ? { strike: true, fade: 0.45 } : {});
          }
          if (c.bot) {
            opts[c.bot] = Object.assign(opts[c.bot] || {}, { dx: dx }, finished ? { strike: true, fade: 0.45 } : {});
          }
          if (c.res && ph >= 2) {
            opts[c.res] = Object.assign(opts[c.res] || {}, { fade: i <= done ? 1 : 0.25 });
          }
        });
        opts['ln:v2'] = Object.assign(opts['ln:v2'] || {}, { dx: dx });
        if (ph === 1) {
          // 第二行移动时，用一条紫色竖线标出它当前的左端位置
          const lx = 220 + dx;
          extra = `<line x1="${lx}" y1="176" x2="${lx}" y2="392" stroke="${PURPLE}" stroke-width="2" stroke-dasharray="7 6" stroke-opacity="0.85"/>`;
        } else if (ph === 2) {
          const c = SUB_COLS[done];
          extra = `<rect x="${c.x - 46}" y="168" width="92" height="330" rx="8" fill="${GREEN}" fill-opacity="0.10" stroke="${GREEN}" stroke-opacity="0.30" stroke-width="1.5"/>`;
        } else if (ph === 3) {
          // 中间一段 r + r² + … + r^(m−1) 整体标出
          extra = `<rect x="174" y="168" width="532" height="330" rx="8" fill="${GREEN}" fill-opacity="0.10" stroke="${GREEN}" stroke-opacity="0.30" stroke-width="1.5"/>`;
        }
      }

      const rank = s => (s.indexOf('ln:') === 0 || s.indexOf('arrow:') === 0) ? 0 : (s.indexOf('cell:') === 0 ? 1 : 2);
      const ordered = ids.slice().sort((a, b) => rank(a) - rank(b));
      const body = ordered.map(id => {
        const e = entities[id];
        return e ? drawEntity(id, e, pts, focus, hasFocus, opts[id]) : '';
      }).join('');
      return `<g data-stage="${esc(stage)}">${decor(stage)}${extra}${body}</g>`;
    }
  };
})();
