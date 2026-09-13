/* dashboard-core.js — logic shared by BOTH dashboards:
 *   web-VN-v2/index.html   (dubaomua, nationwide)
 *   QPF_dam/web/index.html (dam site)
 *
 * SOURCE OF TRUTH: web-shared/dashboard-core.js. The copies inside the two
 * site folders exist only because each site publishes as a self-contained
 * folder (publish_src.py pushes web-VN-v2/** and QPF_dam/web/** verbatim to
 * the `site` branch). Edit web-shared/ and copy to both folders — and as a
 * safety net publish_src.py re-syncs the copies from web-shared/ on every
 * publish, so a forgotten copy can never ship stale.
 *
 * WHEN YOU EDIT THIS FILE also bump the ?v= query on the two
 * <script src="dashboard-core.js?v=N"> tags (web-VN-v2/index.html and
 * QPF_dam/web/index.html) — browsers cache the script by URL, and a viewer
 * with the old copy cached would otherwise mix new page + old core.
 *
 * Loaded with <script type="text/babel" src="dashboard-core.js"> BEFORE each
 * page's inline script. Babel-standalone compiles every text/babel script into
 * a classic global-scope script, so top-level consts WOULD collide with the
 * page's own (e.g. its React-hook destructure) — hence the IIFE: nothing
 * leaks, the only export is window.QPFShared, destructured by each page.
 */
(() => {
const React = window.React;
const { useEffect, useRef } = React;

/* ------------------------------------------------------------- constants */
const DOW = ["CN","T2","T3","T4","T5","T6","T7"];
const MODEL_COLOR = { ifs_ens:"#f0902a", gefs:"#5b9bd5", aifs_ens:"#77b255",
  icon_eps:"#b5539c", ensemble:"#ffd21f", vforce:"#111111" };

// One field menu for every source; which fields a source actually has comes
// from the site's manifest (VForce-cast has no exceedance x50).
const FIELDS = {
  int:{key:"int",label:"Cường độ mưa",kind:"step",unit:"mm/h"},
  cum:{key:"cum",label:"Tổng lượng mưa cộng dồn",kind:"step",unit:"mm"},
  q50:{key:"q50",label:"Kịch bản điển hình (Q50)",kind:"win",unit:"mm/24h"},
  q90:{key:"q90",label:"Kịch bản cực đoan (Q90)",kind:"win",unit:"mm/24h"},
  x50:{key:"x50",label:"Xác suất mưa > 50 mm/24h",kind:"win",unit:"%"},
};
const FIELD_ORDER = ["int","cum","q50","q90","x50"];

const PROB_BINS = [
  {min:0,max:5,color:"#e8f0f7",label:"< 5%"},{min:5,max:20,color:"#2f8fe0",label:"5–20%"},
  {min:20,max:40,color:"#2fa84f",label:"20–40%"},{min:40,max:70,color:"#f2a02a",label:"40–70%"},
  {min:70,max:null,color:"#e8422e",label:"> 70%"},
];
// Rain intensity as a RATE in mm/HOUR (WMO classes). process_dam.py divides
// each per-step accumulation by its step length before rendering, so a
// 3-hourly, 6-hourly or VForce-cast frame all read on the same scale.
// MUST mirror FIELD_SCALE["int"] in process_dam.py — the tiles are
// pre-rendered there, this is only the legend.
const INT_BINS = [
  {min:0.1,max:0.5,color:"#d0e6f5",label:"0,1–0,5 mm/h"},{min:0.5,max:1,color:"#9ccbe8",label:"0,5–1"},
  {min:1,max:2.5,color:"#4f9bd3",label:"1–2,5"},{min:2.5,max:5,color:"#fff176",label:"2,5–5"},
  {min:5,max:10,color:"#fbc02d",label:"5–10"},{min:10,max:20,color:"#f57c00",label:"10–20"},
  {min:20,max:50,color:"#d32f2f",label:"20–50"},{min:50,max:null,color:"#8e24aa",label:"> 50"},
];

/* --------------------------------------------------------------- helpers */
const j=async(u)=>{const r=await fetch(u);if(!r.ok)throw new Error(`${r.status} ${u}`);return r.json();};
const dmy=(iso)=>{const [y,m,d]=iso.slice(0,10).split("-");return `${d}/${m}/${y}`;};
const dm=(iso)=>{const [,m,d]=iso.slice(0,10).split("-");return `${d}/${m}`;};
const dow=(iso)=>{const [y,m,d]=iso.slice(0,10).split("-").map(Number);return DOW[new Date(Date.UTC(y,m-1,d)).getUTCDay()];};
const hhmm=(iso)=>iso.slice(11,16);
const num=(v,d=0)=>(v===null||v===undefined||Number.isNaN(v))?"–":(+v).toFixed(d);
const norm=(s)=>(s||"").normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/đ/g,"d").replace(/Đ/g,"D").toLowerCase();

function binsFor(field,legend){ return field==="x50"?PROB_BINS:field==="int"?INT_BINS:legend; }
function colorFor(v,bins){ if(v===null||v===undefined||Number.isNaN(v))return null;
  for(const b of bins) if(v>=b.min&&(b.max===null||v<b.max)) return b.color;
  // Below the lowest bin (e.g. <0.5 mm intensity): no fill. The top bin is
  // open-ended (max:null) so high values are already matched above — never
  // fall back to the last colour, which painted dry/ocean cells purple.
  return null; }

/* ------------------------------------------------------ timeline labels */
// Both sites label 24-h-window frames from the SELECTED source's own window
// axis ({lead_h,end} rows — dam: tmeta.models[src].windows; dubaomua:
// meta.model_windows[src]): a 6-hourly model's windows end at a different
// clock time than the 3-hourly ones, and its frames are indexed on its own
// axis. Per-step frames are labelled by lead from the dashboard issue (t0).
const winTiles=(windows)=>(windows||[]).map(wn=>(
  {top:`+${wn.lead_h}h`,bot:`${dow(wn.end)} ${dmy(wn.end)} · ${hhmm(wn.end)}`}));
const stepTiles=(steps,t0iso)=>{const t0=Date.parse(t0iso);
  return (steps||[]).map(s=>({top:`+${Math.round((Date.parse(s)-t0)/36e5)}h`,bot:`${hhmm(s)} ${dm(s)}`}));};

/* ---------------------------------------------------------- chart bits */
const PAD={l:38,r:10,t:10,b:26};
function niceMax(raw,ticks=4,floor=5){const target=Math.max(raw*1.12,floor);const step=target/ticks;
  const mag=Math.pow(10,Math.floor(Math.log10(step)));const nice=[1,2,2.5,5,10].find(n=>n*mag>=step-1e-9)||10;return nice*mag*ticks;}
function Axes({w,h,ymax,xLabels,unit,thresholds,ticks=4}){
  const iw=w-PAD.l-PAD.r,ih=h-PAD.t-PAD.b;const y=v=>PAD.t+ih*(1-v/ymax);const out=[];
  for(let i=0;i<=ticks;i++){const v=ymax*i/ticks;out.push(<g key={"t"+i}>
    <line x1={PAD.l} x2={w-PAD.r} y1={y(v)} y2={y(v)} stroke="#eceff3"/>
    <text x={PAD.l-5} y={y(v)+3.5} textAnchor="end" fontSize="9.5" fill="#8b97a5">{ymax>=5?v.toFixed(0):v.toFixed(1)}</text></g>);}
  (thresholds||[]).filter(t=>t.value<=ymax).forEach((t,i)=>out.push(<g key={"th"+i}>
    <line x1={PAD.l} x2={w-PAD.r} y1={y(t.value)} y2={y(t.value)} stroke={t.color} strokeWidth="1.1" strokeDasharray="4 3"/>
    <text x={w-PAD.r-2} y={y(t.value)-3} textAnchor="end" fontSize="9" fill={t.color}>{t.label}</text></g>));
  (xLabels||[]).forEach((lab,i)=>{if(!lab)return;const x=PAD.l+(iw*(i+0.5))/xLabels.length;
    out.push(<text key={"x"+i} x={x} y={h-8} textAnchor="middle" fontSize="9.5" fill="#6b7a8c">{lab}</text>);});
  out.push(<text key="u" x={2} y={PAD.t-1} fontSize="9" fill="#8b97a5">{unit}</text>);
  return <g>{out}</g>;
}

/* ---------------------------------------------------- shared components */
function Timeline({tiles,idx,setIdx,playing,setPlaying}){
  const ref=useRef(null);
  useEffect(()=>{const el=ref.current?.querySelector(".tl-day.on");if(el)el.scrollIntoView({block:"nearest",inline:"center",behavior:"smooth"});},[idx]);
  return <div className="timeline"><div className="tl-inner">
    <button className="tl-play" onClick={()=>setPlaying(!playing)}>{playing?"❚❚":"▶"}</button>
    <div className="tl-days" ref={ref}>
      {tiles.map((t,i)=><button key={i} className={"tl-day"+(i===idx?" on":"")} onClick={()=>{setPlaying(false);setIdx(i);}}>
        <div className="tl-dow">{t.top}</div><div className="tl-date">{t.bot}</div></button>)}
    </div>
  </div></div>;
}

// The 6-hourly window caveat, keyed on the selected model's off_grid flag —
// ONE text for both sites (it had to be fixed twice before this file).
function OffGridNote({models,model}){
  if(!((models||[]).find(m=>m.id===model)||{}).off_grid) return null;
  return <p className="hint" style={{marginTop:8}}>Với các mô hình bước 6 giờ (AIFS-ENS, ICON-EPS), khoảng 24 giờ bắt đầu và kết thúc ở mốc giờ khác so với các mô hình bước 1–3 giờ (IFS-ENS, GEFS, VForce-cast) — chú ý giờ dự báo trên thanh thời gian khác nhau giữa các mô hình.</p>;
}

function Credit(){
  return <div className="card pad credit">
    Mô hình dự báo này được phát triển bởi chương trình SMART-HS của <b>Đại học Oxford</b> phối hợp với <b>Trung tâm Quy hoạch và Điều tra Tài nguyên nước Quốc gia</b> (Bộ Nông nghiệp và Môi trường), nhằm hỗ trợ địa phương chuyển đổi số theo <b>Nghị quyết số 57-NQ/TW</b> của Bộ Chính trị và Nghị quyết số 210/NQ-CP của Chính phủ.
    Để giảm sai số dự báo, người dùng nên tham khảo thêm thông tin từ nhiều nguồn khác nhau,
    đặc biệt là các cơ quan nhà nước có thẩm quyền và chính quyền địa phương.
    Phản hồi xin gửi về: <a href="mailto:bdduong@mae.gov.vn">bdduong@mae.gov.vn</a>.
  </div>;
}

/* ------------------------------------------------- tropical cyclone layer
 * tc.json (written by process_tc.py into BOTH site folders) is OPTIONAL:
 * feature-detect it, a 404 or {"storms":[]} renders nothing. Ensemble member
 * tracks come from up to three models (IFS-ENS, AIFS-ENS = ECMWF; AI-GEFS =
 * NCEP), deterministic tracks from IFS HRES + the GEFS mean. The official
 * NCHMF forecast stays the authority: everything here is captioned as model
 * guidance ("hướng đi tham khảo"), and a landfall is only ever a member
 * fraction, never a single line.
 */
const TC_SRC_COLOR = { ifs_ens:"#f0902a", aifs_ens:"#77b255", aigefs:"#5b9bd5" };
// one accent per STORM (by index), used on its current-position marker, its
// forecast-icon label and its banner headline: with two systems live their
// positions can overlap in time (70W's forecast centre reaching where 71W
// currently sits) and same-coloured markers read as one confused storm
const TC_STORM_ACCENT = ["#c0392b","#7b2d8e","#0b7285","#b8860b","#2d6a4f"];
const TC_DET_COLOR = { ifs_hres:"#5a2d82", gefs_mean:"#1d5e9e" };
const TC_SRC_LABEL = { ifs_ens:"IFS-ENS (ECMWF)", aifs_ens:"AIFS-ENS (ECMWF)",
  aigefs:"AI-GEFS (NCEP)", ifs_hres:"IFS HRES (ECMWF)", gefs_mean:"GEFS TB (NCEP)" };

// Vietnamese classification by cap gio (NCHMF terminology, QD 18/2021/QD-TTg):
// duoi cap 6 = vung ap thap, 6-7 = ap thap nhiet doi, 8-9 = bao, 10-11 = bao
// manh, 12-15 = bao rat manh, >=16 = sieu bao.
const TC_CLASSES = [
  {min:16,label:"Siêu bão",caps:"cấp 16 trở lên"},
  {min:12,label:"Bão rất mạnh",caps:"cấp 12–15"},
  {min:10,label:"Bão mạnh",caps:"cấp 10–11"},
  {min:8,label:"Bão",caps:"cấp 8–9"},
  {min:6,label:"Áp thấp nhiệt đới",caps:"cấp 6–7"},
  {min:0,label:"Vùng áp thấp",caps:"dưới cấp 6"},
];
function tcClass(cap){ if(cap==null) return "Xoáy thuận nhiệt đới";
  return (TC_CLASSES.find(c=>cap>=c.min)||TC_CLASSES[TC_CLASSES.length-1]).label; }
// display name: a depression has no official name yet — show the tracker id
// and say so, never present "71W" as if it were a name
function tcName(s){ const named=s.named!==undefined?s.named:(s.name!==s.id);
  return named?s.name:`${s.id} (chưa đặt tên)`; }

// destination point from [lat,lon], bearing deg, distance km (spherical)
function tcDest(lat,lon,brg,km){
  const R=6371,d=km/R,la=lat*Math.PI/180,lo=lon*Math.PI/180,b=brg*Math.PI/180;
  const la2=Math.asin(Math.sin(la)*Math.cos(d)+Math.cos(la)*Math.sin(d)*Math.cos(b));
  const lo2=lo+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la),
    Math.cos(d)-Math.sin(la)*Math.sin(la2));
  return [la2*180/Math.PI,lo2*180/Math.PI];
}
function tcBearing(a,b){
  const la1=a[0]*Math.PI/180,la2=b[0]*Math.PI/180,dl=(b[1]-a[1])*Math.PI/180;
  const y=Math.sin(dl)*Math.cos(la2);
  const x=Math.cos(la1)*Math.sin(la2)-Math.sin(la1)*Math.cos(la2)*Math.cos(dl);
  return (Math.atan2(y,x)*180/Math.PI+360)%360;
}
// uncertainty cone outline. A left-edge/right-edge ribbon self-intersects
// badly when the centroid track meanders or stalls (seen live on SAUDEL
// 2026-08-28), so instead: sample the boundary of each per-lead circle
// (out to +120 h — the horizon the relevance filter and the banner use) and
// take the convex hull. Slightly generous where the track curves, but always
// a clean single polygon.
function tcConePolygon(cone,maxH=120){
  const cs=(cone||[]).filter(c=>c.h<=maxH);
  if(cs.length<2) return null;
  const pts=[];
  cs.forEach(c=>{ for(let a=0;a<360;a+=20) pts.push(tcDest(c.lat,c.lon,a,c.r_km)); });
  // Andrew monotone chain on [lat,lon] treated as planar (fine at this scale)
  pts.sort((p,q)=>p[1]-q[1]||p[0]-q[0]);
  const cross=(o,a,b)=>(a[1]-o[1])*(b[0]-o[0])-(a[0]-o[0])*(b[1]-o[1]);
  const lo=[],hi=[];
  for(const p of pts){
    while(lo.length>1&&cross(lo[lo.length-2],lo[lo.length-1],p)<=0) lo.pop();
    lo.push(p); }
  for(const p of pts.slice().reverse()){
    while(hi.length>1&&cross(hi[hi.length-2],hi[hi.length-1],p)<=0) hi.pop();
    hi.push(p); }
  return lo.slice(0,-1).concat(hi.slice(0,-1));
}

/* Draws the cyclone overlay on an existing Leaflet map; returns a cleanup fn.
 * Own panes: tracks below the labels pane and NON-interactive (province /
 * dam clicks must keep working); only the current-position marker interacts. */
function attachTcOverlay(map,tc,opts){
  opts=opts||{};
  const storms=(tc&&tc.storms||[]).filter(s=>s.relevant);
  if(!storms.length) return ()=>{};
  if(!map.getPane("tc")){ map.createPane("tc");
    map.getPane("tc").style.zIndex=450; map.getPane("tc").style.pointerEvents="none"; }
  if(!map.getPane("tcmark")){ map.createPane("tcmark"); map.getPane("tcmark").style.zIndex=660; }
  const layers=[];
  const add=l=>{l.addTo(map);layers.push(l);};
  storms.forEach((s,si)=>{
    const accent=TC_STORM_ACCENT[si%TC_STORM_ACCENT.length];
    // Cone only for NAMED storms. A not-yet-named depression's 90% area
    // spans half the basin even at 72 h (seen live 2026-09-10: two unnamed
    // systems washed the whole map purple) — the agencies draw no cone for
    // pre-named systems either; spaghetti + the animated swarm carry the
    // uncertainty for those.
    const named=s.named!==undefined?s.named:(s.name!==s.id);
    const cone=named?tcConePolygon(s.cone):null;
    if(cone) add(L.polygon(cone,{pane:"tc",stroke:true,color:"#8a5a9e",weight:1,
      opacity:.45,fillColor:"#8a5a9e",fillOpacity:.16}));
    // tracks are drawn out to +240 h: the far tail of a 360 h deterministic
    // run wanders enough to scribble over the map without informing anyone
    const clip=t=>t.filter(p=>p[0]<=240).map(p=>[p[1],p[2]]);
    Object.entries(s.members||{}).forEach(([src,tracks])=>{
      tracks.forEach(t=>{ const ll=clip(t); if(ll.length>1)
        add(L.polyline(ll,{pane:"tc",color:TC_SRC_COLOR[src]||"#888",
          weight:0.8,opacity:.25,interactive:false})); });
    });
    // deterministic / mean tracks drawn FAINT on purpose: one line is one
    // scenario with high uncertainty, and a bold solid track next to the
    // spaghetti reads as "the official forecast" — exactly the misreading
    // the wording rules forbid
    Object.entries(s.det||{}).forEach(([src,t])=>{ const ll=clip(t||[]);
      if(ll.length>1)
      add(L.polyline(ll,{pane:"tc",
        color:TC_DET_COLOR[src]||"#444",weight:1.2,opacity:.4,
        dashArray:src==="gefs_mean"?"6 4":null,interactive:false})); });
    const c=s.current||{};
    if(c.lat!=null){
      const cls=tcClass(c.cap_gio);
      const mk=L.circleMarker([c.lat,c.lon],{pane:"tcmark",radius:8,color:"#fff",
        weight:2,fillColor:accent,fillOpacity:.95});
      mk.bindTooltip(`${cls} ${tcName(s)}`,{direction:"top",offset:[0,-8]});
      // permanent id label so the reference dot is identifiable without
      // hover (and tellable apart from another storm's forecast icon
      // nearby). current.h > 0 = the ensemble only resolves this system
      // from that lead (genesis): say so instead of claiming "hiện tại".
      const when=(c.h==null||c.h<=6)?"hiện tại":`bắt đầu +${c.h}h`;
      add(L.marker([c.lat,c.lon],{pane:"tcmark",interactive:false,
        icon:L.divIcon({className:"",iconSize:[86,14],iconAnchor:[43,-7],
          html:`<div style='text-align:center;font-size:9.5px;font-weight:700;`+
               `color:${accent};text-shadow:0 0 3px #fff,0 0 3px #fff'>`+
               `${s.named!==undefined?(s.named?s.name:s.id):s.name} · ${when}</div>`})}));
      const nSrc=Object.entries(s.members_n||{}).map(([k,n])=>`${TC_SRC_LABEL[k]||k}: ${n} thành viên`).join("<br>");
      mk.bindPopup(`<b>${cls} ${tcName(s)}${(s.named===undefined?s.name!==s.id:s.named)?` (${s.id})`:""}</b><br>`+
        (c.cap_gio?`Cấp gió hiện tại (mô hình): <b>cấp ${c.cap_gio}</b><br>`:"")+
        (c.wind_ms!=null?`Gió ${Math.round(c.wind_ms)} m/s · ${c.pres_hpa||"–"} hPa<br>`:"")+
        nSrc+`<br><i>Hướng đi tham khảo từ các mô hình quốc tế — theo dõi bản tin chính thức của NCHMF.</i>`);
      add(mk);
    }
  });

  /* -- track animation: a compact player centred at the bottom of the map.
   * Steps through the shared 6-hourly lead axis; at each lead a 🌀 icon sits
   * on the ensemble centroid (the cone's centre line) and one small dot per
   * member shows the spread at that hour — the swarm widening over time IS
   * the uncertainty message. The static analysis dot stays put. */
  const leads=[...new Set(storms.flatMap(s=>(s.cone||[]).filter(c=>c.h<=120).map(c=>c.h)))]
    .sort((a,b)=>a-b);
  let timer=null,li=0,ctl=null,syncToImpl=null;
  if(leads.length>1){
    const swarm=L.layerGroup(); swarm.addTo(map); layers.push(swarm);
    const runMs=Date.parse(tc.run_utc);
    ctl=document.createElement("div");
    ctl.style.cssText="position:absolute;left:50%;transform:translateX(-50%);bottom:76px;"+
      "z-index:800;background:rgba(28,37,48,.92);color:#fff;border-radius:20px;"+
      "padding:6px 14px;display:flex;gap:10px;align-items:center;"+
      "box-shadow:0 2px 10px rgba(0,0,0,.3);font:12px/1.2 'Segoe UI',Roboto,sans-serif;";
    const btn=document.createElement("button");
    btn.textContent="▶"; btn.title="Chạy mô phỏng đường đi bão";
    btn.style.cssText="border:0;background:none;color:#ffd54a;font-size:16px;cursor:pointer;padding:0;";
    const rng=document.createElement("input");
    rng.type="range"; rng.min=0; rng.max=String(leads.length-1); rng.value=0;
    rng.style.cssText="width:140px;accent-color:#ffd54a;";
    const lab=document.createElement("span"); lab.style.whiteSpace="nowrap";
    ctl.append("🌀",btn,rng,lab);
    L.DomEvent.disableClickPropagation(ctl);   // slider drags must not pan the map
    map.getContainer().appendChild(ctl);
    // `fire` distinguishes user interaction from the initial draw: onLead
    // switches the page to the matching rain frame, and doing that on page
    // load would hijack the default view before the user touched anything
    const setLead=(k,fire)=>{
      li=k; const h=leads[k]; swarm.clearLayers();
      storms.forEach((s,si)=>{
        const accent=TC_STORM_ACCENT[si%TC_STORM_ACCENT.length];
        const pos=[];   // every member position at this lead, all sources
        Object.entries(s.members||{}).forEach(([src,tracks])=>{
          tracks.forEach(t=>{ const p=t.find(q=>q[0]===h); if(p){
            pos.push([p[1],p[2]]);
            swarm.addLayer(L.circleMarker([p[1],p[2]],{pane:"tcmark",radius:2.2,
              stroke:false,fillColor:TC_SRC_COLOR[src]||"#888",fillOpacity:.55,
              interactive:false})); } });
        });
        // the storm icon sits on the MEDOID (the member minimizing summed
        // distance to all others), never the mean: when the cloud splits
        // into clusters the mean lands in empty water between them (seen
        // live 2026-09-10, 70W's mean near Manila with no member nearby)
        let best=null,bestD=Infinity;
        for(const a of pos){ let d=0;
          for(const b of pos) d+=Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1]);
          if(d<bestD){bestD=d;best=a;} }
        // with several simultaneous systems the icons need names: tag each
        // 🌀 with the storm's id/name so two depressions stay tellable apart
        if(best) swarm.addLayer(L.marker(best,{pane:"tcmark",interactive:false,
          icon:L.divIcon({className:"",iconSize:[70,40],iconAnchor:[35,13],
            html:"<div style='text-align:center'>"+
                 "<div style='font-size:22px;line-height:26px;"+
                 "filter:drop-shadow(0 0 3px #fff)'>🌀</div>"+
                 `<div style='font-size:9.5px;font-weight:700;color:${accent};`+
                 "text-shadow:0 0 3px #fff,0 0 3px #fff'>"+
                 (s.named!==undefined?(s.named?s.name:s.id):s.name)+" · dự báo</div></div>"})}));
      });
      if(fire&&opts.onLead) opts.onLead(h, runMs+h*3600e3);
      const ict=new Date(runMs+h*3600e3+7*3600e3);
      const p2=n=>String(n).padStart(2,"0");
      lab.textContent=`+${h}h · ${p2(ict.getUTCHours())}:00 ${p2(ict.getUTCDate())}/${p2(ict.getUTCMonth()+1)} ICT`;
      rng.value=String(k);
    };
    const stop=()=>{ btn.textContent="▶"; if(timer){clearInterval(timer);timer=null;} };
    btn.onclick=()=>{ if(timer){stop();return;} btn.textContent="❚❚";
      timer=setInterval(()=>setLead((li+1)%leads.length,true),700); };
    rng.oninput=()=>{ stop(); setLead(+rng.value,true); };
    setLead(0,false);
    // reverse sync: the RAIN timeline drives the cyclone display to the
    // same valid time. Does not fire onLead (no feedback loop) and yields
    // while the TC player's own autoplay is running — whichever animation
    // the user started stays the driver until they stop it.
    syncToImpl=(ms,gate)=>{
      if(timer) return;
      let bi=-1,bd=Infinity;
      leads.forEach((h,i)=>{const d=Math.abs(runMs+h*3600e3-ms);if(d<bd){bd=d;bi=i;}});
      if(bi>=0&&bd<=(gate||3*3600e3+6e4)) setLead(bi,false);
    };
  }
  const cleanup=()=>{ if(timer)clearInterval(timer); if(ctl)ctl.remove();
    layers.forEach(l=>map.removeLayer(l)); };
  cleanup.syncTo=(ms,gate)=>{ if(syncToImpl) syncToImpl(ms,gate); };
  return cleanup;
}

// legend key: a short line sample (solid / dashed / thin) + label
function TcKey({color,label,dash,thin,swatch}){
  return <div className="legend-row" style={{padding:"1.5px 0"}}>
    {swatch
      ?<span className="swatch" style={{background:color,border:"1px solid rgba(0,0,0,.2)"}}/>
      :<svg width="26" height="10" style={{flex:"0 0 auto"}}><line x1="1" y1="5" x2="25" y2="5"
        stroke={color} strokeWidth={thin?1.2:2.4} strokeDasharray={dash?"5 3":null}/></svg>}
    <span style={{fontSize:12}}>{label}</span>
  </div>;
}

// Vietnamese how-to-read guide for the cyclone layer (collapsible in the
// banner) — the spaghetti/cone presentation is unfamiliar to most visitors,
// and misreading it (e.g. treating one line as THE forecast) is exactly the
// failure mode the plan's wording rules exist to prevent.
function TcHowTo({hasCone,detSrcs}){
  const row=(icon,text)=><div style={{display:"flex",gap:8,alignItems:"flex-start",margin:"4px 0"}}>
    <span style={{flex:"0 0 26px",textAlign:"center"}}>{icon}</span>
    <span style={{fontSize:12,lineHeight:1.45}}>{text}</span></div>;
  return <div style={{marginTop:4}}>
    {row(<svg width="26" height="14">{[2,5,8,11].map((y,i)=><path key={i}
        d={`M1 ${y} Q 13 ${y+(i%2?3:-2)} 25 ${y+(i-1)}`} fill="none"
        stroke="#f0902a" strokeWidth="1" opacity=".6"/>)}</svg>,
      <>Mỗi <b>đường mảnh</b> là một kịch bản đường đi từ một thành viên của tổ
      hợp (mỗi màu tương ứng với một mô hình). Các đường <b>tụm sát nhau</b> cho
      thấy các mô hình khá thống nhất; chùm đường càng <b>xòe rộng</b> thì dự
      báo kém chắc chắn hơn. Điều quan trọng là nhìn vào cả chùm dự báo, không
      chỉ một đường riêng lẻ.</>)}
    {hasCone&&row(<svg width="26" height="14"><ellipse cx="13" cy="7" rx="12" ry="6"
        fill="#8a5a9e" fillOpacity=".25" stroke="#8a5a9e" strokeWidth="1"/></svg>,
      <>Vùng tím là <b>vùng tin cậy 90%</b>: khoảng 9/10 khả năng <b>tâm</b> xoáy
      thuận nằm trong vùng này ở mỗi thời điểm. Vùng càng xa càng rộng vì độ bất
      định tăng theo thời gian. Lưu ý: đây là vùng của <b>tâm</b> — gió mạnh và
      mưa lớn trải rộng ra ngoài vùng này. (Chỉ vẽ cho bão đã đặt tên — áp thấp
      chưa đặt tên phân tán quá rộng, chùm kịch bản tự nói lên độ bất định.)</>)}
    {(detSrcs||[]).length>0&&row(<svg width="26" height="14"><line x1="1" y1="7" x2="25" y2="7"
        stroke="#1d5e9e" strokeWidth="1.3" strokeDasharray="5 3" opacity=".55"/></svg>,
      <>Đường xanh <b>đứt nét mảnh</b> (trung bình tổ hợp GEFS) là dự báo trung
      bình của trung tâm NCEP, <b>chỉ một kịch bản đơn lẻ</b>, độ bất định cao,
      không nhất thiết chính xác hơn so với các thành viên tổ hợp xung quanh
      nó.</>)}
    {row(<svg width="26" height="14"><circle cx="13" cy="7" r="5" fill="#c0392b"
        stroke="#fff" strokeWidth="1.5"/></svg>,
      <>Chấm đỏ là <b>vị trí tâm hiện tại</b> (giờ phân tích của mô hình). Nhấp
      vào để xem cấp gió, khí áp và số thành viên của từng mô hình.</>)}
    {row(<span style={{fontSize:13}}>▶🌀</span>,
      <>Thanh <b>mô phỏng</b> ở giữa phía dưới bản đồ: bấm ▶ (hoặc kéo thanh
      trượt) để xem tâm dự báo di chuyển theo từng bước 6 giờ; bản đồ mưa và
      tâm bão luôn kéo nhau về cùng một thời điểm, dù bạn chạy thanh nào.
      Biểu tượng 🌀 là
      vị trí <b>điển hình</b> — thành viên nằm giữa chùm, không phải trung bình
      cộng; đám chấm nhỏ quanh nó là vị trí của từng thành viên
      — đám chấm càng loang rộng, dự báo càng bất định.</>)}
    {row(<b style={{fontSize:12}}>%</b>,
      <>Con số phần trăm trong thẻ này là <b>tỉ lệ thành viên tổ hợp</b> đưa xoáy
      thuận vào vùng ven biển Việt Nam — một thước đo xác suất, không phải lời
      khẳng định bão sẽ đổ bộ.</>)}
    <p className="hint" style={{margin:"4px 0 0"}}>Luôn đối chiếu với bản tin
      chính thức của Trung tâm Dự báo KTTV Quốc gia (NCHMF) trước khi hành động.</p>
  </div>;
}

// Banner card for the top-left stack when a relevant storm exists. The storm
// headlines are always visible; everything else (legend, guide, scale,
// attribution) collapses behind one toggle — with two systems live the full
// card was crowding out the rest of the panel, so it starts collapsed.
function TcBanner({tc}){
  const [open,setOpen]=React.useState(false);
  const [showScale,setShowScale]=React.useState(false);
  const [showHow,setShowHow]=React.useState(false);
  const storms=(tc&&tc.storms||[]).filter(s=>s.relevant);
  if(!storms.length) return null;
  // legend only for the sources actually present in the data
  const memSrcs=[...new Set(storms.flatMap(s=>Object.keys(s.members||{})))];
  const detSrcs=[...new Set(storms.flatMap(s=>Object.keys(s.det||{})))];
  return <div className="card pad" style={{borderLeft:"4px solid #c0392b"}}>
    {storms.map((s,si)=>{
      const accent=TC_STORM_ACCENT[si%TC_STORM_ACCENT.length];
      const cap=s.current&&s.current.cap_gio;
      const hit=s.vn_hit||{}; const w=hit.window;
      const fmt=t=>t?`${hhmm(t)} ${dm(t)}`:"";
      return <div key={s.id} style={{marginBottom:6}}>
        <p className="title" style={{marginBottom:3}}>
          <span style={{display:"inline-block",width:10,height:10,borderRadius:"50%",
            background:accent,marginRight:6}}/>
          {tcClass(cap)} {tcName(s)}{cap?` — cấp ${cap} (theo mô hình)`:""}</p>
        {hit.hit_frac>0&&w&&<p className="hint" style={{margin:0}}>
          {Math.round(hit.hit_frac*100)}% thành viên tổ hợp IFS-ENS đưa xoáy thuận
          vào vùng ven biển Việt Nam, khoảng {fmt(w.from_ict)} – {fmt(w.to_ict)} ICT.</p>}
      </div>;})}
    <button className="btn-link" onClick={()=>setOpen(v=>!v)} style={{marginTop:2}}>
      {open?"▴ Thu gọn chú giải & hướng dẫn":"▾ Chú giải & hướng dẫn"}</button>
    {open&&<>
    <p className="lbl" style={{margin:"8px 0 3px"}}>Chú giải đường đi</p>
    {memSrcs.map(k=><TcKey key={k} thin color={TC_SRC_COLOR[k]||"#888"}
      label={`${TC_SRC_LABEL[k]||k} — từng thành viên tổ hợp`}/>)}
    {detSrcs.map(k=><TcKey key={k} thin color={TC_DET_COLOR[k]||"#444"} dash={k==="gefs_mean"}
      label={`${TC_SRC_LABEL[k]||k} — ${k==="gefs_mean"?"trung bình tổ hợp":"tất định"} (chỉ một kịch bản, độ bất định cao)`}/>)}
    {storms.some(s=>s.named!==undefined?s.named:(s.name!==s.id))&&
      <TcKey color="#8a5a9e" swatch label="Vùng tin cậy 90% vị trí tâm (tổ hợp IFS-ENS — chỉ bão đã đặt tên)"/>}
    <TcKey color="#c0392b" swatch label="Vị trí tâm hiện tại"/>
    <button className="btn-link" onClick={()=>setShowHow(v=>!v)} style={{marginRight:12}}>
      {showHow?"Ẩn hướng dẫn":"Cách đọc bản đồ đường đi ❓"}</button>
    <button className="btn-link" onClick={()=>setShowScale(v=>!v)}>
      {showScale?"Ẩn thang phân loại":"Thang phân loại xoáy thuận nhiệt đới"}</button>
    {showHow&&<TcHowTo detSrcs={detSrcs}
      hasCone={storms.some(s=>s.named!==undefined?s.named:(s.name!==s.id))}/>}
    {showScale&&<div style={{marginTop:4}}>
      {[...TC_CLASSES].reverse().map(c=><div key={c.min} className="legend-row" style={{padding:"1.5px 0"}}>
        <span style={{fontSize:12}}><b>{c.label}</b> — {c.caps}
          {c.min>=6&&c.min<8?" (gió 39–61 km/h)":c.min===8?" (62–88 km/h)":
           c.min===10?" (89–117 km/h)":c.min===12?" (118–183 km/h)":
           c.min===16?" (từ 184 km/h)":""}</span></div>)}
      <p className="hint" style={{margin:"3px 0 0"}}>Theo thang cấp gió Việt Nam
        (Quyết định 18/2021/QĐ-TTg). Cấp hiển thị được ước tính từ gió mô hình,
        có thể khác cấp trong bản tin chính thức.</p>
    </div>}
    <p className="hint" style={{margin:"6px 0 0"}}>Hướng đi tham khảo từ các mô
      hình quốc tế — <b>không</b> thay thế bản tin chính thức của NCHMF.
      Nguồn: ECMWF (CC-BY-4.0) · NOAA/NCEP.</p>
    </>}
  </div>;
}

window.QPFShared = { DOW, MODEL_COLOR, FIELDS, FIELD_ORDER, PROB_BINS, INT_BINS,
  j, dmy, dm, dow, hhmm, num, norm, binsFor, colorFor,
  winTiles, stepTiles, PAD, niceMax, Axes, Timeline, OffGridNote, Credit,
  attachTcOverlay, TcBanner };
})();
