import express from "express";
import cors from "cors";
import cron from "node-cron";
import dotenv from "dotenv";
import sqlite3 from "sqlite3";
import { open } from "sqlite";
import twilio from "twilio";
dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;
const DB_PATH =
  process.env.NODE_ENV === "production"
    ? "/tmp/cliniguide.db"
    : "./cliniguide.db";
let twilioClient = null;
if (
  process.env.TWILIO_ACCOUNT_SID &&
  process.env.TWILIO_ACCOUNT_SID.startsWith("AC")
) {
  twilioClient = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}
let db;
async function initDB() {
  const v = sqlite3.verbose();
  db = await open({ filename: DB_PATH, driver: v.Database });
  await db.exec(
    "CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY, name TEXT, patient_phone TEXT NOT NULL, guardian1 TEXT NOT NULL, guardian2 TEXT, guardian3 TEXT, language TEXT); CREATE TABLE IF NOT EXISTS doses (id INTEGER PRIMARY KEY, patient_id INTEGER, drug_name TEXT, dosage TEXT, scheduled_time TEXT, scheduled_date TEXT, status TEXT DEFAULT 'pending', missed_count INTEGER DEFAULT 0, total_days INTEGER, day_number INTEGER);"
  );
}
async function sendWA(to, body) {
  if (!to) return false;
  const clean = to.replace(/[^0-9]/g, "");
  if (!clean) return false;
  const toWa = `whatsapp:+${clean}`;
  const fromWa = process.env.TWILIO_WHATSAPP_NUMBER || "whatsapp:+14155238886";
  if (twilioClient) {
    try {
      await twilioClient.messages.create({ from: fromWa, to: toWa, body });
      return true;
    } catch (e) {
      return false;
    }
  } else {
    console.log(`[WA to ${to}]: ${body}`);
    return true;
  }
}
app.post("/api/register", async (req, res) => {
  try {
    const { name, patient_phone, guardian1, guardian2, guardian3 } = req.body;
    if (!patient_phone || !guardian1)
      return res
        .status(400)
        .json({ error: "patient_phone and guardian1 required" });
    await db.run("DELETE FROM patients");
    await db.run("DELETE FROM doses");
    await db.run(
      "INSERT INTO patients (name,patient_phone,guardian1,guardian2,guardian3) VALUES (?,?,?,?,?)",
      [
        name,
        patient_phone.replace(/[^0-9]/g, ""),
        guardian1.replace(/[^0-9]/g, ""),
        guardian2?.replace(/[^0-9]/g, "") || null,
        guardian3?.replace(/[^0-9]/g, "") || null,
      ]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/medicines", async (req, res) => {
  try {
    const { medicines } = req.body;
    const patient = await db.get(
      "SELECT * FROM patients ORDER BY id DESC LIMIT 1"
    );
    if (!patient) return res.status(400).json({ error: "Register first" });
    await db.run("DELETE FROM doses WHERE patient_id=?", [patient.id]);
    const today = new Date();
    let total = 0;
    for (let med of medicines) {
      const days = parseInt(med.days) || 7;
      const times = med.times && med.times.length ? med.times : ["09:00"];
      for (let d = 0; d < days; d++) {
        const date = new Date(today);
        date.setDate(today.getDate() + d);
        const dateStr = date.toISOString().slice(0, 10);
        for (let t of times) {
          await db.run(
            "INSERT INTO doses (patient_id,drug_name,dosage,scheduled_time,scheduled_date,total_days,day_number) VALUES (?,?,?,?,?,?,?)",
            [patient.id, med.drug_name, med.dosage, t, dateStr, days, d + 1]
          );
          total++;
        }
      }
    }
    res.json({ ok: true, totalDoses: total });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/doses/today", async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const doses = await db.all(
      "SELECT * FROM doses WHERE scheduled_date=? ORDER BY scheduled_time",
      [today]
    );
    res.json(doses);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get("/api/doses/all", async (req, res) => {
  try {
    const doses = await db.all(
      "SELECT scheduled_date, COUNT(*) as cnt, GROUP_CONCAT(drug_name) as meds FROM doses GROUP BY scheduled_date ORDER BY scheduled_date"
    );
    res.json(doses);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/doses/:id/taken", async (req, res) => {
  try {
    const dose = await db.get("SELECT * FROM doses WHERE id=?", [
      req.params.id,
    ]);
    if (!dose) return res.status(404).json({ error: "Not found" });
    await db.run("UPDATE doses SET status='taken' WHERE id=?", [req.params.id]);
    const patient = await db.get("SELECT * FROM patients WHERE id=?", [
      dose.patient_id,
    ]);
    const msg = `SAFE: ${patient.name || ""} took ${dose.drug_name} Day ${ dose.day_number }/${dose.total_days} Patient:+${patient.patient_phone}`;
    if (patient.guardian1) await sendWA(patient.guardian1, msg);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/sos", async (req, res) => {
  try {
    const patient = await db.get(
      "SELECT * FROM patients ORDER BY id DESC LIMIT 1"
    );
    if (!patient) return res.status(400).json({ error: "No patient" });
    const msg = `SOS: ${patient.name || ""} needs help! Call +${ patient.patient_phone }`;
    if (patient.guardian1) await sendWA(patient.guardian1, msg);
    if (patient.guardian2) await sendWA(patient.guardian2, msg);
    if (patient.guardian3) await sendWA(patient.guardian3, msg);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
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
      if (diff >= 0 && mc === 0) {
        const names = list.map((d) => d.drug_name).join(", ");
        await sendWA(
          patient.patient_phone,
          `Day ${list[0].day_number}/${list[0].total_days} Time for ${list.length} medicines at ${time}: ${names}`
        );
        for (let d of list)
          await db.run("UPDATE doses SET missed_count=1 WHERE id=?", [d.id]);
      } else if (diff >= 3 && mc <= 2) {
        const names = list.map((d) => d.drug_name).join(", ");
        const msg = `Missed: Patient ${patient.name || ""} missed ${ list.length } medicines at ${time}: ${names} Day ${list[0].day_number}/${ list[0].total_days } Patient +${patient.patient_phone}`;
        if (patient.guardian1) await sendWA(patient.guardian1, msg);
        if (patient.guardian2) await sendWA(patient.guardian2, msg);
        for (let d of list)
          await db.run(
            "UPDATE doses SET missed_count=4, status='missed' WHERE id=?",
            [d.id]
          );
      }
    }
  } catch (e) {
    console.error(e);
  }
});
app.get("/", (req, res) => res.send("Backend running"));
app.get("/api/clear", async (req, res) => {
  await db.run("DELETE FROM doses");
  await db.run("DELETE FROM patients");
  res.json({ ok: true });
});
initDB().then(() => {
  app.listen(PORT, () => console.log(`Running on ${PORT}`));
});
