require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const multer = require("multer");
const nodemailer = require("nodemailer");
const { v2: cloudinary } = require("cloudinary");
const { WebSocketServer } = require("ws");
const { clerkMiddleware, requireAuth, getAuth, clerkClient } = require("@clerk/express");
const db = require("./db");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
const PORT = process.env.PORT || 3000;
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging for debugging
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) {
    console.log(`[${req.method}] ${req.path}`);
  }
  next();
});

app.use(clerkMiddleware());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/clerk-ui", express.static(path.join(__dirname, "node_modules", "@clerk", "ui", "dist")));
app.use(express.static(path.join(__dirname, "public"), { index: false }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const socketsByProfileId = new Map();
const wsTokens = new Map();
const indexTemplate = fs.readFileSync(path.join(__dirname, "public", "index.html"), "utf8");
const cloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_URL ||
    (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
);

if (cloudinaryConfigured) {
  if (process.env.CLOUDINARY_URL) {
    cloudinary.config({
      cloudinary_url: process.env.CLOUDINARY_URL,
      secure: true
    });
  } else {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
      secure: true
    });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function renderIndexHtml() {
  return indexTemplate.replace(/__CLERK_PUBLISHABLE_KEY__/g, process.env.CLERK_PUBLISHABLE_KEY || "");
}

function makeLocalUploadPath(originalName) {
  const stamp = Date.now();
  const safeName = String(originalName || "photo.jpg").replace(/\s+/g, "-");
  const fileName = `${stamp}-${safeName}`;
  const absolutePath = path.join(__dirname, "uploads", fileName);
  return { fileName, absolutePath, publicPath: `/uploads/${fileName}` };
}

function uploadImageToCloudinary(file) {
  return new Promise((resolve, reject) => {
    const uploader = cloudinary.uploader.upload_stream(
      {
        folder: "love-calendar",
        resource_type: "image"
      },
      (error, result) => {
        if (error || !result) {
          reject(error || new Error("Cloudinary upload failed."));
          return;
        }
        resolve(result);
      }
    );

    uploader.end(file.buffer);
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
      } else {
        resolve(row);
      }
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
      } else {
        resolve(rows);
      }
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) {
        reject(err);
      } else {
        resolve({ lastID: this.lastID, changes: this.changes });
      }
    });
  });
}

function createLoveCode() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

function createWsToken() {
  return crypto.randomBytes(18).toString("hex");
}

async function ensureUniqueLoveCode() {
  let code = createLoveCode();
  let exists = await dbGet("SELECT id FROM profiles WHERE love_code = ?", [code]);
  while (exists) {
    code = createLoveCode();
    exists = await dbGet("SELECT id FROM profiles WHERE love_code = ?", [code]);
  }
  return code;
}

function createTransporter() {
  const smtpHost = String(process.env.SMTP_HOST || "").trim();
  const smtpUser = String(process.env.SMTP_USER || "").trim();
  const smtpPassRaw = String(process.env.SMTP_PASS || "").trim();
  const smtpPass = /gmail\.com$/i.test(smtpHost) ? smtpPassRaw.replace(/\s+/g, "") : smtpPassRaw;

  if (!smtpHost || !smtpUser || !smtpPass) {
    return null;
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: Number(process.env.SMTP_PORT || 587),
    secure: Number(process.env.SMTP_PORT || 587) === 465,
    requireTLS: Number(process.env.SMTP_PORT || 587) === 587,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });
}

const mailTransporter = createTransporter();

async function sendMailWithFallback(mailOptions) {
  if (!mailTransporter) {
    return { sent: false, reason: "SMTP is not configured." };
  }

  try {
    await mailTransporter.sendMail(mailOptions);
    return { sent: true };
  } catch (err) {
    const host = String(process.env.SMTP_HOST || "").trim().toLowerCase();
    const port = Number(process.env.SMTP_PORT || 587);
    const isTimeout = String(err?.code || "").toUpperCase() === "ETIMEDOUT" || /timeout/i.test(String(err?.message || ""));

    // Some hosted environments intermittently fail on Gmail STARTTLS:587. Retry once via SSL:465.
    if (isTimeout && host === "smtp.gmail.com" && port === 587) {
      try {
        const smtpUser = String(process.env.SMTP_USER || "").trim();
        const smtpPass = String(process.env.SMTP_PASS || "")
          .trim()
          .replace(/\s+/g, "");

        const fallbackTransporter = nodemailer.createTransport({
          host: "smtp.gmail.com",
          port: 465,
          secure: true,
          connectionTimeout: 15000,
          greetingTimeout: 10000,
          socketTimeout: 20000,
          auth: {
            user: smtpUser,
            pass: smtpPass
          }
        });

        await fallbackTransporter.sendMail(mailOptions);
        return { sent: true };
      } catch (retryErr) {
        return { sent: false, reason: retryErr?.message || "Email sending failed." };
      }
    }

    return { sent: false, reason: err?.message || "Email sending failed." };
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function sendMissYouEmail({ toEmail, toName, fromName, customMessage }) {
  const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
  const safeFromName = escapeHtml(fromName);
  const safeToName = escapeHtml(toName);
  const subject = `${fromName} misses you`;
  const trimmedMessage = String(customMessage || "").trim();
  const customMessageBlock = trimmedMessage
    ? `<blockquote style="margin:12px 0;padding:12px 14px;border-left:4px solid #d44f6f;background:#fff5f8;color:#3d2a20;border-radius:8px;">${escapeHtml(trimmedMessage)}</blockquote>`
    : "";
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;padding:16px;">
      <h2 style="margin-bottom:8px;">${safeFromName} misses you.</h2>
      ${customMessageBlock}
      <p style="margin-top:0;">Open your Love Calendar and send a cute photo + note.</p>
      <p>
        <a href="${APP_URL}" style="display:inline-block;background:#d44f6f;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;">
          Open Love Calendar
        </a>
      </p>
      <p style="color:#555;">Hi ${safeToName}, this notification was sent from your private Love Calendar app.</p>
    </div>
  `;

  return sendMailWithFallback({
    from: fromAddress,
    to: toEmail,
    subject,
    html
  });
}

async function sendCuteReplyEmail({ toEmail, toName, fromName, cuteReply }) {
  const fromAddress = process.env.SMTP_FROM || process.env.SMTP_USER;
  const safeFromName = escapeHtml(fromName);
  const safeToName = escapeHtml(toName);
  const safeCuteReply = escapeHtml(String(cuteReply || "").trim());
  const subject = `${fromName} sent a cute reply`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:auto;padding:16px;">
      <h2 style="margin-bottom:8px;">You received a cute reply from ${safeFromName}.</h2>
      <p style="margin:0 0 12px;"><strong>${safeFromName}'s cute reply:</strong> ${safeCuteReply}</p>
      <p style="margin-top:0;">Open your Love Calendar to view the full memory and photo.</p>
      <p>
        <a href="${APP_URL}" style="display:inline-block;background:#d44f6f;color:#fff;text-decoration:none;padding:10px 14px;border-radius:8px;">
          Open Love Calendar
        </a>
      </p>
      <p style="color:#555;">Hi ${safeToName}, this notification was sent from your private Love Calendar app.</p>
    </div>
  `;

  return sendMailWithFallback({
    from: fromAddress,
    to: toEmail,
    subject,
    html
  });
}

function broadcastToProfile(profileId, event, payload = {}) {
  const key = String(profileId);
  const sockets = socketsByProfileId.get(key);
  if (!sockets || !sockets.size) {
    return;
  }
  const body = JSON.stringify({ event, payload });
  sockets.forEach((socket) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(body);
    }
  });
}

async function getOrCreateProfile(clerkUserId) {
  let profile = await dbGet(
    `
      SELECT id, clerk_user_id AS "clerkUserId", name, email, love_code AS "loveCode", partner_id AS "partnerId"
      FROM profiles
      WHERE clerk_user_id = ?
    `,
    [clerkUserId]
  );

  if (profile) {
    return profile;
  }

  const clerkUser = await clerkClient.users.getUser(clerkUserId);
  const primaryEmail = clerkUser.emailAddresses.find((item) => item.id === clerkUser.primaryEmailAddressId);
  const email = (primaryEmail && primaryEmail.emailAddress) || `${clerkUserId}@clerk.local`;
  const first = clerkUser.firstName || "";
  const last = clerkUser.lastName || "";
  const name = `${first} ${last}`.trim() || clerkUser.username || "Love User";

  const insert = await dbRun(
    `
      INSERT INTO profiles (clerk_user_id, name, email, created_at)
      VALUES (?, ?, ?, ?)
    `,
    [clerkUserId, name, email.toLowerCase(), nowIso()]
  );

  profile = await dbGet(
    `
      SELECT id, clerk_user_id AS "clerkUserId", name, email, love_code AS "loveCode", partner_id AS "partnerId"
      FROM profiles
      WHERE id = ?
    `,
    [insert.lastID]
  );

  return profile;
}

async function attachProfile(req, res, next) {
  try {
    const { userId } = getAuth(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized." });
    }
    const profile = await getOrCreateProfile(userId);
    req.profile = profile;
    return next();
  } catch (_err) {
    return res.status(500).json({ error: "Could not resolve user profile." });
  }
}

wss.on("connection", (socket, req) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    const wsToken = reqUrl.searchParams.get("wsToken");
    if (!wsToken) {
      socket.close();
      return;
    }

    const session = wsTokens.get(wsToken);
    if (!session || session.expiresAt < Date.now()) {
      wsTokens.delete(wsToken);
      socket.close();
      return;
    }

    wsTokens.delete(wsToken);
    const key = String(session.profileId);
    if (!socketsByProfileId.has(key)) {
      socketsByProfileId.set(key, new Set());
    }
    socketsByProfileId.get(key).add(socket);

    socket.on("close", () => {
      const set = socketsByProfileId.get(key);
      if (!set) {
        return;
      }
      set.delete(socket);
      if (!set.size) {
        socketsByProfileId.delete(key);
      }
    });
  } catch (_err) {
    socket.close();
  }
});

app.get("/api/public-config", (_req, res) => {
  return res.json({
    clerkPublishableKey: process.env.CLERK_PUBLISHABLE_KEY || ""
  });
});

app.get("/", (_req, res) => {
  res.type("html").send(renderIndexHtml());
});

app.get("/api/auth/me", requireAuth(), attachProfile, async (req, res) => {
  try {
    const partner = req.profile.partnerId
      ? await dbGet(`SELECT id, name, email FROM profiles WHERE id = ?`, [req.profile.partnerId])
      : null;
    return res.json({
      user: {
        id: req.profile.id,
        name: req.profile.name,
        email: req.profile.email,
        partnerId: req.profile.partnerId
      },
      partner
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load user profile." });
  }
});

app.post("/api/ws-token", requireAuth(), attachProfile, (req, res) => {
  const wsToken = createWsToken();
  wsTokens.set(wsToken, {
    profileId: req.profile.id,
    expiresAt: Date.now() + 60 * 1000
  });
  return res.json({ wsToken });
});

app.post("/api/partner/generate-code", requireAuth(), attachProfile, async (req, res) => {
  console.log(`[GEN] Starting code generation for profile ${req.profile?.id}`);
  try {
    const code = await ensureUniqueLoveCode();
    console.log(`[GEN] Generated code: ${code}`);
    await dbRun(`UPDATE profiles SET love_code = ? WHERE id = ?`, [code, req.profile.id]);
    console.log(`[GEN] Updated database with code for profile ${req.profile.id}`);
    return res.json({ loveCode: code });
  } catch (err) {
    console.error(`[GEN] Error:`, err.message || err);
    return res.status(500).json({ error: "Could not generate love code." });
  }
});

app.post("/api/partner/join", requireAuth(), attachProfile, async (req, res) => {
  console.log(`[JOIN] Starting join process for profile ${req.profile?.id}`);
  const { code } = req.body;
  if (!code) {
    console.log(`[JOIN] No code provided`);
    return res.status(400).json({ error: "Love code is required." });
  }

  try {
    console.log(`[JOIN] Looking for code: ${code}`);
    const meId = Number(req.profile.id);
    if (!Number.isInteger(meId) || meId <= 0) {
      throw new Error(`Invalid requester profile id: ${req.profile.id}`);
    }

    const me = await dbGet(`SELECT id, partner_id AS "partnerId" FROM profiles WHERE id = ?`, [meId]);
    if (!me) {
      return res.status(404).json({ error: "Profile not found." });
    }

    if (me.partnerId) {
      console.log(`[JOIN] Profile ${meId} already has partner ${me.partnerId}`);
      return res.status(400).json({ error: "You are already connected with a partner." });
    }

    const partner = await dbGet(
      `
        SELECT id, name, email, partner_id AS "partnerId"
        FROM profiles
        WHERE love_code = ?
      `,
      [String(code).trim().toUpperCase()]
    );

    if (!partner) {
      console.log(`[JOIN] No partner found with code: ${code}`);
      return res.status(404).json({ error: "Invalid love code." });
    }

    const partnerId = Number(partner.id);
    if (!Number.isInteger(partnerId) || partnerId <= 0) {
      throw new Error(`Invalid partner id for code ${code}: ${partner.id}`);
    }

    if (partnerId === meId) {
      console.log(`[JOIN] User trying to connect with own code`);
      return res.status(400).json({ error: "You cannot connect with your own code." });
    }

    if (partner.partnerId) {
      console.log(`[JOIN] Partner ${partner.id} already has partner ${partner.partnerId}`);
      return res.status(400).json({ error: "This love code is already connected to someone." });
    }

    console.log(`[JOIN] Connecting ${meId} with ${partnerId}`);
    const updateMe = await dbRun(`UPDATE profiles SET partner_id = ? WHERE id = ?`, [partnerId, meId]);
    const updatePartner = await dbRun(`UPDATE profiles SET partner_id = ?, love_code = NULL WHERE id = ?`, [meId, partnerId]);
    const clearMeCode = await dbRun(`UPDATE profiles SET love_code = NULL WHERE id = ?`, [meId]);

    if (updateMe.changes !== 1 || updatePartner.changes !== 1 || clearMeCode.changes !== 1) {
      throw new Error(
        `Join update mismatch: me=${updateMe.changes}, partner=${updatePartner.changes}, clear=${clearMeCode.changes}`
      );
    }

    const updatedMe = await dbGet(
      `
        SELECT id, name, email, love_code AS "loveCode", partner_id AS "partnerId"
        FROM profiles
        WHERE id = ?
      `,
      [meId]
    );
    const updatedPartner = await dbGet(
      `
        SELECT id, name, email, partner_id AS "partnerId"
        FROM profiles
        WHERE id = ?
      `,
      [partnerId]
    );

    if (!updatedMe || !updatedPartner) {
      throw new Error("Missing post-join profile state.");
    }
    if (Number(updatedMe.partnerId) !== partnerId || Number(updatedPartner.partnerId) !== meId) {
      throw new Error(
        `Pair verification failed: me.partnerId=${updatedMe.partnerId}, partner.partnerId=${updatedPartner.partnerId}`
      );
    }

    broadcastToProfile(partnerId, "partner:connected", {});
    console.log(`[JOIN] Successfully connected ${meId} with ${partnerId}`);
    return res.json({
      success: true,
      me: updatedMe,
      partner: {
        id: updatedPartner.id,
        name: updatedPartner.name,
        email: updatedPartner.email
      }
    });
  } catch (err) {
    console.error(`[JOIN] Error:`, err.message || err);
    return res.status(500).json({ error: "Could not join using love code." });
  }
});

app.post("/api/partner/disconnect", requireAuth(), attachProfile, async (req, res) => {
  try {
    const me = await dbGet(
      `
        SELECT id, name, partner_id AS "partnerId"
        FROM profiles
        WHERE id = ?
      `,
      [req.profile.id]
    );

    if (!me.partnerId) {
      return res.status(400).json({ error: "You are not connected with any partner." });
    }

    const partner = await dbGet(`SELECT id FROM profiles WHERE id = ?`, [me.partnerId]);
    if (!partner) {
      await dbRun(`UPDATE profiles SET partner_id = NULL WHERE id = ?`, [me.id]);
      return res.json({ success: true });
    }

    await dbRun(`UPDATE profiles SET partner_id = NULL WHERE id IN (?, ?)`, [me.id, partner.id]);
    await dbRun(
      `
        UPDATE miss_requests
        SET status = 'completed'
        WHERE status = 'pending'
          AND (
            (from_user = ? AND to_user = ?)
            OR
            (from_user = ? AND to_user = ?)
          )
      `,
      [String(me.id), String(partner.id), String(partner.id), String(me.id)]
    );

    const createdAt = nowIso();
    await dbRun(
      `INSERT INTO notifications ("user", message, type, created_at) VALUES (?, ?, 'partner_disconnect', ?)`,
      [String(partner.id), `${me.name} disconnected from the relationship.`, createdAt]
    );

    broadcastToProfile(me.id, "partner:disconnected", {});
    broadcastToProfile(partner.id, "partner:disconnected", {});

    return res.json({ success: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not disconnect partner." });
  }
});

app.get("/api/partner/status", requireAuth(), attachProfile, async (req, res) => {
  try {
    const me = await dbGet(
      `
        SELECT id, name, email, love_code AS "loveCode", partner_id AS "partnerId"
        FROM profiles
        WHERE id = ?
      `,
      [req.profile.id]
    );

    let partner = null;
    if (me.partnerId) {
      partner = await dbGet(`SELECT id, name, email FROM profiles WHERE id = ?`, [me.partnerId]);
    }

    return res.json({
      me,
      partner
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not load partner status." });
  }
});

app.post("/api/miss-you", requireAuth(), attachProfile, async (req, res) => {
  try {
    const customMessage = String(req.body?.message || "").trim().slice(0, 500);
    console.log(`[MISS] Request from profile ${req.profile?.id}`);

    const me = await dbGet(
      `
        SELECT id, name, email, partner_id AS "partnerId"
        FROM profiles
        WHERE id = ?
      `,
      [req.profile.id]
    );

    if (!me.partnerId) {
      return res.status(400).json({ error: "Connect with your partner first using Love Code." });
    }

    const partner = await dbGet(`SELECT id, name, email FROM profiles WHERE id = ?`, [me.partnerId]);
    const createdAt = nowIso();

    const requestInsert = await dbRun(
      `INSERT INTO miss_requests (from_user, to_user, message, status, created_at) VALUES (?, ?, ?, 'pending', ?)`,
      [String(me.id), String(partner.id), customMessage || null, createdAt]
    );

    await dbRun(
      `INSERT INTO notifications ("user", message, type, created_at) VALUES (?, ?, 'miss_request', ?)`,
      [
        String(partner.id),
        customMessage
          ? `${me.name} says: "${customMessage}" Upload a photo and write something cute.`
          : `${me.name} misses you. Upload a photo and write something cute.`,
        createdAt
      ]
    );

    let emailStatus = { sent: false };
    try {
      emailStatus = await sendMissYouEmail({
        toEmail: partner.email,
        toName: partner.name,
        fromName: me.name,
        customMessage
      });
    } catch (mailErr) {
      emailStatus = { sent: false, reason: mailErr?.message || "Email sending failed." };
      console.error(`[MISS] Email send failed:`, mailErr?.message || mailErr);
    }

    broadcastToProfile(partner.id, "miss-you:created", { requestId: requestInsert.lastID });

    return res.status(201).json({
      success: true,
      requestId: requestInsert.lastID,
      email: emailStatus
    });
  } catch (err) {
    console.error(`[MISS] Error:`, err?.message || err);
    return res.status(500).json({ error: "Could not create request." });
  }
});

app.get("/api/requests", requireAuth(), attachProfile, async (req, res) => {
  try {
    const rows = await dbAll(
      `
        SELECT
          r.id,
          r.status,
          r.message,
          r.created_at AS "createdAt",
          r.from_user AS "fromUserId",
          r.to_user AS "toUserId",
          p.name AS "fromName"
        FROM miss_requests r
        INNER JOIN profiles p ON p.id = CAST(r.from_user AS INTEGER)
        WHERE r.to_user = ? AND r.status = 'pending'
        ORDER BY datetime(r.created_at) DESC
      `,
      [String(req.profile.id)]
    );
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load requests." });
  }
});

app.post("/api/reply", requireAuth(), attachProfile, upload.single("photo"), async (req, res) => {
  const { requestId, note, eventDate } = req.body;

  if (!requestId || !note || !eventDate || !req.file) {
    return res.status(400).json({ error: "requestId, note, eventDate, and photo are required." });
  }

  try {
    const requestRow = await dbGet(
      `
        SELECT id, status, message, from_user AS "fromUserId", to_user AS "toUserId"
        FROM miss_requests
        WHERE id = ?
      `,
      [requestId]
    );

    if (!requestRow) {
      return res.status(404).json({ error: "Request not found." });
    }

    if (requestRow.status !== "pending") {
      return res.status(400).json({ error: "This request is already completed." });
    }

    if (String(requestRow.toUserId) !== String(req.profile.id)) {
      return res.status(403).json({ error: "You can only reply to requests sent to you." });
    }

    const createdAt = nowIso();
    let imagePath;
    let cloudinaryPublicId = null;

    if (cloudinaryConfigured) {
      const uploaded = await uploadImageToCloudinary(req.file);
      imagePath = uploaded.secure_url;
      cloudinaryPublicId = uploaded.public_id;
    } else {
      const localImage = makeLocalUploadPath(req.file.originalname);
      fs.writeFileSync(localImage.absolutePath, req.file.buffer);
      imagePath = localImage.publicPath;
    }

    const entryInsert = await dbRun(
      `
        INSERT INTO entries (request_id, from_user, to_user, note, image_path, cloudinary_public_id, event_date, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [requestId, String(req.profile.id), String(requestRow.fromUserId), note, imagePath, cloudinaryPublicId, eventDate, createdAt]
    );

    await dbRun(`UPDATE miss_requests SET status = 'completed' WHERE id = ?`, [requestId]);

    await dbRun(
      `
        INSERT INTO notifications ("user", message, type, related_entry_id, created_at)
        VALUES (?, ?, 'reply_complete', ?, ?)
      `,
      [String(requestRow.fromUserId), `${req.profile.name} uploaded a photo and wrote something cute for you.`, entryInsert.lastID, createdAt]
    );

    const originalRequester = await dbGet(`SELECT name, email FROM profiles WHERE id = ?`, [requestRow.fromUserId]);
    if (originalRequester) {
      try {
        await sendCuteReplyEmail({
          toEmail: originalRequester.email,
          toName: originalRequester.name,
          fromName: req.profile.name,
          cuteReply: note
        });
      } catch (_mailErr) {
        // Keep reply success even if email fails.
      }
    }

    broadcastToProfile(requestRow.fromUserId, "reply:created", { entryId: entryInsert.lastID });
    broadcastToProfile(req.profile.id, "calendar:updated", {});

    return res.status(201).json({
      success: true,
      entryId: entryInsert.lastID
    });
  } catch (_err) {
    return res.status(500).json({ error: "Could not save reply." });
  }
});

app.get("/api/notifications", requireAuth(), attachProfile, async (req, res) => {
  try {
    const rows = await dbAll(
      `
        SELECT
          id,
          user,
          message,
          type,
          related_entry_id AS "relatedEntryId",
          is_read AS "isRead",
          created_at AS "createdAt"
        FROM notifications
        WHERE "user" = ?
        ORDER BY datetime(created_at) DESC
        LIMIT 50
      `,
      [String(req.profile.id)]
    );
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load notifications." });
  }
});

app.post("/api/notifications/:id/read", requireAuth(), attachProfile, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await dbRun(
      `UPDATE notifications SET is_read = 1 WHERE id = ? AND "user" = ?`,
      [id, String(req.profile.id)]
    );
    return res.json({ success: true, changed: result.changes });
  } catch (_err) {
    return res.status(500).json({ error: "Could not mark notification as read." });
  }
});

app.delete("/api/entries/:id", requireAuth(), attachProfile, async (req, res) => {
  const { id } = req.params;

  try {
    const entry = await dbGet(
      `
        SELECT
          id,
          request_id AS "requestId",
          from_user AS "fromUser",
          to_user AS "toUser",
          image_path AS "imagePath",
          cloudinary_public_id AS "cloudinaryPublicId"
        FROM entries
        WHERE id = ?
      `,
      [id]
    );

    if (!entry) {
      return res.status(404).json({ error: "Memory not found." });
    }

    const me = String(req.profile.id);
    if (String(entry.fromUser) !== me && String(entry.toUser) !== me) {
      return res.status(403).json({ error: "You can only delete your shared memories." });
    }

    await dbRun(`DELETE FROM notifications WHERE related_entry_id = ?`, [id]);
    await dbRun(`DELETE FROM entries WHERE id = ?`, [id]);

    if (entry.requestId) {
      await dbRun(`DELETE FROM miss_requests WHERE id = ?`, [entry.requestId]);
    }

    if (entry.cloudinaryPublicId && cloudinaryConfigured) {
      try {
        await cloudinary.uploader.destroy(entry.cloudinaryPublicId, { resource_type: "image" });
      } catch (_err) {
        // Ignore Cloudinary delete failures to avoid blocking memory cleanup.
      }
    } else {
      const fileName = path.basename(String(entry.imagePath || "").replace("/uploads/", ""));
      if (fileName) {
        const filePath = path.join(__dirname, "uploads", fileName);
        fs.unlink(filePath, () => {});
      }
    }

    broadcastToProfile(entry.fromUser, "calendar:updated", {});
    broadcastToProfile(entry.toUser, "calendar:updated", {});

    return res.json({ success: true });
  } catch (_err) {
    return res.status(500).json({ error: "Could not delete memory." });
  }
});

app.get("/api/calendar", requireAuth(), attachProfile, async (req, res) => {
  const { month } = req.query;

  let sql = `
    SELECT
      e.id,
      e.request_id AS "requestId",
      e.note,
      r.message AS "missMessage",
      e.image_path AS "imagePath",
      e.event_date AS "eventDate",
      e.created_at AS "createdAt",
      pf.name AS "fromName",
      pt.name AS "toName"
    FROM entries e
    LEFT JOIN miss_requests r ON r.id = e.request_id
    INNER JOIN profiles pf ON pf.id = CAST(e.from_user AS INTEGER)
    INNER JOIN profiles pt ON pt.id = CAST(e.to_user AS INTEGER)
    WHERE (e.from_user = ? OR e.to_user = ?)
  `;
  const params = [String(req.profile.id), String(req.profile.id)];

  if (month && /^\d{4}-\d{2}$/.test(month)) {
    sql += ` AND substr(e.event_date, 1, 7) = ?`;
    params.push(month);
  }

  sql += ` ORDER BY date(e.event_date) DESC, datetime(e.created_at) DESC`;

  try {
    const rows = await dbAll(sql, params);
    return res.json(rows);
  } catch (_err) {
    return res.status(500).json({ error: "Could not load calendar data." });
  }
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Love app running at http://localhost:${PORT}`);
});
