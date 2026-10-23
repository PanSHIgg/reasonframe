/* Real 3D coordinates, deterministic orthographic projection, word-timed emphasis. */
(() => {
  const {model:M,entities:E}=window.LESSON_DATA;
  const C={ink:'#ffffff',muted:'#a3a3a3',mint:'#83c167',gold:'#ffff00',blue:'#58c4dd',purple:'#c77dff'};
  const add=(a,b)=>a.map((x,i)=>x+b[i]),sub=(a,b)=>a.map((x,i)=>x-b[i]);
  const mul=(a,s)=>a.map(x=>x*s),dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  const norm=a=>Math.sqrt(dot(a,a)),lerp=(a,b,t)=>a.map((x,i)=>x+(b[i]-x)*t);
  const clamp=x=>Math.max(0,Math.min(1,x)),smooth=x=>{x=clamp(x);return x*x*(3-2*x);};
  const round=x=>Number(x.toFixed(3));
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function camera(stage,t,duration,context={}){
    let az=30,el=28,scale=202,target=[1.25,.53,.69];
    if(stage==='overview')az=30+6*Math.sin(Math.PI*clamp(t/duration));
    if(stage==='sphere'||stage==='recap'){scale=143;target=[1,0,0];az=32;el=25;}
    if(stage==='coordinates'||stage==='vectors'){scale=182;target=[1.18,.50,.65];}
    if(stage==='angle'){
      const start=context.firstTimes?.['line:translatedPO']??.5;
      const u=smooth((t-start)/2.2);
      // Face the plane spanned by AC and PO: only this final view preserves the angle.
      az=30+(-35.26438968-30)*u;el=28+(-22.20765430-28)*u;
      scale=168;target=[1,.45,.10];
    }
    const a=az*Math.PI/180,e=el*Math.PI/180;
    const h=[Math.cos(a),-Math.sin(a),0],v=[Math.sin(e)*Math.sin(a),Math.sin(e)*Math.cos(a),-Math.cos(e)];
    const centerY=['coordinates','vectors'].includes(stage)?335:315;
    const project=p=>[450+scale*dot(sub(p,target),h),centerY+scale*dot(sub(p,target),v)];
    return {project,scale};
  }
  function diagram(stage,t,duration,phase,context={}){
    const {project:P,scale}=camera(stage,t,duration,context);
    const focus=new Set(context.active||[]),seen=new Set(context.seen||[]);
    const weight=smooth((context.age??1)/.14),hasFocus=focus.size>0;
    const wrap=(id,s)=>`<g data-object="${id}" data-focus="${focus.has(id)?'1':'0'}">${s}</g>`;
    const line=(a,b,color=C.ink,width=3,dash='',opacity=1)=>{
      const x=P(a),y=P(b);
      return `<path d="M ${round(x[0])} ${round(x[1])} L ${round(y[0])} ${round(y[1])}" fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="round" ${dash?`stroke-dasharray="${dash}"`:''} opacity="${opacity}"/>`;
    };
    const polygon=(points,color,opacity=.12,strokeOpacity=.4,width=1.5)=>`<polygon points="${points.map(p=>P(p).map(round).join(',')).join(' ')}" fill="${color}" fill-opacity="${opacity}" stroke="${color}" stroke-opacity="${strokeOpacity}" stroke-width="${width}" stroke-linejoin="round"/>`;
    const text=(p,s,dx=0,dy=0,color=C.ink,cls='')=>{const q=P(p);return `<text x="${round(q[0]+dx)}" y="${round(q[1]+dy)}" fill="${color}" style="fill:${color}" class="${cls}" text-anchor="middle">${esc(s)}</text>`;};
    const point=(p,color=C.ink,r=5.5)=>{const q=P(p);return `<circle cx="${round(q[0])}" cy="${round(q[1])}" r="${r}" fill="${color}" stroke="#000000" stroke-width="2.5"/>`;};
    const polyline=(points,color,width=2,opacity=.3,dash='')=>`<polyline points="${points.map(p=>P(p).map(round).join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity}" ${dash?`stroke-dasharray="${dash}"`:''}/>`;
    const right=(origin,e1,e2,color=C.gold,size=.15)=>polyline([add(origin,mul(e1,size)),add(add(origin,mul(e1,size)),mul(e2,size)),add(origin,mul(e2,size))],color,2.4,.75);
    const arrow=(a,b,color,width=4,opacity=1)=>{
      const p=P(a),q=P(b),dx=q[0]-p[0],dy=q[1]-p[1],length=Math.hypot(dx,dy),ux=dx/length,uy=dy/length;
      return line(a,b,color,width,'',opacity)+`<path d="M ${round(q[0]-14*ux+6*uy)} ${round(q[1]-14*uy-6*ux)} L ${round(q[0])} ${round(q[1])} L ${round(q[0]-14*ux-6*uy)} ${round(q[1]-14*uy+6*ux)}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity}" stroke-linejoin="round"/>`;
    };
    const mid=(a,b)=>lerp(a,b,.5);
    let s='';
    if(seen.has('sphere')||focus.has('sphere')){
      const center=P(M.O),R=M.radius,on=focus.has('sphere');
      const reveal=smooth((t-(context.firstTimes?.sphere??0))/.6);
      let sphere=`<circle cx="${round(center[0])}" cy="${round(center[1])}" r="${round(R*scale)}" fill="${C.mint}" fill-opacity=".02" stroke="${C.mint}" stroke-opacity="${on?.8:.32}" stroke-width="${on?3:1.8}"/>`;
      for(const z of [-R*.62,0,R*.62]){
        const r=Math.sqrt(R*R-z*z),ring=[];
        for(let i=0;i<=96;i++){const a=i/96*2*Math.PI;ring.push(add(M.O,[r*Math.cos(a),r*Math.sin(a),z]));}
        sphere+=polyline(ring,z===0?C.gold:C.mint,z===0?2.3:1.1,z===0?.5:on?.32:.17,z===0?'8 7':'');
      }
      for(let k=0;k<3;k++){
        const ring=[],phi=k*Math.PI/3;
        for(let i=0;i<=96;i++){const a=i/96*2*Math.PI;ring.push(add(M.O,[R*Math.cos(a)*Math.cos(phi),R*Math.cos(a)*Math.sin(phi),R*Math.sin(a)]));}
        sphere+=polyline(ring,C.mint,1.1,on?.3:.15);
      }
      s+=wrap('sphere',`<g opacity="${reveal}">${sphere}</g>`);
    }
    const faces=new Set(['plane:ABCD',...[...focus].filter(id=>id.startsWith('plane:')||id.startsWith('face:')),...[...seen].filter(id=>id.startsWith('face:'))]);
    for(const id of faces){
      const entity=E[id],on=focus.has(id),color=entity.color,points=entity.vertices.map(k=>M[k]);
      let face=polygon(points,color,on?.035+.18*weight:id==='plane:ABCD'?.018:.035,on?.85:.15,on?2.7:1);
      if(on)face=polygon(points,color,0,.13*weight,10)+face;
      if(on&&id==='plane:PAB')face+=text([.10,.60,.57],'PAB',-70,0,color,'small-label');
      if(on&&id==='plane:PAD')face+=text([1.10,0,.50],'PAD',40,-12,color,'small-label');
      s+=wrap(id,face);
    }
    const lines=new Map();
    const addLine=(key,extra={})=>lines.set(`line:${key}`,{...lines.get(`line:${key}`),...extra});
    for(const key of ['AB','AD','PA','BC','CD','PB','PC','PD'])addLine(key,{base:true,hidden:['AB','AD','PA'].includes(key)});
    if(['equal-pb','equal-c','equal-d'].includes(stage))addLine('AQ');
    if(stage==='equal-d')for(const key of ['QP','QB','QC'])addLine(key);
    if(stage==='sphere'&&seen.has('point:O'))for(const key of ['OP','QB','QC','QD','AO'])addLine(key);
    if(['coordinates','vectors'].includes(stage))addLine('AO');
    if(stage==='angle')for(const key of ['AC','OP'])addLine(key);
    for(const id of new Set([...seen,...focus])){
      if(id.startsWith('line:')&&E[id]?.vertices)addLine(id.slice(5));
      if(id==='face:PAQ')addLine('QP');
      if(id==='face:BAQ')addLine('QB');
      if(id==='face:CQH'){addLine('CH');addLine('QH');addLine('QC');}
      if(id==='face:ABCH'){addLine('CH');addLine('AH');}
      if(id==='face:ABMQ')for(const key of ['AQ','BM','MQ'])addLine(key);
    }
    // Active objects are drawn last, above all the quiet structural edges.
    for(const [id,info] of [...lines].sort((a,b)=>Number(focus.has(a[0]))-Number(focus.has(b[0])))){
      const entity=E[id],on=focus.has(id),[a,b]=entity.vertices.map(k=>M[k]);
      const color=on?entity.color:info.base?C.ink:entity.color;
      const opacity=on?.65+.35*weight:info.base?(hasFocus?.3:.78):(hasFocus?.25:.55);
      const width=on?3.4+2.1*weight:info.base?2.7:2.8;
      const dash=info.hidden?'8 7':stage==='candidate'&&['line:QP','line:QB','line:QC','line:QD'].includes(id)?'7 6':'';
      let shape=on?line(a,b,color,width+10,dash,.12*weight):'';
      shape+=(['vectors','angle','recap'].includes(stage)&&['line:AC','line:OP'].includes(id)&&!(stage==='angle'&&id==='line:OP'))?arrow(a,b,color,width,opacity):line(a,b,color,width,dash,opacity);
      s+=wrap(id,shape);
    }
    if(['overview','givens','perpendicular'].includes(stage)){
      s+=right(M.A,[1,0,0],[0,1,0],C.blue,.17)+right(M.A,[1,0,0],[0,0,1],C.purple,.2);
      if(stage==='perpendicular')s+=right(M.A,[0,1,0],[0,0,1],C.blue,.23);
    }
    if(stage==='candidate'&&seen.has('line:MQ'))s+=right(M.M,[-1,0,0],[0,-1,0],C.blue,.16);
    if(stage==='givens'&&phase>=1){
      s+=text(mid(M.A,M.P),'√2',-45,0,C.purple,'dimension');
      s+=text(mid(M.A,M.B),'√2',-18,27,C.blue,'dimension');
      s+=text(mid(M.B,M.C),'2',0,32,C.gold,'dimension');
      s+=text(mid(M.A,M.D),'1 + √3',45,-22,C.gold,'dimension');
    }
    if(['candidate','equal-pb','equal-c','equal-d'].includes(stage)&&(stage!=='candidate'||seen.has('line:AQ'))){
      s+=text(mid(M.A,M.Q),'1',0,-23,C.gold,'dimension');
    }
    if(stage==='candidate'&&seen.has('face:ABMQ'))s+=text(mid(M.B,M.M),'1',-4,30,C.gold,'dimension');
    if(stage==='equal-pb'){
      s+=right(M.A,[1,0,0],[0,0,1],C.purple,.19)+text(mid(M.A,M.P),'√2',-42,0,C.purple,'dimension');
      if(phase>=1)s+=right(M.A,[1,0,0],[0,1,0],C.blue,.20)+text(mid(M.A,M.B),'√2',-15,30,C.blue,'dimension');
    }
    if(stage==='equal-c'&&seen.has('line:CH')){
      s+=right(M.H,[-1,0,0],[0,1,0],C.blue,.18)+text(mid(M.H,M.C),'√2',34,5,C.blue,'dimension');
      s+=text(mid(M.B,M.C),'2',0,31,C.gold,'dimension');
      if(seen.has('line:QH'))s+=text(mid(M.Q,M.H),'1',0,-23,C.gold,'dimension');
    }
    if(stage==='equal-d'&&context.cueIndex>=2)s+=text(mid(M.Q,M.D),'√3',0,-24,C.mint,'dimension');
    if(stage==='sphere'&&seen.has('line:OP'))s+=text(mid(M.O,M.P),'R = √3',-28,-12,C.mint,'dimension');
    if(['coordinates','vectors'].includes(stage)){
      for(const [axis,end,color] of [['x',[3.12,0,0],C.gold],['y',[0,1.93,0],C.blue],['z',[0,0,1.96],C.purple]]){
        const id=`axis:${axis}`;
        if(stage==='vectors'||seen.has(id)||focus.has(id))s+=wrap(id,arrow(M.A,end,color,focus.has(id)?3.8:2.1,focus.has(id)?1:.5)+text(end,axis,15,-7,color,'axis-label'));
      }
    }
    if(stage==='angle'&&seen.has('line:translatedPO')){
      const start=context.firstTimes['line:translatedPO'],age=t-start,progress=smooth(age/1.8);
      const shift=mul(sub(M.A,M.P),progress),tail=add(M.P,shift),head=add(M.O,shift);
      s+=wrap('line:translatedPO',arrow(tail,head,C.mint,focus.has('line:translatedPO')?5.5:3.5));
      if(age>=2.2){
        const u=sub(M.C,M.A),w=sub(M.O,M.P),un=mul(u,1/norm(u)),wn=mul(w,1/norm(w));
        s+=line(add(M.A,mul(wn,-.7)),add(M.A,mul(wn,1.9)),C.mint,2.3,'7 6',.65);
        const alpha=Math.acos(dot(un,wn)),arc=[];
        for(let i=0;i<=40;i++){const q=i/40;arc.push(add(M.A,mul(add(mul(un,Math.sin((1-q)*alpha)/Math.sin(alpha)),mul(wn,Math.sin(q*alpha)/Math.sin(alpha))),.57)));}
        const bis=mul(add(un,wn),1/norm(add(un,wn)));
        s+=wrap('angle',polygon([M.A,...arc],C.gold,focus.has('angle')?.19:.08,0)+polyline(arc,C.gold,focus.has('angle')?4:2.5,1)+text(add(M.A,mul(bis,.87)),'θ',0,8,C.gold,'point-label'));
        s+=text(add(M.A,mul(wn,1.92)),'∥ PO',30,0,C.mint,'small-label');
      }
    }
    const extra=new Set();
    if(stage==='candidate'){
      if(seen.has('point:M'))extra.add('M');
      if(seen.has('point:Q')||seen.has('line:AQ'))extra.add('Q');
    }
    if(['equal-pb','equal-c','equal-d'].includes(stage))extra.add('Q');
    if(stage==='equal-c'&&seen.has('point:H'))extra.add('H');
    if(stage==='sphere')extra.add(seen.has('point:O')?'O':'Q');
    if(['coordinates','vectors','angle','recap'].includes(stage))extra.add('O');
    for(const id of focus)if(id.startsWith('point:'))extra.add(id.slice(6));
    const offsets={A:[-21,-10],B:[-22,27],C:[12,32],D:[24,10],P:[-8,-24],Q:[0,-22],O:stage==='angle'?[22,18]:[0,-22],H:[0,-22],M:[-9,32]};
    for(const key of new Set(['A','B','C','D','P',...extra])){
      const id=`point:${key}`,direct=focus.has(id);
      const touching=[...focus].filter(k=>E[k]?.vertices?.includes(key));
      const color=direct?E[id].color:touching.length===1?E[touching[0]].color:['Q','O'].includes(key)?C.gold:hasFocus?'#c4c4c4':C.ink;
      const p=P(M[key]);
      const ring=direct?`<circle cx="${round(p[0])}" cy="${round(p[1])}" r="${11+2*weight}" fill="none" stroke="${C.gold}" stroke-width="2.8" opacity="${.8*weight}"/>`:'';
      s+=wrap(id,ring+point(M[key],color,['Q','O'].includes(key)?6.8:5.2)+text(M[key],key,...offsets[key],color,'point-label'));
    }
    return s;
  }
  window.GeometryDiagram={diagram,camera};
})();

window.ReasonFrameVisual={render:({scene,time,duration,phase,context})=>window.GeometryDiagram.diagram(scene.stage,time,duration,phase,context)};
