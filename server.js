import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const LEADS_FILE = "leads.json";
const GOOGLE_CREDENTIALS_FILE = "google-service-account.json";
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_RANGE = "Sheet1!A:E";

// simple in-memory current lead for demo
let currentLead = {
  name: "",
  phone: "",
  email: "",
  notes: "",
  time: ""
};

function ensureLeadsFileExists() {
  if (!fs.existsSync(LEADS_FILE)) {
    fs.writeFileSync(LEADS_FILE, "[]", "utf8");
  }
}

function readLeads() {
  ensureLeadsFileExists();

  try {
    const raw = fs.readFileSync(LEADS_FILE, "utf8");
    const leads = JSON.parse(raw);
    return Array.isArray(leads) ? leads : [];
  } catch {
    return [];
  }
}

function writeLeads(leads) {
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2), "utf8");
}

function extractName(message) {
  const match = message.match(/my name is\s+([a-zA-Z\s'-]+)/i);
  return match ? match[1].trim() : "";
}

function extractEmail(message) {
  const match = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/i);
  return match ? match[0].trim() : "";
}

function extractPhone(message) {
  const match = message.match(/(\+?\d[\d\s\-()]{7,}\d)/);
  return match ? match[0].trim() : "";
}

function looksLikeLeadInfo(message) {
  const text = message.toLowerCase();

  return (
    text.includes("my name is") ||
    text.includes("phone") ||
    text.includes("email") ||
    text.includes("@") ||
    text.includes("call me at") ||
    text.includes("reach me at")
  );
}

function updateCurrentLead(message) {
  const name = extractName(message);
  const phone = extractPhone(message);
  const email = extractEmail(message);

  if (name) currentLead.name = name;
  if (phone) currentLead.phone = phone;
  if (email) currentLead.email = email;

  currentLead.notes = currentLead.notes
    ? `${currentLead.notes} | ${message}`
    : message;

  if (!currentLead.time) {
    currentLead.time = new Date().toISOString();
  }

  return currentLead;
}

function isLeadComplete(lead) {
  return !!(lead.name && lead.phone && lead.email);
}

function saveCompletedLead(lead) {
  const leads = readLeads();
  leads.push({ ...lead });
  writeLeads(leads);
}

function resetCurrentLead() {
  currentLead = {
    name: "",
    phone: "",
    email: "",
    notes: "",
    time: ""
  };
}

async function appendLeadToGoogleSheet(lead) {
  if (!SPREADSHEET_ID) {
    console.log("GOOGLE_SHEETS_SPREADSHEET_ID missing. Skipping Google Sheets.");
    return;
  }

  if (!fs.existsSync(GOOGLE_CREDENTIALS_FILE)) {
    console.log("google-service-account.json not found. Skipping Google Sheets.");
    return;
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: GOOGLE_CREDENTIALS_FILE,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[lead.name, lead.phone, lead.email, lead.notes, lead.time]]
    }
  });
}

let openai = null;
if (process.env.OPENAI_API_KEY) {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.post("/chat", async (req, res) => {
  try {
    const message = req.body.message;

    if (!message) {
      return res.status(400).json({
        reply: "No message was provided."
      });
    }

    if (looksLikeLeadInfo(message)) {
      const lead = updateCurrentLead(message);

      if (isLeadComplete(lead)) {
        saveCompletedLead(lead);

        try {
          await appendLeadToGoogleSheet(lead);
        } catch (sheetError) {
          console.error("GOOGLE SHEETS ERROR:", sheetError);
        }

        const customerName = lead.name;
        resetCurrentLead();

        return res.json({
          reply: `Thanks ${customerName}. I’ve captured your details and the business will follow up shortly.`
        });
      }

      if (lead.name && !lead.phone && !lead.email) {
        return res.json({
          reply: `Thanks ${lead.name}. Could you also share your phone number and email?`
        });
      }

      if (lead.name && lead.phone && !lead.email) {
        return res.json({
          reply: `Thanks ${lead.name}. I’ve got your phone number. Could you also share your email?`
        });
      }

      if (lead.name && !lead.phone && lead.email) {
        return res.json({
          reply: `Thanks ${lead.name}. I’ve got your email. Could you also share your phone number?`
        });
      }

      if (!lead.name && lead.phone && !lead.email) {
        return res.json({
          reply: "Thanks. Could you also share your name and email?"
        });
      }

      if (!lead.name && !lead.phone && lead.email) {
        return res.json({
          reply: "Thanks. Could you also share your name and phone number?"
        });
      }

      if (!lead.name && lead.phone && lead.email) {
        return res.json({
          reply: "Thanks. I’ve got your phone and email. Could you also share your name?"
        });
      }

      return res.json({
        reply: "Thanks, I’ve captured that. Could you also share any missing contact details?"
      });
    }

    if (!openai) {
      return res.json({
        reply: "Demo mode: Thanks for your message. How can I help you today?"
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a friendly AI assistant for a local business.

Your job:
- Answer customer questions clearly
- Be short, helpful, and professional
- Encourage the visitor to book an appointment
- If the visitor shows interest, ask for their name, phone number, and email
- Never make up pricing, hours, or services unless the business provided them
          `.trim()
        },
        {
          role: "user",
          content: message
        }
      ]
    });

    return res.json({
      reply: completion.choices[0].message.content
    });
  } catch (error) {
    console.error("SERVER ERROR:", error);

    if (error.status === 429) {
      return res.json({
        reply: "Demo mode: We'd be happy to help. To get started, may I have your name, phone number, and email?"
      });
    }

    return res.status(500).json({
      reply: "Something went wrong on the server."
    });
  }
});

app.listen(3000, () => {
  ensureLeadsFileExists();
  console.log("AI server running on port 3000");
});