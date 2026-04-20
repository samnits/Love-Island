const state = {
  user: null,
  partner: null,
  loveCode: null,
  notifications: [],
  pendingRequests: [],
  calendarEntries: [],
  ws: null,
  authMode: "login",
  isBootstrapping: false,
  activeSessionId: null,
  isMountingAuth: false,
  authWidgetsReady: false
};

const authPanel = document.getElementById("authPanel");
const appPanel = document.getElementById("appPanel");
const authHint = document.getElementById("authHint");
const showLoginBtn = document.getElementById("showLoginBtn");
const showSignupBtn = document.getElementById("showSignupBtn");
const loginMount = document.getElementById("loginMount");
const signupMount = document.getElementById("signupMount");
const logoutBtn = document.getElementById("logoutBtn");
const welcomeTitle = document.getElementById("welcomeTitle");
const partnerState = document.getElementById("partnerState");
const generateCodeBtn = document.getElementById("generateCodeBtn");
const myLoveCode = document.getElementById("myLoveCode");
const disconnectPartnerBtn = document.getElementById("disconnectPartnerBtn");
const joinCodeForm = document.getElementById("joinCodeForm");
const joinCodeInput = document.getElementById("joinCodeInput");
const missYouBtn = document.getElementById("missYouBtn");
const missYouMessageInput = document.getElementById("missYouMessage");
const actionStatus = document.getElementById("actionStatus");
const pendingList = document.getElementById("pendingList");
const requestSelect = document.getElementById("requestSelect");
const replyForm = document.getElementById("replyForm");
const notificationsList = document.getElementById("notificationsList");
const monthPicker = document.getElementById("monthPicker");
const calendarGrid = document.getElementById("calendarGrid");
const eventsList = document.getElementById("eventsList");

function formatDate(dateValue) {
  return new Date(dateValue).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function currentMonthInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

async function getBearerToken() {
  if (!window.Clerk || !window.Clerk.session) {
    throw new Error("Please login first.");
  }
  const token = await window.Clerk.session.getToken();
  if (!token) {
    throw new Error("Could not get auth token.");
  }
  return token;
}

async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  const token = await getBearerToken();
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Cache-Control", "no-store");

  const response = await fetch(url, {
    ...options,
    headers,
    cache: "no-store"
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || "Request failed");
  }
  return response.json();
}

function setAppVisibility(isLoggedIn) {
  authPanel.classList.toggle("hidden", isLoggedIn);
  appPanel.classList.toggle("hidden", !isLoggedIn);
}

function setAuthMode(mode) {
  state.authMode = mode;
  const loginMode = mode === "login";
  loginMount.classList.toggle("hidden", !loginMode);
  signupMount.classList.toggle("hidden", loginMode);
  showLoginBtn.classList.toggle("active", loginMode);
  showSignupBtn.classList.toggle("active", !loginMode);
}

function clearClerkAuthQueryParams() {
  const url = new URL(window.location.href);
  const keysToDelete = [
    "__clerk_status",
    "__clerk_created_session",
    "__clerk_invitation_token",
    "__clerk_ticket",
    "__clerk_modal_state",
    "__clerk_handshake",
    "__clerk_handshake_nonce",
    "__clerk_help",
    "redirect_url",
    "after_sign_in_url",
    "after_sign_up_url",
    "sign_in_force_redirect_url",
    "sign_in_fallback_redirect_url",
    "sign_up_force_redirect_url",
    "sign_up_fallback_redirect_url"
  ];

  let changed = false;
  keysToDelete.forEach((key) => {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  });

  if (changed) {
    window.history.replaceState(window.history.state, "", url.toString());
  }
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (window.Clerk) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Failed loading ${src}`)), { once: true });
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.crossOrigin = "anonymous";
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed loading ${src}`)), { once: true });
    document.head.appendChild(script);
  });
}

async function ensureClerkLoaded() {
  if (window.Clerk) {
    return;
  }

  const local = "/vendor/clerk.browser.js";
  const primary = "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js";
  const fallback = "https://unpkg.com/@clerk/clerk-js@latest/dist/clerk.browser.js";

  try {
    await injectScript(local);
  } catch (_err) {
    try {
      await injectScript(primary);
    } catch (_err2) {
      await injectScript(fallback);
    }
  }

  if (!window.Clerk) {
    throw new Error("Clerk failed to load. Check internet/firewall and try refresh.");
  }
}

let clerkUiPromise = null;

async function ensureClerkUiLoaded() {
  if (window.__internal_ClerkUICtor) {
    return { ClerkUI: window.__internal_ClerkUICtor };
  }

  if (!clerkUiPromise) {
    clerkUiPromise = injectScript("/clerk-ui/ui.browser.js").then(() => {
      if (!window.__internal_ClerkUICtor) {
        throw new Error("Clerk UI failed to load.");
      }

      return { ClerkUI: window.__internal_ClerkUICtor };
    });
  }

  return clerkUiPromise;
}

function renderIdentity() {
  if (!state.user) {
    return;
  }

  welcomeTitle.textContent = `Hi ${state.user.name}`;
  if (state.partner) {
    partnerState.textContent = `Connected with ${state.partner.name} (${state.partner.email}).`;
    myLoveCode.textContent = "You are connected. Love code is hidden for privacy.";
    disconnectPartnerBtn.classList.remove("hidden");
  } else {
    partnerState.textContent = "No partner connected yet. Generate or join using Love Code.";
    myLoveCode.textContent = state.loveCode ? `Your Love Code: ${state.loveCode}` : "No active code yet.";
    disconnectPartnerBtn.classList.add("hidden");
  }
}

async function setupWebSocket() {
  if (state.ws) {
    state.ws.close();
  }

  try {
    const tokenData = await api("/api/ws-token", { method: "POST" });
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/ws?wsToken=${encodeURIComponent(tokenData.wsToken)}`;
    state.ws = new WebSocket(wsUrl);

    state.ws.addEventListener("message", async () => {
      await Promise.all([loadPartnerStatus(), loadNotifications(), loadPendingRequests(), loadCalendar()]);
    });
  } catch (error) {
    authHint.textContent = error.message;
  }
}

async function loadProfile() {
  const data = await api("/api/auth/me");
  state.user = data.user;
  state.partner = data.partner;
}

async function loadPartnerStatus() {
  const data = await api(`/api/partner/status?t=${Date.now()}`);
  state.partner = data.partner;
  state.loveCode = data.me.loveCode || null;
  renderIdentity();
}

async function generateLoveCode() {
  try {
    const data = await api("/api/partner/generate-code", { method: "POST" });
    state.loveCode = data.loveCode;
    renderIdentity();
  } catch (error) {
    alert(error.message);
  }
}

async function joinLoveCode(event) {
  event.preventDefault();
  try {
    const normalizedCode = String(joinCodeInput.value || "").trim().toUpperCase();
    const data = await api("/api/partner/join", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: normalizedCode })
    });

    if (data?.partner) {
      state.partner = data.partner;
    }
    state.loveCode = data?.me?.loveCode || null;
    renderIdentity();

    joinCodeForm.reset();
    await Promise.all([loadNotifications(), loadPendingRequests(), loadCalendar()]);
    await loadPartnerStatus();
    alert("Connected with your partner.");
  } catch (error) {
    alert(error.message);
  }
}

async function disconnectPartner() {
  if (!state.partner) {
    alert("You are not connected with any partner.");
    return;
  }

  const shouldDisconnect = window.confirm("Are you sure you want to disconnect from your partner?");
  if (!shouldDisconnect) {
    return;
  }

  try {
    await api("/api/partner/disconnect", { method: "POST" });
    await Promise.all([loadPartnerStatus(), loadPendingRequests(), loadNotifications(), loadCalendar()]);
    alert("You are now disconnected from your partner.");
  } catch (error) {
    alert(error.message);
  }
}

async function sendMissYou() {
  const message = (missYouMessageInput?.value || "").trim();
  if (actionStatus) {
    actionStatus.textContent = "Sending your message...";
    actionStatus.className = "hint action-status";
  }

  try {
    const result = await api("/api/miss-you", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message })
    });

    const emailReason = result?.email?.reason ? ` Reason: ${result.email.reason}` : "";
    const successMessage = result.email && result.email.sent
      ? "Miss-you sent. Partner got in-app + email notification."
      : `Miss-you sent in-app, but email was not sent.${emailReason}`;

    if (actionStatus) {
      actionStatus.textContent = successMessage;
      actionStatus.className = `hint action-status ${result.email && result.email.sent ? "success" : "error"}`;
    }

    if (result.email && result.email.sent) {
      alert("Miss-you sent. Partner got in-app + email notification.");
    } else {
      alert(successMessage);
    }

    if (missYouMessageInput) {
      missYouMessageInput.value = "";
    }

    await loadNotifications();
  } catch (error) {
    if (actionStatus) {
      actionStatus.textContent = error.message || "Could not send miss-you message.";
      actionStatus.className = "hint action-status error";
    }
    alert(error.message);
  }
}

function renderPendingRequests() {
  pendingList.innerHTML = "";
  requestSelect.innerHTML = "";

  if (!state.pendingRequests.length) {
    pendingList.innerHTML = "<li>No pending requests right now.</li>";
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "No pending requests";
    requestSelect.appendChild(emptyOption);
    requestSelect.disabled = true;
    return;
  }

  requestSelect.disabled = false;
  state.pendingRequests.forEach((request) => {
    const senderMessage = (request.message || "I miss you").trim();
    const safeFromName = escapeHtml(request.fromName);
    const safeSenderMessage = escapeHtml(senderMessage);
    const li = document.createElement("li");
    li.className = "pending-request-item";
    li.innerHTML = `
      <strong class="pending-request-name">${safeFromName}</strong>
      <div class="pending-request-message">${safeSenderMessage}</div>
      <small class="pending-request-time">${formatDate(request.createdAt)}</small>
    `;
    pendingList.appendChild(li);

    const option = document.createElement("option");
    option.value = String(request.id);
    option.textContent = `${request.fromName} - ${formatDate(request.createdAt)} - ${senderMessage.slice(0, 34)}${senderMessage.length > 34 ? "..." : ""}`;
    requestSelect.appendChild(option);
  });
}

async function loadPendingRequests() {
  try {
    const data = await api("/api/requests");
    state.pendingRequests = data;
    renderPendingRequests();
  } catch (error) {
    pendingList.innerHTML = `<li>${error.message}</li>`;
  }
}

function renderNotifications() {
  notificationsList.innerHTML = "";
  if (!state.notifications.length) {
    notificationsList.innerHTML = "<li>No notifications yet.</li>";
    return;
  }

  state.notifications.forEach((item) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <div><strong>${item.isRead ? "Read" : "New"}</strong> - ${item.message}</div>
      <small>${formatDate(item.createdAt)}</small>
    `;

    if (!item.isRead) {
      const markReadBtn = document.createElement("button");
      markReadBtn.className = "small-btn";
      markReadBtn.textContent = "Mark Read";
      markReadBtn.addEventListener("click", async () => {
        await api(`/api/notifications/${item.id}/read`, { method: "POST" });
        loadNotifications();
      });
      li.appendChild(markReadBtn);
    }

    notificationsList.appendChild(li);
  });
}

async function loadNotifications() {
  try {
    const data = await api("/api/notifications");
    state.notifications = data;
    renderNotifications();
  } catch (error) {
    notificationsList.innerHTML = `<li>${error.message}</li>`;
  }
}

async function submitReply(event) {
  event.preventDefault();

  if (!state.pendingRequests.length) {
    alert("No pending request to reply to.");
    return;
  }

  const formData = new FormData();
  formData.append("requestId", requestSelect.value);
  formData.append("note", document.getElementById("noteInput").value);
  formData.append("eventDate", document.getElementById("eventDateInput").value);

  const photoFile = document.getElementById("photoInput").files[0];
  if (!photoFile) {
    alert("Please select a photo.");
    return;
  }
  formData.append("photo", photoFile);

  try {
    await api("/api/reply", {
      method: "POST",
      body: formData
    });

    alert("Cute reply sent.");
    replyForm.reset();
    await Promise.all([loadPendingRequests(), loadNotifications(), loadCalendar()]);
  } catch (error) {
    alert(error.message);
  }
}

function createIcsContent(entry) {
  const dateStamp = new Date(entry.eventDate).toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const uid = `love-${entry.id}@our-love-calendar`;
  const summary = `Love Memory: ${entry.fromName} -> ${entry.toName}`;
  const missYouLine = entry.missMessage ? `Miss-you message: ${entry.missMessage}` : "Miss-you message: I miss you";
  const replyLine = `Cute reply: ${entry.note}`;
  const description = `${missYouLine} | ${replyLine}`.replace(/\n/g, " ");

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Our Love Calendar//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dateStamp}`,
    `DTSTART;VALUE=DATE:${entry.eventDate.replace(/-/g, "")}`,
    `SUMMARY:${summary}`,
    `DESCRIPTION:${description}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
}

function downloadIcs(entry) {
  const content = createIcsContent(entry);
  const blob = new Blob([content], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `love-memory-${entry.id}.ics`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function deleteMemoryEntry(entryId) {
  const confirmed = window.confirm("Delete this memory? This removes the photo and both messages.");
  if (!confirmed) {
    return;
  }

  try {
    await api(`/api/entries/${entryId}`, { method: "DELETE" });
    await Promise.all([loadCalendar(), loadNotifications(), loadPendingRequests()]);
    alert("Memory deleted.");
  } catch (error) {
    alert(error.message);
  }
}

function renderCalendarGrid(month, year, entries) {
  calendarGrid.innerHTML = "";

  const first = new Date(year, month, 1);
  const startDay = first.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const weekDays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  weekDays.forEach((day) => {
    const head = document.createElement("div");
    head.className = "day-label";
    head.textContent = day;
    calendarGrid.appendChild(head);
  });

  for (let i = 0; i < startDay; i += 1) {
    const empty = document.createElement("div");
    empty.className = "day-cell";
    calendarGrid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    const date = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const dayEntries = entries.filter((item) => item.eventDate === date);

    const cell = document.createElement("div");
    cell.className = `day-cell ${dayEntries.length ? "has-event" : ""}`;

    const dayNumber = document.createElement("div");
    dayNumber.className = "day-number";
    dayNumber.textContent = String(day);
    cell.appendChild(dayNumber);

    if (dayEntries.length) {
      const dot = document.createElement("div");
      dot.className = "event-dot";
      cell.appendChild(dot);
    }

    calendarGrid.appendChild(cell);
  }
}

function renderEvents(entries) {
  eventsList.innerHTML = "";
  if (!entries.length) {
    eventsList.innerHTML = "<div class='event-card'>No memories in this month yet.</div>";
    return;
  }

  entries.forEach((entry) => {
    const safeFromName = escapeHtml(entry.fromName);
    const safeToName = escapeHtml(entry.toName);
    const safeMissMessage = escapeHtml(entry.missMessage || "I miss you");
    const safeReply = escapeHtml(entry.note);

    const card = document.createElement("article");
    card.className = "event-card";
    card.innerHTML = `
      <strong>${formatDate(entry.eventDate)}: ${safeFromName} -> ${safeToName}</strong>
      <p><strong>Message from ${safeToName}:</strong> ${safeMissMessage}</p>
      <p><strong>Reply from ${safeFromName}:</strong> ${safeReply}</p>
      <img src="${entry.imagePath}" alt="Memory" />
    `;

    const exportBtn = document.createElement("button");
    exportBtn.type = "button";
    exportBtn.className = "small-btn";
    exportBtn.textContent = "Export To Outlook (.ics)";
    exportBtn.addEventListener("click", () => downloadIcs(entry));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "small-btn danger-btn";
    deleteBtn.textContent = "Delete Memory";
    deleteBtn.addEventListener("click", () => deleteMemoryEntry(entry.id));

    const actionRow = document.createElement("div");
    actionRow.className = "event-actions";
    actionRow.appendChild(exportBtn);
    actionRow.appendChild(deleteBtn);

    card.appendChild(actionRow);
    eventsList.appendChild(card);
  });
}

async function loadCalendar() {
  const monthValue = monthPicker.value || currentMonthInput();
  const [yearStr, monthStr] = monthValue.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1;

  try {
    const data = await api(`/api/calendar?month=${monthValue}`);
    state.calendarEntries = data;
    renderCalendarGrid(month, year, data);
    renderEvents(data);
  } catch (error) {
    eventsList.innerHTML = `<div class='event-card'>${error.message}</div>`;
  }
}

async function bootstrapApp() {
  if (state.isBootstrapping) {
    return;
  }

  state.isBootstrapping = true;
  try {
    await loadProfile();
    setAppVisibility(true);
    clearClerkAuthQueryParams();
    renderIdentity();
    await setupWebSocket();
    await Promise.all([loadPartnerStatus(), loadNotifications(), loadPendingRequests(), loadCalendar()]);
    authHint.textContent = "";
  } catch (error) {
    // Keep app panel visible for signed-in users even if a data call fails.
    setAppVisibility(true);
    authHint.textContent = error.message || "Could not fully load app data.";
    console.error("Bootstrap error:", error);
  } finally {
    state.isBootstrapping = false;
    console.log("Bootstrap complete. state.user:", state.user?.name, "state.partner:", state.partner?.name);
  }
}

function handleSignedOut() {
  state.user = null;
  state.partner = null;
  state.loveCode = null;
  state.activeSessionId = null;
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  setAppVisibility(false);
}

async function syncAuthState() {
  if (state.isBootstrapping) {
    return;
  }

  if (window.Clerk && (window.Clerk.user || window.Clerk.session)) {
    const nextSessionId = window.Clerk.session?.id || null;
    if (state.activeSessionId !== nextSessionId || !state.user) {
      state.activeSessionId = nextSessionId;
      await bootstrapApp();
    }
    return;
  }

  if (state.user) {
    handleSignedOut();
  }

  setAuthMode("login");
  await mountClerk("login");
}

async function mountClerk(mode) {
  if (!window.Clerk) {
    authHint.textContent = "Clerk script not loaded.";
    return;
  }

  if (state.isMountingAuth) {
    return;
  }

  state.isMountingAuth = true;

  const sharedAppearance = {
    variables: {
      colorPrimary: "#d44f6f",
      colorText: "#2d1f16",
      colorBackground: "#ffffff",
      borderRadius: "12px",
      fontFamily: "Manrope, sans-serif"
    },
    elements: {
      card: "clerk-card",
      formButtonPrimary: "clerk-btn-primary"
    }
  };

  try {
    const needsFreshMount = !state.authWidgetsReady || !loginMount.childElementCount || !signupMount.childElementCount;

    if (needsFreshMount) {
      loginMount.innerHTML = "";
      signupMount.innerHTML = "";

      window.Clerk.mountSignIn(loginMount, {
        signInForceRedirectUrl: "/",
        signInFallbackRedirectUrl: "/",
        appearance: sharedAppearance
      });

      window.Clerk.mountSignUp(signupMount, {
        signUpForceRedirectUrl: "/",
        signUpFallbackRedirectUrl: "/",
        appearance: sharedAppearance
      });

      state.authWidgetsReady = true;
    }

    setAuthMode(mode);
  } catch (error) {
    state.authWidgetsReady = false;
    authHint.textContent = error.message || "Could not render auth UI.";
  } finally {
    state.isMountingAuth = false;
  }
}

async function initClerk() {
  try {
    await ensureClerkLoaded();
    const clerkUi = await ensureClerkUiLoaded();

    const cfgResponse = await fetch("/api/public-config");
    const cfg = await cfgResponse.json();

    if (!cfg.clerkPublishableKey) {
      authHint.textContent = "Missing CLERK_PUBLISHABLE_KEY on server.";
      return;
    }

    await window.Clerk.load({
      publishableKey: cfg.clerkPublishableKey,
      ui: clerkUi,
      signInForceRedirectUrl: "/",
      signInFallbackRedirectUrl: "/",
      signUpForceRedirectUrl: "/",
      signUpFallbackRedirectUrl: "/"
    });

    window.Clerk.addListener(async ({ user, session }) => {
      const isSignedIn = Boolean(user || session || window.Clerk.session);
      const nextSessionId = session?.id || window.Clerk.session?.id || null;

      if (!isSignedIn) {
        // Ignore transient signed-out events from Clerk internals to avoid UI flicker.
        // We only move to signed-out UI on explicit logout or hard auth failures.
        return;
      }

      authHint.textContent = "";

      if (state.activeSessionId !== nextSessionId || !state.user) {
        state.activeSessionId = nextSessionId;
        await bootstrapApp();
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void syncAuthState();
      }
    });

    window.addEventListener("focus", () => {
      void syncAuthState();
    });

    if (window.Clerk.user || window.Clerk.session) {
      state.activeSessionId = window.Clerk.session?.id || null;
      await bootstrapApp();
    } else {
      setAuthMode("login");
      await mountClerk("login");
      handleSignedOut();
    }

    void syncAuthState();
  } catch (error) {
    authHint.textContent = error.message || "Clerk init failed.";
  }
}

showLoginBtn.addEventListener("click", async () => {
  setAuthMode("login");
  try {
    await mountClerk("login");
  } catch (error) {
    authHint.textContent = error.message || "Could not open login.";
  }
});

showSignupBtn.addEventListener("click", async () => {
  setAuthMode("signup");
  try {
    await mountClerk("signup");
  } catch (error) {
    authHint.textContent = error.message || "Could not open sign up.";
  }
});

logoutBtn.addEventListener("click", async () => {
  if (window.Clerk) {
    await window.Clerk.signOut();
  }
  handleSignedOut();
});

generateCodeBtn.addEventListener("click", generateLoveCode);
joinCodeForm.addEventListener("submit", joinLoveCode);
disconnectPartnerBtn.addEventListener("click", disconnectPartner);
missYouBtn.addEventListener("click", sendMissYou);
replyForm.addEventListener("submit", submitReply);
monthPicker.addEventListener("change", loadCalendar);

monthPicker.value = currentMonthInput();
document.getElementById("eventDateInput").valueAsDate = new Date();

function isReloadLoopDetected() {
  const key = "love-calendar-reload-track";
  const now = Date.now();
  let timestamps = [];

  try {
    timestamps = JSON.parse(window.sessionStorage.getItem(key) || "[]");
    if (!Array.isArray(timestamps)) {
      timestamps = [];
    }
  } catch (_error) {
    timestamps = [];
  }

  timestamps = timestamps.filter((ts) => now - Number(ts) < 15000);
  timestamps.push(now);
  window.sessionStorage.setItem(key, JSON.stringify(timestamps));

  return timestamps.length >= 4;
}

if (isReloadLoopDetected()) {
  authHint.textContent = "Refresh loop detected. Reload stopped. Please clear URL params and login again.";
  setAppVisibility(false);
} else {
  initClerk();
}
