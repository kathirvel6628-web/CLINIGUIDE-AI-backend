
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;
let db;

// ===== TWILIO - MOCK BY DEFAULT (No keys needed for hackathon) =====
let twilioClient = null;
let TWILIO_WHATSAPP_NUMBER = null;
try {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const wnum = process.env.TWILIO_WHATSAPP_NUMBER;
  if(sid && sid.startsWith('AC') && token && wnum && wnum.includes('whatsapp:') && wnum.length > 15 && !wnum.includes('value')){
    const twilio = require('twilio');
    twilioClient = twilio(sid, token);
    TWILIO_WHATSAPP_NUMBER = wnum;
    console.log('[TWILIO] REAL mode - WhatsApp:', wnum);
  } else {
    console.log('[TWILIO] MOCK FINAL mode - No valid keys, using logs. Perfect for hackathon.');
  }
} catch(e){
  console.log('[TWILIO] MOCK FINAL mode - twilio package not installed or error:', e.message);
}

async function sendWA(to, message){
  if(!to) return false;
  let num = to.toString().replace(/[^0-9+]/g,'');
  if(!num.startsWith('+')) num = '+' + num;
  const waTo = 'whatsapp:' + num;
  
  // MOCK MODE - For hackathon demo - shows in Render logs
  if(!twilioClient){
    console.log(`[MOCK WA to ${num}]: ${message}`);
    return true;
  }
  
  // REAL MODE - For production with Twilio sandbox
  try {
    const msg = await twilioClient.messages.create({
      from: TWILIO_WHATSAPP_NUMBER,
      to: waTo,
      body: message
    });
    console.log(`[REAL WA SENT] to ${num} SID:${msg.sid}`);
    return true;
  } catch(err){
    console.log(`[REAL WA FAILED] to ${waTo} ERROR:${err.message} CODE:${err.code}`);
    if(err.code === 21654) console.log('HINT: Trial needs ContentSid. Use MOCK for hackathon by deleting Twilio env vars.');
    if(err.code === 63007) console.log('HINT: Recipient must send join <code> to +14155238886 first. Error 63007 = not in sandbox.');
    if(err.code === 21211) console.log('HINT: Invalid number format. Use 91 + number.');
    // Fallback to MOCK log so demo still works
    console.log(`[MOCK FALLBACK to ${num}]: ${message}`);
    return true;
  }
}

// ===== DB SETUP =====
function initDB(){
  return new Promise((resolve, reject)=>{
    const dbPath = path.join(__dirname, 'cliniguide.db');
    const database = new sqlite3.Database(dbPath, (err)=>{
      if(err){ console.error('DB open error', err); reject(err); return; }
      console.log('DB opened at', dbPath);
      database.serialize(()=>{
        database.run(`CREATE TABLE IF NOT EXISTS patients (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT,
          patient_phone TEXT,
          guardian1 TEXT,
          guardian2 TEXT,
          guardian3 TEXT,
          language TEXT DEFAULT 'en',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        database.run(`CREATE TABLE IF NOT EXISTS medicines (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER,
          drug_name TEXT,
          dosage TEXT,
          raw_line TEXT,
          FOREIGN KEY(patient_id) REFERENCES patients(id)
        )`);
        database.run(`CREATE TABLE IF NOT EXISTS doses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER,
          medicine_id INTEGER,
          drug_name TEXT,
          dosage TEXT,
          scheduled_date TEXT,
          scheduled_time TEXT,
          day_number INTEGER,
          total_days INTEGER,
          status TEXT DEFAULT 'pending',
          missed_count INTEGER DEFAULT 0,
          FOREIGN KEY(patient_id) REFERENCES patients(id)
        )`);
        // Add language column if not exists (for old DB)
        database.run(`ALTER TABLE patients ADD COLUMN language TEXT DEFAULT 'en'`, ()=>{});
      });
      // Promisify
      database.getAsync = (sql, params=[])=> new Promise((res, rej)=>{ database.get(sql, params, (e,row)=> e?rej(e):res(row)); });
      database.allAsync = (sql, params=[])=> new Promise((res, rej)=>{ database.all(sql, params, (e,rows)=> e?rej(e):res(rows)); });
      database.runAsync = (sql, params=[])=> new Promise((res, rej)=>{ database.run(sql, params, function(e){ e?rej(e):res(this); }); });
      // Legacy compatibility for old code using .all/.get
      database.all = database.allAsync;
      database.get = database.getAsync;
      database.run = database.runAsync;
      resolve(database);
    });
  });
}

// ===== ROUTES =====
app.get('/', (req,res)=> res.json({ok:true, mode: twilioClient?'REAL':'MOCK FINAL', message:'CliniGuide AI Backend with Language Support - MOCK works for hackathon'}));

app.get('/api/test-wa', async(req,res)=>{
  const to = req.query.to || '919025226305';
  const ok = await sendWA(to, 'Test from CliniGuide AI - MOCK/REAL mode working! Time:'+new Date().toISOString());
  res.json({ok, mode: twilioClient?'REAL':'MOCK FINAL', to});
});

app.post('/api/register', async(req,res)=>{
  try{
    const {name, patient_phone, guardian1, guardian2, guardian3, language} = req.body;
    if(!patient_phone || !guardian1) return res.json({ok:false, error:'patient_phone and guardian1 required'});
    await db.runAsync("DELETE FROM doses");
    await db.runAsync("DELETE FROM medicines");
    await db.runAsync("DELETE FROM patients");
    const result = await db.runAsync("INSERT INTO patients (name, patient_phone, guardian1, guardian2, guardian3, language) VALUES (?,?,?,?,?,?)",
      [name||'', patient_phone, guardian1, guardian2||'', guardian3||'', language||'en']);
    console.log(`[REGISTER] Patient ${name} Lang:${language} Phone:${patient_phone} Guardian:${guardian1}`);
    res.json({ok:true, id: result.lastID, language: language||'en'});
  }catch(e){ console.error(e); res.json({ok:false, error:e.message}); }
});

app.post('/api/medicines', async(req,res)=>{
  try{
    const {medicines, language} = req.body;
    if(!medicines || !medicines.length) return res.json({ok:false, error:'no medicines'});
    const patient = await db.getAsync("SELECT * FROM patients ORDER BY id DESC LIMIT 1");
    if(!patient) return res.json({ok:false, error:'no patient registered'});
    if(language){ await db.runAsync("UPDATE patients SET language=? WHERE id=?", [language, patient.id]); }
    await db.runAsync("DELETE FROM doses WHERE patient_id=?", [patient.id]);
    await db.runAsync("DELETE FROM medicines WHERE patient_id=?", [patient.id]);
    
    let totalDoses = 0;
    const today = new Date();
    for(let med of medicines){
      const medRes = await db.runAsync("INSERT INTO medicines (patient_id, drug_name, dosage, raw_line) VALUES (?,?,?,?)",
        [patient.id, med.drug_name, med.dosage||'', med.drug_name]);
      const medId = medRes.lastID;
      const totalDays = parseInt(med.days)||7;
      const times = med.times && med.times.length ? med.times : ['09:00'];
      for(let day=0; day<totalDays; day++){
        const d = new Date(today); d.setDate(today.getDate()+day);
        const dateStr = d.toISOString().slice(0,10);
        for(let t of times){
          let timeStr = t.trim();
          // Normalize to HH:MM 24h
          const m = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
          if(m){
            let h=parseInt(m[1]); const min=m[2]; const ap=(m[3]||'').toUpperCase();
            if(ap==='PM' && h<12) h+=12; if(ap==='AM' && h===12) h=0;
            timeStr = String(h).padStart(2,'0')+':'+min;
          }
          await db.runAsync("INSERT INTO doses (patient_id, medicine_id, drug_name, dosage, scheduled_date, scheduled_time, day_number, total_days) VALUES (?,?,?,?,?,?,?,?)",
            [patient.id, medId, med.drug_name, med.dosage||'', dateStr, timeStr, day+1, totalDays]);
          totalDoses++;
        }
      }
    }
    console.log(`[MEDICINES] ${medicines.length} medicines -> ${totalDoses} doses created Lang:${language||patient.language}`);
    res.json({ok:true, totalDoses, count: medicines.length, language: language||patient.language});
  }catch(e){ console.error(e); res.json({ok:false, error:e.message}); }
});

app.get('/api/doses/today', async(req,res)=>{
  try{
    const today = new Date().toISOString().slice(0,10);
    const doses = await db.allAsync("SELECT * FROM doses WHERE scheduled_date=? ORDER BY scheduled_time", [today]);
    res.json(doses);
  }catch(e){ res.json([]); }
});

app.post('/api/doses/:id/taken', async(req,res)=>{
  try{
    await db.runAsync("UPDATE doses SET status='taken' WHERE id=?", [req.params.id]);
    res.json({ok:true});
  }catch(e){ res.json({ok:false}); }
});

app.post('/api/sos', async(req,res)=>{
  try{
    const patient = await db.getAsync("SELECT * FROM patients ORDER BY id DESC LIMIT 1");
    if(!patient) return res.json({ok:false, error:'no patient'});
    const lang = patient.language || 'en';
    const msgEn = `SOS! Patient ${patient.name} needs help! Phone:${patient.patient_phone} - Please check immediately!`;
    const msgTa = `SOS! நோயாளி ${patient.name} க்கு உதவி தேவை! தொலைபேசி:${patient.patient_phone} உடனே பார்க்கவும்!`;
    const msg = lang==='ta'?msgTa:msgEn;
    if(patient.guardian1) await sendWA(patient.guardian1, msg);
    if(patient.guardian2) await sendWA(patient.guardian2, msg);
    if(patient.guardian3) await sendWA(patient.guardian3, msg);
    console.log(`[SOS] Lang:${lang} Sent to guardians`);
    res.json({ok:true});
  }catch(e){ res.json({ok:false, error:e.message}); }
});

// ===== CRON - IST TIMEZONE - 0min to patient, 3rd min to guardian GUARANTEED =====
cron.schedule('* * * * *', async()=>{
  try{
    if(!db) return;
    const today = new Date().toISOString().slice(0,10);
    const now = new Date();
    const istNow = new Date(now.toLocaleString("en-US",{timeZone:"Asia/Kolkata"}));
    const nowM = istNow.getHours()*60 + istNow.getMinutes();
    const pending = await db.allAsync("SELECT * FROM doses WHERE scheduled_date=? AND status='pending'", [today]);
    if(!pending.length) return;
    const groups={}; pending.forEach(d=>{ if(!groups[d.scheduled_time]) groups[d.scheduled_time]=[]; groups[d.scheduled_time].push(d); });

    for(let time in groups){
      const list = groups[time];
      const [h,m] = time.split(':').map(Number); if(isNaN(h)) continue;
      const schedM = h*60 + m;
      const diff = nowM - schedM;
      if(diff < 0) continue;
      const patient = await db.getAsync("SELECT * FROM patients WHERE id=?", [list[0].patient_id]);
      if(!patient) continue;
      const mc = list[0].missed_count;
      const lang = patient.language || 'en';

      const names = list.map(d=>d.drug_name).join(', ');

      if(diff>=0 && mc===0){
        let msg = lang==='ta' ? `நாள் ${list[0].day_number}/${list[0].total_days} - ${time} மணிக்கு ${list.length} மருந்துகள்: ${names}` : `Day ${list[0].day_number}/${list[0].total_days} Time for ${list.length} medicines at ${time}: ${names}`;
        await sendWA(patient.patient_phone, msg);
        for(let d of list) await db.runAsync("UPDATE doses SET missed_count=1 WHERE id=?", [d.id]);
        console.log(`[AUTO 0min] to PATIENT ${patient.patient_phone} at ${time} Lang:${lang}`);
      }
      else if(diff>=1 && mc===1){
        let msg = lang==='ta' ? `1வது நினைவூட்டல் (1 நிமிடம் தவறியது): ${names}` : `1st Reminder (1 min missed): ${list.length} medicines at ${time}: ${names}`;
        await sendWA(patient.patient_phone, msg);
        for(let d of list) await db.runAsync("UPDATE doses SET missed_count=2 WHERE id=?", [d.id]);
      }
      else if(diff>=2 && mc===2){
        let msg = lang==='ta' ? `2வது நினைவூட்டல் (2 நிமிடம்): ${names}` : `2nd Reminder (2 mins missed): ${names}`;
        await sendWA(patient.patient_phone, msg);
        for(let d of list) await db.runAsync("UPDATE doses SET missed_count=3 WHERE id=?", [d.id]);
      }
      else if(diff>=3 && mc<4){ // FIXED: mc<4 guarantees guardian even if Render slept
        let msg = lang==='ta' ? `தவறியது: நோயாளி ${patient.name||''} ${time} மணி மருந்து தவறவிட்டார்: ${names} நாள் ${list[0].day_number}/${list[0].total_days} Patient +${patient.patient_phone}` : `Missed: Patient ${patient.name||''} missed ${list.length} medicines at ${time}: ${names} Day ${list[0].day_number}/${list[0].total_days} Patient +${patient.patient_phone}`;
        console.log(`[AUTO 3min] WARNING to GUARDIANS Lang:${lang}: ${msg}`);
        if(patient.guardian1){ await sendWA(patient.guardian1, msg); console.log(`-> Sent to Guardian1 ${patient.guardian1}`); }
        if(patient.guardian2){ await sendWA(patient.guardian2, msg); console.log(`-> Sent to Guardian2 ${patient.guardian2}`); }
        if(patient.guardian3){ await sendWA(patient.guardian3, msg); console.log(`-> Sent to Guardian3 ${patient.guardian3}`); }
        for(let d of list) await db.runAsync("UPDATE doses SET missed_count=4, status='missed' WHERE id=?", [d.id]);
      }
    }
  }catch(e){ console.error('[CRON ERROR]', e.message); }
});

// ===== START =====
initDB().then(database=>{
  db=database;
  app.listen(PORT, ()=> console.log(`CliniGuide AI Backend Running on ${PORT} Mode:${twilioClient?'REAL':'MOCK FINAL'} with Language Support`));
}).catch(err=>{ console.error('Failed to init DB', err); process.exit(1); });
