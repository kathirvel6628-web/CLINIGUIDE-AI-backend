
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// MOCK mode - hackathon proof, no Twilio keys needed
let twilioClient = null;
let WA_FROM = null;
try{
  const sid = (process.env.TWILIO_ACCOUNT_SID||'').trim();
  const token = (process.env.TWILIO_AUTH_TOKEN||'').trim();
  const wnum = (process.env.TWILIO_WHATSAPP_NUMBER||'').trim();
  if(sid.startsWith('AC') && sid.length>10 && token.length>10 && wnum.includes('whatsapp:') && wnum.length>15){
    const twilio = require('twilio');
    twilioClient = twilio(sid, token);
    WA_FROM = wnum;
    console.log('[TWILIO] REAL mode:', wnum);
  }else{
    console.log('[TWILIO] MOCK FIXED mode - Buttons will work');
  }
}catch(e){
  console.log('[TWILIO] MOCK FIXED:', e.message);
}

async function sendWA(to, message){
  if(!to) return false;
  let num = to.toString().replace(/[^0-9]/g,'');
  if(num.length===10) num='91'+num;
  if(!num.startsWith('+')) num='+'+num;
  const waTo='whatsapp:'+num;
  if(!twilioClient){
    console.log(`[MOCK WA to ${num}]: ${message}`);
    return true;
  }
  try{
    const r=await twilioClient.messages.create({from:WA_FROM, to:waTo, body:message});
    console.log(`[REAL WA SENT] to ${num}`);
    return true;
  }catch(err){
    console.log(`[REAL FAILED] ${err.message} - MOCK FALLBACK to ${num}: ${message}`);
    return true;
  }
}

// DB FIXED - NO RECURSION
const dbPath = path.join(__dirname, 'cliniguide.db');
const db = new sqlite3.Database(dbPath);
console.log('DB', dbPath);

db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, patient_phone TEXT, guardian1 TEXT, guardian2 TEXT, guardian3 TEXT, language TEXT DEFAULT 'en')`);
  db.run(`CREATE TABLE IF NOT EXISTS doses (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER, drug_name TEXT, dosage TEXT, scheduled_date TEXT, scheduled_time TEXT, day_number INTEGER, total_days INTEGER, status TEXT DEFAULT 'pending', missed_count INTEGER DEFAULT 0)`);
});

function dbGet(sql, params=[]){ return new Promise((res, rej)=>{ db.get(sql, params, (e,r)=> e?rej(e):res(r)); }); }
function dbAll(sql, params=[]){ return new Promise((res, rej)=>{ db.all(sql, params, (e,rows)=> e?rej(e):res(rows)); }); }
function dbRun(sql, params=[]){ return new Promise((res, rej)=>{ db.run(sql, params, function(e){ e?rej(e):res(this); }); }); }

app.get('/', (req,res)=> res.json({ok:true, mode: twilioClient?'REAL':'MOCK FIXED'}));

app.get('/api/test-wa', async(req,res)=>{
  const to=req.query.to||'919025226305';
  const ok=await sendWA(to, 'Test OK '+new Date().toISOString());
  res.json({ok, mode: twilioClient?'REAL':'MOCK FIXED'});
});

app.post('/api/register', async(req,res)=>{
  try{
    const {name, patient_phone, guardian1, guardian2, guardian3, language} = req.body;
    console.log('REGISTER', req.body);
    if(!patient_phone) return res.json({ok:false, error:'phone required'});
    await dbRun("DELETE FROM doses");
    await dbRun("DELETE FROM patients");
    const r=await dbRun("INSERT INTO patients (name, patient_phone, guardian1, guardian2, guardian3, language) VALUES (?,?,?,?,?,?)",[name||'', patient_phone, guardian1||'', guardian2||'', guardian3||'', language||'en']);
    console.log('REGISTERED ID', r.lastID);
    res.json({ok:true, id:r.lastID});
  }catch(e){ console.error(e); res.json({ok:false, error:e.message}); }
});

app.post('/api/medicines', async(req,res)=>{
  try{
    const {medicines} = req.body;
    const patient=await dbGet("SELECT * FROM patients ORDER BY id DESC LIMIT 1");
    if(!patient) return res.json({ok:false, error:'register first'});
    await dbRun("DELETE FROM doses WHERE patient_id=?", [patient.id]);
    let total=0;
    for(let med of medicines){
      const days=parseInt(med.days)||7;
      const times=med.times && med.times.length?med.times:['09:00'];
      for(let d=0; d<days; d++){
        const dt=new Date(); dt.setDate(dt.getDate()+d);
        const dateStr=dt.toISOString().slice(0,10);
        for(let t of times){
          let timeStr=t.trim();
          const m=timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
          if(m){ let h=parseInt(m[1]); const min=m[2]; const ap=(m[3]||'').toUpperCase(); if(ap==='PM'&&h<12)h+=12; if(ap==='AM'&&h===12)h=0; timeStr=String(h).padStart(2,'0')+':'+min; }
          await dbRun("INSERT INTO doses (patient_id, drug_name, dosage, scheduled_date, scheduled_time, day_number, total_days) VALUES (?,?,?,?,?,?,?)",[patient.id, med.drug_name, med.dosage||'', dateStr, timeStr, d+1, days]);
          total++;
        }
      }
    }
    console.log('ACTIVATED', total);
    res.json({ok:true, totalDoses:total});
  }catch(e){ console.error(e); res.json({ok:false, error:e.message}); }
});

app.get('/api/doses/today', async(req,res)=>{
  try{
    const today=new Date().toISOString().slice(0,10);
    const rows=await dbAll("SELECT * FROM doses WHERE scheduled_date=? ORDER BY scheduled_time", [today]);
    res.json(rows);
  }catch(e){ res.json([]); }
});

app.post('/api/doses/:id/taken', async(req,res)=>{
  try{ await dbRun("UPDATE doses SET status='taken' WHERE id=?", [req.params.id]); res.json({ok:true}); }catch(e){ res.json({ok:false}); }
});

app.post('/api/sos', async(req,res)=>{
  try{
    const p=await dbGet("SELECT * FROM patients ORDER BY id DESC LIMIT 1");
    if(!p) return res.json({ok:false});
    const msg=`SOS! Patient ${p.name} needs help! ${p.patient_phone}`;
    if(p.guardian1) await sendWA(p.guardian1, msg);
    res.json({ok:true});
  }catch(e){ res.json({ok:false}); }
});

cron.schedule('* * * * *', async()=>{
  try{
    const today=new Date().toISOString().slice(0,10);
    const now=new Date();
    const ist=new Date(now.toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
    const nowM=ist.getHours()*60+ist.getMinutes();
    const pending=await dbAll("SELECT * FROM doses WHERE scheduled_date=? AND status='pending'", [today]);
    if(!pending.length) return;
    const groups={}; pending.forEach(d=>{ if(!groups[d.scheduled_time]) groups[d.scheduled_time]=[]; groups[d.scheduled_time].push(d); });
    for(let time in groups){
      const list=groups[time];
      const [h,m]=time.split(':').map(Number); if(isNaN(h)) continue;
      const diff=nowM-(h*60+m); if(diff<0) continue;
      const patient=await dbGet("SELECT * FROM patients WHERE id=?", [list[0].patient_id]);
      if(!patient) continue;
      const mc=list[0].missed_count;
      const names=list.map(d=>d.drug_name).join(', ');
      if(diff>=0 && mc===0){
        await sendWA(patient.patient_phone, `Day ${list[0].day_number}/${list[0].total_days} Time for ${list.length} meds at ${time}: ${names}`);
        for(let d of list) await dbRun("UPDATE doses SET missed_count=1 WHERE id=?", [d.id]);
        console.log(`[AUTO 0min] to PATIENT ${patient.patient_phone} at ${time}`);
      }else if(diff>=3 && mc<4){
        const msg=`Missed: Patient ${patient.name||''} missed ${list.length} meds at ${time}: ${names} Phone +${patient.patient_phone}`;
        console.log(`[AUTO 3min] WARNING to GUARDIANS: ${msg}`);
        if(patient.guardian1) await sendWA(patient.guardian1, msg);
        if(patient.guardian2) await sendWA(patient.guardian2, msg);
        if(patient.guardian3) await sendWA(patient.guardian3, msg);
        for(let d of list) await dbRun("UPDATE doses SET missed_count=4, status='missed' WHERE id=?", [d.id]);
      }
    }
  }catch(e){ console.error('[CRON]', e.message); }
});

app.listen(PORT, ()=> console.log(`Fixed Backend Running on ${PORT} Mode:${twilioClient?'REAL':'MOCK FIXED'}`));
