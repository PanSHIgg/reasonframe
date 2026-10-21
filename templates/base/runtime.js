(() => {
  const {lesson,timeline,entities}=window.LESSON_DATA;
  const diagrams=[...document.querySelectorAll('.diagram')];
  const chapters=[...document.querySelectorAll('.chapter')];
  const focusLabels=[...document.querySelectorAll('.focus-label')];
  const counter=document.querySelector('.page-counter'),captionNode=document.querySelector('#live-caption');
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let lastCaption=-1;
  // Keep the opening heading visible from the first frame. Formula blocks still
  // reveal independently; fading their common parent can hide the heading at t=0.
  const openingPanel=document.querySelector(`#scene-${lesson.scenes[0].id} .explanation`);
  const composition=window.__timelines?.reasonframe;
  if(openingPanel&&composition&&window.gsap){
    for(const tween of composition.getTweensOf(openingPanel))tween.kill();
    window.gsap.set(openingPanel,{opacity:1,y:0});
  }
  function renderAt(time){
    time=Math.max(0,Math.min(timeline.duration-1e-6,Number(time)||0));
    let index=timeline.scenes.findIndex(s=>time>=s.start&&time<s.end);
    if(index<0)index=0;
    const scene=lesson.scenes[index],timing=timeline.scenes[index];
    let phase=0;
    timing.beats.forEach((beat,i)=>{if(time>=beat.start)phase=i;});
    const played=timing.focus.filter(event=>time>=event.start);
    const cue=played.at(-1),seen=[...new Set(played.flatMap(event=>event.objects))],firstTimes={};
    for(const event of played)for(const key of event.objects)if(!(key in firstTimes))firstTimes[key]=event.start-timing.start;
    diagrams[index].innerHTML=window.ReasonFrameVisual.render({scene,time:time-timing.start,duration:timing.duration,phase,context:{
      active:cue?.objects||[],seen,firstTimes,beatStarts:timing.beats.map(beat=>beat.start-timing.start),age:cue?time-cue.start:1,cueIndex:played.length-1,
    }});
    focusLabels[index].innerHTML=cue?`<span class="focus-dot" style="background:${entities[cue.objects[0]].color}"></span>${esc(cue.label)}`:'';
    chapters.forEach((node,i)=>node.classList.toggle('active',i===scene.chapter));
    counter.textContent=`${String(index+1).padStart(2,'0')} / ${String(lesson.scenes.length).padStart(2,'0')}`;
    document.documentElement.dataset.scene=scene.id;
    document.documentElement.dataset.focus=cue?.id||'';
    let currentBlock=-1;
    timing.reveals.forEach((start,i)=>{if(time>=start&&(currentBlock<0||start>=timing.reveals[currentBlock]))currentBlock=i;});
    document.querySelectorAll(`#scene-${scene.id} .proof-block`).forEach((node,i)=>node.classList.toggle('block-active',i===currentBlock));
    const ci=timeline.captions.findIndex(c=>time>=c.start&&time<c.end);
    if(ci!==lastCaption){
      lastCaption=ci;
      const caption=timeline.captions[ci];
      captionNode.textContent=caption?caption.text:'';
    }
  }
  window.addEventListener('hf-seek',event=>renderAt(event.detail.time));
  window.renderLessonAt=renderAt;
  // Explicit seek is for local QA only. Production clip visibility belongs to HyperFrames.
  window.seekReasonFrame=time=>{
    const t=Math.max(0,Math.min(timeline.duration-1e-6,time));
    window.__timelines.reasonframe.totalTime(t,false);
    document.querySelectorAll('.scene').forEach(node=>{
      const start=Number(node.dataset.start),end=start+Number(node.dataset.duration);
      node.style.visibility=t>=start&&t<end?'visible':'hidden';
    });
    renderAt(t);
  };
  renderAt(0);
})();
