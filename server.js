import express from "express";
import cors from "cors";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import axios from "axios";
import { fileURLToPath } from "url";
import { google } from "googleapis";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LEADS_FILE = path.join(__dirname, "leads.json");
const CLIENTS_DIR = path.join(__dirname, "clients");
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_RANGE = "Sheet1!A:E";

const leadSessions = {};

function ensureLeadsFileExists() {
  if (!fs.existsSync(LEADS_FILE)) {
    fs.writeFileSync(LEADS_FILE, "[]", "utf8");
  }
}

function ensureClientsDirExists() {
  if (!fs.existsSync(CLIENTS_DIR)) {
    fs.mkdirSync(CLIENTS_DIR, { recursive: true });
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

function getClientFilePath(clientId) {
  const safeClientId = String(clientId || "default")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "");

  return path.join(CLIENTS_DIR, `${safeClientId}.json`);
}

function readBusinessData(clientId = "bright-smile-dental") {
  ensureClientsDirExists();

  const filePath = getClientFilePath(clientId);

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      businessName: "Demo Business",
      industry: "Local Business",
      location: "Unknown",
      hours: "Unknown",
      phone: "",
      email: "",
      services: [],
      bookingMessage:
        "To book an appointment, please share your name, phone number, and email.",
      faqs: []
    };
  }
}

function writeBusinessData(clientId, data) {
  ensureClientsDirExists();
  const filePath = getClientFilePath(clientId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
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

function getSession(sessionId) {
  if (!leadSessions[sessionId]) {
    leadSessions[sessionId] = {
      name: "",
      phone: "",
      email: "",
      notes: "",
      time: ""
    };
  }

  return leadSessions[sessionId];
}

function updateSessionLead(sessionId, message) {
  const session = getSession(sessionId);

  const name = extractName(message);
  const phone = extractPhone(message);
  const email = extractEmail(message);

  if (name) session.name = name;
  if (phone) session.phone = phone;
  if (email) session.email = email;

  session.notes = session.notes
    ? `${session.notes} | ${message}`
    : message;

  if (!session.time) {
    session.time = new Date().toISOString();
  }

  return session;
}

function resetSession(sessionId) {
  leadSessions[sessionId] = {
    name: "",
    phone: "",
    email: "",
    notes: "",
    time: ""
  };
}

function isLeadComplete(lead) {
  return !!(lead.name && lead.phone && lead.email);
}

function saveCompletedLead(lead, clientId) {
  const leads = readLeads();
  leads.push({
    ...lead,
    clientId
  });
  writeLeads(leads);
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractEmailsFromText(text) {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi) || [];
  return [...new Set(matches)];
}

function extractPhonesFromText(text) {
  const matches = text.match(/(\+?\d[\d\s\-()]{7,}\d)/g) || [];
  return [...new Set(matches.map((m) => m.trim()))];
}

function extractLikelyServices(text) {
  const serviceKeywords = [
    "teeth whitening",
    "dental cleaning",
    "dental implants",
    "veneers",
    "emergency dental care",
    "root canal",
    "checkup",
    "consultation",
    "cleaning",
    "whitening",
    "implants",
    "emergency care",
    "personal training",
    "gym membership",
    "roof repair",
    "roof installation",
    "plumbing repair"
  ];

  const lower = text.toLowerCase();
  return serviceKeywords.filter((service) => lower.includes(service));
}

async function appendLeadToGoogleSheet(lead, clientId, businessData) {
  if (!SPREADSHEET_ID) return;
  if (!process.env.GOOGLE_SERVICE_ACCOUNT) return;

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth });

  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_RANGE,
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        clientId,
        businessData.businessName,
        lead.name,
        lead.phone,
        lead.email,
        lead.notes,
        lead.time
      ]]
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

app.get("/business-data", (req, res) => {
  const clientId = req.query.client || "bright-smile-dental";
  res.json(readBusinessData(clientId));
});

app.get("/clients", (req, res) => {
  ensureClientsDirExists();

  const files = fs.readdirSync(CLIENTS_DIR)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.replace(".json", ""));

  res.json({ clients: files });
});

app.post("/train-from-website", async (req, res) => {
  try {
    const { url, clientId } = req.body;

    if (!url) {
      return res.status(400).json({ error: "Website URL is required." });
    }

    if (!clientId) {
      return res.status(400).json({ error: "clientId is required." });
    }

    const readerUrl = `https://r.jina.ai/${url}`;

    const websiteResponse = await axios.get(readerUrl, {
      timeout: 20000,
      maxRedirects: 5,
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "text/plain, text/markdown, text/html"
      }
    });

    const plainText = String(websiteResponse.data || "").slice(0, 12000);

    const emails = extractEmailsFromText(plainText);
    const phones = extractPhonesFromText(plainText);
    const likelyServices = extractLikelyServices(plainText);

    const fallbackBusinessData = {
      businessName: "Imported Business",
      industry: "Local Business",
      location: "Unknown",
      hours: "Unknown",
      phone: phones[0] || "",
      email: emails[0] || "",
      services: likelyServices.length ? likelyServices : [],
      bookingMessage:
        "To book an appointment, please share your name, phone number, and email.",
      faqs: plainText
        ? [
            {
              question: "What does this business offer?",
              answer: plainText.slice(0, 300)
            }
          ]
        : []
    };

    let businessData = fallbackBusinessData;

    if (openai) {
      try {
        const completion = await openai.chat.completions.create({
          model: "gpt-4o-mini",
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content: `
You extract business information from website content.

Return valid JSON only with this exact structure:
{
  "businessName": "",
  "industry": "",
  "location": "",
  "hours": "",
  "phone": "",
  "email": "",
  "services": [],
  "bookingMessage": "",
  "faqs": [
    { "question": "", "answer": "" }
  ]
}
              `.trim()
            },
            {
              role: "user",
              content: `
Client ID:
${clientId}

Website URL:
${url}

Website text:
${plainText}
              `.trim()
            }
          ]
        });

        const parsed = JSON.parse(completion.choices[0].message.content);

        businessData = {
          businessName: parsed.businessName || fallbackBusinessData.businessName,
          industry: parsed.industry || fallbackBusinessData.industry,
          location: parsed.location || fallbackBusinessData.location,
          hours: parsed.hours || fallbackBusinessData.hours,
          phone: parsed.phone || fallbackBusinessData.phone,
          email: parsed.email || fallbackBusinessData.email,
          services: Array.isArray(parsed.services)
            ? parsed.services
            : fallbackBusinessData.services,
          bookingMessage:
            parsed.bookingMessage ||
            "To book an appointment, please share your name, phone number, and email.",
          faqs: Array.isArray(parsed.faqs)
            ? parsed.faqs
            : fallbackBusinessData.faqs
        };
      } catch (aiError) {
        console.error("AI TRAINING PARSE ERROR:", aiError.message);
      }
    }

    writeBusinessData(clientId, businessData);

    return res.json({
      success: true,
      clientId,
      businessData
    });
  } catch (error) {
    console.error("TRAINING ERROR:", error.message);

    return res.status(500).json({
      error: error.message || "Failed to train from website."
    });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const message = req.body.message;
    const clientId = req.body.clientId || "bright-smile-dental";
    const sessionId = req.body.sessionId || "default-session";
    const businessData = readBusinessData(clientId);

    if (!message) {
      return res.status(400).json({
        reply: "No message was provided."
      });
    }

    if (looksLikeLeadInfo(message)) {
      const lead = updateSessionLead(sessionId, message);

      if (isLeadComplete(lead)) {
        saveCompletedLead(lead, clientId);

        try {
          await appendLeadToGoogleSheet(lead, clientId, businessData);
        } catch (sheetError) {
          console.error("GOOGLE SHEETS ERROR:", sheetError.message);
        }

        const customerName = lead.name;
        resetSession(sessionId);

        return res.json({
          reply: `Thanks ${customerName}. I’ve captured your details and ${businessData.businessName} will follow up shortly.`
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
        reply: `Thanks for your message. ${businessData.bookingMessage}`
      });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a friendly AI assistant for ${businessData.businessName}, a ${businessData.industry} business.

Business details:
- Name: ${businessData.businessName}
- Industry: ${businessData.industry}
- Location: ${businessData.location}
- Hours: ${businessData.hours}
- Phone: ${businessData.phone}
- Email: ${businessData.email}
- Services: ${businessData.services.join(", ")}

FAQs:
${businessData.faqs.map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`).join("\n\n")}

Your job:
- Answer customer questions clearly using only the business information above
- Be short, helpful, and professional
- Encourage the visitor to book an appointment when appropriate
- If the visitor wants to book, ask for their name, phone number, and email
- Never invent prices, services, opening hours, or policies not listed above
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
    console.error("SERVER ERROR:", error.message);

    return res.status(500).json({
      reply: "Something went wrong on the server."
    });
  }
});

app.listen(3000, () => {
  ensureLeadsFileExists();
  ensureClientsDirExists();
  console.log("AI server running on port 3000");
});