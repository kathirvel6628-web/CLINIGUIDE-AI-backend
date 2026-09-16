import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import twilio from 'twilio';

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());
const PORT = process.env.PORT || 10000;
const DB_PATH = process.env.NODE_ENV === 'production'? '/tmp/cliniguide.db' : './cliniguide.db';

let twilioClient = null;
if(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_ACCOUNT_SID.startsWith('AC')){
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    console.log("REAL mode");
} else { console.log("MOCK mode - logs only - PERFECT FOR GIRLFRIEND DEMO"); }

let db;
async function initDB(){
    const sqlite3Verbose = sqlite3.verbose();
    db = await open({filename: DB_PATH, driver: sqlite3Verbose.Database});
    await db.exec(`
        CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY, name TEXT, patient_phone TEXT NOT NULL, guardian1 TEXT NOT NULL, guardian2 TEXT, guardian3 TEXT, language TEXT);
        CREATE TABLE IF NOT EXISTS doses (id INTEGER PRIMARY KEY, patient_id INTEGER, drug_name TEXT, dosage TEXT, scheduled_time TEXT, scheduled_date TEXT, status TEXT DEFAULT 'pending', missed_count INTEGER DEFAULT 0);
    `);
    console.log(`DB ready at ${DB_PATH}`);
}

async function sendWA(to, body){
    if(!to) return false;
    const clean = to.replace(/[^0-9]/g,'');
    if(!clean) return false;
    const toWa = `whatsapp:+${clean}`;
    const fromWa = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
    if(twilioClient){
        try{ await twilioClient.messages.create({from: fromWa, to: toWa, body}); console.log(`REAL WA to ${to}`); return true; }catch(e){console.error(e.message); return false;}
    } else { console.log(`[MOCK WA to ${to}]: ${body}`); return true; }
}

app.post('/api/register', async (req,res)=>{
    try{
        const {name, patient_phone, guardian1, guardian2, guardian3, language} = req.body;
        if(!patient_phone || !guardian1) return res.status(400).json({error:"patient_phone and guardian1 compulsory"});
        await db.run("DELETE FROM patients");
        await db.run("INSERT INTO patients (name, patient_phone, guardian1, guardian2, guardian3, language) VALUES (?,?,?,?,?,?)", [name, patient_phone.replace(/[^0-9]/g,''), guardian1.replace(/[^0-9]/g,''), guardian2?.replace(/[^0-9]/g,'')||null, guardian3?.replace(/[^0-9]/g,'')||null, language||'English']);
        res.json({ok:true});
    }catch(e){ res.status(500).json({error:e.message}) }
});

app.get('/api/patient', async (req,res)=>{ try{ const p = await db.get("SELECT * FROM patients ORDER BY id DESC LIMIT 1"); res.json(p||{}); }catch(e){ res.status(500).json({error:e.message}) } });

app.post('/api/medicines', async (req,res)=>{
    try{
        const {medicines} = req.body;
        for(let m of medicines){ if(!m.drug_name || m.drug_name.includes('UNKNOWN')) return res.status(400).json({error:"Fix UNKNOWN"}); }
        const patient = await db.get("SELECT * FROM patients ORDER BY id DESC LIMIT 1");
        if(!patient) return res.status(400).json({error:"Register first"});
        await db.run("DELETE FROM doses WHERE patient_id=?", [patient.id]);
        const today = new Date();
        for(let d=0; d<2; d++){
            const date = new Date(today); date.setDate(today.getDate()+d);
            const dateStr = date.toISOString().slice(0,10);
            for(let m of medicines){
                const times = m.times && m.times.length? m.times : ["09:00"];
                for(let t of times){
                    await db.run("INSERT INTO doses (patient_id, drug_name, dosage, scheduled_time, scheduled_date) VALUES (?,?,?,?,?)", [patient.id, m.drug_name, m.dosage, t, dateStr]);
                }
            }
        }
        console.log(`Saved ${medicines.length} medicines for patient ${patient.id}`);
        res.json({ok:true});
    }catch(e){ console.error(e); res.status(500).json({error:e.message}) }
});

app.get('/api/doses/today', async (req,res)=>{
    try{
        const today = new Date().toISOString().slice(0,10);
        const doses = await db.all("SELECT * FROM doses WHERE scheduled_date=? ORDER BY scheduled_time", [today]);
        res.json(doses);
    }catch(e){ res.status(500).json({error:e.message}) }
});

app.post('/api/doses/:id/taken', async (req,res)=>{
    try{
        const dose = await db.get("SELECT * FROM doses WHERE id=?", [req.params.id]);
        if(!dose) return res.status(404).json({error:"Dose not found"});
        await db.run("UPDATE doses SET status='taken' WHERE id=?", [req.params.id]);
        const patient = await db.get("SELECT * FROM patients WHERE id=?", [dose.patient_id]);
        const msg = `CliniGuide SAFE: ${patient.name||''} took ${dose.drug_name} ${dose.dosage||''} at ${new Date().toLocaleString()} scheduled ${dose.scheduled_time} Patient:+${patient.patient_phone}`;
        if(patient.guardian1) await sendWA(patient.guardian1, msg);
        if(patient.guardian2) await sendWA(patient.guardian2, msg);
        if(patient.guardian3) await sendWA(patient.guardian3, msg);
        res.json({ok:true});
    }catch(e){ console.error(e); res.status(500).json({error:e.message}) }
});

app.post('/api/sos', async (req,res)=>{
    try{
        const patient = await db.get("SELECT * FROM patients ORDER BY id DESC LIMIT 1");
        if(!patient) return res.status(400).json({error:"No patient"});
        const msg = `🚨 SOS EMERGENCY ${patient.name||''} needs help! Cannot move! Call +${patient.patient_phone} IMMEDIATELY ${new Date().toLocaleString()}`;
        if(patient.guardian1) await sendWA(patient.guardian1, msg);
        if(patient.guardian2) await sendWA(patient.guardian2, msg);
        if(patient.guardian3) await sendWA(patient.guardian3, msg);
        res.json({ok:true});
    }catch(e){ res.status(500).json({error:e.message}) }
});

// FIXED CRON - This was the bug!
cron.schedule('* * * * *', async ()=>{
    try{
        if(!db) return;
        const today = new Date().toISOString().slice(0,10);
        const now = new Date();
        // Fix IST timezone for India demo
        const istNow = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));
        const nowM = istNow.getHours()*60 + istNow.getMinutes();
        const pending = await db.all("SELECT * FROM doses WHERE scheduled_date=? AND status='pending'", [today]);
        if(pending.length>0) console.log(`[CRON CHECK] ${pending.length} pending at IST ${istNow.getHours()}:${istNow.getMinutes()} - ${today}`);
        
        for(let dose of pending){
            const [h,m] = dose.scheduled_time.split(':').map(Number);
            if(isNaN(h)) continue;
            const schedM = h*60+m;
            const diff = nowM - schedM;
            if(diff<0) continue;
            const patient = await db.get("SELECT * FROM patients WHERE id=?", [dose.patient_id]);
            if(!patient) continue;

            // FIXED LOGIC - >= not ===
            if(diff>=0 && dose.missed_count===0){
                await sendWA(patient.patient_phone, `CliniGuide 💊 Time for ${dose.drug_name} ${dose.dosage||''} at ${dose.scheduled_time}. Reply TAKEN in app. Voice: Automatic voice reminder for your medicine in ${patient.language||'English'}.`);
                await db.run("UPDATE doses SET missed_count=1 WHERE id=?", [dose.id]);
                console.log(`[AUTO 0min] SENT TO PATIENT ${patient.patient_phone} - ${dose.drug_name}`);
            } else if(diff>=1 && dose.missed_count===1){
                await sendWA(patient.patient_phone, `CliniGuide 1st Reminder (1 min missed): ${dose.drug_name} at ${dose.scheduled_time} not taken. Please take now.`);
                await db.run("UPDATE doses SET missed_count=2 WHERE id=?", [dose.id]);
                console.log(`[AUTO 1min] 1st Reminder to PATIENT`);
            } else if(diff>=2 && dose.missed_count===2){
                await sendWA(patient.patient_phone, `CliniGuide 2nd Reminder (2 mins missed): ${dose.drug_name} important.`);
                await db.run("UPDATE doses SET missed_count=3 WHERE id=?", [dose.id]);
                console.log(`[AUTO 2min] 2nd Reminder to PATIENT`);
            } else if(diff>=3 && dose.missed_count===3){
                const msg = `⚠️ WARNING - Missed Dose: Patient ${patient.name||''} missed ${dose.drug_name} at ${dose.scheduled_time}, no response 3 mins. Patient phone +${patient.patient_phone} - Please call now.`;
                if(patient.guardian1) await sendWA(patient.guardian1, msg);
                if(patient.guardian2) await sendWA(patient.guardian2, msg);
                if(patient.guardian3) await sendWA(patient.guardian3, msg);
                await db.run("UPDATE doses SET missed_count=4, status='missed' WHERE id=?", [dose.id]);
                console.log(`[AUTO 3min] WARNING to GUARDIANS`);
            }
        }
    }catch(e){console.error("Cron error", e);}
});

app.get('/', (req,res)=>res.send('Backend running - FIXED FOR GIRLFRIEND DEMO'));
app.get('/api/clear', async (req,res)=>{ await db.run("DELETE FROM doses"); await db.run("DELETE FROM patients"); res.json({ok:true, msg:"Cleared for fresh demo"}); });

initDB().then(()=>{ app.listen(PORT, ()=>console.log(`Backend FIXED running on ${PORT}`)); }).catch(err=>{ console.error(err); process.exit(1); });
