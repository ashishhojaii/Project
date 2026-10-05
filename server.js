const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cookieSession = require('cookie-session');
const { rateLimit } = require('express-rate-limit');

const app = express();
const port = Number(process.env.PORT) || 3000;
const dataDirectory = path.join(__dirname, '.private');
const databasePath = process.env.DATABASE_PATH || path.join(dataDirectory, 'enquiries.sqlite');

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const database = new Database(databasePath);
database.pragma('journal_mode = WAL');
database.pragma('foreign_keys = ON');
database.exec(`
	CREATE TABLE IF NOT EXISTS enquiries (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT NOT NULL,
		phone TEXT NOT NULL,
		home_type TEXT NOT NULL,
		service TEXT NOT NULL,
		location TEXT NOT NULL,
		message TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	);
	CREATE TABLE IF NOT EXISTS admin_sessions (
		session_id TEXT PRIMARY KEY,
		expires_at INTEGER NOT NULL
	);
`);

const insertEnquiry = database.prepare(`
	INSERT INTO enquiries (name, phone, home_type, service, location, message)
	VALUES (@name, @phone, @homeType, @service, @location, @message)
`);

app.disable('x-powered-by');
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.use(express.json({ limit: '16kb' }));
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const adminPassword = process.env.ADMIN_PASSWORD || '';
const adminConfigured = Boolean(process.env.SESSION_SECRET && sessionSecret.length >= 32 && adminPassword.length >= 12);

app.use(cookieSession({
	name: 'sw_admin',
	keys: [sessionSecret],
	maxAge: 8 * 60 * 60 * 1000,
	httpOnly: true,
	secure: process.env.NODE_ENV === 'production',
	sameSite: 'strict',
	path: '/'
}));

const adminLoginLimiter = rateLimit({
	windowMs: 15 * 60 * 1000,
	limit: 8,
	standardHeaders: 'draft-7',
	legacyHeaders: false,
	message: { error: 'Too many sign-in attempts. Please try again in 15 minutes.' }
});

const activeAdminSession = database.prepare('SELECT 1 FROM admin_sessions WHERE session_id = ? AND expires_at > ?');
const requireAdmin = (request, response, next) => {
	if (!adminConfigured) {
		return response.status(503).json({ error: 'Owner sign-in is not configured. Set ADMIN_PASSWORD and SESSION_SECRET.' });
	}
	const sessionId = request.session?.sessionId;
	if (request.session?.authenticated !== true || typeof sessionId !== 'string' || !activeAdminSession.get(sessionId, Date.now())) {
		request.session = null;
		return response.status(401).json({ error: 'Please sign in to view enquiries.' });
	}
	next();
};

const passwordMatches = (candidate) => {
	if (typeof candidate !== 'string') return false;
	const submitted = Buffer.from(candidate, 'utf8');
	const expected = Buffer.from(adminPassword, 'utf8');
	if (submitted.length !== expected.length) return false;
	return crypto.timingSafeEqual(submitted, expected);
};

app.get('/admin', (_request, response) => {
	response.set('Cache-Control', 'no-store');
	response.set('X-Frame-Options', 'DENY');
	response.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/api/admin/login', adminLoginLimiter, (request, response) => {
	if (!adminConfigured) {
		return response.status(503).json({ error: 'Set ADMIN_PASSWORD (at least 12 characters) and SESSION_SECRET (at least 32 characters) in .env, then restart the server.' });
	}
	const password = request.body?.password;
	if (typeof password !== 'string' || password.length > 256 || !passwordMatches(password)) {
		return response.status(401).json({ error: 'Incorrect password.' });
	}
	const sessionId = crypto.randomUUID();
	database.prepare('INSERT INTO admin_sessions (session_id, expires_at) VALUES (?, ?)').run(sessionId, Date.now() + 8 * 60 * 60 * 1000);
	request.session = { authenticated: true, sessionId };
	return response.json({ authenticated: true });
});

app.get('/api/admin/session', requireAdmin, (_request, response) => {
	response.set('Cache-Control', 'no-store');
	response.json({ authenticated: true });
});

app.post('/api/admin/logout', requireAdmin, (request, response) => {
	database.prepare('DELETE FROM admin_sessions WHERE session_id = ?').run(request.session.sessionId);
	request.session = null;
	response.clearCookie('sw_admin');
	response.status(204).end();
});

app.get('/api/admin/enquiries', requireAdmin, (_request, response) => {
	response.set('Cache-Control', 'no-store');
	const enquiries = database.prepare(`
		SELECT id, name, phone, home_type AS homeType, service, location, message, created_at AS createdAt
		FROM enquiries ORDER BY id DESC LIMIT 500
	`).all();
	response.json({ enquiries });
});

app.get('/', (_request, response) => response.sendFile(path.join(__dirname, 'index.html')));
app.get('/video.mp4', (_request, response) => {
	response.set('Cache-Control', 'public, max-age=86400');
	response.sendFile(path.join(__dirname, 'video.mp4'));
});

app.get('/api/health', (_request, response) => {
	response.json({ status: 'ok' });
});

app.post('/api/enquiries', (request, response) => {
	const { name, phone, homeType, service, location, message = '' } = request.body || {};
	const values = { name, phone, homeType, service, location, message };
	const requiredFields = ['name', 'phone', 'homeType', 'service', 'location'];

	if (requiredFields.some((field) => typeof values[field] !== 'string' || !values[field].trim())) {
		return response.status(400).json({ error: 'Please complete all required fields.' });
	}
	if (typeof message !== 'string') {
		return response.status(400).json({ error: 'Project details must be text.' });
	}

	const enquiry = {
		name: name.trim(),
		phone: phone.trim(),
		homeType: homeType.trim(),
		service: service.trim(),
		location: location.trim(),
		message: message.trim()
	};
	const fieldLimits = { name: 120, phone: 40, homeType: 80, service: 120, location: 120, message: 2000 };
	if (Object.entries(fieldLimits).some(([field, limit]) => enquiry[field].length > limit)) {
		return response.status(400).json({ error: 'One or more fields are too long.' });
	}
	if (!/^[+()\d\s.-]{7,40}$/.test(enquiry.phone)) {
		return response.status(400).json({ error: 'Please enter a valid phone number.' });
	}

	try {
		const result = insertEnquiry.run(enquiry);
		return response.status(201).json({ id: result.lastInsertRowid });
	} catch (error) {
		console.error('Failed to save enquiry:', error.message);
		return response.status(500).json({ error: 'We could not save your enquiry. Please try again.' });
	}
});

app.use((error, _request, response, _next) => {
	if (error instanceof SyntaxError && 'body' in error) {
		return response.status(400).json({ error: 'Please submit valid form data.' });
	}
	if (error.type === 'entity.too.large') {
		return response.status(413).json({ error: 'The submitted request is too large.' });
	}
	console.error('Request failed:', error.message);
	return response.status(500).json({ error: 'Something went wrong. Please try again.' });
});

const server = app.listen(port, () => {
	console.log(`SW Living Solutions is running at http://localhost:${port}`);
});

const shutdown = () => {
	server.close(() => {
		database.close();
		process.exit(0);
	});
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);