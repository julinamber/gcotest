const appRoot = document.getElementById("appRoot");
const logoutBtn = document.getElementById("logoutBtn");
const API_BASE = "/api";
let notificationPollTimer = null;
let adminOverviewPollTimer = null;
let adminSectionPollTimer = null;
let counselorAnalyticsPollTimer = null;
let counselorCalendarPollTimer = null;
let counselorChartDaily = null;
let counselorChartMonthly = null;
let adminChartDaily = null;
let adminChartMonthly = null;

console.log("SCRIPT IS WORKING");

console.log(typeof Chart);
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Normalize API date values (YYYY-MM-DD or ISO strings) for display */
function formatDisplayDate(val) {
  if (val == null || val === "") return "—";
  const s = String(val).trim();
  const ymd = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (ymd) return ymd[1];
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s;
}

function formatDisplayTime(val) {
  if (val == null || val === "") return "—";
  const s = String(val).trim();
  if (/^\d{2}:\d{2}/.test(s)) return s.slice(0, 5);
  return s;
}

async function downloadWithAuth(path, filename) {
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  const res = await fetch(`${API_BASE}${path}`, { headers, credentials: "include" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || "Download failed");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function destroyCounselorAnalyticsCharts() {
  if (counselorChartDaily) {
    counselorChartDaily.destroy();
    counselorChartDaily = null;
  }
  if (counselorChartMonthly) {
    counselorChartMonthly.destroy();
    counselorChartMonthly = null;
  }
}

function destroyAdminAnalyticsCharts() {
  if (adminChartDaily) {
    adminChartDaily.destroy();
    adminChartDaily = null;
  }
  if (adminChartMonthly) {
    adminChartMonthly.destroy();
    adminChartMonthly = null;
  }
}

function stopCounselorCalendarPolling() {
  if (counselorCalendarPollTimer) {
    clearInterval(counselorCalendarPollTimer);
    counselorCalendarPollTimer = null;
  }
}

function bindOrUpdateLineChart(existingRef, canvasId, labels, values, datasetLabel, borderColor) {
  const canvas = document.getElementById(canvasId);
  if (!canvas || typeof Chart === "undefined") return null;
  if (existingRef) {
    existingRef.data.labels = labels;
    existingRef.data.datasets[0].data = values;
    existingRef.data.datasets[0].label = datasetLabel;
    existingRef.update();
    return existingRef;
  }
  const ctx = canvas.getContext("2d");
  return new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: datasetLabel,
          data: values,
          borderColor: borderColor,
          backgroundColor: borderColor === "#1a367c" ? "rgba(26,54,124,0.12)" : "rgba(184,137,27,0.15)",
          tension: 0.25,
          fill: true
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { beginAtZero: true, ticks: { precision: 0, maxTicksLimit: 8 } } }
    }
  });
}

const state = {
  currentRole: null,
  activeMenu: null,
  darkMode: false,
  token: localStorage.getItem("gco_token") || null,
  user: JSON.parse(localStorage.getItem("gco_user") || "null"),
  appointments: [],
  notifications: [],
  importProfiles: [],
  users: [],
  adminOverview: null,
  counselorAnalytics: null,
  counselors: [],
  counselorUnavail: [],
  profilePicture: "",
  lastSeenNotificationCount: Number(localStorage.getItem("gco_last_seen_notif_count") || 0)
};

const DASHBOARD_MENUS = {
  student: ["Dashboard", "GCO Services", "Book Appointment", "Appointment History", "Notifications", "Settings"],
  counselor: ["Dashboard", "GCO Services", "Requests", "Availability", "Analytics", "Notifications", "Settings"],
  admin: [
    "Dashboard",
    "GCO Services",
    "Analytics",
    "Reports",
    "System Logs",
    "Users",
    "Calendars",
    "Appointments",
    "Notifications",
    "Settings"
  ]
};

const MENU_SLUGS_BY_ROLE = {
  student: {
    Dashboard: "home",
    "GCO Services": "services",
    "Book Appointment": "book",
    "Appointment History": "history",
    Notifications: "notifications",
    Settings: "settings"
  },
  counselor: {
    Dashboard: "home",
    "GCO Services": "services",
    Requests: "requests",
    Availability: "availability",
    Analytics: "analytics",
    Notifications: "notifications",
    Settings: "settings"
  },
  admin: {
    Dashboard: "home",
    "GCO Services": "services",
    Analytics: "analytics",
    Reports: "reports",
    "System Logs": "logs",
    Users: "users",
    Calendars: "calendars",
    Appointments: "appointments",
    Notifications: "notifications",
    Settings: "settings"
  }
};

function menuToSlug(role, menu) {
  return MENU_SLUGS_BY_ROLE[role]?.[menu] || "home";
}

function slugToMenu(role, slug) {
  const map = MENU_SLUGS_BY_ROLE[role];
  if (!map) return null;
  const hit = Object.entries(map).find(([, s]) => s === slug);
  return hit ? hit[0] : null;
}

function getDashboardPath(role, menu) {
  return `/dashboard/${role}/${menuToSlug(role, menu)}`;
}

function parseDashboardPath(pathname) {
  const p = (pathname || "").replace(/\/$/, "") || "/";
  const m = p.match(/^\/dashboard\/(student|counselor|admin)\/([a-z0-9-]+)$/);
  if (!m) return null;
  return { role: m[1], slug: m[2] };
}

function setDashboardDocumentTitle(menuLabel) {
  document.title = `${menuLabel} · XU GCO`;
}

function syncDashboardUrl(role, menu, mode) {
  const url = getDashboardPath(role, menu);
  if (mode === "replace") history.replaceState({ role, menu }, "", url);
  else if (mode === "push") history.pushState({ role, menu }, "", url);
  setDashboardDocumentTitle(menu);
}

function navigateDashboard(role, menu, urlMode = "push") {
  state.activeMenu = menu;
  syncDashboardUrl(role, menu, urlMode);
  renderDashboard(role);
}

function bindSidebarToggleMobile() {
  const sidebar = document.getElementById("sidebarNav");
  const toggle = document.getElementById("sidebarToggle");
  const overlay = document.getElementById("sidebarOverlay");
  if (!sidebar || !toggle || !overlay) return;
  const close = () => {
    sidebar.classList.remove("sidebar-open");
    overlay.classList.remove("sidebar-overlay-visible");
    overlay.setAttribute("aria-hidden", "true");
    toggle.setAttribute("aria-expanded", "false");
  };
  const open = () => {
    sidebar.classList.add("sidebar-open");
    overlay.classList.add("sidebar-overlay-visible");
    overlay.setAttribute("aria-hidden", "false");
    toggle.setAttribute("aria-expanded", "true");
  };
  toggle.onclick = () => {
    if (sidebar.classList.contains("sidebar-open")) close();
    else open();
  };
  overlay.onclick = close;
  sidebar.querySelectorAll(".menu-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (window.matchMedia("(max-width: 900px)").matches) close();
    });
  });
}

function resolveInitialDashboardMenu(userRole, pathname) {
  const menus = DASHBOARD_MENUS[userRole];
  let menu = menus[0];
  const parsed = parseDashboardPath(pathname);
  if (parsed) {
    const m = slugToMenu(userRole, parsed.slug);
    if (m && menus.includes(m)) menu = m;
  }
  return menu;
}

let authProvidersCache = null;
async function getAuthProviders() {
  if (authProvidersCache) return authProvidersCache;
  try {
    const r = await fetch(`${API_BASE}/auth/providers`, { credentials: "include" });
    authProvidersCache = r.ok ? await r.json() : { password: true, google: false };
  } catch {
    authProvidersCache = { password: true, google: false };
  }
  return authProvidersCache;
}

function clearAuthProvidersCache() {
  authProvidersCache = null;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, { ...options, headers, credentials: "include" });
  } catch (_networkError) {
    throw new Error("Cannot reach API. Open the app via http://localhost:3000 (not file://).");
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Request failed");
  return data;
}

async function apiUpload(path, formData) {
  const headers = state.token ? { Authorization: `Bearer ${state.token}` } : {};
  const response = await fetch(`${API_BASE}${path}`, { method: "POST", headers, body: formData, credentials: "include" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || "Upload failed");
  return data;
}

function setupLogoDisplay() {
  const logoImg = document.getElementById("schoolLogo");
  const logoFallback = document.getElementById("logoFallback");
  if (!logoImg || !logoFallback) return;

  logoImg.addEventListener("load", () => {
    logoImg.style.display = "block";
    logoFallback.style.display = "none";
  });
  logoImg.addEventListener("error", () => {
    logoImg.style.display = "none";
    logoFallback.style.display = "grid";
  });
}

function setDarkMode(enabled) {
  state.darkMode = enabled;
  document.body.style.background = enabled
    ? "linear-gradient(145deg, #09111f 0%, #10203a 100%)"
    : "linear-gradient(145deg, #f8fbff 0%, #eef4ff 100%)";
  document.querySelectorAll(".panel, .card, .top-bar").forEach((el) => {
    el.style.background = enabled ? "#111827" : "";
    el.style.color = enabled ? "#f3f4f6" : "";
    el.style.borderColor = enabled ? "#1f2937" : "";
  });
}

function getRequiredDomainByRole(role) {
  if (role === "student") return "my.xu.edu.ph";
  if (role === "counselor" || role === "admin") return "xu.edu.ph";
  return "";
}

function isValidUniversityEmailForRole(email, role) {
  const requiredDomain = getRequiredDomainByRole(role);
  return email.trim().toLowerCase().endsWith(`@${requiredDomain}`);
}

function renderRoleSelect() {
  document.title = "XU GCO";
  const tpl = document.getElementById("roleSelectTpl")?.content.cloneNode(true);
  if (!tpl) return;
  appRoot.innerHTML = "";
  appRoot.appendChild(tpl);
  logoutBtn.classList.add("hidden");

  const msgEl = document.getElementById("roleSelectMessage");
  const params = new URLSearchParams(window.location.search);
  if (params.get("err") === "role" && msgEl) {
    msgEl.classList.remove("hidden");
    msgEl.textContent = "Choose Student, Counselor, or Admin first.";
    msgEl.style.color = "#b91c1c";
  }

  document.querySelectorAll(".role-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.currentRole = btn.dataset.role;
      if (state.currentRole === "student") {
        renderStudentLogin();
        return;
      }
      renderLogin(state.currentRole);
    });
  });
}

function renderStudentLogin() {
  const tpl = document.getElementById("studentLoginTpl")?.content.cloneNode(true);
  if (!tpl) return;
  appRoot.innerHTML = "";
  appRoot.appendChild(tpl);
  logoutBtn.classList.add("hidden");

  const msgEl = document.getElementById("studentGoogleMessage");
  const googleBtn = document.getElementById("studentGoogleBtn");
  const backBtn = document.getElementById("studentBackBtn");

  googleBtn?.addEventListener("click", () => {
    state.currentRole = "student";
    startStudentGoogleSignIn(msgEl);
  });
  backBtn?.addEventListener("click", () => {
    renderRoleSelect();
  });
}

function startStudentGoogleSignIn(msgEl) {
  getAuthProviders()
    .then((p) => {
      if (!p.google) {
        if (msgEl) {
          msgEl.classList.remove("hidden");
          msgEl.textContent =
            "Google sign-in is not configured yet. Set ENABLE_GOOGLE_OAUTH=true and valid GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET in .env, then restart.";
          msgEl.style.color = "#b91c1c";
        }
        return;
      }
      window.location.href = "/auth/google/start?role=student";
    })
    .catch(() => {
      if (msgEl) {
        msgEl.classList.remove("hidden");
        msgEl.textContent = "Cannot reach server.";
        msgEl.style.color = "#b91c1c";
      }
    });
}

function renderLogin(role) {
  const tpl = document.getElementById("loginTpl")?.content.cloneNode(true);
  if (!tpl) return;
  appRoot.innerHTML = "";
  appRoot.appendChild(tpl);
  logoutBtn.classList.add("hidden");

  const label = document.getElementById("loginRoleLabel");
  if (label) label.textContent = role.charAt(0).toUpperCase() + role.slice(1);

  const form = document.getElementById("loginForm");
  const signupForm = document.getElementById("signupForm");
  const message = document.getElementById("loginMessage");
  const signupMessage = document.getElementById("signupMessage");
  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const signupNameInput = document.getElementById("signupFullName");
  const signupEmailInput = document.getElementById("signupEmail");
  const signupPasswordInput = document.getElementById("signupPassword");
  const showSignupBtn = document.getElementById("showSignupBtn");
  const showLoginBtn = document.getElementById("showLoginBtn");
  const loginPane = document.getElementById("loginPane");
  const signupPane = document.getElementById("signupPane");
  const roleEmailHint = document.getElementById("roleEmailHint");
  if (roleEmailHint) roleEmailHint.textContent = "@xu.edu.ph";

  const openPane = (name) => {
    const loginOpen = name === "login";
    loginPane.classList.toggle("hidden", !loginOpen);
    signupPane.classList.toggle("hidden", loginOpen);
  };
  showSignupBtn?.addEventListener("click", () => openPane("signup"));
  showLoginBtn?.addEventListener("click", () => openPane("login"));

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const email = emailInput.value.trim().toLowerCase();
    const password = passwordInput.value;

    if (!isValidUniversityEmailForRole(email, role)) {
      message.textContent = `Use @${getRequiredDomainByRole(role)} for this portal.`;
      message.style.color = "#b91c1c";
      return;
    }

    api("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password, role })
    })
      .then((result) => {
        state.token = result.token;
        state.user = result.user;
        localStorage.setItem("gco_token", result.token);
        localStorage.setItem("gco_user", JSON.stringify(result.user));
        message.textContent = "Success. Loading dashboard…";
        message.classList.add("status-success");
        const ur = result.user.role;
        state.activeMenu = DASHBOARD_MENUS[ur][0];
        history.replaceState(null, "", getDashboardPath(ur, state.activeMenu));
        setDashboardDocumentTitle(state.activeMenu);
        setTimeout(() => renderDashboard(ur), 200);
      })
      .catch((err) => {
        message.textContent = err.message;
        message.style.color = "#b91c1c";
      });
  });

  signupForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    const fullName = signupNameInput.value.trim();
    const email = signupEmailInput.value.trim().toLowerCase();
    const password = signupPasswordInput.value;
    if (!fullName || !email || !password) return;
    if (!isValidUniversityEmailForRole(email, role)) {
      signupMessage.textContent = "Use @xu.edu.ph email.";
      signupMessage.style.color = "#b91c1c";
      return;
    }
    api("/auth/signup", {
      method: "POST",
      body: JSON.stringify({ fullName, email, password, role })
    })
      .then((out) => {
        signupMessage.textContent = out.message || "Sign-up successful. Check your email.";
        signupMessage.className = "feedback status-success";
      })
      .catch((err) => {
        signupMessage.textContent = err.message;
        signupMessage.style.color = "#b91c1c";
      });
  });

  document.getElementById("backBtn").addEventListener("click", renderRoleSelect);
}

function renderDashboard(role) {
  const tpl = document.getElementById("dashboardTpl").content.cloneNode(true);
  appRoot.innerHTML = "";
  appRoot.appendChild(tpl);
  logoutBtn.classList.remove("hidden");
  logoutBtn.onclick = () => {
    if (notificationPollTimer) {
      clearInterval(notificationPollTimer);
      notificationPollTimer = null;
    }
    if (adminOverviewPollTimer) {
      clearInterval(adminOverviewPollTimer);
      adminOverviewPollTimer = null;
    }
    if (adminSectionPollTimer) {
      clearInterval(adminSectionPollTimer);
      adminSectionPollTimer = null;
    }
    if (counselorAnalyticsPollTimer) {
      clearInterval(counselorAnalyticsPollTimer);
      counselorAnalyticsPollTimer = null;
    }
    stopCounselorCalendarPolling();
    destroyCounselorAnalyticsCharts();
    destroyAdminAnalyticsCharts();
    state.currentRole = null;
    state.activeMenu = null;
    state.token = null;
    state.user = null;
    localStorage.removeItem("gco_token");
    localStorage.removeItem("gco_user");
    clearAuthProvidersCache();
    window.location.href = "/auth/logout";
  };

  const menusByRole = DASHBOARD_MENUS;
  const roleDescriptions = {
    student: "Appointments and updates.",
    counselor: "Requests and schedules.",
    admin: "Oversee records, users, and schedules."
  };

  document.getElementById("roleDashboardLabel").textContent = state.user?.name || "User";
  const sidebarMeta = document.getElementById("sidebarUserMeta");
  if (sidebarMeta) {
    sidebarMeta.textContent = `${state.user?.email || ""} · ${role}`;
  }
  const sidebarDesc = document.getElementById("sidebarRoleDesc");
  if (sidebarDesc) sidebarDesc.textContent = roleDescriptions[role] || "";
  refreshSidebarIdentity();
  const menuNav = document.getElementById("menuNav");
  if (!state.activeMenu || !menusByRole[role].includes(state.activeMenu)) {
    state.activeMenu = menusByRole[role][0];
  }

  menusByRole[role].forEach((menu) => {
    const btn = document.createElement("button");
    btn.className = `menu-btn ${menu === state.activeMenu ? "active" : ""}`;
    btn.textContent = menu;
    btn.onclick = () => {
      navigateDashboard(role, menu, "push");
    };
    menuNav.appendChild(btn);
  });

  bindSidebarToggleMobile();

  renderViewByRole(role, state.activeMenu).catch((err) => {
    const root = document.getElementById("viewRoot");
    root.innerHTML = `<p class="feedback" style="color:#b91c1c;">${err.message}</p>`;
  });
  if (notificationPollTimer) clearInterval(notificationPollTimer);
  notificationPollTimer = setInterval(() => {
    if (!state.user) return;
    loadNotifications().catch(() => {});
  }, 20000);
}

async function refreshSidebarIdentity() {
  const avatarImg = document.getElementById("sidebarProfileImg");
  const avatarFallback = document.getElementById("sidebarAvatarFallback");
  const label = document.getElementById("roleDashboardLabel");
  if (!avatarImg || !avatarFallback || !label || !state.user) return;
  try {
    const me = await api("/auth/me");
    state.user = { ...(state.user || {}), name: me.name, email: me.email, role: me.role };
    localStorage.setItem("gco_user", JSON.stringify(state.user));
    label.textContent = me.name || "User";
    const initials = String(me.name || "U")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() || "")
      .join("") || "U";
    avatarFallback.textContent = initials;
    if (me.profilePicture) {
      avatarImg.src = me.profilePicture.startsWith("http") ? me.profilePicture : `/${me.profilePicture}`;
      avatarImg.classList.remove("hidden");
      avatarFallback.classList.add("hidden");
    } else {
      avatarImg.classList.add("hidden");
      avatarFallback.classList.remove("hidden");
    }
  } catch (_err) {
    const initials = String(state.user?.name || "U")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() || "")
      .join("") || "U";
    avatarFallback.textContent = initials;
    avatarImg.classList.add("hidden");
    avatarFallback.classList.remove("hidden");
  }
}

async function renderViewByRole(role, menu) {
  const root = document.getElementById("viewRoot");
  if (!root) return;
  if (role === "student") return renderStudentView(root, menu);
  if (role === "counselor") return renderCounselorView(root, menu);
  if (role === "admin") return renderAdminView(root, menu);
}

async function loadAppointments() {
  state.appointments = await api("/appointments/my");
}

async function loadNotifications() {
  state.notifications = await api("/notifications/my");
  if (state.notifications.length > state.lastSeenNotificationCount) {
    const newest = state.notifications[0];
    if (newest) showToast(`${newest.title}: ${newest.message}`);
  }
  state.lastSeenNotificationCount = state.notifications.length;
  localStorage.setItem("gco_last_seen_notif_count", String(state.lastSeenNotificationCount));
}

async function loadCounselors() {
  state.counselors = await api("/utility/counselors");
}

function showToast(message) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add("visible"), 10);
  setTimeout(() => {
    el.classList.remove("visible");
    setTimeout(() => el.remove(), 250);
  }, 2800);
}

function buildYearCalendar(year, appointments, unavailable) {
  const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const week = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const todayIso = new Date().toISOString().slice(0, 10);
  const unavailableMap = new Map(unavailable.map((u) => [String(u.unavailable_date).slice(0, 10), u]));
  const appointmentDates = new Set(appointments.map((a) => String(a.appointment_date).slice(0, 10)));
  return monthNames
    .map((monthName, monthIndex) => {
      const firstDay = new Date(year, monthIndex, 1).getDay();
      const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
      const cells = [];
      for (let i = 0; i < firstDay; i += 1) cells.push('<div class="month-day empty"></div>');
      for (let day = 1; day <= daysInMonth; day += 1) {
        const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const classes = ["month-day"];
        if (unavailableMap.has(iso)) classes.push("unavailable");
        else if (iso === todayIso) classes.push("today");
        else if (appointmentDates.has(iso)) classes.push("booked");
        const title = unavailableMap.has(iso) ? unavailableMap.get(iso).message || "Unavailable" : appointmentDates.has(iso) ? "With appointments" : "Available";
        cells.push(`<button type="button" class="${classes.join(" ")} calendar-day-btn" data-date="${iso}" title="${title}">${day}</button>`);
      }
      return `
        <div class="month-card">
          <h3>${monthName}</h3>
          <div class="month-weekdays">${week.map((w) => `<span>${w}</span>`).join("")}</div>
          <div class="month-grid">${cells.join("")}</div>
        </div>
      `;
    })
    .join("");
}

async function renderCounselorCalendar(root) {
  if (!counselorCalendarPollTimer) {
    counselorCalendarPollTimer = setInterval(async () => {
      if (!state.user || state.currentRole !== "counselor") return;
      if (!["Availability"].includes(state.activeMenu)) return;
      try {
        await renderCounselorCalendar(root);
      } catch (_err) {
        // Ignore transient refresh errors; user-triggered actions still show explicit errors.
      }
    }, 5000);
  }

  const year = state.calendarYear || new Date().getFullYear();
  const [calendar, availability] = await Promise.all([api(`/counselor/calendar?year=${year}`), api("/counselor/availability")]);
  state.counselorUnavail = availability;
  const refreshedAt = new Date();

  root.innerHTML = `
    <div class="panel-header">
      <div>
        <h2 class="section-title">Calendar and Availability System</h2>
        <p class="muted">Set specific unavailable dates with optional reason and see it instantly on the yearly calendar.</p>
        <p class="muted tiny">Last updated: ${refreshedAt.toLocaleTimeString()}</p>
      </div>
    </div>
    <div class="card stack-md" style="margin-bottom:1rem;">
      <h3>Add Unavailable Date</h3>
      <form id="availabilityForm" class="stack-md">
        <label class="field"><span>Date</span><input type="date" id="unavailableDate" required /></label>
        <label class="field"><span>Reason (optional)</span><input type="text" id="unavailableReason" placeholder="e.g., May 1, 2026, unavailable (Labor Day)" /></label>
        <button class="btn primary" type="submit">Save Availability</button>
      </form>
      <p id="availabilityMsg" class="feedback"></p>
    </div>
    <div class="table-wrap" style="margin-bottom:1rem;">
      ${availability.length ? `
      <table>
        <thead><tr><th>Date</th><th>Reason</th><th>Action</th></tr></thead>
        <tbody>
          ${availability.slice(0, 20).map((u) => `<tr><td>${String(u.unavailable_date).slice(0, 10)}</td><td>${u.message || "-"}</td><td><button class="btn ghost remove-unavailable" data-id="${u.id}">Remove</button></td></tr>`).join("")}
        </tbody>
      </table>` : `<p class="muted">No unavailable dates yet.</p>`}
    </div>
    <div class="year-header">
      <div class="year-nav">
        <button class="btn ghost" id="prevYearBtn">‹</button>
        <strong>${year}</strong>
        <button class="btn ghost" id="nextYearBtn">›</button>
      </div>
      <div class="calendar-legend">
        <span><i class="dot available"></i>Available</span>
        <span><i class="dot booked"></i>With appointments</span>
        <span><i class="dot unavailable"></i>Unavailable</span>
        <span><i class="dot today"></i>Today</span>
      </div>
    </div>
    <div class="year-calendar-grid">${buildYearCalendar(year, calendar.appointments || [], calendar.unavailable || [])}</div>
    <div id="calendarDayModal" class="modal hidden">
      <div class="modal-content">
        <h3 id="dayModalTitle">Day details</h3>
        <div id="dayModalBody" class="stack-md"></div>
        <div class="auth-actions">
          <button class="btn ghost" id="closeDayModal">Close</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("availabilityForm").onsubmit = async (e) => {
    e.preventDefault();
    const date = document.getElementById("unavailableDate").value;
    const reason = document.getElementById("unavailableReason").value.trim();
    const msg = document.getElementById("availabilityMsg");
    try {
      await api("/counselor/availability", { method: "POST", body: JSON.stringify({ unavailable_date: date, message: reason || null }) });
      msg.textContent = "Availability saved.";
      msg.className = "feedback status-success";
      await renderCounselorCalendar(root);
    } catch (err) {
      msg.textContent = err.message;
      msg.style.color = "#b91c1c";
    }
  };

  document.querySelectorAll(".remove-unavailable").forEach((btn) => {
    btn.onclick = async () => {
      await api(`/counselor/availability/${btn.dataset.id}`, { method: "DELETE" });
      await renderCounselorCalendar(root);
    };
  });
  document.getElementById("prevYearBtn").onclick = async () => {
    state.calendarYear = year - 1;
    await renderCounselorCalendar(root);
  };
  document.getElementById("nextYearBtn").onclick = async () => {
    state.calendarYear = year + 1;
    await renderCounselorCalendar(root);
  };

  const appointmentByDate = {};
  (calendar.appointments || []).forEach((a) => {
    const key = String(a.appointment_date).slice(0, 10);
    if (!appointmentByDate[key]) appointmentByDate[key] = [];
    appointmentByDate[key].push(a);
  });
  const unavailableByDate = {};
  (calendar.unavailable || []).forEach((u) => {
    unavailableByDate[String(u.unavailable_date).slice(0, 10)] = u;
  });

  const modal = document.getElementById("calendarDayModal");
  const modalBody = document.getElementById("dayModalBody");
  const modalTitle = document.getElementById("dayModalTitle");
  document.querySelectorAll(".calendar-day-btn").forEach((btn) => {
    btn.onclick = () => {
      const date = btn.dataset.date;
      const dayAppointments = appointmentByDate[date] || [];
      const blocked = unavailableByDate[date];
      modalTitle.textContent = `Schedule for ${date}`;
      modalBody.innerHTML = `
        <div class="info-card">
          <h4>Availability</h4>
          <p>${blocked ? `Unavailable${blocked.message ? ` - ${blocked.message}` : ""}` : "Available"}</p>
        </div>
        <div class="info-card">
          <h4>Appointments (${dayAppointments.length})</h4>
          ${dayAppointments.length
            ? `<ul>${dayAppointments
                .map((a) => `<li>${String(a.appointment_time).slice(0, 5)} - ${a.service_type} (${a.status})</li>`)
                .join("")}</ul>`
            : "<p>No appointments for this day.</p>"}
        </div>
      `;
      modal.classList.remove("hidden");
      modal.style.display = "flex";
    };
  });
  document.getElementById("closeDayModal").onclick = () => {
    modal.classList.add("hidden");
    modal.style.display = "none";
  };
  modal.onclick = (e) => {
    if (e.target === modal) {
      modal.classList.add("hidden");
      modal.style.display = "none";
    }
  };
}

function renderRecentActivity(items) {
  const rows = (items || []).slice(0, 8);
  if (!rows.length) return "<p class='muted'>No recent activity.</p>";
  return `<div class="stack-sm">${rows
    .map((n) => `<div class="info-card"><strong>${n.title || "Activity"}</strong><p class="muted">${n.message || ""}</p></div>`)
    .join("")}</div>`;
}

async function renderNotificationsView(root) {
  await loadNotifications();
  root.innerHTML = `<div class="panel-header"><h2 class="section-title">Notifications</h2></div>${renderRecentActivity(state.notifications)}`;
}

async function renderAccountSettings(root) {
  const me = await api("/auth/me");
  const oauthOnly = me.authProvider === "google" && !me.hasPassword;
  const passwordSection = oauthOnly
    ? ""
    : `<div class="card stack-md" style="margin-bottom:1rem;">
      <h3>Change Password</h3>
      <form id="passwordForm" class="stack-md">
        <label class="field"><span>Current password</span><input id="currentPassword" type="password" required /></label>
        <label class="field"><span>New password</span><input id="newPassword" type="password" minlength="8" required /></label>
        <button class="btn primary" type="submit">Update Password</button>
      </form>
    </div>`;
  root.innerHTML = `
    <div class="panel-header"><h2 class="section-title">Settings</h2></div>
    <div class="card stack-md" style="margin-bottom:1rem;">
      <h3>Profile</h3>
      <p class="muted tiny">Signed in as <strong>${escapeHtml(me.email || "")}</strong> (${escapeHtml(me.role || "")})</p>
      <form id="profileForm" class="stack-md">
        <label class="field"><span>Full name</span><input id="profileName" type="text" value="${me.name || ""}" /></label>
        <label class="field"><span>Profile Picture</span><input id="profilePicFile" type="file" accept="image/*" /></label>
        <button class="btn primary" type="submit">Save Name</button>
        <button class="btn ghost" id="uploadProfilePicBtn" type="button">Upload Picture</button>
      </form>
    </div>
    ${passwordSection}
    <div class="switch-row">
      <div><strong>Dark Mode</strong><p class="muted tiny">Toggle appearance</p></div>
      <input id="darkModeToggle" type="checkbox" ${state.darkMode ? "checked" : ""} />
    </div>
    <div class="switch-row">
      <div><strong>Delete Account</strong><p class="muted tiny">Deactivate your account</p></div>
      <button id="deleteAccountBtn" class="btn ghost">Delete Account</button>
    </div>
    <p id="settingsMsg" class="feedback"></p>
  `;

  const msg = document.getElementById("settingsMsg");
  document.getElementById("profileForm").onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api("/auth/me/profile", {
        method: "PATCH",
        body: JSON.stringify({
          fullName: document.getElementById("profileName").value.trim()
        })
      });
      if (state.user) state.user.name = document.getElementById("profileName").value.trim();
      await refreshSidebarIdentity();
      msg.textContent = "Profile updated.";
      msg.className = "feedback status-success";
    } catch (err) {
      msg.textContent = err.message;
      msg.style.color = "#b91c1c";
    }
  };
  document.getElementById("uploadProfilePicBtn").onclick = async () => {
    const file = document.getElementById("profilePicFile").files?.[0];
    if (!file) {
      msg.textContent = "Choose an image file first.";
      msg.style.color = "#b91c1c";
      return;
    }
    const form = new FormData();
    form.append("profilePicture", file);
    try {
      await apiUpload("/auth/me/profile-picture", form);
      await refreshSidebarIdentity();
      msg.textContent = "Profile picture uploaded.";
      msg.className = "feedback status-success";
    } catch (err) {
      msg.textContent = err.message;
      msg.style.color = "#b91c1c";
    }
  };

  if (!oauthOnly) {
    document.getElementById("passwordForm").onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api("/auth/me/password", {
          method: "PATCH",
          body: JSON.stringify({
            currentPassword: document.getElementById("currentPassword").value,
            newPassword: document.getElementById("newPassword").value
          })
        });
        msg.textContent = "Password updated.";
        msg.className = "feedback status-success";
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = "#b91c1c";
      }
    };
  }
  document.getElementById("darkModeToggle").onchange = (e) => setDarkMode(e.target.checked);
  document.getElementById("deleteAccountBtn").onclick = async () => {
    if (!confirm("Delete your account? You will be logged out.")) return;
    await api("/auth/me", { method: "DELETE" });
    logoutBtn.click();
  };
}

async function renderCounselorView(root, menu) {
  if (counselorAnalyticsPollTimer) {
    clearInterval(counselorAnalyticsPollTimer);
    counselorAnalyticsPollTimer = null;
  }
  destroyCounselorAnalyticsCharts();
  if (!["Calendar", "Availability"].includes(menu)) {
    stopCounselorCalendarPolling();
  }
  if (menu === "GCO Services") return renderGcoServicesPage(root);
  if (menu === "Calendar" || menu === "Availability") return renderCounselorCalendar(root);
  if (menu === "Notifications") return renderNotificationsView(root);
  if (menu === "Settings") return renderAccountSettings(root);
  if (menu === "Requests") {
    await loadAppointments();
    const rows = state.appointments.filter((a) => ["pending", "reschedule_requested"].includes(a.status));
    const logRows = [...state.appointments].sort((a, b) => {
      const d = String(b.appointment_date).localeCompare(String(a.appointment_date));
      if (d !== 0) return d;
      return String(b.appointment_time).localeCompare(String(a.appointment_time));
    });
    const pendingTable = `<div class="table-wrap"><table><thead><tr><th>Code</th><th>Date</th><th>Time</th><th>Status</th><th>Action</th></tr></thead><tbody>${rows.map((a) => `<tr><td>${escapeHtml(a.booking_code)}</td><td>${a.appointment_date}</td><td>${String(a.appointment_time).slice(0, 5)}</td><td>${a.status}</td><td><button class="btn primary approve-btn" data-id="${a.id}">Accept</button><button class="btn ghost decline-btn" data-id="${a.id}">Decline</button></td></tr>`).join("") || `<tr><td colspan="5">No open requests</td></tr>`}</tbody></table></div>`;
    const logTable = `<div class="table-wrap" style="margin-top:1.25rem;"><table><thead><tr><th>Code</th><th>Student</th><th>Date</th><th>Time</th><th>Status</th><th>Student cancellation</th></tr></thead><tbody>${logRows.map((a) => `<tr><td>${escapeHtml(a.booking_code)}</td><td>${escapeHtml(a.student_name || "—")}</td><td>${a.appointment_date}</td><td>${String(a.appointment_time).slice(0, 5)}</td><td>${a.status}</td><td>${a.student_cancellation_reason ? escapeHtml(a.student_cancellation_reason) : "—"}</td></tr>`).join("") || `<tr><td colspan="6">No appointments yet</td></tr>`}</tbody></table></div>`;
    root.innerHTML = `<div class="panel-header"><h2 class="section-title">Requests</h2></div><h3 class="subsection-title">Open requests</h3>${pendingTable}<h3 class="subsection-title">All your appointments</h3><p class="muted tiny">When a student cancels, their reason appears in the last column.</p>${logTable}`;
    document.querySelectorAll(".approve-btn").forEach((btn) => (btn.onclick = async () => { await api(`/appointments/${btn.dataset.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "accepted" }) }); await renderCounselorView(root, menu); }));
    document.querySelectorAll(".decline-btn").forEach((btn) => (btn.onclick = async () => { await api(`/appointments/${btn.dataset.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "declined" }) }); await renderCounselorView(root, menu); }));
    return;
  }
  if (menu === "Analytics") {
    let firstPaint = true;
    const paint = async () => {
      const data = await api("/counselor/analytics");
      if (firstPaint) {
        root.innerHTML = `
          <div class="panel-header"><h2 class="section-title">Analytics</h2></div>
          <p class="muted tiny">Figures are <strong>approved sessions</strong> (appointments with status <em>accepted</em>), based on appointment date.</p>
          <div class="grid-3">
            <div class="kpi"><p>This week</p><strong id="counselorKpiWeek">${data.weekly}</strong></div>
            <div class="kpi"><p>This month</p><strong id="counselorKpiMonth">${data.monthly}</strong></div>
            <div class="kpi"><p>This year</p><strong id="counselorKpiYear">${data.yearly}</strong></div>
          </div>
          <div class="analytics-charts-row">
            <div class="chart-card">
              <h4 class="chart-card-title">Daily trend (last 30 days)</h4>
              <div class="chart-canvas-wrap"><canvas id="counselorChartDaily" aria-label="Daily sessions chart"></canvas></div>
            </div>
            <div class="chart-card">
              <h4 class="chart-card-title">Monthly trend (last 12 months)</h4>
              <div class="chart-canvas-wrap"><canvas id="counselorChartMonthly" aria-label="Monthly sessions chart"></canvas></div>
            </div>
          </div>
          <p id="counselorAnalyticsUpdated" class="muted tiny"></p>`;
        firstPaint = false;
      } else {
        document.getElementById("counselorKpiWeek").textContent = data.weekly;
        document.getElementById("counselorKpiMonth").textContent = data.monthly;
        document.getElementById("counselorKpiYear").textContent = data.yearly;
      }
      counselorChartDaily = bindOrUpdateLineChart(
        counselorChartDaily,
        "counselorChartDaily",
        data.chart30Days.map((d) => d.label),
        data.chart30Days.map((d) => d.sessions),
        "Approved sessions",
        "#1a367c"
      );
      counselorChartMonthly = bindOrUpdateLineChart(
        counselorChartMonthly,
        "counselorChartMonthly",
        data.chart12Months.map((d) => d.label),
        data.chart12Months.map((d) => d.sessions),
        "Approved sessions",
        "#b8891b"
      );
      const u = document.getElementById("counselorAnalyticsUpdated");
      if (u) u.textContent = `Last updated: ${new Date().toLocaleString()}`;
    };
    await paint();
    counselorAnalyticsPollTimer = setInterval(paint, 14000);
    return;
  }
  await loadNotifications();
  root.innerHTML = `<div class="panel-header"><h2 class="section-title">Welcome ${state.user?.name || "Counselor"}!</h2></div><h3>Recent Activity</h3>${renderRecentActivity(state.notifications)}`;
}

function renderGcoServicesPage(root) {
  const services = [
    {
      title: "Counseling",
      body:
        "Individual and group sessions, conducted by trained counselors, are offered to students who have special concerns regarding their academic, career, family or personal life in general."
    },
    {
      title: "Academic / Probation Follow-up",
      body:
        "The program helps students develop proper attitudes and more effective skills in coping with academic difficulties."
    },
    {
      title: "Individual Inventory",
      body:
        "To help the student keep track of his/her personal growth and development, the CRC makes sure that educational records, test results, and interview notes are safely filed in individual envelopes and updated yearly."
    },
    {
      title: "Placement Program",
      body:
        "Placement counselors are available to help graduating students prepare for future job screening by giving them exit interviews."
    },
    {
      title: "Faculty / Parent Consultation",
      body:
        "The services of P/ACTS-CRC staff are open to parents, faculty members and personnel regarding school and family matters."
    }
  ];
  root.innerHTML = `
    <div class="panel-header">
      <div>
        <h2 class="section-title">GCO Services</h2>
        <p class="muted">Programs offered through the Guidance and Counseling Office (CRC).</p>
      </div>
    </div>
    <div class="services-grid">
      ${services
        .map(
          (s) => `
        <article class="service-card">
          <h3 class="service-card-title">${escapeHtml(s.title)}</h3>
          <p class="service-card-body">${escapeHtml(s.body)}</p>
        </article>`
        )
        .join("")}
    </div>`;
}

async function renderStudentView(root, menu) {
  if (menu === "GCO Services") return renderGcoServicesPage(root);
  if (menu === "Book Appointment") {
    await loadCounselors();
    const todayIso = new Date().toISOString().slice(0, 10);
    const slotOptions = [
      { value: "07:30", label: "07:30 AM - 08:30 AM" },
      { value: "09:00", label: "09:00 AM - 10:00 AM" },
      { value: "10:30", label: "10:30 AM - 11:30 AM" },
      { value: "13:00", label: "01:00 PM - 02:00 PM" },
      { value: "14:30", label: "02:30 PM - 03:30 PM" }
    ];
    root.innerHTML = `
      <div class="panel-header"><h2 class="section-title">Book Appointment</h2></div>
      <form id="bookForm" class="stack-md">
        <label class="field"><span>Counselor</span><select id="bookCounselor" required>${state.counselors.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select></label>
        <label class="field"><span>Date</span><input type="date" id="bookDate" min="${todayIso}" required /></label>
        <label class="field"><span>Time</span><select id="bookTime">${slotOptions.map((s) => `<option value="${s.value}">${s.label}</option>`).join("")}</select></label>
        <label class="field"><span>Service Type</span><select id="bookService"><option value="Counseling">Counseling</option><option value="Academic/Probation Follow up">Academic/Probation Follow up</option><option value="Individual Inventory">Individual Inventory</option><option value="Placement Program">Placement Program</option><option value="Faculty/Parent Consultation">Faculty/Parent Consultation</option></select></label>
        <label class="field"><span>Additional Information</span><textarea id="bookReason" placeholder="Tell us briefly what you need help with."></textarea></label>
        <button type="submit" class="btn primary">Book</button>
      </form><p id="bookMsg" class="feedback"></p>`;

    const counselorSelect = document.getElementById("bookCounselor");
    const dateInput = document.getElementById("bookDate");
    let unavailableDates = [];
    const loadUnavailable = async () => {
      if (!counselorSelect.value) return;
      const rows = await api(`/counselor/availability/${counselorSelect.value}`);
      unavailableDates = rows.map((r) => String(r.unavailable_date).slice(0, 10));
    };
    counselorSelect.onchange = loadUnavailable;
    await loadUnavailable();
    dateInput.onchange = () => dateInput.setCustomValidity(unavailableDates.includes(dateInput.value) ? "Selected date is unavailable for this counselor." : "");
    document.getElementById("bookForm").onsubmit = async (e) => {
      e.preventDefault();
      const payload = {
        counselorId: Number(counselorSelect.value),
        date: dateInput.value,
        time: document.getElementById("bookTime").value,
        serviceType: document.getElementById("bookService").value,
        reason: document.getElementById("bookReason").value.trim()
      };
      const msg = document.getElementById("bookMsg");
      try {
        await api("/appointments", { method: "POST", body: JSON.stringify(payload) });
        msg.textContent = "Appointment booked successfully.";
        msg.className = "feedback status-success";
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = "#b91c1c";
      }
    };
    return;
  }
  if (menu === "Appointment History") {
    await loadAppointments();
    const canCancel = (status) => ["pending", "accepted", "reschedule_requested"].includes(String(status).toLowerCase());
    const rowsHtml =
      state.appointments.length === 0
        ? `<tr><td colspan="6">No appointments yet.</td></tr>`
        : state.appointments
            .map((a) => {
              const timeDisp = formatDisplayTime(a.appointment_time);
              const cancelBtn = canCancel(a.status)
                ? `<button type="button" class="btn ghost student-cancel-appt" data-id="${a.id}" data-code="${escapeHtml(a.booking_code)}">Cancel</button>`
                : `<span class="muted">—</span>`;
              const cancelNote =
                String(a.status).toLowerCase() === "cancelled" && a.student_cancellation_reason
                  ? escapeHtml(a.student_cancellation_reason)
                  : "—";
              return `<tr><td>${escapeHtml(a.booking_code)}</td><td>${formatDisplayDate(a.appointment_date)}</td><td>${timeDisp}</td><td>${a.status}</td><td class="cancel-reason-cell">${cancelNote}</td><td>${cancelBtn}</td></tr>`;
            })
            .join("");
    root.innerHTML = `
      <div class="panel-header"><h2 class="section-title">Appointment History</h2></div>
      <div class="table-wrap"><table><thead><tr><th>Code</th><th>Date</th><th>Time</th><th>Status</th><th>Your cancellation reason</th><th>Action</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
      <div id="studentCancelModal" class="modal hidden" style="display:none;">
        <div class="modal-content stack-md">
          <h3 id="studentCancelTitle">Cancel appointment</h3>
          <p class="muted tiny">Counselors and admin will see this reason.</p>
          <label class="field"><span>Why are you cancelling?</span><textarea id="studentCancelReason" rows="4" required placeholder="e.g. Schedule conflict, no longer needed…" minlength="5"></textarea></label>
          <div class="auth-actions">
            <button type="button" class="btn ghost" id="studentCancelDismiss">Back</button>
            <button type="button" class="btn primary" id="studentCancelConfirm">Confirm cancellation</button>
          </div>
        </div>
      </div>
      <p id="studentHistoryMsg" class="feedback"></p>`;
    const modal = document.getElementById("studentCancelModal");
    const reasonInput = document.getElementById("studentCancelReason");
    const titleEl = document.getElementById("studentCancelTitle");
    let pendingCancelId = null;
    const closeModal = () => {
      modal.classList.add("hidden");
      modal.style.display = "none";
      pendingCancelId = null;
      reasonInput.value = "";
    };
    const openModal = (id, code) => {
      pendingCancelId = id;
      titleEl.textContent = `Cancel ${code}`;
      reasonInput.value = "";
      modal.classList.remove("hidden");
      modal.style.display = "flex";
      reasonInput.focus();
    };
    document.getElementById("studentCancelDismiss").onclick = closeModal;
    modal.onclick = (e) => {
      if (e.target === modal) closeModal();
    };
    document.getElementById("studentCancelConfirm").onclick = async () => {
      const msg = document.getElementById("studentHistoryMsg");
      const reason = reasonInput.value.trim();
      if (reason.length < 5) {
        msg.textContent = "Please enter at least 5 characters.";
        msg.style.color = "#b91c1c";
        return;
      }
      if (!pendingCancelId) return;
      try {
        await api(`/appointments/${pendingCancelId}`, {
          method: "DELETE",
          body: JSON.stringify({ cancellationReason: reason })
        });
        closeModal();
        msg.textContent = "Appointment cancelled.";
        msg.className = "feedback status-success";
        await renderStudentView(root, menu);
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = "#b91c1c";
      }
    };
    document.querySelectorAll(".student-cancel-appt").forEach((btn) => {
      btn.onclick = () => openModal(btn.dataset.id, btn.dataset.code || "booking");
    });
    return;
  }
  if (menu === "Notifications") {
    return renderNotificationsView(root);
  }
  if (menu === "Settings") return renderAccountSettings(root);
  await loadNotifications();
  root.innerHTML = `<div class="panel-header"><h2 class="section-title">Welcome ${state.user?.name || "Student"}!</h2></div><h3>Recent Activity</h3>${renderRecentActivity(state.notifications)}`;
}

async function renderAdminSystemLogsPage(root) {
  const paint = async () => {
    const data = await api("/admin/logs?limit=120");
    const rows = data.items.length === 0
      ? `<tr><td colspan="4">No recent activity.</td></tr>`
      : data.items.map((r) => {
          const time = new Date(r.createdAt).toLocaleString('en-PH');
          const actor = `${r.actorName || 'System'} (${r.actorRole})`;
          let readableAction = r.action;
          const meta = r.meta || {};
          
          // Parse common actions to readable format
          if (r.action === 'login') readableAction = `${actor} logged in`;
          else if (r.action === 'admin_created_user') readableAction = `Created user: ${meta.email || 'unknown'} (${meta.role || '?'})`;
          else if (r.action === 'appointment_status_changed') readableAction = `Appointment ${meta.bookingCode || meta.appointmentId}: ${meta.newStatus || 'updated'}`;
          else if (r.action === 'student_cancelled_appointment') readableAction = `Student cancelled: ${meta.bookingCode}`;
          else if (r.action === 'admin_deleted_appointment') readableAction = `Admin deleted appointment: ${meta.bookingCode}`;
          else if (r.action.includes('import')) readableAction = `CSV import: ${meta.imported || 0} records`;
          else if (r.action === 'admin_notification_sent') readableAction = `Sent notification: ${meta.title}`;
          
          const details = Object.entries(meta)
            .map(([k, v]) => `${k}: ${String(v).slice(0, 50)}${String(v).length > 50 ? '...' : ''}`)
            .join(', ') || '—';
            
          return `<tr><td>${time}</td><td>${escapeHtml(actor)}</td><td>${escapeHtml(readableAction)}</td><td class="log-meta-cell">${escapeHtml(details)}</td></tr>`;
        }).join("");
  root.innerHTML = `
      <div class="panel-header"><h2 class="section-title">System Logs</h2></div>
      <p class="muted tiny">Recent actions, appointment updates, cancellations, and user activity. Auto-refreshes every 10s.</p>
      <div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Activity</th><th>Details</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="muted tiny">Last refresh: ${new Date().toLocaleString()}</p>`;
  };
  await paint();
  adminSectionPollTimer = setInterval(paint, 10000);
}

async function renderAdminReportsPage(root) {
  let shellReady = false;
  const paint = async () => {
    const s = await api("/admin/reports/summary");
    if (!shellReady) {
      root.innerHTML = `
        <div class="panel-header"><h2 class="section-title">Reports</h2></div>
        <p class="muted tiny">Live database summary. Export files for documentation or accreditation.</p>
        <div class="grid-3">
          <div class="kpi"><p>Active users</p><strong id="repUsers">0</strong></div>
          <div class="kpi"><p>Total bookings</p><strong id="repAppt">0</strong></div>
          <div class="kpi"><p>Open requests</p><strong id="repPending">0</strong></div>
        </div>
        <div class="grid-3">
          <div class="kpi"><p>Accepted sessions</p><strong id="repAcc">0</strong></div>
          <div class="kpi"><p>Cancelled</p><strong id="repCan">0</strong></div>
          <div class="kpi"><p>Audit rows (24h)</p><strong id="repLog">0</strong></div>
        </div>
        <div class="admin-report-actions stack-sm">
          <button type="button" class="btn primary" id="dlApptCsv">Download appointments (CSV)</button>
          <button type="button" class="btn ghost" id="dlAuditCsv">Download system activity (CSV)</button>
          <button type="button" class="btn ghost" id="dlSummaryJson">Download summary (JSON)</button>
        </div>
        <h3 class="subsection-title">Counselor workload</h3>
        <div id="repCounselorTable" class="table-wrap"></div>
        <p id="repUpdated" class="muted tiny"></p>
        <p id="repMsg" class="feedback"></p>`;
      document.getElementById("dlApptCsv").onclick = async () => {
        const msg = document.getElementById("repMsg");
        try {
          await downloadWithAuth("/admin/reports/appointments-csv", `gco-appointments-${Date.now()}.csv`);
          msg.textContent = "Appointments CSV download started.";
          msg.className = "feedback status-success";
        } catch (e) {
          msg.textContent = e.message;
          msg.style.color = "#b91c1c";
        }
      };
      document.getElementById("dlAuditCsv").onclick = async () => {
        const msg = document.getElementById("repMsg");
        try {
          await downloadWithAuth("/admin/reports/audit-csv", `gco-system-activity-${Date.now()}.csv`);
          msg.textContent = "Activity log CSV download started.";
          msg.className = "feedback status-success";
        } catch (e) {
          msg.textContent = e.message;
          msg.style.color = "#b91c1c";
        }
      };
      document.getElementById("dlSummaryJson").onclick = async () => {
        const msg = document.getElementById("repMsg");
        try {
          const fresh = await api("/admin/reports/summary");
          const blob = new Blob([JSON.stringify(fresh, null, 2)], { type: "application/json" });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `gco-report-summary-${Date.now()}.json`;
          a.click();
          URL.revokeObjectURL(url);
          msg.textContent = "Summary JSON download started.";
          msg.className = "feedback status-success";
        } catch (e) {
          msg.textContent = e.message;
          msg.style.color = "#b91c1c";
        }
      };
      shellReady = true;
    }
    document.getElementById("repUsers").textContent = s.users.total;
    document.getElementById("repAppt").textContent = s.appointments.total;
    document.getElementById("repPending").textContent = s.appointments.pending;
    document.getElementById("repAcc").textContent = s.appointments.accepted;
    document.getElementById("repCan").textContent = s.appointments.cancelled;
    document.getElementById("repLog").textContent = s.activity.auditLogEntriesLast24h;
    const tb = document.getElementById("repCounselorTable");
    tb.innerHTML =
      s.counselorBreakdown.length === 0
        ? `<p class="muted">No counselors.</p>`
        : `<table><thead><tr><th>Counselor</th><th>Approved sessions</th><th>All bookings</th></tr></thead><tbody>${s.counselorBreakdown
            .map(
              (c) =>
                `<tr><td>${escapeHtml(c.counselorName)}</td><td>${c.acceptedSessions}</td><td>${c.totalBookings}</td></tr>`
            )
            .join("")}</tbody></table>`;
    document.getElementById("repUpdated").textContent = `Summary generated: ${new Date(s.generatedAt).toLocaleString()}`;
  };
  await paint();
  adminSectionPollTimer = setInterval(paint, 16000);
}

async function renderAdminAnalyticsPage(root) {
  const users = await api("/admin/users");
  const counselors = users.filter((u) => u.role === "counselor" && u.is_active);
  let selectedId = counselors.length ? counselors[0].id : null;

  const paint = async () => {
    if (!selectedId) {
      root.innerHTML = `<div class="panel-header"><h2 class="section-title">Analytics</h2></div><p class="muted">Add at least one counselor to view session analytics.</p>`;
      destroyAdminAnalyticsCharts();
      adminChartDaily = null;
      adminChartMonthly = null;
      return;
    }
    const data = await api(`/admin/analytics/counselor/${selectedId}`);
    if (!root.querySelector("#adminAnalyticsSelect")) {
      root.innerHTML = `
        <div class="panel-header"><h2 class="section-title">Counselor Analytics</h2></div>
        <div class="card stack-md" style="margin-bottom:1rem;">
          <label class="field"><span>Counselor</span><select id="adminAnalyticsSelect"></select></label>
          <p class="muted tiny">KPIs and charts count <strong>approved sessions</strong> (status: accepted) by appointment date. Updates every few seconds while you stay on this page.</p>
        </div>
        <div class="grid-3">
          <div class="kpi"><p>This week</p><strong id="admKpiW">0</strong></div>
          <div class="kpi"><p>This month</p><strong id="admKpiM">0</strong></div>
          <div class="kpi"><p>This year</p><strong id="admKpiY">0</strong></div>
        </div>
        <p class="subsection-title" id="admCounTitle"></p>
        <div class="analytics-charts-row">
          <div class="chart-card"><h4 class="chart-card-title">Daily trend (30 days)</h4><div class="chart-canvas-wrap"><canvas id="adminChartDaily"></canvas></div></div>
          <div class="chart-card"><h4 class="chart-card-title">Monthly trend (12 months)</h4><div class="chart-canvas-wrap"><canvas id="adminChartMonthly"></canvas></div></div>
        </div>
        <p id="adminAnUpdated" class="muted tiny"></p>`;
      const sel = document.getElementById("adminAnalyticsSelect");
      counselors.forEach((c) => {
        const o = document.createElement("option");
        o.value = c.id;
        o.textContent = c.full_name;
        sel.appendChild(o);
      });
      sel.value = String(selectedId);
      sel.addEventListener("change", () => {
        selectedId = Number(sel.value);
        destroyAdminAnalyticsCharts();
        adminChartDaily = null;
        adminChartMonthly = null;
        paint();
      });
    }
    const selEl = document.getElementById("adminAnalyticsSelect");
    if (selEl) selEl.value = String(selectedId);
    document.getElementById("admKpiW").textContent = data.weekly;
    document.getElementById("admKpiM").textContent = data.monthly;
    document.getElementById("admKpiY").textContent = data.yearly;
    document.getElementById("admCounTitle").textContent = `${data.counselorName || ""} — session overview`;
    adminChartDaily = bindOrUpdateLineChart(
      adminChartDaily,
      "adminChartDaily",
      data.chart30Days.map((d) => d.label),
      data.chart30Days.map((d) => d.sessions),
      "Approved sessions",
      "#1a367c"
    );
    adminChartMonthly = bindOrUpdateLineChart(
      adminChartMonthly,
      "adminChartMonthly",
      data.chart12Months.map((d) => d.label),
      data.chart12Months.map((d) => d.sessions),
      "Approved sessions",
      "#b8891b"
    );
    document.getElementById("adminAnUpdated").textContent = `Last updated: ${new Date().toLocaleString()}`;
  };

  await paint();
  if (counselors.length) adminSectionPollTimer = setInterval(paint, 14000);
}

async function renderAdminView(root, menu) {
  // Clear all polls before new view
  if (adminOverviewPollTimer) {
    clearInterval(adminOverviewPollTimer);
    adminOverviewPollTimer = null;
  }
  if (adminSectionPollTimer) {
    clearInterval(adminSectionPollTimer);
    adminSectionPollTimer = null;
  }
  destroyAdminAnalyticsCharts();
  if (menu === "GCO Services") return renderGcoServicesPage(root);
  if (menu === "Notifications") return renderNotificationsView(root);
  if (menu === "Settings") {
    root.innerHTML = `
      <div class="panel-header"><h2 class="section-title">Settings</h2></div>
      <div class="card stack-md" style="margin-bottom:1rem;">
        <h3>CSV Upload (Google Sheets Integration)</h3>
        <form id="adminCsvImportForm" class="stack-md">
          <input type="file" id="adminCsvFile" accept=".csv" required />
          <button class="btn primary" type="submit">Upload CSV</button>
        </form>
        <p id="adminCsvMsg" class="feedback"></p>
      </div>
      <div class="card stack-md" style="margin-bottom:1rem;">
        <h3>Google Sheets API Sync</h3>
        <form id="adminSheetSyncForm" class="stack-md">
          <label class="field"><span>Spreadsheet ID</span><input id="sheetId" type="text" placeholder="e.g., 1AbC..." required /></label>
          <label class="field"><span>Range</span><input id="sheetRange" type="text" placeholder="e.g., Appointments!A1:K" required /></label>
          <button class="btn primary" type="submit">Sync from Google Sheets</button>
        </form>
        <p id="adminSheetMsg" class="feedback"></p>
      </div>
      <div class="card stack-md"><h3>Account Settings</h3><button id="openAdminAccountSettings" class="btn ghost">Open Account Settings</button></div>
    `;
    document.getElementById("openAdminAccountSettings").onclick = () => renderAccountSettings(root);
    document.getElementById("adminCsvImportForm").onsubmit = async (e) => {
      e.preventDefault();
      const msg = document.getElementById("adminCsvMsg");
      const f = document.getElementById("adminCsvFile").files?.[0];
      if (!f) return;
      const form = new FormData();
      form.append("file", f);
      try {
        const out = await apiUpload("/import/appointments-csv", form);
        msg.textContent = `Imported ${out.imported}, skipped ${out.skipped}.`;
        msg.className = "feedback status-success";
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = "#b91c1c";
      }
    };
    document.getElementById("adminSheetSyncForm").onsubmit = async (e) => {
      e.preventDefault();
      const msg = document.getElementById("adminSheetMsg");
      try {
        const out = await api("/sheets/sync", {
          method: "POST",
          body: JSON.stringify({
            spreadsheetId: document.getElementById("sheetId").value.trim(),
            range: document.getElementById("sheetRange").value.trim()
          })
        });
        msg.textContent = `Sync complete. Imported ${out.imported}, skipped ${out.skipped}.`;
        msg.className = "feedback status-success";
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = "#b91c1c";
      }
    };
    return;
  }
  if (menu === "Users") {
    const users = await api("/admin/users");
    root.innerHTML = `
      <div class="panel-header"><h2 class="section-title">User Management</h2></div>
      <div class="card stack-md" style="margin-bottom:1rem;">
        <h3>Create Account</h3>
        <form id="createUserForm" class="grid-4">
          <input id="newUserName" type="text" placeholder="Full name" required />
          <input id="newUserEmail" type="email" placeholder="Email" required />
          <select id="newUserRole"><option value="student">Student</option><option value="counselor">Counselor</option><option value="admin">Admin</option></select>
          <input id="newUserPassword" type="password" placeholder="Password (min 8)" minlength="8" required />
          <button class="btn primary" type="submit">Create</button>
        </form>
      </div>
      <div class="table-wrap"><table><thead><tr><th>ID</th><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Action</th></tr></thead><tbody>${users.map((u) => `<tr><td>${u.id}</td><td>${u.full_name}</td><td>${u.email}</td><td>${u.role}</td><td>${u.is_active ? "Active" : "Inactive"}</td><td><button class="btn ghost admin-delete-user" data-id="${u.id}" data-email="${u.email}">Delete</button></td></tr>`).join("")}</tbody></table></div><p id="adminUserMsg" class="feedback"></p>`;
    document.getElementById("createUserForm").onsubmit = async (e) => {
      e.preventDefault();
      const msg = document.getElementById("adminUserMsg");
      try {
        await api("/admin/users", {
          method: "POST",
          body: JSON.stringify({
            fullName: document.getElementById("newUserName").value.trim(),
            email: document.getElementById("newUserEmail").value.trim().toLowerCase(),
            role: document.getElementById("newUserRole").value,
            password: document.getElementById("newUserPassword").value
          })
        });
        msg.textContent = "User account created.";
        msg.className = "feedback status-success";
        await renderAdminView(root, menu);
      } catch (err) {
        msg.textContent = err.message;
        msg.style.color = "#b91c1c";
      }
    };
    document.querySelectorAll(".admin-delete-user").forEach((btn) => {
      btn.onclick = async () => {
        const ok = confirm(`Delete user ${btn.dataset.email}? This also removes linked appointments and notifications.`);
        if (!ok) return;
        const msg = document.getElementById("adminUserMsg");
        try {
          await api(`/admin/users/${btn.dataset.id}`, { method: "DELETE" });
          msg.textContent = "User deleted successfully.";
          msg.className = "feedback status-success";
          await renderAdminView(root, menu);
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = "#b91c1c";
        }
      };
    });
    return;
  }
  if (menu === "Appointments") {
    const rows = await api("/appointments/my");
    root.innerHTML = `<div class="panel-header"><h2 class="section-title">Appointments</h2></div><div class="table-wrap"><table><thead><tr><th>Code</th><th>Student</th><th>Counselor</th><th>Date</th><th>Time</th><th>Status</th><th>Student cancellation</th><th>Action</th></tr></thead><tbody>${rows.map((a) => `<tr><td>${escapeHtml(a.booking_code)}</td><td>${escapeHtml(a.student_name || "—")}</td><td>${escapeHtml(a.counselor_name || "—")}</td><td>${a.appointment_date}</td><td>${String(a.appointment_time).slice(0, 5)}</td><td>${a.status}</td><td>${a.student_cancellation_reason ? escapeHtml(a.student_cancellation_reason) : "—"}</td><td><button class="btn ghost admin-resched" data-id="${a.id}">Request Reschedule</button><button class="btn ghost admin-delete-appt" data-id="${a.id}">Delete</button></td></tr>`).join("")}</tbody></table></div><p id="adminApptMsg" class="feedback"></p>`;
    document.querySelectorAll(".admin-resched").forEach((btn) => {
      btn.onclick = async () => {
        const msg = document.getElementById("adminApptMsg");
        try {
          await api(`/appointments/${btn.dataset.id}/status`, { method: "PATCH", body: JSON.stringify({ status: "reschedule_requested" }) });
          msg.textContent = "Reschedule request sent.";
          msg.className = "feedback status-success";
          await renderAdminView(root, menu);
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = "#b91c1c";
        }
      };
    });
    document.querySelectorAll(".admin-delete-appt").forEach((btn) => {
      btn.onclick = async () => {
        const ok = confirm("Delete this appointment permanently? This will remove it from the database.");
        if (!ok) return;
        const msg = document.getElementById("adminApptMsg");
        try {
          await api(`/admin/appointments/${btn.dataset.id}`, { method: "DELETE" });
          msg.textContent = "Appointment deleted.";
          msg.className = "feedback status-success";
          await renderAdminView(root, menu);
        } catch (err) {
          msg.textContent = err.message;
          msg.style.color = "#b91c1c";
        }
      };
    });
    return;
  }
  if (menu === "Calendars") {
    await loadCounselors();
    const year = state.calendarYear || new Date().getFullYear();
    root.innerHTML = `
      <div class="panel-header"><h2 class="section-title">Counselor Calendar</h2></div>
      <div class="card stack-md" style="margin-bottom:1rem;">
        <label class="field"><span>Select Counselor</span><select id="adminCounselorSelect">${state.counselors.map((c) => `<option value="${c.id}">${c.name}</option>`).join("")}</select></label>
        <div class="auth-actions"><button id="adminLoadCalendar" class="btn primary">Load Calendar</button></div>
      </div>
      <div id="adminCalendarArea"></div>
    `;
    const loadAdminCalendar = async () => {
      const counselorId = Number(document.getElementById("adminCounselorSelect").value);
      const data = await api(`/counselor/calendar?year=${year}&counselorId=${counselorId}`);
      const area = document.getElementById("adminCalendarArea");
      area.innerHTML = `<div class="year-header"><strong>${year}</strong></div><div class="year-calendar-grid">${buildYearCalendar(year, data.appointments || [], data.unavailable || [])}</div>`;
    };
    document.getElementById("adminLoadCalendar").onclick = loadAdminCalendar;
    await loadAdminCalendar();
    return;
  }
  if (menu === "Analytics") {
    await renderAdminAnalyticsPage(root);
    return;
  }
  if (menu === "Reports") {
    await renderAdminReportsPage(root);
    return;
  }
  if (menu === "System Logs") {
    await renderAdminSystemLogsPage(root);
    return;
  }
  await loadNotifications();
  let overview = { totalUsers: "—", totalAppointments: "—", pendingRequests: "—" };
  try {
    overview = await api("/admin/overview");
  } catch (_e) {
    /* keep placeholders */
  }
  root.innerHTML = `
    <div class="panel-header"><h2 class="section-title">Welcome ${escapeHtml(state.user?.name || "Admin")}!</h2></div>
    <div class="admin-overview-stats">
      <div class="admin-stat-card">
        <p class="admin-stat-label">Registered users</p>
        <p class="admin-stat-value" id="adminStatUsers">${overview.totalUsers}</p>
      </div>
      <div class="admin-stat-card">
        <p class="admin-stat-label">Total bookings</p>
        <p class="admin-stat-value" id="adminStatBookings">${overview.totalAppointments}</p>

      </div>
      <div class="admin-stat-card">
        <p class="admin-stat-label">Open requests</p>
        <p class="admin-stat-value" id="adminStatOpen">${overview.pendingRequests}</p>

      </div>
    </div>

      </div>

      </div>
    </div>
    <h3>Recent Activity</h3>
    ${renderRecentActivity(state.notifications)}`;

  const refreshAdminOverview = async () => {
    try {
      const o = await api("/admin/overview");
      const u = document.getElementById("adminStatUsers");
      const b = document.getElementById("adminStatBookings");
      const p = document.getElementById("adminStatOpen");
      if (u) u.textContent = o.totalUsers;
      if (b) b.textContent = o.totalAppointments;
      if (p) p.textContent = o.pendingRequests;
    } catch (_err) {
      /* leave previous values */
    }
  };
  adminOverviewPollTimer = setInterval(refreshAdminOverview, 12000);
}

async function initApp() {
  setupLogoDisplay();
  const path = (window.location.pathname || "/").replace(/\/$/, "") || "/";
  const headers = {};
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  const tryMe = async () => {
    const res = await fetch(`${API_BASE}/auth/me`, { credentials: "include", headers });
    if (!res.ok) return null;
    return res.json();
  };

  try {
    let me = await tryMe();
    if (!me && path.startsWith("/dashboard")) {
      for (let i = 0; i < 4 && !me; i += 1) {
        await new Promise((r) => setTimeout(r, 120 * (i + 1)));
        me = await tryMe();
      }
    }
    if (me) {
      state.user = { id: me.id, name: me.name, email: me.email, role: me.role };
      state.currentRole = me.role;
      state.activeMenu = resolveInitialDashboardMenu(me.role, path);
      history.replaceState(null, "", getDashboardPath(me.role, state.activeMenu));
      setDashboardDocumentTitle(state.activeMenu);
      renderDashboard(me.role);
      return;
    }
  } catch (_err) {
    /* network */
  }
  if (path.startsWith("/dashboard")) {
    window.location.replace("/");
    return;
  }
  renderRoleSelect();
}

window.addEventListener("popstate", () => {
  if (!state.user?.role) return;
  const p = (window.location.pathname || "/").replace(/\/$/, "") || "/";
  const parsed = parseDashboardPath(p);
  if (!parsed || parsed.role !== state.user.role) return;
  const m = slugToMenu(state.user.role, parsed.slug);
  if (m && DASHBOARD_MENUS[state.user.role].includes(m)) {
    state.activeMenu = m;
    setDashboardDocumentTitle(m);
    renderDashboard(state.user.role);
  }
});

initApp();

