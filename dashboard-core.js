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
  int:{key:"int",label:"Cường độ mưa",kind:"step",unit:"mm/bước"},
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
const INT_BINS = [
  {min:0.5,max:2,color:"#c7e9c0",label:"0,5–2 mm"},{min:2,max:5,color:"#7fcdbb",label:"2–5"},
  {min:5,max:10,color:"#41b6c4",label:"5–10"},{min:10,max:20,color:"#1d91c0",label:"10–20"},
  {min:20,max:35,color:"#225ea8",label:"20–35"},{min:35,max:null,color:"#7a0177",label:"> 35"},
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

window.QPFShared = { DOW, MODEL_COLOR, FIELDS, FIELD_ORDER, PROB_BINS, INT_BINS,
  j, dmy, dm, dow, hhmm, num, norm, binsFor, colorFor,
  winTiles, stepTiles, PAD, niceMax, Axes, Timeline, OffGridNote, Credit };
})();
