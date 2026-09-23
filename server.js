const express = require('express');
const cors = require('cors');
const twilio = require('twilio');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;

const CONTENT_SID_REMINDER = process.env.TWILIO_CONTENT_SID || 'HXa24e7092cda5c369dbcf9060f64f9588';
const CONTENT_SID_MISSED = process.env.TWILIO_CONTENT_SID_MISSED || 'HXa24e7092cda5c369dbcf9060f64f9588';

const DB_PATH = path.join(__dirname, 'cliniguide.db');
const db = new sqlite3.Database(DB_PATH);

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
let client = null;
let twilioReady = false;
if (accountSid && authToken) {
  client = twilio(accountSid, authToken);
  twilioReady = true;
  console.log('[TWILIO] REAL MODE ACTIVE: ' + fromNumber);
  console.log('[TWILIO] REMINDER SID: ' + CONTENT_SID_REMINDER);
}

async function sendRealWhatsApp(toNumber, patientName, medicineName, timeStr, isMissed=false) {
  let clean = toNumber.toString().replace(/[^0-9]/g,'');
  if (!clean.startsWith('91') && clean.length===10) clean='91'+clean;
  const to = 'whatsapp:+'+clean;
  if (!twilioReady) return {success:false, error:'NOT READY', to:clean};
  try {
    const sid = isMissed ? CONTENT_SID_MISSED : CONTENT_SID_REMINDER;
    const vars = {"1":patientName||"Patient","2":medicineName||"tablet","3":timeStr||"now"};
    console.log('[SEND] to '+clean+' Type '+(isMissed?'MISSED':'REMINDER')+' SID '+sid);
    const msg = await client.messages.create({
      from: fromNumber,
      to: to,
      contentSid: sid,
      contentVariables: JSON.stringify(vars)
    });
    console.log('[REAL WA SENT] to +'+clean+' SID:'+msg.sid);
    return {success:true, sid:msg.sid, to:clean};
  } catch(err) {
    console.error('[REAL FAILED] '+err.message+' Code:'+err.code+' to +'+clean);
    return {success:false, error:err.message, code:err.code, to:clean};
  }
}

app.get('/', (req,res)=>res.send('CliniGuide Backend LIVE Mode: '+(twilioReady?'REAL':'MOCK')+'<br>Reminder SID:'+CONTENT_SID_REMINDER+'<br>Test: /api/test-wa?to=919025226305'));
app.get('/api/test-wa', async (req,res)=>{
  const to=req.query.to; if(!to) return res.status(400).json({ok:false});
  const r=await sendRealWhatsApp(to,'TestUser','PARACETAMOL', new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'}), false);
  res.json(r.success?{ok:true,mode:'REAL',sid:r.sid,to:r.to}:{ok:false,error:r.error,code:r.code,to:r.to});
});
app.get('/api/test-missed', async (req,res)=>{
  const to=req.query.to; if(!to) return res.status(400).json({ok:false});
  const r=await sendRealWhatsApp(to,'Kathirvel s','PARACETAMOL','13:38 Phone +919025226305', true);
  res.json(r.success?{ok:true,mode:'REAL',type:'MISSED',sid:r.sid}:{ok:false,error:r.error,code:r.code});
});
app.get('/api/health', (req,res)=>res.json({status:'live',mode:twilioReady?'REAL':'MOCK',contentSid:CONTENT_SID_REMINDER}));

app.post('/api/patients', (req,res)=>{
  const {name,medicine,patientNumber,guardianNumber,time,mode}=req.body;
  db.run('INSERT INTO patients (name,medicine,patientNumber,guardianNumber,time,mode,active,createdAt) VALUES (?,?,?,?,?,?,1,?)',
    [name,medicine,patientNumber,guardianNumber,time,mode||'REAL',new Date().toISOString()],
    function(err){ if(err) return res.status(500).json({error:err.message}); res.json({id:this.lastID,success:true}); });
});
app.get('/api/patients', (req,res)=>{ db.all('SELECT * FROM patients WHERE active=1 ORDER BY id DESC',[],(err,rows)=>res.json(rows)); });

cron.schedule('* * * * *', async ()=>{
  const istTime=new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'2-digit',minute:'2-digit',hour12:false});
  db.all('SELECT * FROM patients WHERE active=1',[],async (err,rows)=>{
    if(!rows) return;
    for(const p of rows){
      if(p.time===istTime){
        if(p.patientNumber) await sendRealWhatsApp(p.patientNumber,p.name,p.medicine,p.time,false);
      }
    }
  });
});

app.listen(PORT, ()=>console.log('Backend Running on '+PORT+' REAL'));
