/* Deterministic 3D starter. Use one shared coordinate model; edit camera/auxiliary constructions as needed. */
(() => {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const BLUE = '#2F6690', AMBER = '#A66B12', GREEN = '#4F7A55', PURPLE = '#785A96', GRAY = '#7A776D';
  const COLOR_MAP = {'#58c4dd': BLUE, '#ffff00': AMBER, '#83c167': GREEN, '#c77dff': PURPLE, '#9a9a9a': GRAY};
  window.ReasonFrameVisual = {
    render({context}) {
      const {model, entities: sourceEntities} = window.LESSON_DATA;
      const entities = Object.fromEntries(Object.entries(sourceEntities || {}).map(([k, e]) => [k, { ...e, color: COLOR_MAP[e.color] || e.color }]));
      const points = Object.fromEntries(Object.entries(model).filter(([,v]) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)));
      if (!Object.keys(points).length) return '';
      const flat = false;
      const raw = p => flat ? [p[0], -p[1]] : [.866*p[0]-.5*p[1], .235*p[0]+.407*p[1]-.883*p[2]];
      const coords = Object.fromEntries(Object.entries(points).map(([k,p]) => [k,raw(p)]));
      const xs = Object.values(coords).map(p=>p[0]), ys = Object.values(coords).map(p=>p[1]);
      const xmin=Math.min(...xs), xmax=Math.max(...xs), ymin=Math.min(...ys), ymax=Math.max(...ys);
      const scale=Math.min(700/Math.max(.5,xmax-xmin),440/Math.max(.5,ymax-ymin));
      const project=k=>[450+(coords[k][0]-(xmin+xmax)/2)*scale,315+(coords[k][1]-(ymin+ymax)/2)*scale];
      const focus=new Set(context.active), hasFocus=focus.size>0;
      return Object.entries(entities).sort((a,b)=>(b[1].vertices?.length||0)-(a[1].vertices?.length||0)).map(([key,e])=>{
        if (!e.vertices?.length || !e.vertices.every(k=>coords[k])) return '';
        const p=e.vertices.map(project), active=focus.has(key), opacity=active||!hasFocus?1:.25;
        const shape=p.length>=3?`<polygon points="${p.map(p=>p.join(',')).join(' ')}" fill="${e.color}" fill-opacity="${active ? .22 : .06}" stroke="${e.color}" stroke-width="${active?4:2}"/>`:p.length===2?`<path d="M${p[0].join(',')} L${p[1].join(',')}" fill="none" stroke="${e.color}" stroke-width="${active?6:3}"/>`:`<circle cx="${p[0][0]}" cy="${p[0][1]}" r="${active?8:5}" fill="${e.color}"/><text x="${p[0][0]+20}" y="${p[0][1]-18}" fill="${e.color}">${esc(e.label)}</text>`;
        return `<g data-object="${esc(key)}" data-focus="${active?'1':'0'}" opacity="${opacity}">${shape}</g>`;
      }).join('');
    }
  };
})();
