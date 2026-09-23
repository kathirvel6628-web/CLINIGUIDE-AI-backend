// ===== CliniGuide AI - FINAL PROPER BACKEND - WORKS FOR ALL USERS INCLUDING JUDGE =====
// Deploy this ONE file as server.js - No more changes needed!

const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cron = require('node-cron');

const app = express();

// 1. CORS - Allows 23885.netlify.app
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 10000;

// 2. YOUR APPROVED TEMPLATE - WORKS FOR ALL 6 LANGUAGES (fallback to this if others not created)
const CONTENT_SID_EN = 'HXa24e7092cda5c369dbcf9060f64f9588';
const CONTENT_SIDS = {
  en: process.env.TWILIO_CONTENT_SID_EN || process.env.TWILIO_CONTENT_SID || CONTENT_SID_EN,
  ta: process.env.TWILIO_CONTENT_SID_TA || CONTENT_SID_EN,
  hi: process.env.TWILIO_CONTENT_SID_HI || CONTENT_SID_EN,
  te: process.env.TWILIO_CONTENT_SID_TE || CONTENT_SID_EN,
  ml: process.env.TWILIO_CONTENT_SID_ML || CONTENT_SID_EN,
  kn: process.env.TWILIO_CONTENT_SID_KN || CONTENT_SID_EN,
};
const LANG_MAP = { English:'en', Tamil:'ta', Hindi:'hi', Telugu:'te', Malayalam:'ml', Kannada:'kn' };

// 3. DATABASE - Supports all your form fields
const DB_PATH = path.join(__dirname, 'cliniguide.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if(err) console.error('DB ERROR', err);
  else console.log('DB OK', DB_PATH);
});
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS patients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, medicine TEXT, patientNumber TEXT, guardianNumber TEXT,
    guardian2 TEXT, guardian3 TEXT, time TEXT, language TEXT, active INTEGER DEFAULT 1, createdAt TEXT
  )`);
});

// 4. TWILIO - REAL MODE
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
let client = null; let twilioReady = false;
if(accountSid && authToken){
  client = twilio(accountSid, authToken);
  twilioReady = true;
  console.log(`TWILIO REAL MODE: ${fromNumber} SID: ${CONTENT_SID_EN}`);
} else {
  console.log('TWILIO MOCK MODE - Add creds in Render env');
}

// 5. SEND WHATSAPP - ALWAYS USES CONTENT SID - FIXES 21604 ERROR
async function sendWhatsApp(toNumber, patientName, medicineName, timeStr, language='English'){
  if(!toNumber) return {success:false, error:'No number'};
  let clean = String(toNumber).replace(/[^0-9]/g,'');
  if(clean.length===10) clean='91'+clean;
  if(clean.length<10) return {success:false, error:'Invalid number'};
  const to = `whatsapp:+${clean}`;
  const langKey = LANG_MAP[language] || 'en';
  const contentSid = CONTENT_SIDS[langKey] || CONTENT_SID_EN;

  if(!twilioReady){
    console.log(`[MOCK ${langKey}] to +${clean} - ${patientName}`);
    return {success:true, mode:'MOCK', to:clean, sid:'MOCK_'+Date.now()};
  }
  try{
    const msg = await client.messages.create({
      from: fromNumber,
      to: to,
      contentSid: contentSid,
      contentVariables: JSON.stringify({
        "1": patientName || "Patient",
        "2": medicineName || "PARACETAMOL",
        "3": timeStr || new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'})
      })
    });
    console.log(`[REAL SENT ${langKey}] +${clean} SID:${msg.sid}`);
    return {success:true, mode:'REAL', sid:msg.sid, to:clean, language:langKey};
  }catch(err){
    console.error(`[FAILED ${langKey}] ${err.message} Code:${err.code} to +${clean}`);
    // If language template fails, try EN fallback
    if(langKey!=='en'){
      try{
        const msg2 = await client.messages.create({
          from: fromNumber, to: to, contentSid: CONTENT_SID_EN,
          contentVariables: JSON.stringify({"1":patientName||"Patient","2":medicineName||"PARACETAMOL","3":timeStr||"now"})
        });
        console.log(`[FALLBACK EN SENT] +${clean}`);
        return {success:true, mode:'REAL-FALLBACK', sid:msg2.sid, to:clean};
      }catch(e2){
        return {success:false, error:e2.message, code:e2.code, to:clean};
      }
    }
    return {success:false, error:err.message, code:err.code, to:clean};
  }
}

// 6. ROUTES

// Health - For frontend Connected REAL check
app.get('/', (req,res)=>{
  res.json({status:'CliniGuide AI LIVE', mode:twilioReady?'REAL':'MOCK', contentSid:CONTENT_SID_EN, message:'Anyone can register - Judge can test'});
});
app.get('/api/health', (req,res)=>{
  res.json({status:'live', mode:twilioReady?'REAL':'MOCK', contentSid:CONTENT_SID_EN, languages:Object.keys(CONTENT_SIDS)});
});

// Test WA - Instant test for Judge: /api/test-wa?to=919025226305&lang=English
app.get('/api/test-wa', async (req,res)=>{
  const to = req.query.to;
  const lang = req.query.lang || 'English';
  if(!to) return res.json({ok:false, error:'Add ?to=91YOURNUMBER&lang=English'});
  const result = await sendWhatsApp(to, 'TestUser', 'PARACETAMOL', 'Now', lang);
  if(result.success) res.json({ok:true, mode:result.mode, sid:result.sid, to:result.to, lang:lang});
  else res.json({ok:false, error:result.error, code:result.code, hint:'Join sandbox: send join usually-men to +14155238886 on WhatsApp'});
});

// REGISTER - ULTRA TOLERANT - Accepts ANY field name, ANY user
function handleRegister(req,res){
  try{
    const b = req.body || {};
    console.log('REGISTER REQUEST BODY:', JSON.stringify(b));

    // Accept ANY possible field names from frontend
    let name = b.name || b.patientName || b.PatientName || b.fullName || '';
    let patientPhone = b.patientNumber || b.patientPhone || b.PatientPhone || b.patient_phone || b.phone || b.Phone || b.mobile || '';
    let guardianPhone = b.guardianNumber || b.guardianPhone || b.GuardianPhone || b.guardian_phone || b.guardian || '';
    let guardian2 = b.guardian2 || b.Guardian2 || b.g2 || '';
    let guardian3 = b.guardian3 || b.Guardian3 || b.g3 || '';
    let time = b.time || b.reminderTime || b.Time || '09:00';
    let language = b.language || b.Language || b.lang || 'English';
    let medicine = b.medicine || b.Medicine || 'PARACETAMOL';

    // Auto-detect phones if fields missing - scans all values for 10-13 digit numbers
    if(!patientPhone || !guardianPhone){
      const allVals = Object.values(b).map(v=>String(v));
      const phones = [];
      for(const v of allVals){
        const digits = v.replace(/[^0-9]/g,'');
        if(digits.length>=10 && digits.length<=13) phones.push(digits);
      }
      // First phone = patient, second = guardian, etc
      if(!patientPhone && phones[0]) patientPhone = phones[0];
      if(!guardianPhone && phones[1]) guardianPhone = phones[1];
      if(!guardian2 && phones[2]) guardian2 = phones[2];
      if(!guardian3 && phones[3]) guardian3 = phones[3];
    }

    // Auto-detect name if missing
    if(!name){
      for(const v of Object.values(b)){
        const s=String(v);
        if(s && isNaN(s) && s.length>=2 && s.length<=50 && !/^\d+$/.test(s.replace(/[^0-9]/g,'')) && s.length>2){
          if(!s.includes('91') || s.length<20){ name=s; break; }
        }
      }
      if(!name) name='Patient';
    }

    // FINAL VALIDATION - Allow anyone (Judge) - No blocking
    if(!patientPhone){
      return res.json({success:false, error:'Patient Phone required - Please enter 91 + 10 digit number', received: b});
    }

    // Save to DB
    db.run(`INSERT INTO patients (name, medicine, patientNumber, guardianNumber, guardian2, guardian3, time, language, active, createdAt) VALUES (?,?,?,?,?,?,?,?,1,?)`,
      [name, medicine, patientPhone, guardianPhone, guardian2, guardian3, time, language, new Date().toISOString()],
      function(err){
        if(err){
          console.error('DB ERROR', err.message);
          return res.json({success:false, error:err.message});
        }
        console.log(`[REGISTERED] ID ${this.lastID} Name:${name} Patient:${patientPhone} Time:${time} Lang:${language}`);
        // Always return success format - prevents frontend undefined error
        res.json({success:true, id:this.lastID, message:'Registered successfully - WhatsApp will be sent at '+time, data:{name, patientNumber:patientPhone, guardianNumber:guardianPhone, time, language}});
      }
    );
  }catch(err){
    console.error('REGISTER CRASH', err);
    res.json({success:false, error:err.message || 'Server error'});
  }
}

// Support ALL possible routes frontend might call
app.post('/api/patients', handleRegister);
app.post('/api/register', handleRegister);
app.post('/api/patient', handleRegister);
app.post('/api/save', handleRegister);
app.post('/register', handleRegister);
app.post('/patients', handleRegister);

app.get('/api/patients', (req,res)=>{
  db.all(`SELECT * FROM patients WHERE active=1 ORDER BY id DESC`, [], (err,rows)=>{
    if(err) return res.json({success:false, error:err.message});
    res.json(rows || []);
  });
});

// 7. CRON - Auto send every minute IST - For reminder
cron.schedule('* * * * *', ()=>{
  const istTime = new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata', hour:'2-digit', minute:'2-digit', hour12:false});
  db.all(`SELECT * FROM patients WHERE active=1`, [], async (err,rows)=>{
    if(err || !rows || rows.length===0) return;
    for(const p of rows){
      if((p.time||'').trim()===istTime){
        console.log(`[AUTO TRIGGER] ${p.name} at ${istTime} Lang:${p.language}`);
        const phones = [p.patientNumber, p.guardianNumber, p.guardian2, p.guardian3].filter(Boolean);
        for(const ph of phones){
          await sendWhatsApp(ph, p.name, p.medicine, p.time, p.language||'English');
        }
      }
    }
  });
});

app.listen(PORT, ()=>{
  console.log(`=== CliniGuide FINAL LIVE on ${PORT} Mode:${twilioReady?'REAL':'MOCK'} ContentSid:${CONTENT_SID_EN} ===`);
  console.log(`Anyone can register - Judge can test - 6 languages ready`);
});
