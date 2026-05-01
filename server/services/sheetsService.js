const { google } = require("googleapis");

async function syncAppointmentToSheet(appointmentRow) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  if (!sheetId || !credentials) {
    console.log("[sheets stub] would sync row", appointmentRow);
    return;
  }

  const auth = new google.auth.GoogleAuth({
    credentials: JSON.parse(credentials),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });

  const sheets = google.sheets({ version: "v4", auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId: sheetId,
    range: "Appointments!A1",
    valueInputOption: "RAW",
    requestBody: { values: [appointmentRow] }
  });
}

module.exports = { syncAppointmentToSheet };
