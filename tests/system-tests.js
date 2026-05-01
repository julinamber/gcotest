const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const SYSTEM_NAME = process.env.TEST_SYSTEM_NAME || "GCO Counseling Appointment Management System";
const BRANCH = process.env.TEST_BRANCH || "feature/user-management";

function padRight(s, n) {
  const v = String(s ?? "");
  return v.length >= n ? v.slice(0, n - 1) + "…" : v + " ".repeat(n - v.length);
}

async function j(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const body = await res.json().catch(() => ({}));
  return { res, body };
}

async function login({ email, password, role }) {
  const { res, body } = await j("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, role })
  });
  if (!res.ok) throw new Error(body.message || "login failed");
  return body.token;
}

async function pickAvailableCounselorAndDate(studentToken, daysAheadMin = 1, maxLookaheadDays = 21) {
  for (let i = daysAheadMin; i <= maxLookaheadDays; i += 1) {
    const date = new Date(Date.now() + i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const { res, body } = await j(`/api/utility/counselors?date=${date}`, {
      headers: { Authorization: `Bearer ${studentToken}` }
    });
    if (!res.ok || !Array.isArray(body) || body.length === 0) continue;
    return { counselorId: body[0].id, date };
  }
  return null;
}

async function runTest(test) {
  try {
    const out = await test.run();
    return {
      id: test.id,
      description: test.description,
      expected: test.expected,
      observed: out.observed || "",
      result: out.pass ? "PASSED" : "FAILED"
    };
  } catch (e) {
    return {
      id: test.id,
      description: test.description,
      expected: test.expected,
      observed: `Error: ${e.message}`,
      result: "FAILED"
    };
  }
}

function printReport(title, rows) {
  console.log("");
  console.log(title);
  console.log(`System: ${SYSTEM_NAME}`);
  console.log(`Branch: ${BRANCH}`);
  console.log("");
  console.log(
    [
      padRight("Test ID", 7),
      padRight("Description", 38),
      padRight("Expected Outcome", 34),
      padRight("Observed Outcome", 38),
      padRight("Result", 7)
    ].join(" | ")
  );
  console.log("-".repeat(140));
  for (const r of rows) {
    console.log(
      [
        padRight(r.id, 7),
        padRight(r.description, 38),
        padRight(r.expected, 34),
        padRight(r.observed, 38),
        padRight(r.result, 7)
      ].join(" | ")
    );
  }
}

async function runSuite(title, tests) {
  const rows = [];
  for (const t of tests) rows.push(await runTest(t));
  printReport(title, rows);
}

async function run() {
  console.log(`SYSTEM TESTING: ${SYSTEM_NAME}`);
  console.log(`Base: ${BASE}`);
  console.log(`Branch: ${BRANCH}`);
  console.log(`Date: ${new Date().toISOString()}`);

  // Tokens (shared)
  let adminToken = null;
  let counselorToken = null;
  let studentToken = null;
  try { adminToken = await login({ email: "admin@xu.edu.ph", password: "admin123", role: "admin" }); } catch {}
  try { counselorToken = await login({ email: "counselor@xu.edu.ph", password: "counselor123", role: "counselor" }); } catch {}
  try { studentToken = await login({ email: "student@my.xu.edu.ph", password: "student123", role: "student" }); } catch {}

  let createdAppointmentId = null;

  // ---------------- STUDENT (12) ----------------
  const studentTests = [
    {
      id: 1,
      description: "Server Status Check",
      expected: "System responds with success status",
      run: async () => {
        const { res } = await j("/api/health");
        return { pass: res.ok, observed: res.ok ? "Server responded successfully" : `Status ${res.status}` };
      }
    },
    {
      id: 2,
      description: "Student Login",
      expected: "Token should be generated successfully",
      run: async () => ({ pass: Boolean(studentToken), observed: studentToken ? "Token returned" : "Token not returned" })
    },
    {
      id: 3,
      description: "View own profile",
      expected: "Profile data should be returned",
      run: async () => {
        if (!studentToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/auth/me", { headers: { Authorization: `Bearer ${studentToken}` } });
        return { pass: res.ok, observed: res.ok ? "Profile returned" : `Status ${res.status}` };
      }
    },
    {
      id: 4,
      description: "Retrieve Users without Authorization",
      expected: "Request should be blocked (unauthorized access)",
      run: async () => {
        if (!studentToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/admin/users", { headers: { Authorization: `Bearer ${studentToken}` } });
        return { pass: res.status === 403, observed: res.status === 403 ? "Access denied (403)" : `Unexpected status ${res.status}` };
      }
    },
    {
      id: 5,
      description: "List Counselors",
      expected: "Counselor list should be returned",
      run: async () => {
        if (!studentToken) return { pass: false, observed: "No token" };
        const { res, body } = await j("/api/utility/counselors", { headers: { Authorization: `Bearer ${studentToken}` } });
        return { pass: res.ok && Array.isArray(body), observed: res.ok ? `Returned ${body.length} counselors` : `Status ${res.status}` };
      }
    },
    {
      id: 6,
      description: "Create Appointment (valid)",
      expected: "Appointment should be created successfully",
      run: async () => {
        if (!studentToken) return { pass: false, observed: "No token" };
        const pick = await pickAvailableCounselorAndDate(studentToken);
        if (!pick) return { pass: false, observed: "No available counselor/date found" };
        const { res, body } = await j("/api/appointments", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${studentToken}` },
          body: JSON.stringify({ counselorId: pick.counselorId, date: pick.date, time: "09:00", serviceType: "Academic", reason: "Student test booking" })
        });
        if (res.ok) createdAppointmentId = body.id;
        return { pass: res.status === 201, observed: res.ok ? `Created appointment id=${body.id}` : `${res.status} ${body?.message || ""}` };
      }
    },
    {
      id: 7,
      description: "Request Reschedule (student)",
      expected: "Status update should succeed",
      run: async () => {
        if (!studentToken || !createdAppointmentId) return { pass: false, observed: "Missing token or appointment" };
        const { res } = await j(`/api/appointments/${createdAppointmentId}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${studentToken}` },
          body: JSON.stringify({ status: "reschedule_requested" })
        });
        return { pass: res.ok, observed: res.ok ? "Updated successfully" : `Status ${res.status}` };
      }
    },
    {
      id: 8,
      description: "Accept Appointment (student)",
      expected: "Request should be rejected (role restriction)",
      run: async () => {
        if (!studentToken || !createdAppointmentId) return { pass: false, observed: "Missing token or appointment" };
        const { res } = await j(`/api/appointments/${createdAppointmentId}/status`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${studentToken}` },
          body: JSON.stringify({ status: "accepted" })
        });
        return { pass: res.status === 400, observed: `Status ${res.status}` };
      }
    },
    {
      id: 9,
      description: "Notifications fetch",
      expected: "Notifications list should be returned",
      run: async () => {
        if (!studentToken) return { pass: false, observed: "No token" };
        const { res, body } = await j("/api/notifications/my", { headers: { Authorization: `Bearer ${studentToken}` } });
        return { pass: res.ok && Array.isArray(body), observed: res.ok ? `Returned ${body.length} notifications` : `Status ${res.status}` };
      }
    },
    {
      id: 10,
      description: "Upload profile picture (non-image)",
      expected: "System should reject invalid file type",
      run: async () => {
        if (!studentToken) return { pass: false, observed: "No token" };
        const f = new FormData();
        const blob = new Blob(["not an image"], { type: "text/plain" });
        f.append("profilePicture", blob, "not-image.txt");
        const res = await fetch(`${BASE}/api/auth/me/profile-picture`, { method: "POST", headers: { Authorization: `Bearer ${studentToken}` }, body: f });
        return { pass: res.status === 400 || res.status === 415, observed: `Status ${res.status}` };
      }
    },
    {
      id: 11,
      description: "Reuse same password",
      expected: "System should reject reusing current password",
      run: async () => {
        if (!studentToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/auth/me/password", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${studentToken}` },
          body: JSON.stringify({ currentPassword: "student123", newPassword: "student123" })
        });
        return { pass: res.status === 400, observed: `Status ${res.status}` };
      }
    },
    {
      id: 12,
      description: "Book past date",
      expected: "System should block past date booking",
      run: async () => {
        if (!studentToken) return { pass: false, observed: "No token" };
        const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const { res } = await j("/api/appointments", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${studentToken}` },
          body: JSON.stringify({ counselorId: 2, date: past, time: "09:00", serviceType: "Academic", reason: "Past date" })
        });
        return { pass: res.status === 400, observed: `Status ${res.status}` };
      }
    }
  ];

  // ---------------- COUNSELOR (12) ----------------
  const counselorTests = [
    {
      id: 1,
      description: "Counselor Login",
      expected: "Token should be generated successfully",
      run: async () => ({ pass: Boolean(counselorToken), observed: counselorToken ? "Token returned" : "Token not returned" })
    },
    {
      id: 2,
      description: "View own profile",
      expected: "Profile data should be returned",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/auth/me", { headers: { Authorization: `Bearer ${counselorToken}` } });
        return { pass: res.ok, observed: res.ok ? "Profile returned" : `Status ${res.status}` };
      }
    },
    {
      id: 3,
      description: "Retrieve users list (forbidden)",
      expected: "Request should be blocked (403)",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/admin/users", { headers: { Authorization: `Bearer ${counselorToken}` } });
        return { pass: res.status === 403, observed: `Status ${res.status}` };
      }
    },
    {
      id: 4,
      description: "Fetch counselor calendar",
      expected: "Calendar data should be returned",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const { res, body } = await j(`/api/counselor/calendar?year=${new Date().getFullYear()}`, { headers: { Authorization: `Bearer ${counselorToken}` } });
        return { pass: res.ok && Array.isArray(body.appointments), observed: res.ok ? `Returned ${body.appointments.length} items` : `Status ${res.status}` };
      }
    },
    {
      id: 5,
      description: "Set unavailable date (valid)",
      expected: "Availability should be saved",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const { res } = await j("/api/counselor/availability", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${counselorToken}` },
          body: JSON.stringify({ unavailable_date: date, message: "Test unavailable" })
        });
        return { pass: res.status === 201 || res.status === 409, observed: `Status ${res.status}` };
      }
    },
    {
      id: 6,
      description: "Set unavailable date (past)",
      expected: "System should reject past unavailable date",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const past = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const { res } = await j("/api/counselor/availability", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${counselorToken}` },
          body: JSON.stringify({ unavailable_date: past, message: "Past unavailable should fail" })
        });
        return { pass: res.status === 400, observed: `Status ${res.status}` };
      }
    },
    {
      id: 7,
      description: "Decline appointment not found",
      expected: "System should return 404",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/appointments/999999/status", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${counselorToken}` },
          body: JSON.stringify({ status: "declined" })
        });
        return { pass: res.status === 404, observed: `Status ${res.status}` };
      }
    },
    {
      id: 8,
      description: "Analytics endpoint",
      expected: "Analytics counts should be returned",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const { res, body } = await j("/api/counselor/analytics", { headers: { Authorization: `Bearer ${counselorToken}` } });
        return { pass: res.ok && body && typeof body.weekly === "number", observed: res.ok ? "Analytics returned" : `Status ${res.status}` };
      }
    },
    {
      id: 9,
      description: "Notifications fetch",
      expected: "Notifications list should be returned",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const { res, body } = await j("/api/notifications/my", { headers: { Authorization: `Bearer ${counselorToken}` } });
        return { pass: res.ok && Array.isArray(body), observed: res.ok ? `Returned ${body.length}` : `Status ${res.status}` };
      }
    },
    {
      id: 10,
      description: "Admin appointment delete (forbidden)",
      expected: "Request should be blocked (403)",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/admin/appointments/1", { method: "DELETE", headers: { Authorization: `Bearer ${counselorToken}` } });
        return { pass: res.status === 403, observed: `Status ${res.status}` };
      }
    },
    {
      id: 11,
      description: "Upload profile picture (non-image)",
      expected: "System should reject invalid file type",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const f = new FormData();
        const blob = new Blob(["not an image"], { type: "text/plain" });
        f.append("profilePicture", blob, "not-image.txt");
        const res = await fetch(`${BASE}/api/auth/me/profile-picture`, { method: "POST", headers: { Authorization: `Bearer ${counselorToken}` }, body: f });
        return { pass: res.status === 400 || res.status === 415, observed: `Status ${res.status}` };
      }
    },
    {
      id: 12,
      description: "Change password with short new password",
      expected: "System should reject weak password",
      run: async () => {
        if (!counselorToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/auth/me/password", {
          method: "PATCH",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${counselorToken}` },
          body: JSON.stringify({ currentPassword: "counselor123", newPassword: "123" })
        });
        return { pass: res.status === 400, observed: `Status ${res.status}` };
      }
    }
  ];

  // ---------------- ADMIN (12) ----------------
  const adminTests = [
    {
      id: 1,
      description: "Admin login process",
      expected: "Token should be generated successfully",
      run: async () => ({ pass: Boolean(adminToken), observed: adminToken ? "Token returned" : "Token not returned" })
    },
    {
      id: 2,
      description: "Retrieve users with valid token",
      expected: "User list should be returned",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const { res, body } = await j("/api/admin/users", { headers: { Authorization: `Bearer ${adminToken}` } });
        return { pass: res.ok && Array.isArray(body), observed: res.ok ? `Returned ${body.length} users` : `Status ${res.status}` };
      }
    },
    {
      id: 3,
      description: "Create user with missing email",
      expected: "System should return validation error",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ fullName: "X", password: "password123", role: "student" })
        });
        return { pass: res.status === 400, observed: `Status ${res.status}` };
      }
    },
    {
      id: 4,
      description: "Create user with weak password",
      expected: "System should reject weak password",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const { res } = await j("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ fullName: "Weak", email: `weak${Date.now()}@my.xu.edu.ph`, password: "123", role: "student" })
        });
        return { pass: res.status === 400, observed: `Status ${res.status}` };
      }
    },
    {
      id: 5,
      description: "Create valid user account",
      expected: "User should be successfully created",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const email = `user${Date.now()}@my.xu.edu.ph`;
        const { res } = await j("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ fullName: "Created User", email, password: "password123", role: "student" })
        });
        return { pass: res.status === 201, observed: `Status ${res.status}` };
      }
    },
    {
      id: 6,
      description: "Duplicate user creation attempt",
      expected: "System should detect existing record",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const email = `dupe${Date.now()}@my.xu.edu.ph`;
        await j("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ fullName: "Dupe", email, password: "password123", role: "student" })
        });
        const { res } = await j("/api/admin/users", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ fullName: "Dupe2", email, password: "password123", role: "student" })
        });
        return { pass: res.status === 409, observed: `Status ${res.status}` };
      }
    },
    {
      id: 7,
      description: "Admin view counselor calendar",
      expected: "Calendar view should be returned",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const { res } = await j(`/api/counselor/calendar?year=${new Date().getFullYear()}&counselorId=2`, { headers: { Authorization: `Bearer ${adminToken}` } });
        return { pass: res.ok, observed: res.ok ? "Calendar returned" : `Status ${res.status}` };
      }
    },
    {
      id: 8,
      description: "Admin delete appointment",
      expected: "Appointment should be deleted in DB",
      run: async () => {
        if (!adminToken || !studentToken) return { pass: false, observed: "Missing token(s)" };
        const pick = await pickAvailableCounselorAndDate(studentToken);
        if (!pick) return { pass: false, observed: "No available counselor/date" };
        const { body: b } = await j("/api/appointments", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${studentToken}` },
          body: JSON.stringify({ counselorId: pick.counselorId, date: pick.date, time: "10:30", serviceType: "Personal", reason: "Admin delete test" })
        });
        const { res } = await j(`/api/admin/appointments/${b.id}`, { method: "DELETE", headers: { Authorization: `Bearer ${adminToken}` } });
        return { pass: res.ok, observed: res.ok ? "Deleted successfully" : `Status ${res.status}` };
      }
    },
    {
      id: 9,
      description: "Google Sheets sync (success)",
      expected: "Sheet rows should sync into DB",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const { res, body } = await j("/api/sheets/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
          body: JSON.stringify({ spreadsheetId: "TEST", range: "Sheet1!A1:B2" })
        });
        return { pass: res.ok, observed: res.ok ? "Synced successfully" : `${res.status} ${body?.message || ""}` };
      }
    },
    {
      id: 10,
      description: "CSV import (admin)",
      expected: "CSV import should succeed",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const f = new FormData();
        f.append("file", new Blob(["booking_code,student_email,counselor_email,service_type,appointment_date,appointment_time,status\nX,a@my.xu.edu.ph,c@xu.edu.ph,Academic,2026-12-01,09:00,pending"], { type: "text/csv" }), "t.csv");
        const res = await fetch(`${BASE}/api/import/appointments-csv`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: f });
        return { pass: res.status === 200, observed: `Status ${res.status}` };
      }
    },
    {
      id: 11,
      description: "Admin notifications fetch",
      expected: "Notifications list should be returned",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const { res, body } = await j("/api/notifications/my", { headers: { Authorization: `Bearer ${adminToken}` } });
        return { pass: res.ok && Array.isArray(body), observed: res.ok ? `Returned ${body.length}` : `Status ${res.status}` };
      }
    },
    {
      id: 12,
      description: "Admin profile non-image upload",
      expected: "System should reject invalid file type",
      run: async () => {
        if (!adminToken) return { pass: false, observed: "No token" };
        const f = new FormData();
        const blob = new Blob(["not an image"], { type: "text/plain" });
        f.append("profilePicture", blob, "not-image.txt");
        const res = await fetch(`${BASE}/api/auth/me/profile-picture`, { method: "POST", headers: { Authorization: `Bearer ${adminToken}` }, body: f });
        return { pass: res.status === 400 || res.status === 415, observed: `Status ${res.status}` };
      }
    }
  ];

  await runSuite("STUDENT TEST REPORT", studentTests);
  await runSuite("COUNSELOR TEST REPORT", counselorTests);
  await runSuite("ADMIN TEST REPORT", adminTests);

  console.log("");
  console.log("DONE");
}

run().catch((e) => {
  console.error("Fatal:", e.message);
  process.exit(1);
});

