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
const BUSINESS_DATA_FILE = "business-data.json";
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const SHEET_RANGE = "Sheet1!A:E";

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

function ensureBusinessDataFileExists() {
  if (!fs.existsSync(BUSINESS_DATA_FILE)) {
    fs.writeFileSync(
      BUSINESS_DATA_FILE,
      JSON.stringify(
        {
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
        },
        null,
        2
      ),
      "utf8"
    );
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

function readBusinessData() {
  ensureBusinessDataFileExists();

  try {
    const raw = fs.readFileSync(BUSINESS_DATA_FILE, "utf8");
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

function writeBusinessData(data) {
  fs.writeFileSync(BUSINESS_DATA_FILE, JSON.stringify(data, null, 2), "utf8");
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

function getTitleFromHtml(html) {
  const match = html.match(/<title>([\s\S]*?)<\/title>/i);
  return match ? match[1].trim() : "";
}

function getMetaDescriptionFromHtml(html) {
  const match = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"]*?)["']/i
  );
  return match ? match[1].trim() : "";
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
    "emergency care"
  ];

  const lower = text.toLowerCase();
  return serviceKeywords.filter((service) => lower.includes(service));
}

async function appendLeadToGoogleSheet(lead) {
  if (!SPREADSHEET_ID) {
    console.log("GOOGLE_SHEETS_SPREADSHEET_ID missing. Skipping Google Sheets.");
    return;
  }

  if (!process.env.GOOGLE_SERVICE_ACCOUNT) {
    console.log("GOOGLE_SERVICE_ACCOUNT missing. Skipping Google Sheets.");
    return;
  }

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

app.get("/business-data", (req, res) => {
  const businessData = readBusinessData();
  res.json(businessData);
});

app.post("/train-from-website", async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({
        error: "Website URL is required."
      });
    }

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      return res.status(400).json({
        error: `Could not fetch website. Status: ${response.status}`
      });
    }

    const html = await response.text();
    const pageTitle = getTitleFromHtml(html);
    const metaDescription = getMetaDescriptionFromHtml(html);
    const plainText = stripHtml(html).slice(0, 12000);

    const emails = extractEmailsFromText(plainText);
    const phones = extractPhonesFromText(plainText);
    const likelyServices = extractLikelyServices(plainText);

    const fallbackBusinessData = {
      businessName: pageTitle || "Imported Business",
      industry: "Local Business",
      location: "Unknown",
      hours: "Unknown",
      phone: phones[0] || "",
      email: emails[0] || "",
      services: likelyServices.length ? likelyServices : [],
      bookingMessage:
        "To book an appointment, please share your name, phone number, and email.",
      faqs: metaDescription
        ? [
            {
              question: "What does this business offer?",
              answer: metaDescription
            }
          ]
        : []
    };

    if (!openai) {
      writeBusinessData(fallbackBusinessData);
      return res.json({
        success: true,
        mode: "fallback",
        businessData: fallbackBusinessData
      });
    }

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

Rules:
- Use only the provided website content
- If something is unknown, use "Unknown" or empty string
- Keep services concise
- Keep 3 to 6 FAQs if possible
          `.trim()
        },
        {
          role: "user",
          content: `
Website URL: ${url}

Page title:
${pageTitle}

Meta description:
${metaDescription}

Website text:
${plainText}
          `.trim()
        }
      ]
    });

    const parsed = JSON.parse(completion.choices[0].message.content);

    const businessData = {
      businessName: parsed.businessName || fallbackBusinessData.businessName,
      industry: parsed.industry || fallbackBusinessData.industry,
      location: parsed.location || fallbackBusinessData.location,
      hours: parsed.hours || fallbackBusinessData.hours,
      phone: parsed.phone || fallbackBusinessData.phone,
      email: parsed.email || fallbackBusinessData.email,
      services: Array.isArray(parsed.services) ? parsed.services : fallbackBusinessData.services,
      bookingMessage:
        parsed.bookingMessage ||
        "To book an appointment, please share your name, phone number, and email.",
      faqs: Array.isArray(parsed.faqs) ? parsed.faqs : fallbackBusinessData.faqs
    };

    writeBusinessData(businessData);

    return res.json({
      success: true,
      mode: "ai",
      businessData
    });
    } catch (error) {
    console.error("TRAINING ERROR:", error);

    return res.status(500).json({
      error: error.message || "Failed to train from website."
    });
  }
});

app.post("/chat", async (req, res) => {
  try {
    const message = req.body.message;
    const businessData = readBusinessData();

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
    console.error("SERVER ERROR:", error);

    if (error.status === 429) {
      return res.json({
        reply: "We’d be happy to help. To get started, please share your name, phone number, and email."
      });
    }

    return res.status(500).json({
      reply: "Something went wrong on the server."
    });
  }
});

app.listen(3000, () => {
  ensureLeadsFileExists();
  ensureBusinessDataFileExists();
  console.log("AI server running on port 3000");
});