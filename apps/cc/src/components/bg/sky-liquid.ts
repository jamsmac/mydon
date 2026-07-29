/* eslint-disable */
// @ts-nocheck
/*
 * Фон панели: реальное звёздное небо Ташкента + «жидкий эфир».
 * ПЕРЕНЕСЕНО из дизайна Claude Design (mydon-bg.js) как есть — правило проекта:
 * готовое переносим, не переписываем. Правки: экспорт классов вместо
 * самозапуска; three подключается лениво тем, кто монтирует.
 *
 * Звёзды считаются из каталога по текущему времени: JD → GMST → LST →
 * часовой угол → alt/az. Жидкость — порт LiquidEther (React Bits) на ваниль.
 */

/* Точка по умолчанию — Ташкент; реальная подставляется геолокацией браузера. */
const DEFAULT_LAT = 41.3111, DEFAULT_LON = 69.2797;
/* [имя, RA (часы), Dec (град), видимая величина] — J2000, ярчайшие звёзды */
const STARS = [
  ['Сириус',6.752,-16.716,-1.46],['Канопус',6.399,-52.696,-0.72],['Арктур',14.261,19.182,-0.05],
  ['Вега',18.616,38.784,0.03],['Капелла',5.278,45.998,0.08],['Ригель',5.242,-8.202,0.13],
  ['Процион',7.655,5.225,0.34],['Ахернар',1.629,-57.237,0.46],['Бетельгейзе',5.919,7.407,0.50],
  ['Хадар',14.064,-60.373,0.61],['Альтаир',19.846,8.868,0.77],['Акрукс',12.443,-63.099,0.77],
  ['Альдебаран',4.599,16.509,0.85],['Антарес',16.490,-26.432,0.96],['Спика',13.420,-11.161,0.97],
  ['Поллукс',7.755,28.026,1.14],['Фомальгаут',22.961,-29.622,1.16],['Денеб',20.690,45.280,1.25],
  ['Мимоза',12.795,-59.689,1.25],['Регул',10.139,11.967,1.35],['Адара',6.977,-28.972,1.50],
  ['Кастор',7.577,31.888,1.58],['Шаула',17.560,-37.104,1.62],['Гакрукс',12.519,-57.113,1.63],
  ['Беллатрикс',5.418,6.350,1.64],['Эльнат',5.438,28.608,1.65],['Миаплацидус',9.220,-69.717,1.67],
  ['Альнилам',5.604,-1.202,1.69],['Альнаир',22.137,-46.961,1.74],['Альнитак',5.679,-1.943,1.74],
  ['Алиот',12.900,55.960,1.77],['Дубхе',11.062,61.751,1.79],['Мирфак',3.405,49.861,1.79],
  ['Везен',7.140,-26.393,1.83],['Каус Аустралис',18.403,-34.384,1.85],['Авиор',8.375,-59.510,1.86],
  ['Алькаид',13.792,49.313,1.86],['Менкалинан',5.992,44.947,1.90],['Атрия',16.811,-69.028,1.91],
  ['Альхена',6.629,16.399,1.93],['Павлин',20.427,-56.735,1.94],['Мирцам',6.378,-17.956,1.98],
  ['Альфард',9.460,-8.659,1.98],['Полярная',2.530,89.264,1.98],['Хамаль',2.120,23.462,2.00],
  ['Алгейба',10.333,19.841,2.08],['Дифда',0.726,-17.987,2.04],['Нунки',18.921,-26.297,2.05],
  ['Менкент',14.111,-36.370,2.06],['Мицар',13.399,54.925,2.23],['Альферац',0.140,29.090,2.06],
  ['Рас Альхаге',17.582,12.560,2.08],['Кохаб',14.845,74.156,2.08],['Саиф',5.796,-9.670,2.06],
  ['Денебола',11.818,14.572,2.14],['Алголь',3.136,40.956,2.09],['Мухлифайн',12.692,-48.960,2.20],
  ['Аспидиске',9.285,-59.275,2.21],['Сухайль',9.133,-43.433,2.23],['Альфекка',15.578,26.715,2.22],
  ['Минтака',5.533,-0.299,2.25],['Садр',20.371,40.257,2.23],['Этамин',17.943,51.489,2.23],
  ['Шедар',0.675,56.537,2.24],['Наос',8.060,-40.003,2.25],['Альмак',2.065,42.330,2.10],
  ['Каф',0.153,59.150,2.28],['Изар',14.750,27.074,2.35],['Джубба',16.005,-22.622,2.29],
  ['Ларавag',16.836,-34.293,2.29],['Мерак',11.031,56.383,2.37],['Анкаа',0.438,-42.306,2.40],
  ['Гиртаб',17.708,-39.030,2.39],['Эниф',21.736,9.875,2.39],['Шеат',23.063,28.083,2.42],
  ['Сабик',17.173,-15.725,2.43],['Фекда',11.897,53.695,2.44],['Алудра',7.402,-29.303,2.45],
  ['Маркаб',23.079,15.205,2.48],['Гамма Кас',0.945,60.717,2.47],['Менкар',3.038,4.090,2.53],
  ['Зосма',11.235,20.524,2.56],['Рас Альгети',17.244,14.390,2.78],['Альбирео',19.512,27.960,3.05],
  ['Рухба',1.430,60.235,2.68],['Сегин',1.906,63.670,3.35],['Альдерамин',21.310,62.586,2.45],
  ['Гienah Cygni',20.770,33.970,2.48],['Дельта Лебедя',19.750,45.130,2.87],['Мегрец',12.257,57.033,3.31],
  ['Шелиак',18.834,33.363,3.52],['Сулафат',18.982,32.690,3.25],['Альгораб',12.573,-16.515,2.94],
  ['Гиенах Корви',12.263,-17.542,2.59],['Крус',12.168,-58.749,2.79],['Тарф',8.275,9.186,3.52],
];
const LINES = [
  ['Алькаид','Мицар'],['Мицар','Алиот'],['Алиот','Мегрец'],['Мегрец','Фекда'],['Фекда','Мерак'],['Мерак','Дубхе'],['Дубхе','Мегрец'],
  ['Бетельгейзе','Беллатрикс'],['Беллатрикс','Минтака'],['Минтака','Альнилам'],['Альнилам','Альнитак'],['Альнитак','Бетельгейзе'],['Минтака','Ригель'],['Альнитак','Саиф'],
  ['Каф','Шедар'],['Шедар','Гамма Кас'],['Гамма Кас','Рухба'],['Рухба','Сегин'],
  ['Денеб','Садр'],['Садр','Гienah Cygni'],['Садр','Дельта Лебедя'],['Садр','Альбирео'],
  ['Вега','Шелиак'],['Шелиак','Сулафат'],['Сулафат','Вега'],
  ['Регул','Алгейба'],['Алгейба','Зосма'],['Зосма','Денебола'],['Регул','Денебола'],
  ['Кастор','Поллукс'],['Поллукс','Альхена'],
];

const rad = d => d*Math.PI/180, deg = r => r*180/Math.PI;
function lstHours(date, lon){
  const jd = date.getTime()/86400000 + 2440587.5;
  const T = (jd - 2451545.0)/36525;
  let gmst = 280.46061837 + 360.98564736629*(jd - 2451545.0) + 0.000387933*T*T;
  gmst = ((gmst % 360) + 360) % 360;
  return (((gmst + lon)/15) % 24 + 24) % 24;
}
function altAz(raH, decD, lst, latDeg){
  const ha = rad((lst - raH)*15), dec = rad(decD), lat = rad(latDeg);
  const sinAlt = Math.sin(dec)*Math.sin(lat) + Math.cos(dec)*Math.cos(lat)*Math.cos(ha);
  const alt = Math.asin(Math.max(-1,Math.min(1,sinAlt)));
  let az = Math.atan2(-Math.cos(dec)*Math.sin(ha), Math.sin(dec) - Math.sin(alt)*Math.sin(lat));
  az = (deg(az) + 360) % 360;
  return { alt: deg(alt), az };
}

export class Sky {
  constructor(canvas, capEl, lat = null, lon = null) {
    this.c = canvas; this.ctx = canvas.getContext('2d'); this.cap = capEl;
    this.lat = lat ?? DEFAULT_LAT; this.lon = lon ?? DEFAULT_LON;
    this.isDefault = lat === null || lat === undefined;
    this.pts = []; this.t0 = performance.now();
    this.resize(); this.compute();
    this._onResize = ()=>{ this.resize(); this.compute(); this.draw(); };
    window.addEventListener('resize', this._onResize);
    this.recalc = setInterval(()=>{ this.compute(); }, 60000);
    this.loop = this.loop.bind(this);
    this.running = true; requestAnimationFrame(this.loop);
  }
  resize(){
    const dpr = Math.min(window.devicePixelRatio||1, 2);
    this.w = window.innerWidth; this.h = window.innerHeight;
    this.c.width = this.w*dpr; this.c.height = this.h*dpr;
    this.ctx.setTransform(dpr,0,0,dpr,0,0);
  }
  project(alt, az){
    let a = az - 180; if(a > 180) a -= 360; if(a < -180) a += 360;
    return { x: this.w*(0.5 + a/300), y: this.h*(1 - Math.min(alt,90)/95) - this.h*0.04 };
  }
  /** Смена точки наблюдения — приходит из геолокации браузера. */
  setLocation(lat, lon){
    this.lat = lat; this.lon = lon; this.isDefault = false;
    this.compute();
  }
  compute(){
    const now = new Date(), lst = lstHours(now, this.lon);
    this.pts = STARS.map(([n,ra,dec,mag])=>{
      const {alt,az} = altAz(ra,dec,lst,this.lat);
      if(alt < -2) return null;
      const p = this.project(alt,az);
      if(p.x < -80 || p.x > this.w+80) return null;
      return { n, mag, alt, ...p, r: Math.max(.55, (3.4 - mag)*0.62), ph: Math.random()*6.28 };
    });
    const map = {}; this.pts.forEach(p=>{ if(p) map[p.n]=p; });
    this.segs = LINES.map(([a,b])=>(map[a]&&map[b])?[map[a],map[b]]:null).filter(Boolean);
    const hh=String(now.getHours()).padStart(2,'0'), mm=String(now.getMinutes()).padStart(2,'0');
    const up = this.pts.filter(p=>p&&p.alt>0).length;
    if(this.cap){
      const place = this.isDefault ? 'небо над Ташкентом' : 'небо над твоей точкой';
      this.cap.textContent = `${place} · ${this.lat.toFixed(1)}°N ${this.lon.toFixed(1)}°E · ${hh}:${mm} · ${up} ярких звёзд над горизонтом`;
    }
  }
  loop(){
    if(!this.running) return;
    this.draw();
    setTimeout(()=>requestAnimationFrame(this.loop), 110);
  }
  draw(){
    const {ctx,w,h} = this, t=(performance.now()-this.t0)/1000;
    ctx.clearRect(0,0,w,h);
    const hy = this.project(0,180).y;
    ctx.strokeStyle='rgba(26,107,255,.10)'; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(0,hy); ctx.lineTo(w,hy); ctx.stroke();
    ctx.strokeStyle='rgba(132,148,168,.13)'; ctx.lineWidth=1;
    this.segs.forEach(([a,b])=>{ ctx.beginPath(); ctx.moveTo(a.x,a.y); ctx.lineTo(b.x,b.y); ctx.stroke(); });
    this.pts.forEach(p=>{
      if(!p) return;
      const tw = 0.72 + 0.28*Math.sin(t*1.7 + p.ph);
      const below = p.alt <= 0;
      const a = (below?0.10:0.30 + (3.4-p.mag)*0.14) * tw;
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,6.2832);
      ctx.fillStyle=`rgba(232,236,242,${Math.min(a,0.9)})`; ctx.fill();
      if(p.mag < 1.0 && !below){
        ctx.beginPath(); ctx.arc(p.x,p.y,p.r*4.2,0,6.2832);
        const g=ctx.createRadialGradient(p.x,p.y,0,p.x,p.y,p.r*4.2);
        g.addColorStop(0,`rgba(200,220,255,${0.16*tw})`); g.addColorStop(1,'rgba(200,220,255,0)');
        ctx.fillStyle=g; ctx.fill();
      }
    });
  }
  stop(){ this.running=false; clearInterval(this.recalc); window.removeEventListener('resize',this._onResize); this.ctx.clearRect(0,0,this.w,this.h); if(this.cap) this.cap.textContent=''; }
}

/* ============ LIQUID ETHER (three.js) ============ */
const face_vert=`attribute vec3 position;uniform vec2 px;uniform vec2 boundarySpace;varying vec2 uv;precision highp float;
void main(){vec3 pos=position;vec2 scale=1.0-boundarySpace*2.0;pos.xy=pos.xy*scale;uv=vec2(0.5)+(pos.xy)*0.5;gl_Position=vec4(pos,1.0);}`;
const line_vert=`attribute vec3 position;uniform vec2 px;precision highp float;varying vec2 uv;
void main(){vec3 pos=position;uv=0.5+pos.xy*0.5;vec2 n=sign(pos.xy);pos.xy=abs(pos.xy)-px*1.0;pos.xy*=n;gl_Position=vec4(pos,1.0);}`;
const mouse_vert=`precision highp float;attribute vec3 position;attribute vec2 uv;uniform vec2 center;uniform vec2 scale;uniform vec2 px;varying vec2 vUv;
void main(){vec2 pos=position.xy*scale*2.0*px+center;vUv=uv;gl_Position=vec4(pos,0.0,1.0);}`;
const advection_frag=`precision highp float;uniform sampler2D velocity;uniform float dt;uniform bool isBFECC;uniform vec2 fboSize;uniform vec2 px;varying vec2 uv;
void main(){vec2 ratio=max(fboSize.x,fboSize.y)/fboSize;
if(isBFECC==false){vec2 vel=texture2D(velocity,uv).xy;vec2 uv2=uv-vel*dt*ratio;vec2 newVel=texture2D(velocity,uv2).xy;gl_FragColor=vec4(newVel,0.0,0.0);}
else{vec2 spot_new=uv;vec2 vel_old=texture2D(velocity,uv).xy;vec2 spot_old=spot_new-vel_old*dt*ratio;vec2 vel_new1=texture2D(velocity,spot_old).xy;
vec2 spot_new2=spot_old+vel_new1*dt*ratio;vec2 error=spot_new2-spot_new;vec2 spot_new3=spot_new-error/2.0;vec2 vel_2=texture2D(velocity,spot_new3).xy;
vec2 spot_old2=spot_new3-vel_2*dt*ratio;vec2 newVel2=texture2D(velocity,spot_old2).xy;gl_FragColor=vec4(newVel2,0.0,0.0);}}`;
const color_frag=`precision highp float;uniform sampler2D velocity;uniform sampler2D palette;uniform vec4 bgColor;varying vec2 uv;
void main(){vec2 vel=texture2D(velocity,uv).xy;float lenv=clamp(length(vel),0.0,1.0);vec3 c=texture2D(palette,vec2(lenv,0.5)).rgb;
vec3 outRGB=mix(bgColor.rgb,c,lenv);float outA=mix(bgColor.a,1.0,lenv);gl_FragColor=vec4(outRGB,outA);}`;
const divergence_frag=`precision highp float;uniform sampler2D velocity;uniform float dt;uniform vec2 px;varying vec2 uv;
void main(){float x0=texture2D(velocity,uv-vec2(px.x,0.0)).x;float x1=texture2D(velocity,uv+vec2(px.x,0.0)).x;
float y0=texture2D(velocity,uv-vec2(0.0,px.y)).y;float y1=texture2D(velocity,uv+vec2(0.0,px.y)).y;
float divergence=(x1-x0+y1-y0)/2.0;gl_FragColor=vec4(divergence/dt);}`;
const externalForce_frag=`precision highp float;uniform vec2 force;uniform vec2 center;uniform vec2 scale;uniform vec2 px;varying vec2 vUv;
void main(){vec2 circle=(vUv-0.5)*2.0;float d=1.0-min(length(circle),1.0);d*=d;gl_FragColor=vec4(force*d,0.0,1.0);}`;
const poisson_frag=`precision highp float;uniform sampler2D pressure;uniform sampler2D divergence;uniform vec2 px;varying vec2 uv;
void main(){float p0=texture2D(pressure,uv+vec2(px.x*2.0,0.0)).r;float p1=texture2D(pressure,uv-vec2(px.x*2.0,0.0)).r;
float p2=texture2D(pressure,uv+vec2(0.0,px.y*2.0)).r;float p3=texture2D(pressure,uv-vec2(0.0,px.y*2.0)).r;
float div=texture2D(divergence,uv).r;float newP=(p0+p1+p2+p3)/4.0-div;gl_FragColor=vec4(newP);}`;
const pressure_frag=`precision highp float;uniform sampler2D pressure;uniform sampler2D velocity;uniform vec2 px;uniform float dt;varying vec2 uv;
void main(){float step=1.0;float p0=texture2D(pressure,uv+vec2(px.x*step,0.0)).r;float p1=texture2D(pressure,uv-vec2(px.x*step,0.0)).r;
float p2=texture2D(pressure,uv+vec2(0.0,px.y*step)).r;float p3=texture2D(pressure,uv-vec2(0.0,px.y*step)).r;
vec2 v=texture2D(velocity,uv).xy;vec2 gradP=vec2(p0-p1,p2-p3)*0.5;v=v-gradP*dt;gl_FragColor=vec4(v,0.0,1.0);}`;

export function createLiquidEther(THREE, container, o={}){
  function paletteTexture(stops){
    const arr = stops.length===1?[stops[0],stops[0]]:stops;
    const data = new Uint8Array(arr.length*4);
    arr.forEach((s,i)=>{ const c=new THREE.Color(s);
      data[i*4]=Math.round(c.r*255); data[i*4+1]=Math.round(c.g*255); data[i*4+2]=Math.round(c.b*255); data[i*4+3]=255; });
    const t=new THREE.DataTexture(data,arr.length,1,THREE.RGBAFormat);
    t.magFilter=t.minFilter=THREE.LinearFilter; t.wrapS=t.wrapT=THREE.ClampToEdgeWrapping;
    t.generateMipmaps=false; t.needsUpdate=true; return t;
  }

  class LiquidEther {
    constructor(el, opts){
      this.o = Object.assign({ mouseForce:16, cursorSize:110, resolution:0.42, dt:0.014, BFECC:true,
        iterationsPoisson:26, isBounce:false, colors:['#0C1F44','#1A6BFF','#7FB2FF'],
        autoDemo:true, autoSpeed:0.42, autoIntensity:2.0, takeoverDuration:0.25,
        autoResumeDelay:2200, autoRampDuration:0.7 }, opts);
      this.el = el;
      if(getComputedStyle(this.el).position === 'static') this.el.style.position = 'relative';
      this.el.style.overflow = 'hidden';
      this.palette = paletteTexture(this.o.colors);
      this.bg = new THREE.Vector4(0,0,0,0);
      this.time=0; this.running=false;
      this._initRenderer(); this._initMouse(); this._initSim(); this._initOutput();
      this.lastUser = performance.now();
      this._auto = { active:false, cur:new THREE.Vector2(), target:new THREE.Vector2(), last:performance.now(), act:0, tmp:new THREE.Vector2() };
      this._pickTarget();
      this._loop = this._loop.bind(this);
      this._onResize = ()=>this.resize();
      window.addEventListener('resize', this._onResize);
      this._onVis = ()=>{ document.hidden ? this.pause() : this.start(); };
      document.addEventListener('visibilitychange', this._onVis);
      this.ro = new ResizeObserver(()=>this.resize()); this.ro.observe(this.el);
    }
    _initRenderer(){
      this.pr = Math.min(window.devicePixelRatio||1, 2);
      this._measure();
      this.renderer = new THREE.WebGLRenderer({ antialias:false, alpha:true });
      this.renderer.autoClear=false;
      this.renderer.setClearColor(new THREE.Color(0x000000),0);
      this.renderer.setPixelRatio(this.pr);
      this.renderer.setSize(this.width,this.height);
      const c=this.renderer.domElement;
      c.style.width='100%'; c.style.height='100%'; c.style.display='block';
      this.el.prepend(c);
      this.clock=new THREE.Clock(); this.clock.start();
    }
    _measure(){
      const r=this.el.getBoundingClientRect();
      this.width=Math.max(1,Math.floor(r.width)); this.height=Math.max(1,Math.floor(r.height));
    }
    _initMouse(){
      this.m = { coords:new THREE.Vector2(), old:new THREE.Vector2(), diff:new THREE.Vector2(),
        moved:false, timer:null, hasUser:false, autoActive:false, takeover:false,
        tFrom:new THREE.Vector2(), tTo:new THREE.Vector2(), tStart:0, inside:false };
      const setCoords=(x,y)=>{
        const r=this.el.getBoundingClientRect(); if(!r.width||!r.height) return;
        this.m.coords.set(((x-r.left)/r.width)*2-1, -(((y-r.top)/r.height)*2-1));
        this.m.moved=true; clearTimeout(this.m.timer);
        this.m.timer=setTimeout(()=>{this.m.moved=false;},100);
      };
      this._onMove=e=>{
        this.m.inside=true; this.lastUser=performance.now(); this._auto.active=false; this.m.autoActive=false;
        setCoords(e.clientX,e.clientY); this.m.hasUser=true;
      };
      this._onTouch=e=>{ if(e.touches.length!==1) return; const t=e.touches[0];
        this.lastUser=performance.now(); this._auto.active=false; this.m.autoActive=false;
        setCoords(t.clientX,t.clientY); this.m.hasUser=true; };
      window.addEventListener('mousemove',this._onMove);
      window.addEventListener('touchmove',this._onTouch,{passive:true});
      window.addEventListener('touchstart',this._onTouch,{passive:true});
    }
    _pickTarget(){ const r=Math.random, m=0.2; this._auto.target.set((r()*2-1)*(1-m),(r()*2-1)*(1-m)); }
    _updateAuto(){
      if(!this.o.autoDemo) return;
      const now=performance.now(), a=this._auto;
      if(now - this.lastUser < this.o.autoResumeDelay){ a.active=false; this.m.autoActive=false; return; }
      if(!a.active){ a.active=true; a.cur.copy(this.m.coords); a.last=now; a.act=now; }
      this.m.autoActive=true;
      let dt=(now-a.last)/1000; a.last=now; if(dt>0.2) dt=0.016;
      const dir=a.tmp.subVectors(a.target,a.cur), dist=dir.length();
      if(dist<0.01){ this._pickTarget(); return; }
      dir.normalize();
      let ramp=1; const rd=this.o.autoRampDuration*1000;
      if(rd>0){ const t=Math.min(1,(now-a.act)/rd); ramp=t*t*(3-2*t); }
      a.cur.addScaledVector(dir, Math.min(this.o.autoSpeed*dt*ramp, dist));
      this.m.coords.set(a.cur.x,a.cur.y); this.m.moved=true;
    }
    _updateMouse(){
      const m=this.m;
      m.diff.subVectors(m.coords,m.old); m.old.copy(m.coords);
      if(m.old.x===0&&m.old.y===0) m.diff.set(0,0);
      if(m.autoActive) m.diff.multiplyScalar(this.o.autoIntensity);
    }
    _fbo(){ const isIOS=/(iPad|iPhone|iPod)/i.test(navigator.userAgent);
      return new THREE.WebGLRenderTarget(this.fboSize.x,this.fboSize.y,{
        type: isIOS?THREE.HalfFloatType:THREE.FloatType, depthBuffer:false, stencilBuffer:false,
        minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter,
        wrapS:THREE.ClampToEdgeWrapping, wrapT:THREE.ClampToEdgeWrapping }); }
    _calcSize(){
      const w=Math.max(1,Math.round(this.o.resolution*this.width)), h=Math.max(1,Math.round(this.o.resolution*this.height));
      this.fboSize=this.fboSize||new THREE.Vector2(); this.cellScale=this.cellScale||new THREE.Vector2();
      this.boundary=this.boundary||new THREE.Vector2();
      this.fboSize.set(w,h); this.cellScale.set(1/w,1/h);
    }
    _pass(mat,out){
      const scene=new THREE.Scene(), cam=new THREE.Camera();
      const material=new THREE.RawShaderMaterial(mat);
      scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2),material));
      const self=this;
      return { scene, cam, material, uniforms:material.uniforms, out,
        run:(target)=>{ self.renderer.setRenderTarget(target!==undefined?target:out);
          self.renderer.render(scene,cam); self.renderer.setRenderTarget(null); } };
    }
    _initSim(){
      this._calcSize();
      this.fbos={}; ['vel0','vel1','div','p0','p1'].forEach(k=>this.fbos[k]=this._fbo());
      const cs=this.cellScale, bs=this.boundary;
      this.advection=this._pass({ vertexShader:face_vert, fragmentShader:advection_frag, uniforms:{
        boundarySpace:{value:cs}, px:{value:cs}, fboSize:{value:this.fboSize},
        velocity:{value:this.fbos.vel0.texture}, dt:{value:this.o.dt}, isBFECC:{value:this.o.BFECC} } }, this.fbos.vel1);
      const bg2=new THREE.BufferGeometry();
      bg2.setAttribute('position', new THREE.BufferAttribute(new Float32Array(
        [-1,-1,0,-1,1,0,-1,1,0,1,1,0,1,1,0,1,-1,0,1,-1,0,-1,-1,0]),3));
      this.bLine=new THREE.LineSegments(bg2, new THREE.RawShaderMaterial({
        vertexShader:line_vert, fragmentShader:advection_frag, uniforms:this.advection.uniforms }));
      this.bLine.visible=this.o.isBounce; this.advection.scene.add(this.bLine);
      const fScene=new THREE.Scene(), fCam=new THREE.Camera();
      const fMat=new THREE.RawShaderMaterial({ vertexShader:mouse_vert, fragmentShader:externalForce_frag,
        blending:THREE.AdditiveBlending, depthWrite:false, uniforms:{ px:{value:cs},
          force:{value:new THREE.Vector2()}, center:{value:new THREE.Vector2()},
          scale:{value:new THREE.Vector2(this.o.cursorSize,this.o.cursorSize)} } });
      fScene.add(new THREE.Mesh(new THREE.PlaneGeometry(1,1), fMat));
      this.force={ scene:fScene, cam:fCam, uniforms:fMat.uniforms };
      this.divergence=this._pass({ vertexShader:face_vert, fragmentShader:divergence_frag, uniforms:{
        boundarySpace:{value:bs}, velocity:{value:this.fbos.vel1.texture}, px:{value:cs}, dt:{value:this.o.dt} } }, this.fbos.div);
      this.poisson=this._pass({ vertexShader:face_vert, fragmentShader:poisson_frag, uniforms:{
        boundarySpace:{value:bs}, pressure:{value:this.fbos.p0.texture},
        divergence:{value:this.fbos.div.texture}, px:{value:cs} } }, this.fbos.p1);
      this.pressure=this._pass({ vertexShader:face_vert, fragmentShader:pressure_frag, uniforms:{
        boundarySpace:{value:bs}, pressure:{value:this.fbos.p0.texture},
        velocity:{value:this.fbos.vel1.texture}, px:{value:cs}, dt:{value:this.o.dt} } }, this.fbos.vel0);
    }
    _initOutput(){
      this.oScene=new THREE.Scene(); this.oCam=new THREE.Camera();
      this.oMat=new THREE.RawShaderMaterial({ vertexShader:face_vert, fragmentShader:color_frag,
        transparent:true, depthWrite:false, uniforms:{ velocity:{value:this.fbos.vel0.texture},
          boundarySpace:{value:new THREE.Vector2()}, palette:{value:this.palette}, bgColor:{value:this.bg} } });
      this.oScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2,2), this.oMat));
    }
    _simulate(){
      this.o.isBounce ? this.boundary.set(0,0) : this.boundary.copy(this.cellScale);
      this.bLine.visible=this.o.isBounce;
      this.advection.uniforms.dt.value=this.o.dt;
      this.advection.uniforms.isBFECC.value=this.o.BFECC;
      this.advection.run();
      const cs=this.cellScale, m=this.m, u=this.force.uniforms;
      const csx=this.o.cursorSize*cs.x, csy=this.o.cursorSize*cs.y;
      u.force.value.set((m.diff.x/2)*this.o.mouseForce, (m.diff.y/2)*this.o.mouseForce);
      u.center.value.set(
        Math.min(Math.max(m.coords.x, -1+csx+cs.x*2), 1-csx-cs.x*2),
        Math.min(Math.max(m.coords.y, -1+csy+cs.y*2), 1-csy-cs.y*2));
      u.scale.value.set(this.o.cursorSize,this.o.cursorSize);
      this.renderer.setRenderTarget(this.fbos.vel1);
      this.renderer.render(this.force.scene,this.force.cam);
      this.renderer.setRenderTarget(null);
      this.divergence.uniforms.velocity.value=this.fbos.vel1.texture;
      this.divergence.run();
      let pIn,pOut;
      for(let i=0;i<this.o.iterationsPoisson;i++){
        pIn = i%2===0 ? this.fbos.p0 : this.fbos.p1;
        pOut = i%2===0 ? this.fbos.p1 : this.fbos.p0;
        this.poisson.uniforms.pressure.value=pIn.texture;
        this.poisson.run(pOut);
      }
      this.pressure.uniforms.velocity.value=this.fbos.vel1.texture;
      this.pressure.uniforms.pressure.value=pOut.texture;
      this.pressure.run();
    }
    _loop(){
      if(!this.running) return;
      this._updateAuto(); this._updateMouse();
      this.delta=this.clock.getDelta(); this.time+=this.delta;
      this._simulate();
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.oScene,this.oCam);
      this.raf=requestAnimationFrame(this._loop);
    }
    start(){ if(this.running) return; this.running=true; this._loop(); }
    pause(){ this.running=false; if(this.raf){ cancelAnimationFrame(this.raf); this.raf=null; } }
    resize(){
      this._measure();
      this.renderer.setSize(this.width,this.height,false);
      this._calcSize();
      Object.values(this.fbos).forEach(f=>f.setSize(this.fboSize.x,this.fboSize.y));
    }
    dispose(){
      this.pause();
      if(this.ro){ try{this.ro.disconnect();}catch(e){} this.ro=null; }
      window.removeEventListener('resize',this._onResize);
      window.removeEventListener('mousemove',this._onMove);
      window.removeEventListener('touchmove',this._onTouch);
      window.removeEventListener('touchstart',this._onTouch);
      document.removeEventListener('visibilitychange',this._onVis);
      try{ const c=this.renderer.domElement; c.parentNode&&c.parentNode.removeChild(c);
        this.renderer.dispose(); this.renderer.forceContextLoss(); }catch(e){}
    }
  }
  return new LiquidEther(container, o);
}
