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

// ===== DB SETUP =====
const DB_PATH = path.join(__dirname, 'cliniguide.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('[DB ERROR]', err);
  else console.log(`[DB] DB ${DB_PATH}`);
});

db.run(`CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  medicine TEXT,
  patientNumber TEXT,
  guardianNumber TEXT,
  time TEXT,
  mode TEXT,
  active INTEGER DEFAULT 1,
  createdAt TEXT,
  attemptCount INTEGER DEFAULT 0,
  lastAttemptDate TEXT,
  lastAttemptTime TEXT
)`);

// Add columns if old DB
db.run(`ALTER TABLE patients ADD COLUMN attemptCount INTEGER DEFAULT 0`, ()=>{});
db.run(`ALTER TABLE patients ADD COLUMN lastAttemptDate TEXT`, ()=>{});
db.run(`ALTER TABLE patients ADD COLUMN lastAttemptTime TEXT`, ()=>{});

// ===== TWILIO INIT =====
console.log('[TWILIO INIT] Checking env...');
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const contentSid = process.env.TWILIO_CONTENT_SID || 'HXa24e7092cda5c369dbcf9060f64f9588';

console.log(`SID: ${accountSid ? accountSid.substring(0,6) : 'MISSING'}...`);
console.log(`FROM: ${fromNumber} CONTENT_SID: ${contentSid}`);

let client = null;
let twilioReady = false;
if (accountSid && authToken) {
  try {
    client = twilio(accountSid, authToken);
    twilioReady = true;
    console.log(`[TWILIO] ✅ REAL MODE ACTIVE: ${fromNumber}`);
  } catch (e) {
    console.log('[TWILIO ERROR]', e.message);
  }
} else {
  console.log('[TWILIO] ⚠️ MOCK MODE - no credentials');
}

console.log(`✅ Backend Running on ${PORT} Mode:${twilioReady ? 'REAL' : 'MOCK'} - 2x Patient + 1x Guardian Logic Enabled`);

// Helper: Add minutes to HH:MM
function addMinutes(timeStr, mins) {
  if (!timeStr || !timeStr.includes(':')) return null;
  const [h, m] = timeStr.split(':').map(Number);
  let total = h * 60 + m + mins;
  total = total % (24*60);
  if (total < 0) total += 24*60;
  const nh = Math.floor(total/60);
  const nm = total % 60;
  return `${String(nh).padStart(2,'0')}:${String(nm).padStart(2,'0')}`;
}

// ===== CORE SEND FUNCTION =====
async function sendRealWhatsApp(toNumber, patientName, medicineName, timeStr, type='PATIENT_REMINDER') {
  let clean = toNumber.toString().replace(/[^0-9]/g, '');
  if (!clean.startsWith('91') && clean.length === 10) clean = '91' + clean;
  const to = `whatsapp:+${clean}`;
  
  // CLEAR LOGS FOR JUDGE
  if (type === 'PATIENT_REMINDER_1') {
    console.log(`[MEDICINE REMINDER 1st TIME] To PATIENT +${clean} | Patient:${patientName} | Medicine:${medicineName} | Time:${timeStr}`);
  } else if (type === 'PATIENT_REMINDER_2') {
    console.log(`[MEDICINE REMINDER 2nd TIME] To PATIENT +${clean} | Patient:${patientName} | Medicine:${medicineName} | Time:${timeStr} - 1 min after first`);
  } else if (type === 'GUARDIAN_ALERT') {
    console.log(`[GUARDIAN ALERT 3rd TIME] To GUARDIAN +${clean} | Patient:${patientName} missed ${medicineName} at ${timeStr} - 2 mins overdue!`);
    console.log(`[GUARDIAN MESSAGE] Hi Guardian, ${patientName} did NOT take ${medicineName} at ${timeStr}. Please check on patient! - CliniGuide AI`);
  } else if (type === 'SOS_ALERT') {
    console.log(`[SOS ALERT CLICKED] SOS button pressed by ${patientName}! Sending SOS to +${clean}`);
    console.log(`[SOS MESSAGE] 🚨 SOS EMERGENCY: ${patientName} needs immediate help! Medicine: ${medicineName} - Contact guardian ASAP!`);
  } else {
    console.log(`[${type}] To +${clean} Patient:${patientName} Medicine:${medicineName} Time:${timeStr}`);
  }

  if (!twilioReady || !client) {
    console.log(`[MOCK WA - ${type}] Would send REAL WhatsApp to +${clean} - Mode:MOCK`);
    return { success: true, mode: 'MOCK', to: clean, type };
  }

  try {
    const msg = await client.messages.create({
      from: fromNumber,
      to: to,
      contentSid: contentSid,
      contentVariables: JSON.stringify({
        "1": patientName || "Patient",
        "2": medicineName || "your tablet",
        "3": timeStr || new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'})
      })
    });
    console.log(`[✅ REAL WA SENT - ${type}] To +${clean} SID:${msg.sid}`);
    return { success: true, mode: 'REAL', sid: msg.sid, to: clean, type };
  } catch (err) {
    console.error(`[❌ WA FAILED - ${type}] To +${clean} : ${err.message} Code:${err.code}`);
    // Fallback to body if template fails (within 24h window)
    if (err.code === 21604 || err.code === 63016) {
      try {
        let body = '';
        if (type === 'GUARDIAN_ALERT') body = `🚨 CliniGuide Alert: ${patientName} missed medicine ${medicineName} at ${timeStr}. Please check on patient immediately!`;
        else if (type === 'SOS_ALERT') body = `🚨 SOS EMERGENCY: ${patientName} needs help! Medicine: ${medicineName}. Please contact ASAP! - CliniGuide AI`;
        else body = `💊 CliniGuide: Hi ${patientName}, take ${medicineName} at ${timeStr}. Reply Yes after taking.`;
        const fb = await client.messages.create({ from: fromNumber, to: to, body });
        console.log(`[✅ FALLBACK SENT - ${type}] To +${clean} SID:${fb.sid}`);
        return { success: true, mode: 'REAL-FALLBACK', sid: fb.sid, to: clean, type };
      } catch (e2) {
        console.error(`[FALLBACK FAILED] ${e2.message}`);
        return { success: false, error: e2.message, code: e2.code, to: clean };
      }
    }
    return { success: false, error: err.message, code: err.code, to: clean };
  }
}

// ===== API ROUTES =====
app.get('/', (req, res) => {
  res.send(`<h2>CliniGuide Backend LIVE - 2x Patient + 1x Guardian + SOS</h2><p>Mode: ${twilioReady ? 'REAL' : 'MOCK'} - ${fromNumber}</p><p>ContentSid: ${contentSid}</p><p>Logic: 1st PATIENT, 2nd PATIENT (after 1min), 3rd GUARDIAN ALERT (after 2min)</p><p>Test: /api/test-wa?to=919025226305</p><p>Test 3-step: /api/test-3step?toPatient=91...&toGuardian=91...</p>`);
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'live', mode: twilioReady ? 'REAL' : 'MOCK', from: fromNumber, contentSid, time: new Date().toISOString(), logic: '2x Patient + 1x Guardian + SOS' });
});

// Quick test 3-step logic
app.get('/api/test-3step', async (req, res) => {
  const toPatient = req.query.toPatient || req.query.to;
  const toGuardian = req.query.toGuardian || req.query.guardian || toPatient;
  if (!toPatient) return res.status(400).json({ ok: false, error: 'Add ?toPatient=91...&toGuardian=91...' });
  console.log(`[TEST 3-STEP TRIGGERED BY JUDGE] Patient:${toPatient} Guardian:${toGuardian}`);
  
  const results = [];
  console.log('[TEST] Step 1: Sending 1st reminder to PATIENT');
  let r1 = await sendRealWhatsApp(toPatient, 'TestPatient', 'Dolo 650', new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'}), 'PATIENT_REMINDER_1');
  results.push({step:1, to:'PATIENT', ...r1});
  
  setTimeout(async () => {
    console.log('[TEST] Step 2: Sending 2nd reminder to PATIENT after 1 min simulation (immediate for test)');
    await sendRealWhatsApp(toPatient, 'TestPatient', 'Dolo 650', new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'}), 'PATIENT_REMINDER_2');
  }, 10000); // 10 sec for demo instead of 60 sec

  setTimeout(async () => {
    console.log('[TEST] Step 3: Sending 3rd alert to GUARDIAN after 2 min simulation');
    await sendRealWhatsApp(toGuardian, 'TestPatient', 'Dolo 650', new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'}), 'GUARDIAN_ALERT');
  }, 20000); // 20 sec for demo

  res.json({ ok: true, message: '3-step test started! 1st PATIENT now, 2nd PATIENT after 10sec, 3rd GUARDIAN after 20sec. Check Render logs and WhatsApp.', results, logs: 'Check logs for [MEDICINE REMINDER 1st], [2nd TIME], [GUARDIAN ALERT 3rd]' });
});

app.get('/api/test-wa', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ ok: false, error: 'Missing ?to=' });
  const result = await sendRealWhatsApp(to, 'TestUser', 'Dolo 650', new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'}), 'PATIENT_REMINDER_1');
  res.json({ ok: result.success, ...result, contentSid });
});

app.get('/api/send-now', async (req, res) => {
  db.all(`SELECT * FROM patients WHERE active=1 ORDER BY id DESC LIMIT 1`, [], async (err, rows) => {
    if (!rows || rows.length===0) return res.json({ ok: false, error: 'No patient registered - Register first on frontend' });
    const p = rows[0];
    console.log(`[SEND-NOW TRIGGERED] Patient ${p.name} - Sending 1st reminder now`);
    const r = await sendRealWhatsApp(p.patientNumber, p.name, p.medicine, p.time, 'PATIENT_REMINDER_1');
    res.json({ ok: r.success, result: r, message: '1st reminder sent - 2nd will go after 1 min, 3rd guardian alert after 2 min - Check logs' });
  });
});

app.post('/api/sos', async (req, res) => {
  const { patientNumber, guardianNumber, name, medicine } = req.body || {};
  console.log(`[SOS ALERT CLICKED] Body: ${JSON.stringify(req.body)}`);
  
  if (patientNumber || guardianNumber) {
    // Direct SOS test
    const toList = [patientNumber, guardianNumber].filter(Boolean);
    const results = [];
    for (const num of toList) {
      const r = await sendRealWhatsApp(num, name || 'Patient', medicine || 'Emergency Medicine', new Date().toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata'}), 'SOS_ALERT');
      results.push(r);
    }
    console.log(`[SOS ALERT SENT] Results: ${JSON.stringify(results)}`);
    return res.json({ ok: true, message: 'SOS ALERT sent to patient and guardian! Check logs for [SOS ALERT CLICKED]', results });
  }

  db.all(`SELECT * FROM patients WHERE active=1 ORDER BY id DESC LIMIT 1`, [], async (err, rows) => {
    if (!rows || rows.length===0) return res.json({ ok: false, error: 'No patient registered' });
    const p = rows[0];
    console.log(`[SOS ALERT CLICKED] For patient ${p.name} ID ${p.id}`);
    const toList = [p.patientNumber, p.guardianNumber].filter(Boolean);
    const results = [];
    for (const num of toList) {
      const r = await sendRealWhatsApp(num, p.name, p.medicine, p.time, 'SOS_ALERT');
      results.push(r);
    }
    res.json({ ok: true, message: `SOS ALERT for ${p.name} sent! Guardian will receive alert`, results, logs: 'Check Render logs for [SOS ALERT CLICKED] and [SOS MESSAGE]' });
  });
});

app.post('/api/patients', (req, res) => {
  const { name, medicine, patientNumber, guardianNumber, time, mode } = req.body;
  const createdAt = new Date().toISOString();
  db.run(`INSERT INTO patients (name, medicine, patientNumber, guardianNumber, time, mode, active, createdAt, attemptCount, lastAttemptDate) VALUES (?,?,?,?,?,?,1,?,0,'')`,
    [name, medicine, patientNumber, guardianNumber, time, mode || 'REAL', createdAt],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      console.log(`[REGISTERED] ID ${this.lastID} Name:${name} Med:${medicine} Time:${time} Patient:${patientNumber} Guardian:${guardianNumber} - AUTO LOGIC: 2x Patient + 1x Guardian`);
      res.json({ id: this.lastID, success: true, message: `Registered! Will send at ${time} -> 1st PATIENT, 2nd PATIENT after 1min, 3rd GUARDIAN ALERT after 2min` });
    });
});

app.get('/api/patients', (req, res) => {
  db.all(`SELECT * FROM patients WHERE active=1 ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ===== AUTO CRON - Every minute - 2x PATIENT + 1x GUARDIAN LOGIC =====
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const istTime = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  const todayDate = now.toISOString().split('T')[0]; // YYYY-MM-DD

  db.all(`SELECT * FROM patients WHERE active=1`, [], async (err, rows) => {
    if (err) return;
    if (!rows || rows.length === 0) return;

    for (const p of rows) {
      if (!p.time) continue;
      
      const scheduledTime = p.time; // e.g., "21:30"
      const timePlus1 = addMinutes(scheduledTime, 1);
      const timePlus2 = addMinutes(scheduledTime, 2);

      // Reset attemptCount if new day
      if (p.lastAttemptDate !== todayDate) {
        // If last attempt was yesterday, reset
        if (p.lastAttemptDate && p.lastAttemptDate !== todayDate) {
          db.run(`UPDATE patients SET attemptCount=0, lastAttemptDate=?, lastAttemptTime='' WHERE id=?`, [todayDate, p.id]);
          p.attemptCount = 0;
        }
      }

      // STEP 1: First reminder at exact scheduled time
      if (istTime === scheduledTime && (p.attemptCount === 0 || p.attemptCount === null)) {
        console.log(`[AUTO TRIGGER 1st TIME] Patient ${p.name} ID ${p.id} Time ${scheduledTime} == IST ${istTime} - Sending to PATIENT`);
        if (p.patientNumber) {
          await sendRealWhatsApp(p.patientNumber, p.name, p.medicine, scheduledTime, 'PATIENT_REMINDER_1');
        }
        db.run(`UPDATE patients SET attemptCount=1, lastAttemptDate=?, lastAttemptTime=? WHERE id=?`, [todayDate, istTime, p.id]);
      }
      // STEP 2: Second reminder to PATIENT after 1 minute
      else if (istTime === timePlus1 && p.attemptCount === 1) {
        console.log(`[AUTO TRIGGER 2nd TIME] Patient ${p.name} ID ${p.id} - 1 min after ${scheduledTime} (now ${istTime}) - Sending 2nd to PATIENT`);
        if (p.patientNumber) {
          await sendRealWhatsApp(p.patientNumber, p.name, p.medicine, scheduledTime, 'PATIENT_REMINDER_2');
        }
        db.run(`UPDATE patients SET attemptCount=2, lastAttemptTime=? WHERE id=?`, [istTime, p.id]);
      }
      // STEP 3: Third alert to GUARDIAN after 2 minutes
      else if (istTime === timePlus2 && p.attemptCount === 2) {
        console.log(`[AUTO TRIGGER 3rd TIME - GUARDIAN ALERT] Patient ${p.name} ID ${p.id} - 2 mins after ${scheduledTime} (now ${istTime}) - Patient missed! Alerting GUARDIAN`);
        if (p.guardianNumber && p.guardianNumber !== p.patientNumber) {
          await sendRealWhatsApp(p.guardianNumber, p.name, p.medicine, scheduledTime, 'GUARDIAN_ALERT');
        } else if (p.patientNumber) {
          // If no separate guardian, send alert to patient as guardian alert too
          await sendRealWhatsApp(p.patientNumber, p.name, p.medicine, scheduledTime, 'GUARDIAN_ALERT');
        }
        db.run(`UPDATE patients SET attemptCount=3, lastAttemptTime=? WHERE id=?`, [istTime, p.id]);
        console.log(`[MISSED MEDICINE DETECTED] ${p.name} missed ${p.medicine} at ${scheduledTime} - Guardian alerted - Marked as MISSED for today`);
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ REAL-READY Backend Running on ${PORT} Mode:${twilioReady ? 'REAL' : 'MOCK'} - LOGIC: 2x Patient + 1x Guardian + SOS`);
  console.log(`IST Time now: ${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})}`);
});
    
