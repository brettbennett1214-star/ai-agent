(function () {
  const urlParams = new URLSearchParams(window.location.search);
  const clientId = urlParams.get("client") || "bright-smile-dental";

  const config = {
    apiBaseUrl: "https://ai-agent-production-5fa8.up.railway.app",
    primaryColor: "#2563eb",
    clientId
  };

  const sessionId =
    "session_" + Math.random().toString(36).slice(2) + Date.now();

  let businessData = {
    businessName: "Business Assistant",
    assistantTitle: "AI Assistant",
    welcomeMessage: "Hi! How can I help you today?",
    subtitle: "Ask about services or appointments"
  };

  const style = document.createElement("style");
  style.textContent = `
    #ai-widget-button {
      position: fixed;
      bottom: 20px;
      right: 20px;
      width: 60px;
      height: 60px;
      border-radius: 50%;
      background: ${config.primaryColor};
      color: white;
      border: none;
      font-size: 24px;
      cursor: pointer;
      box-shadow: 0 10px 25px rgba(0,0,0,0.2);
      z-index: 9999;
    }

    #ai-widget-chatbox {
      position: fixed;
      bottom: 90px;
      right: 20px;
      width: 360px;
      height: 520px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 10px 35px rgba(0,0,0,0.18);
      display: none;
      flex-direction: column;
      overflow: hidden;
      z-index: 9999;
      font-family: Arial, sans-serif;
    }

    #ai-widget-header {
      background: #111827;
      color: white;
      padding: 16px;
      font-size: 18px;
      font-weight: bold;
    }

    #ai-widget-subheader {
      font-size: 12px;
      font-weight: normal;
      color: #d1d5db;
      margin-top: 4px;
    }

    #ai-widget-messages {
      flex: 1;
      padding: 12px;
      overflow-y: auto;
      background: #f9fafb;
    }

    .ai-widget-message {
      max-width: 80%;
      margin-bottom: 10px;
      padding: 10px 12px;
      border-radius: 12px;
      line-height: 1.4;
      white-space: pre-wrap;
      font-size: 14px;
    }

    .ai-widget-user {
      background: #dbeafe;
      margin-left: auto;
      text-align: right;
    }

    .ai-widget-bot {
      background: #e5e7eb;
      margin-right: auto;
      text-align: left;
    }

    #ai-widget-input-area {
      display: flex;
      gap: 8px;
      padding: 12px;
      border-top: 1px solid #e5e7eb;
      background: white;
    }

    #ai-widget-input {
      flex: 1;
      padding: 10px;
      border: 1px solid #d1d5db;
      border-radius: 10px;
      font-size: 14px;
      outline: none;
    }

    #ai-widget-send {
      background: ${config.primaryColor};
      color: white;
      border: none;
      border-radius: 10px;
      padding: 10px 14px;
      cursor: pointer;
    }
  `;
  document.head.appendChild(style);

  const button = document.createElement("button");
  button.id = "ai-widget-button";
  button.innerHTML = "💬";

  const chatbox = document.createElement("div");
  chatbox.id = "ai-widget-chatbox";
  chatbox.innerHTML = `
    <div id="ai-widget-header">
      <span id="ai-widget-title">AI Assistant</span>
      <div id="ai-widget-subheader">Ask about services or appointments</div>
    </div>
    <div id="ai-widget-messages"></div>
    <div id="ai-widget-input-area">
      <input id="ai-widget-input" type="text" placeholder="Type your message..." />
      <button id="ai-widget-send">Send</button>
    </div>
  `;

  document.body.appendChild(button);
  document.body.appendChild(chatbox);

  const messages = document.getElementById("ai-widget-messages");
  const input = document.getElementById("ai-widget-input");
  const sendButton = document.getElementById("ai-widget-send");
  const titleEl = document.getElementById("ai-widget-title");
  const subtitleEl = document.getElementById("ai-widget-subheader");

  function addMessage(text, sender) {
    const div = document.createElement("div");
    div.className = `ai-widget-message ${sender}`;
    div.textContent = text;
    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
  }

  async function loadBusinessData() {
    try {
      const response = await fetch(
        `${config.apiBaseUrl}/business-data?client=${encodeURIComponent(config.clientId)}`
      );
      const data = await response.json();

      businessData = {
        businessName: data.businessName || "Business Assistant",
        assistantTitle: `${data.businessName || "Business"} Assistant`,
        welcomeMessage: `Hi! I’m ${data.businessName || "the business"}'s assistant. How can I help you today?`,
        subtitle: "Ask about services or appointments"
      };

      titleEl.textContent = businessData.assistantTitle;
      subtitleEl.textContent = businessData.subtitle;

      console.log("Loaded client:", config.clientId);
      console.log("Loaded business:", data.businessName);
    } catch (error) {
      console.error("Failed to load business data:", error);
    }
  }

  async function sendMessage() {
    const message = input.value.trim();
    if (!message) return;

    addMessage("You: " + message, "ai-widget-user");
    input.value = "";

    try {
      const response = await fetch(`${config.apiBaseUrl}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message,
          clientId: config.clientId,
          sessionId
        })
      });

      const data = await response.json();
      addMessage("AI: " + (data.reply || "No response received."), "ai-widget-bot");
    } catch (error) {
      addMessage("AI: Error connecting to server.", "ai-widget-bot");
      console.error(error);
    }
  }

  button.addEventListener("click", () => {
    chatbox.style.display = chatbox.style.display === "flex" ? "none" : "flex";

    if (chatbox.style.display === "flex") {
      if (!messages.dataset.started) {
        addMessage(`AI: ${businessData.welcomeMessage}`, "ai-widget-bot");
        messages.dataset.started = "true";
      }
      input.focus();
    }
  });

  sendButton.addEventListener("click", sendMessage);

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter") {
      sendMessage();
    }
  });

  loadBusinessData();
})();