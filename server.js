import express from "express";
import cors from "cors";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import cron from "node-cron";
import twilio from "twilio";

const app = express();
app.use(cors());
app.use(express.json());

let db;
async function initDB() {
  db = await open({ filename: "/tmp/cliniguide.db", driver: sqlite3.Database });
  await db.exec(`CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY, name TEXT, patient_phone TEXT, guardian1 TEXT, guardian2 TEXT, guardian3 TEXT); CREATE TABLE IF NOT EXISTS doses (id INTEGER PRIMARY KEY, patient_id INTEGER, drug_name TEXT, dosage TEXT, scheduled_date TEXT, scheduled_time TEXT, day_number INTEGER, total_days INTEGER, status TEXT DEFAULT 'pending', missed_count INTEGER DEFAULT 0);`);
}
await initDB();

let twilioClient = null;
let waFrom = null;
const sid = process.env.TWILIO_ACCOUNT_SID;
const token = process.env.TWILIO_AUTH_TOKEN;
const from = process.env.TWILIO_WHATSAPP_NUMBER;
console.log("=== TWILIO CHECK ===");
console.log(
  "SID exists:",
  !!sid,
  sid ? sid.substring(0, 10) + "..." : "MISSING"
);
console.log(
  "TOKEN exists:",
  !!token,
  token ? "yes " + token.length + " chars" : "MISSING"
);
console.log("FROM:", from || "MISSING - WILL BE MOCK");
if (sid && token && from && sid.startsWith("AC")) {
  try {
    twilioClient = twilio(sid, token);
    waFrom = from;
    console.log("✅ TWILIO CLIENT CREATED - REAL MODE - FROM:", waFrom);
  } catch (e) {
    console.log("❌ TWILIO CLIENT CREATE FAILED:", e.message);
  }
} else {
  console.log("⚠️ MOCK MODE - No Twilio keys or wrong SID format");
}

async function sendWA(to, msg) {
  if (!to) {
    console.log("sendWA skipped: no to");
    return false;
  }
  let toWA = to.includes("whatsapp:")
    ? to
    : `whatsapp:+${to.replace(/\D/g, "")}`;
  // ensure +91
  if (!toWA.includes("+")) toWA = `whatsapp:+${to.replace(/\D/g, "")}`;
  console.log(
    `[SEND ATTEMPT] Mode:${ twilioClient ? "REAL" : "MOCK" } From:${waFrom} To:${toWA} Msg:${msg.substring(0, 60)}`
  );
  if (!twilioClient) {
    console.log(`[MOCK WA to ${toWA}]: ${msg}`);
    return true;
  }
  try {
    const res = await twilioClient.messages.create({
      from: waFrom,
      to: toWA,
      body: msg,
    });
    console.log(`[REAL WA SUCCESS] to ${toWA} SID:${res.sid}`);
    return true;
  } catch (e) {
    console.log(
      `[REAL WA FAILED] to ${toWA} ERROR:${e.message} CODE:${e.code}`
    );
    console.log(
      `HINT: For Trial, recipient must send 'join <code>' to +14155238886 first. Error 63007 = not in sandbox. Error 21211 = invalid number.`
    );
    return false;
  }
}

app.get("/", (req, res) => {
  res.send(
    `CliniGuide Backend - ${ twilioClient ? "REAL" : "MOCK" } Mode - From ${waFrom}`
  );
});

app.get("/api/test-wa", async (req, res) => {
  const to = req.query.to || "919025226305";
  const ok = await sendWA(
    to,
    `Test from CliniGuide Backend - ${ twilioClient ? "REAL" : "MOCK" } - ${new Date().toISOString()} - If you get this, WhatsApp works!`
  );
  res.json({
    ok,
    mode: twilioClient ? "REAL" : "MOCK",
    from: waFrom,
    to,
    sidExists: !!sid,
  });
});

app.post("/api/register", async (req, res) => {
  try {
    const { name, patient_phone, guardian1, guardian2, guardian3 } = req.body;
    await db.run("DELETE FROM patients");
    await db.run("DELETE FROM doses");
    const r = await db.run(
      "INSERT INTO patients (name, patient_phone, guardian1, guardian2, guardian3) VALUES (?,?,?,?,?)",
      [name || "Patient", patient_phone, guardian1, guardian2, guardian3]
    );
    console.log(`Registered patient ${patient_phone} guardians ${guardian1}`);
    res.json({ ok: true, id: r.lastID });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.post("/api/medicines", async (req, res) => {
  try {
    const { medicines } = req.body;
    const patient = await db.get(
      "SELECT * FROM patients ORDER BY id DESC LIMIT 1"
    );
    if (!patient) return res.json({ ok: false, error: "Register first" });
    await db.run("DELETE FROM doses");
    const today = new Date();
    let total = 0;
    for (let med of medicines) {
      const times = med.times && med.times.length ? med.times : ["09:00"];
      const days = parseInt(med.days) || 1;
      for (let d = 0; d < days; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() + d);
        const dateStr = date.toISOString().slice(0, 10);
        for (let t of times) {
          let clean = t.trim();
          const m = clean.match(/(\d+):(\d+)\s*(AM|PM)?/i);
          if (m) {
            let h = parseInt(m[1]);
            const mm = m[2];
            const ap = (m[3] || "").toUpperCase();
            if (ap === "PM" && h < 12) h += 12;
            if (ap === "AM" && h === 12) h = 0;
            clean = String(h).padStart(2, "0") + ":" + mm;
          }
          await db.run(
            "INSERT INTO doses (patient_id, drug_name, dosage, scheduled_date, scheduled_time, day_number, total_days) VALUES (?,?,?,?,?,?,?)",
            [patient.id, med.drug_name, med.dosage, dateStr, clean, d + 1, days]
          );
          total++;
        }
      }
    }
    console.log(`Activated ${total} doses for ${medicines.length} meds`);
    res.json({ ok: true, totalDoses: total });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get("/api/doses/today", async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const rows = await db.all("SELECT * FROM doses WHERE scheduled_date=?", [
    today,
  ]);
  res.json(rows);
});

app.post("/api/doses/:id/taken", async (req, res) => {
  await db.run("UPDATE doses SET status='taken' WHERE id=?", [req.params.id]);
  res.json({ ok: true });
});

app.post("/api/sos", async (req, res) => {
  const patient = await db.get(
    "SELECT * FROM patients ORDER BY id DESC LIMIT 1"
  );
  if (patient) {
    const msg = `🆘 SOS from ${patient.name} Phone +${patient.patient_phone} Needs help now!`;
    if (patient.guardian1) await sendWA(patient.guardian1, msg);
    if (patient.guardian2) await sendWA(patient.guardian2, msg);
    if (patient.guardian3) await sendWA(patient.guardian3, msg);
  }
  res.json({ ok: true });
});

// CRON with logging
cron.schedule("* * * * *", async () => {
  try {
    if (!db) return;
    const today = new Date().toISOString().slice(0, 10);
    const now = new Date();
    const istNow = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );
    const nowM = istNow.getHours() * 60 + istNow.getMinutes();
    const pending = await db.all(
      "SELECT * FROM doses WHERE scheduled_date=? AND status='pending'",
      [today]
    );
    if (pending.length === 0) return;
    const groups = {};
    pending.forEach((d) => {
      if (!groups[d.scheduled_time]) groups[d.scheduled_time] = [];
      groups[d.scheduled_time].push(d);
    });
    for (let time in groups) {
      const list = groups[time];
      const [h, m] = time.split(":").map(Number);
      if (isNaN(h)) continue;
      const schedM = h * 60 + m;
      const diff = nowM - schedM;
      if (diff < 0) continue;
      const patient = await db.get("SELECT * FROM patients WHERE id=?", [
        list[0].patient_id,
      ]);
      if (!patient) continue;
      const mc = list[0].missed_count;
      const names = list.map((d) => d.drug_name).join(", ");
      if (diff >= 0 && mc === 0) {
        await sendWA(
          patient.patient_phone,
          `Day ${list[0].day_number}/${list[0].total_days} Time for ${list.length} medicines at ${time}: ${names}`
        );
        for (let d of list)
          await db.run("UPDATE doses SET missed_count=1 WHERE id=?", [d.id]);
        console.log(
          `[AUTO 0min] to PATIENT ${patient.patient_phone} at ${time}`
        );
      } else if (diff >= 1 && mc === 1) {
        await sendWA(
          patient.patient_phone,
          `1st Reminder (1 min missed): ${list.length} medicines at ${time}: ${names}`
        );
        for (let d of list)
          await db.run("UPDATE doses SET missed_count=2 WHERE id=?", [d.id]);
      } else if (diff >= 2 && mc === 2) {
        await sendWA(
          patient.patient_phone,
          `2nd Reminder (2 mins missed): ${names}`
        );
        for (let d of list)
          await db.run("UPDATE doses SET missed_count=3 WHERE id=?", [d.id]);
      } else if (diff >= 3 && mc < 4) {
        const msg = `Missed: Patient ${patient.name || ""} missed ${ list.length } medicines at ${time}: ${names} Day ${list[0].day_number}/${ list[0].total_days } Patient +${patient.patient_phone}`;
        console.log(`[AUTO 3min] WARNING to GUARDIANS: ${msg}`);
        if (patient.guardian1) {
          const ok = await sendWA(patient.guardian1, msg);
          console.log(
            `-> Guardian1 ${patient.guardian1} ${ok ? "SENT" : "FAILED"}`
          );
        }
        if (patient.guardian2) {
          const ok = await sendWA(patient.guardian2, msg);
          console.log(
            `-> Guardian2 ${patient.guardian2} ${ok ? "SENT" : "FAILED"}`
          );
        }
        if (patient.guardian3) {
          await sendWA(patient.guardian3, msg);
        }
        for (let d of list)
          await db.run(
            "UPDATE doses SET missed_count=4, status='missed' WHERE id=?",
            [d.id]
          );
      }
    }
  } catch (e) {
    console.log("Cron error", e.message);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Running on ${PORT}`);
  console.log(`Your service is live 🎉`);
});
