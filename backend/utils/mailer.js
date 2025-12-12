const postmark = require("postmark");
require("dotenv").config();
const SEND_LIMIT_PER_DAY = 3; // per-recipient guardrail
const dailyCounts = new Map();

const resetDailyCounts = () => {
  dailyCounts.clear();
};

// reset every 24h
setInterval(resetDailyCounts, 24 * 60 * 60 * 1000).unref();

let client = null;
let initialized = false;

const initPostmark = () => {
  const token = process.env.POSTMARK_SERVER_TOKEN;
  console.log(token);
  if (!token) {
    console.warn(
      "[mailer] POSTMARK_SERVER_TOKEN not set; emails will be skipped"
    );
    return false;
  }
  client = new postmark.ServerClient(token);
  return true;
};

const ensureInit = () => {
  if (!initialized) {
    initialized = initPostmark();
  }
  return initialized;
};

const canSend = (recipient) => {
  const count = dailyCounts.get(recipient) || 0;
  return count < SEND_LIMIT_PER_DAY;
};

const bumpCount = (recipient) => {
  const count = dailyCounts.get(recipient) || 0;
  dailyCounts.set(recipient, count + 1);
};

/**
 * Send an email via Postmark with simple rate limiting.
 * Falls back to log-only mode if not configured.
 */
const sendEmail = async ({ to, subject, text, html }) => {
  if (!to) {
    console.warn("[mailer] Missing recipient email; skipping send");
    return { skipped: true, reason: "missing-recipient" };
  }

  if (!canSend(to)) {
    console.warn(`[mailer] Daily limit reached for ${to}; skipping`);
    return { skipped: true, reason: "rate-limited" };
  }

  const hasKey = ensureInit();
  const fromEmail = process.env.POSTMARK_FROM || "no-reply@healthpal.com";
  const fromName = process.env.POSTMARK_FROM_NAME || "HealthPal";
  const from = `${fromName} <${fromEmail}>`;

  // Extract domains for validation
  const fromDomain = fromEmail.split("@")[1];
  const toDomain = to.split("@")[1];

  if (!hasKey || !client) {
    console.info(
      `[mailer][log-only] to=${to} subject="${subject}" text="${text}"`
    );
    return { logged: true };
  }

  try {
    await client.sendEmail({
      From: from,
      To: to,
      Subject: subject,
      TextBody: text,
      HtmlBody: html,
    });
    bumpCount(to);
    return { sent: true };
  } catch (err) {
    const errorMsg = err?.message || err;
    console.error("[mailer] Postmark error:", errorMsg);

    // Provide helpful message for domain mismatch during pending approval
    if (errorMsg.includes("pending approval") && fromDomain !== toDomain) {
      console.warn(
        `[mailer] Domain mismatch: From domain is "${fromDomain}" but recipient is "${toDomain}". ` +
          `During Postmark pending approval, you can only send to addresses matching your From domain. ` +
          `Use a test email like "test@${fromDomain}" or wait for Postmark account approval.`
      );
    }

    return { error: true, message: errorMsg };
  }
};

module.exports = {
  sendEmail,
};
