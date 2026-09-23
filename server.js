const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());
const PORT = process.env.PORT || 10000;

// ===== 6 LANGUAGE CONTENT SIDs - YOUR APPROVED + FUTURE ONES =====
// You have 1 now (EN). Create 5 more using texts below, then add their HX to Render env.
// If env not set, it falls back to EN - so everything works even with 1 template!
const CONTENT_SIDS = {
  en: process.env.TWILIO_CONTENT_SID_EN || process.env.TWILIO_CONTENT_SID || 'HXa24e7092cda5c369dbcf9060f64f9588',
  ta: process.env.TWILIO_CONTENT_SID_TA || process.env.TWILIO_CONTENT_SID || 'HXa24e7092cda5c369dbcf9060f64f9588',
  hi: process.env.TWILIO_CONTENT_SID_HI || process.env.TWILIO_CONTENT_SID || 'HXa24e7092cda5c369dbcf9060f64f9588',
  te: process.env.TWILIO_CONTENT_SID_TE || process.env.TWILIO_CONTENT_SID || 'HXa24e7092cda5c369dbcf9060f64f9588',
  ml: process.env.TWILIO_CONTENT_SID_ML || process.env.TWILIO_CONTENT_SID || 'HXa24e7092cda5c369dbcf9060f64f9588',
  kn: process.env.TWILIO_CONTENT_SID_KN || process.env.TWILIO_CONTENT_SID || 'HXa24e7092cda5c369dbcf9060f64f9588',
};

// Language code mapping from frontend
const LANG_MAP = {
  'English': 'en', 'Tamil': 'ta', 'Hindi': 'hi',
  'Telugu': 'te', 'Malayalam': 'ml', 'Kannada': 'kn',
  'en': 'en', 'ta': 'ta', 'hi': 'hi', 'te': 'te', 'ml': 'ml', 'kn': 'kn'
};

const DB_PATH = path.join(__dirname, 'cliniguide.db');
const db = new sqlite3.Database(DB_PATH);
db.run(`CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT, patientName TEXT, medicine TEXT,
  patientNumber TEXT, patientPhone TEXT,
  guardianNumber TEXT, guardianPhone TEXT,
  guardian2 TEXT, guardian3 TEXT,
  time TEXT, language TEXT, mode TEXT,
  active INTEGER DEFAULT 1, createdAt TEXT
)`);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
let client = null; let twilioReady = false;
if (accountSid && authToken) {
  client = twilio(accountSid, authToken);
  twilioReady = true;
  console.log(`[TWILIO] REAL MODE: ${fromNumber}`);
  console.log(`[CONTENT SIDs] EN:${CONTENT_SIDS.en} TA:${CONTENT_SIDS.ta} HI:${CONTENT_SIDS.hi}`);
}

async function sendWhatsApp(toNumber, patientName, medicineName, timeStr, language = 'English') {
  if (!toNumber) return { success: false, error: 'No number' };
  let clean = toNumber.toString().replace(/[^0-9]/g, '');
  if (clean.length === 10) clean = '91' + clean;
  const to = `whatsapp:+${clean}`;

  const langKey = LANG_MAP[language] || 'en';
  const contentSid = CONTENT_SIDS[langKey] || CONTENT_SIDS.en;

  if (!twilioReady) {
    console.log(`[MOCK ${langKey}] to ${clean} ${patientName}`);
    return { success: true, mode: 'MOCK', to: clean, language: langKey };
  }

  try {
    console.log(`[REAL SEND ${langKey.toUpperCase()}] to +${clean} SID ${contentSid}`);
    const msg = await client.messages.create({
      from: fromNumber,
      to: to,
      contentSid: contentSid,
      contentVariables: JSON.stringify({
        "1": patientName || "Patient",
        "2": medicineName || "PARACETAMOL",
        "3": timeStr || new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })
      })
    });
    console.log(`[REAL WA SENT ${langKey}] to +${clean} SID:${msg.sid}`);
    return { success: true, mode: 'REAL', sid: msg.sid, to: clean, language: langKey, contentSid };
  } catch (err) {
    console.error(`[REAL FAILED ${langKey}] ${err.message} Code:${err.code}`);
    // Fallback to EN if language template fails
    if (langKey !== 'en') {
      try {
        console.log(`[FALLBACK EN] for +${clean}`);
        const msg = await client.messages.create({
          from: fromNumber, to: to,
          contentSid: CONTENT_SIDS.en,
          contentVariables: JSON.stringify({ "1": patientName || "Patient", "2": medicineName || "PARACETAMOL", "3": timeStr || "now" })
        });
        console.log(`[FALLBACK SENT EN] to +${clean} SID:${msg.sid}`);
        return { success: true, mode: 'REAL-FALLBACK-EN', sid: msg.sid, to: clean };
      } catch (e2) {
        return { success: false, error: e2.message, code: e2.code, to: clean };
      }
    }
    return { success: false, error: err.message, code: err.code, to: clean };
  }
}

// ROUTES
app.get('/', (req,res)=>res.json({ status:'CliniGuide Backend LIVE 6 Languages', mode: twilioReady?'REAL':'MOCK', contentSids: CONTENT_SIDS, endpoints:['/api/health','/api/test-wa?to=91...&lang=Tamil','/api/patients','/api/register'] }));
app.get('/api/health', (req,res)=>res.json({ status:'live', mode: twilioReady?'REAL':'MOCK', contentSids: CONTENT_SIDS, languages:['English','Tamil','Hindi','Telugu','Malayalam','Kannada'] }));

app.get('/api/test-wa', async (req,res)=>{
  const to=req.query.to; const lang=req.query.lang||'English';
  if(!to) return res.status(400).json({ok:false, error:'?to=91...&lang=Tamil'});
  const r=await sendWhatsApp(to,'TestUser','PARACETAMOL','Now', lang);
  res.json(r.success?{ok:true, mode:'REAL', lang, sid:r.sid, to:r.to, contentSid:r.contentSid}:{ok:false, error:r.error, code:r.code, to:r.to});
});

function handleRegister(req,res){
  const b=req.body||{};
  const name=b.name||b.patientName||'Patient';
  const medicine=b.medicine||'PARACETAMOL';
  const patientNumber=b.patientNumber||b.patientPhone||b.PatientPhone;
  const guardianNumber=b.guardianNumber||b.guardianPhone||b.GuardianPhone;
  const guardian2=b.guardian2||b.Guardian2||'';
  const guardian3=b.guardian3||b.Guardian3||'';
  const time=b.time||'09:00';
  const language=b.language||b.Language||'English';
  const mode=b.mode||'REAL';
  if(!patientNumber) return res.status(400).json({success:false, error:'Patient Phone required'});
  console.log(`[REGISTER] ${name} ${patientNumber} Time ${time} Lang ${language}`);
  db.run(`INSERT INTO patients (name, patientName, medicine, patientNumber, patientPhone, guardianNumber, guardianPhone, guardian2, guardian3, time, language, mode, active, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`,
    [name,name,medicine,patientNumber,patientNumber,guardianNumber,guardianNumber,guardian2,guardian3,time,language,mode,new Date().toISOString()],
    function(err){ if(err) return res.status(500).json({success:false, error:err.message}); console.log(`[REGISTERED] ID ${this.lastID}`); res.json({success:true, id:this.lastID}); });
}
app.post('/api/patients', handleRegister);
app.post('/api/register', handleRegister);
app.post('/api/patient', handleRegister);
app.get('/api/patients', (req,res)=>{ db.all(`SELECT * FROM patients WHERE active=1 ORDER BY id DESC`,[],(err,rows)=>res.json(rows||[])); });

cron.schedule('* * * * *', ()=>{
  const istTime=new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false});
  db.all(`SELECT * FROM patients WHERE active=1`,[],async (err,rows)=>{
    if(!rows) return;
    for(const p of rows){
      if((p.time||'').trim()===istTime){
        console.log(`[AUTO] ${p.name||p.patientName} ${istTime} Lang ${p.language}`);
        const phones=[p.patientNumber||p.patientPhone, p.guardianNumber||p.guardianPhone, p.guardian2, p.guardian3].filter(Boolean);
        for(const ph of phones){
          await sendWhatsApp(ph, p.name||p.patientName, p.medicine, p.time, p.language||'English');
        }
      }
    }
  });
});

app.listen(PORT, ()=>console.log(`Backend LIVE on ${PORT} REAL:${twilioReady} 6 Langs Ready`));
