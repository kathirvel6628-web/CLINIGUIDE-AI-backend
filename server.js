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

// ===== DB SETUP (same as yours) =====
const DB_PATH = path.join(__dirname, 'cliniguide.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) console.error('[DB ERROR]', err);
  else console.log(`[rkgwv]  DB /opt/render/project/src/cliniguide.db`);
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
  createdAt TEXT
)`);

// ===== TWILIO INIT (same as yours) =====
console.log('[rkgwv]  [TWILIO INIT] Checking env...');
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromNumber = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
const contentSid = process.env.TWILIO_CONTENT_SID || 'HXa24e7092cda5c369dbcf9060f64f9588';

console.log(`[rkgwv]  SID: ${accountSid ? accountSid.substring(0,5) : 'MISSING'}... Length:${accountSid ? accountSid.length : 0}`);
console.log(`[rkgwv]  Token: *** Length:${authToken ? authToken.length : 0}`);
console.log(`[rkgwv]  FROM: ${fromNumber}`);
console.log(`[rkgwv]  CONTENT_SID: ${contentSid}`);

let client = null;
let twilioReady = false;
if (accountSid && authToken) {
  try {
    client = twilio(accountSid, authToken);
    twilioReady = true;
    console.log(`[rkgwv]  [TWILIO] ✅ REAL MODE ACTIVE: ${fromNumber}`);
  } catch (e) {
    console.log('[TWILIO ERROR]', e.message);
  }
} else {
  console.log('[TWILIO] ⚠️ MOCK MODE - no credentials');
}

console.log(`[rkgwv]  ✅ REAL-READY Backend Running on ${PORT} Mode:${twilioReady ? 'REAL' : 'MOCK'} AUTO SENDING - IST:${new Date().toLocaleString('en-IN', {timeZone:'Asia/Kolkata'})} AM`);

// ===== CORE SEND FUNCTION - FIXED FOR 21604 ERROR =====
async function sendRealWhatsApp(toNumber, patientName, medicineName, timeStr) {
  // Clean number
  let clean = toNumber.toString().replace(/[^0-9]/g, '');
  if (!clean.startsWith('91') && clean.length === 10) clean = '91' + clean;
  
  const to = `whatsapp:+${clean}`;
  
  if (!twilioReady || !client) {
    console.log(`[MOCK] Would send to ${to}`);
    return { success: true, mode: 'MOCK', to: clean };
  }

  try {
    // FIXED: Use ContentSid template to avoid Code 21604
    // This works even outside 24h window
    console.log(`[AUTO 1m REAL] to PATIENT ${clean} at ${timeStr} using ContentSid ${contentSid}`);
    
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

    console.log(`[REAL WA SENT] to +${clean} SID:${msg.sid}`);
    return { success: true, mode: 'REAL', sid: msg.sid, to: clean };
  } catch (err) {
    console.error(`[REAL WA FAILED] to +${clean} : ${err.message} Code: ${err.code}`);
    console.error(`[HINT] Did number join sandbox? Send "join usually-men" to +1 415 523 8886`);
    
    // Fallback: try old body method if ContentSid fails (within 24h window)
    if (err.code === 21604 || err.code === 63016 || err.message.includes('ContentSid')) {
      // If template fails, try fallback free-form (only works within 24h after user sends Hi)
      try {
        console.log(`[FALLBACK] Trying free-form body for ${clean}`);
        const fallbackMsg = await client.messages.create({
          from: fromNumber,
          to: to,
          body: `💊 CliniGuide Reminder: Hi ${patientName || 'Patient'}, please take your medicine ${medicineName || 'your tablet'} at ${timeStr || 'now'}. Reply Yes after taking.`
        });
        console.log(`[FALLBACK SENT] to +${clean} SID:${fallbackMsg.sid}`);
        return { success: true, mode: 'REAL-FALLBACK', sid: fallbackMsg.sid, to: clean };
      } catch (fallbackErr) {
        console.error(`[FALLBACK FAILED] ${fallbackErr.message}`);
        return { success: false, mode: 'REAL', error: err.message, code: err.code, hint: 'Send Hi to +14155238886 after join', to: clean };
      }
    }
    
    return { success: false, mode: 'REAL', error: err.message, code: err.code, to: clean };
  }
}

// ===== API ROUTES (same structure) =====
app.get('/', (req, res) => {
  res.send(`<h2>CliniGuide Backend LIVE</h2><p>Mode: ${twilioReady ? 'REAL' : 'MOCK'} - ${fromNumber}</p><p>ContentSid: ${contentSid}</p><p>Test: /api/test-wa?to=919025226305</p>`);
});

// Test endpoint - this is what you use: /api/test-wa?to=917871709622
app.get('/api/test-wa', async (req, res) => {
  const to = req.query.to;
  if (!to) return res.status(400).json({ ok: false, error: 'Missing ?to= number' });
  
  const result = await sendRealWhatsApp(to, 'TestUser', 'Dolo 650', new Date().toLocaleTimeString('en-IN', {timeZone:'Asia/Kolkata'}));
  
  if (result.success) {
    res.json({ ok: true, mode: 'REAL', sid: result.sid, to: result.to, contentSid: contentSid });
  } else {
    res.json({ ok: false, mode: 'REAL', error: result.error, code: result.code, hint: result.hint, to: result.to });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'live', mode: twilioReady ? 'REAL' : 'MOCK', from: fromNumber, contentSid, time: new Date().toISOString() });
});

app.post('/api/patients', (req, res) => {
  const { name, medicine, patientNumber, guardianNumber, time, mode } = req.body;
  const createdAt = new Date().toISOString();
  
  db.run(`INSERT INTO patients (name, medicine, patientNumber, guardianNumber, time, mode, active, createdAt) VALUES (?,?,?,?,?,?,1,?)`,
    [name, medicine, patientNumber, guardianNumber, time, mode || 'REAL', createdAt],
    function(err) {
      if (err) return res.status(500).json({ error: err.message });
      console.log(`[REGISTERED] ID ${this.lastID} Mode: ${mode || 'REAL'} AUTO ACTIVATED - Will auto send at ${time}`);
      res.json({ id: this.lastID, success: true });
    });
});

app.get('/api/patients', (req, res) => {
  db.all(`SELECT * FROM patients WHERE active=1 ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ===== AUTO CRON - Every minute (same as yours) =====
cron.schedule('* * * * *', async () => {
  const now = new Date();
  const istTime = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
  // console.log(`[CRON CHECK] IST ${istTime}`);

  db.all(`SELECT * FROM patients WHERE active=1`, [], async (err, rows) => {
    if (err) return;
    if (!rows || rows.length === 0) return;

    for (const p of rows) {
      // p.time is like "11:30" - check if matches current IST minute
      if (p.time === istTime || p.time === istTime.replace(/^0/, '')) {
        console.log(`[AUTO TRIGGER] Patient ${p.name} ID ${p.id} time ${p.time} == ${istTime}`);
        
        // Send to patient number
        if (p.patientNumber) {
          await sendRealWhatsApp(p.patientNumber, p.name, p.medicine, p.time);
        }
        // Optional: also send to guardian
        if (p.guardianNumber && p.guardianNumber !== p.patientNumber) {
          setTimeout(async () => {
            await sendRealWhatsApp(p.guardianNumber, p.name, p.medicine, p.time);
          }, 3000);
        }
      }
    }
  });
});

app.listen(PORT, () => {
  console.log(`[rkgwv]  === Your service is live 🎉 ===`);
  console.log(`[rkgwv]  Available at your primary URL https://cliniguide-ai-backend-1.onrender.com`);
});
