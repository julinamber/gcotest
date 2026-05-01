# XU GCO Appointment System (Phase 2 - Dockerized)

Full-stack centralized appointment management system for Xavier University Guidance and Counseling Office.

## Implemented Integrations

- Centralized MySQL database as the source of truth
- Google Sheets API sync hook for reporting/monitoring
- Web portal with role-based access (student, counselor, admin)
- QR endpoint for student portal access (`/api/utility/qr/student-portal`)
- Automated Gmail/SMTP notification hook for appointment events

## Docker-First Setup (Recommended)

No manual MySQL Workbench installation is required on the client device.

1. Copy `.env.example` to `.env`
2. Start containers:
   - `docker compose up --build -d`
3. Open the system:
   - `http://localhost:3000/index.html`
4. Optional DB web UI (Adminer):
   - `http://localhost:8080`
   - System: `MySQL`
   - Server: `mysql`
   - Username: `gco_user`
   - Password: `gco_password`
   - Database: `gco_appointments`

Stop containers:
- `docker compose down`

Reset DB volume (fresh database):
- `docker compose down -v`

## Optional Non-Docker Local Run

If needed for development only:

1. Install dependencies with `npm install`
2. Configure `.env` to point to your local MySQL
3. Run `npm start`

## Demo Accounts

- Student: `student@my.xu.edu.ph` / `student123`
- Counselor: `counselor@xu.edu.ph` / `counselor123`
- Admin: `admin@xu.edu.ph` / `admin123`

## API Summary

- `POST /api/auth/login`
- `GET /api/appointments/my`
- `POST /api/appointments` (student)
- `DELETE /api/appointments/:id` (student)
- `PATCH /api/appointments/:id/status` (counselor/admin)
- `GET /api/counselor/analytics`
- `GET /api/admin/overview`
- `GET /api/admin/users`
- `GET /api/utility/qr/student-portal`

## Security Baseline Included

- JWT authentication
- Role-based authorization
- University email domain validation
- Password hashing with bcrypt
- Input validation on key flows
- Audit logs for major appointment actions

## Container Notes

- `app` service runs Node/Express API + frontend static files on port `3000`
- `mysql` service is the centralized relational database
- `adminer` service provides browser-based DB management (no Workbench needed)
- App startup includes automatic DB-retry logic for container boot timing
