const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const cron = require('node-cron');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 10000;

// ===== REAL-TIME TWILIO SETUP - FIXED =====
let twilioClient = null;
let WA_FROM = null;

function initTwilio() {
  try {
    const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const token = (process.env.TWILIO_AUTH_TOKEN || '').trim();
    // Support both variable names
    const wnum = (process.env.TWILIO_WHATSAPP_NUMBER || process.env.TWILIO_WHATSAPP_FROM || '').trim();
    
    console.log('[TWILIO INIT] Checking env...');
    console.log(`SID: ${sid ? sid.substring(0,5)+'...' : 'MISSING'} Length:${sid.length}`);
    console.log(`Token: ${token ? '***' : 'MISSING'} Length:${token.length}`);
    console.log(`FROM: ${wnum || 'MISSING'}`);
    
    if (sid.startsWith('AC') && sid.length > 20 && token.length > 20 && wnum.includes('whatsapp:')) {
      const twilio = require('twilio');
      twilioClient = twilio(sid, token);
      WA_FROM = wnum;
      console.log(`[TWILIO] ✅ REAL MODE ACTIVE: ${wnum}`);
      return true;
    } else {
      console.log('[TWILIO] ⚠️ MOCK MODE - Missing env: Need AC SID + Token + whatsapp:+1415... in TWILIO_WHATSAPP_NUMBER');
      console.log('[TWILIO] Add in Render: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_NUMBER=whatsapp:+14155238886, WHATSAPP_MODE=REAL');
      return false;
    }
  } catch (e) {
    console.log('[TWILIO] ❌ INIT ERROR:', e.message);
    return false;
  }
}

initTwilio();

async function sendWA(to, message) {
  if (!to) {
    console.log('[WA] No to number');
    return false;
  }
  let num = to.toString().replace(/[^0-9]/g, '');
  if (num.length === 10) num = '91' + num;
  if (!num.startsWith('+')) num = '+' + num;
  const waTo = 'whatsapp:' + num;
  
  // REAL MODE
  if (twilioClient && WA_FROM) {
    try {
      const r = await twilioClient.messages.create({
        from: WA_FROM,
        to: waTo,
        body: message
      });
      console.log(`[REAL WA SENT ✅] to ${num} SID:${r.sid} | ${message.substring(0,80)}`);
      return true;
    } catch (err) {
      console.log(`[REAL WA FAILED ❌] to ${num}: ${err.message} - Code:${err.code}`);
      console.log(`[HINT] Did number join sandbox? Send "join your-code" to +1 415 523 8886 from ${num}`);
      return false;
    }
  } 
  // MOCK MODE - for demo video testing purpose only
  else {
    console.log(`[MOCK WA to ${num}]: ${message} | (Add Twilio env to make REAL)`);
    return true;
  }
}

// DB - FIXED NO RECURSION
const dbPath = path.join(__dirname, 'cliniguide.db');
const db = new sqlite3.Database(dbPath);
console.log('DB', dbPath);

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, patient_phone TEXT, guardian1 TEXT, guardian2 TEXT, guardian3 TEXT, language TEXT DEFAULT 'en')`);
  db.run(`CREATE TABLE IF NOT EXISTS doses (id INTEGER PRIMARY KEY AUTOINCREMENT, patient_id INTEGER, drug_name TEXT, dosage TEXT, scheduled_date TEXT, scheduled_time TEXT, day_number INTEGER, total_days INTEGER, status TEXT DEFAULT 'pending', missed_count INTEGER DEFAULT 0)`);
});

function dbGet(sql, params = []) { return new Promise((res, rej) => { db.get(sql, params, (e, r) => e ? rej(e) : res(r)); }); }
function dbAll(sql, params = []) { return new Promise((res, rej) => { db.all(sql, params, (e, rows) => e ? rej(e) : res(rows)); }); }
function dbRun(sql, params = []) { return new Promise((res, rej) => { db.run(sql, params, function (e) { e ? rej(e) : res(this); }); }); }

// ===== API ROUTES FOR JUDGES =====

app.get('/', (req, res) => {
  res.json({
    ok: true,
    mode: twilioClient ? 'REAL' : 'MOCK FIXED',
    from: WA_FROM || 'not set',
    time: new Date().toISOString(),
    ist: new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
    message: twilioClient ? 'REAL WhatsApp active - auto sending' : 'MOCK mode - Add Twilio env in Render to make REAL'
  });
});

app.get('/api/test-wa', async (req, res) => {
  const to = req.query.to || '919025226305';
  console.log(`[TEST-WA] Request to ${to}`);
  const ok = await sendWA(to, `✅ CliniGuide REAL Test OK ${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })} IST - Day 1/7 Time for 1 medicines at ${new Date().toLocaleTimeString()} - If you get this, REAL mode works!`);
  res.json({
    ok,
    mode: twilioClient ? 'REAL' : 'MOCK FIXED',
    to: to,
    from: WA_FROM,
    hint: ok ? 'Check WhatsApp, message should arrive in 5 sec' : 'If MOCK, add Twilio env in Render. If REAL FAILED, join sandbox: send join code to +1 415 523 8886'
  });
});

app.post('/api/register', async (req, res) => {
  try {
    const { name, patient_phone, guardian1, guardian2, guardian3, language } = req.body;
    console.log('REGISTER', req.body);
    if (!patient_phone) return res.json({ ok: false, error: 'patient_phone required' });
    await dbRun("DELETE FROM doses");
    await dbRun("DELETE FROM patients");
    const r = await dbRun("INSERT INTO patients (name, patient_phone, guardian1, guardian2, guardian3, language) VALUES (?,?,?,?,?,?)", [name || '', patient_phone, guardian1 || '', guardian2 || '', guardian3 || '', language || 'en']);
    console.log('REGISTERED ID', r.lastID, 'Mode:', twilioClient ? 'REAL' : 'MOCK');
    res.json({ ok: true, id: r.lastID, mode: twilioClient ? 'REAL' : 'MOCK FIXED' });
  } catch (e) { console.error(e); res.json({ ok: false, error: e.message }); }
});

app.post('/api/medicines', async (req, res) => {
  try {
    const { medicines } = req.body;
    const patient = await dbGet("SELECT * FROM patients ORDER BY id DESC LIMIT 1");
    if (!patient) return res.json({ ok: false, error: 'register first' });
    await dbRun("DELETE FROM doses WHERE patient_id=?", [patient.id]);
    let total = 0;
    for (let med of medicines) {
      const days = parseInt(med.days) || 7;
      const times = med.times && med.times.length ? med.times : ['09:00'];
      for (let d = 0; d < days; d++) {
        const dt = new Date(); dt.setDate(dt.getDate() + d);
        const dateStr = dt.toISOString().slice(0, 10);
        for (let t of times) {
          let timeStr = t.trim();
          const m = timeStr.match(/(\d+):(\d+)\s*(AM|PM)?/i);
          if (m) { let h = parseInt(m[1]); const min = m[2]; const ap = (m[3] || '').toUpperCase(); if (ap === 'PM' && h < 12) h += 12; if (ap === 'AM' && h === 12) h = 0; timeStr = String(h).padStart(2, '0') + ':' + min; }
          await dbRun("INSERT INTO doses (patient_id, drug_name, dosage, scheduled_date, scheduled_time, day_number, total_days) VALUES (?,?,?,?,?,?,?)", [patient.id, med.drug_name, med.dosage || '', dateStr, timeStr, d + 1, days]);
          total++;
        }
      }
    }
    console.log(`ACTIVATED ${total} doses - Mode:${twilioClient ? 'REAL AUTO' : 'MOCK'} - Will auto send at scheduled times`);
    res.json({ ok: true, totalDoses: total, mode: twilioClient ? 'REAL - Auto WhatsApp will send' : 'MOCK - Add Twilio env for REAL' });
  } catch (e) { console.error(e); res.json({ ok: false, error: e.message }); }
});

app.get('/api/doses/today', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await dbAll("SELECT * FROM doses WHERE scheduled_date=? ORDER BY scheduled_time", [today]);
    res.json(rows);
  } catch (e) { res.json([]); }
});

app.get('/api/doses/all', async (req, res) => {
  try {
    const rows = await dbAll("SELECT scheduled_date, COUNT(*) as cnt, GROUP_CONCAT(drug_name, ', ') as meds FROM doses GROUP BY scheduled_date ORDER BY scheduled_date");
    res.json(rows);
  } catch (e) { res.json([]); }
});

app.get('/api/clear', async (req, res) => {
  try {
    await dbRun("DELETE FROM doses");
    await dbRun("DELETE FROM patients");
    console.log('CLEARED DB');
    res.json({ ok: true, message: 'Cleared' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/doses/:id/taken', async (req, res) => {
  try { await dbRun("UPDATE doses SET status='taken' WHERE id=?", [req.params.id]); console.log(`TAKEN id:${req.params.id}`); res.json({ ok: true }); } catch (e) { res.json({ ok: false }); }
});

app.post('/api/sos', async (req, res) => {
  try {
    const p = await dbGet("SELECT * FROM patients ORDER BY id DESC LIMIT 1");
    if (!p) return res.json({ ok: false });
    const msg = `🚨 SOS! Patient ${p.name || 'Patient'} needs help! Phone: ${p.patient_phone} Time:${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })}`;
    console.log(`[SOS] ${msg}`);
    if (p.guardian1) await sendWA(p.guardian1, msg);
    if (p.guardian2) await sendWA(p.guardian2, msg);
    if (p.guardian3) await sendWA(p.guardian3, msg);
    res.json({ ok: true, mode: twilioClient ? 'REAL SOS sent' : 'MOCK SOS logged' });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ===== REAL-TIME CRON - AUTO SENDING WITHOUT MANUAL =====
cron.schedule('* * * * *', async () => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const nowM = ist.getHours() * 60 + ist.getMinutes();
    const istStr = ist.toLocaleTimeString("en-US", { hour: '2-digit', minute: '2-digit', hour12: true }) + ' IST';

    const pending = await dbAll("SELECT * FROM doses WHERE scheduled_date=? AND status='pending'", [today]);
    if (!pending.length) {
      // console.log(`[CRON CHECK] ${istStr} - No pending`);
      return;
    }

    const groups = {}; pending.forEach(d => { if (!groups[d.scheduled_time]) groups[d.scheduled_time] = []; groups[d.scheduled_time].push(d); });

    for (let time in groups) {
      const list = groups[time];
      const [h, m] = time.split(':').map(Number); if (isNaN(h)) continue;
      const diff = nowM - (h * 60 + m);
      if (diff < 0) continue; // Future

      const patient = await dbGet("SELECT * FROM patients WHERE id=?", [list[0].patient_id]);
      if (!patient) continue;

      const mc = list[0].missed_count || 0;
      const names = list.map(d => d.drug_name).join(', ');
      const displayTime = (() => { const ap = h >= 12 ? 'PM' : 'AM'; const hh = h % 12 || 12; return `${hh}:${String(m).padStart(2, '0')} ${ap}`; })();

      // 0 min - Patient first
      if (diff >= 0 && mc === 0) {
        const msg = `💊 Day ${list[0].day_number}/${list[0].total_days} Time for ${list.length} medicines at ${displayTime}: ${names}. Reply TAKEN or click button in app.`;
        await sendWA(patient.patient_phone, msg);
        for (let d of list) await dbRun("UPDATE doses SET missed_count=1 WHERE id=?", [d.id]);
        console.log(`[AUTO 0min REAL] to PATIENT ${patient.patient_phone} at ${time} IST:${istStr} - ${names}`);
      }
      // 1 min - Patient reminder 2
      else if (diff >= 1 && mc === 1) {
        const msg = `⏰ Reminder Day ${list[0].day_number}/${list[0].total_days} - Still pending ${list.length} medicines at ${displayTime}: ${names}. Please take now.`;
        await sendWA(patient.patient_phone, msg);
        for (let d of list) await dbRun("UPDATE doses SET missed_count=2 WHERE id=?", [d.id]);
        console.log(`[AUTO 1min REAL] to PATIENT ${patient.patient_phone} at ${time}`);
      }
      // 2 min - Patient last reminder
      else if (diff >= 2 && mc === 2) {
        const msg = `⚠️ Last Reminder Day ${list[0].day_number}/${list[0].total_days} - ${list.length} medicines at ${displayTime}: ${names} - Take now or guardian will be alerted.`;
        await sendWA(patient.patient_phone, msg);
        for (let d of list) await dbRun("UPDATE doses SET missed_count=3 WHERE id=?", [d.id]);
        console.log(`[AUTO 2min REAL] to PATIENT ${patient.patient_phone} at ${time}`);
      }
      // 3 min - Guardian warning - REAL TIME USABLE
      else if (diff >= 3 && mc === 3) {
        const msg = `🚨 Missed Alert: Patient ${patient.name || 'Patient'} missed ${list.length} medicines at ${displayTime}: ${names}. Phone: ${patient.patient_phone}. Please check immediately. Day ${list[0].day_number}/${list[0].total_days}`;
        console.log(`[AUTO 3min WARNING] to GUARDIANS: ${msg}`);
        if (patient.guardian1) await sendWA(patient.guardian1, msg);
        if (patient.guardian2) await sendWA(patient.guardian2, msg);
        if (patient.guardian3) await sendWA(patient.guardian3, msg);
        for (let d of list) await dbRun("UPDATE doses SET missed_count=4, status='missed' WHERE id=?", [d.id]);
        console.log(`[AUTO 3min REAL] GUARDIAN alert sent for ${time}`);
      }
    }
  } catch (e) { console.error('[CRON ERROR]', e.message); }
});

app.listen(PORT, () => console.log(`✅ REAL-READY Backend Running on ${PORT} Mode:${twilioClient ? 'REAL AUTO SENDING' : 'MOCK - Add Twilio env to make REAL'} - IST:${new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })}`));
    
