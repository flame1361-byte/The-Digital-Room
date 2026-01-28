const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const { usersDb } = require('./db');

// SECURITY: Validate required environment variables
const rateLimit = require('express-rate-limit');

// SECURITY: Validate required environment variables
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER;
if (!JWT_SECRET || !ADMIN_USER) {
    console.error('[FATAL] Missing required environment variables: JWT_SECRET and ADMIN_USER');
    process.exit(1);
}

const hasAllowedOriginsEnv = Boolean(process.env.ALLOWED_ORIGINS);
const ALLOWED_ORIGINS = hasAllowedOriginsEnv
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
    : ['http://localhost:3000', 'https://the-digital-room.onrender.com'];

// Optional additional admin usernames (comma-separated in env)
const ADDITIONAL_ADMINS = process.env.ADDITIONAL_ADMINS
    ? process.env.ADDITIONAL_ADMINS.split(',').map(s => s.trim()).filter(Boolean)
    : [];

if (process.env.NODE_ENV !== 'production' && !hasAllowedOriginsEnv) {
    console.warn("⚠️  WARNING: No ALLOWED_ORIGINS defined. Defaulting to localhost and the deployed domain for development.");
}

let roomState = {
    currentTrack: '',
    isPlaying: false,
    seekPosition: 0, // Legacy support
    startedAt: null, // Authoritative server timestamp when playback started/resumed
    pausedAt: 0,    // Authoritative elapsed ms when paused
    announcement: null,
    djId: null,
    djUsername: null, // Track DJ by name for session restoration
    users: {},
    messages: [],
    voiceUsers: {},
    streams: {}
};

// Rate Limiter for Socket Events (Simple Token Bucket)
const socketRateLimits = new Map(); // socketId -> { count, lastReset }
const RATE_LIMIT_WINDOW = 1000; // 1 second
const MAX_EVENTS_PER_WINDOW = 10; // 10 events per second

function checkRateLimit(socketId) {
    const now = Date.now();
    let record = socketRateLimits.get(socketId);

    if (!record) {
        record = { count: 1, lastReset: now };
        socketRateLimits.set(socketId, record);
        return true;
    }

    if (now - record.lastReset > RATE_LIMIT_WINDOW) {
        record.count = 1;
        record.lastReset = now;
        return true;
    }

    if (record.count >= MAX_EVENTS_PER_WINDOW) {
        return false; // Rate limit exceeded
    }

    record.count++;
    return true;
}

const app = express();
const server = http.createServer(app);

// HTTP Rate Limiter
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    standardHeaders: true,
    legacyHeaders: false,
});
app.use(apiLimiter);

const io = new Server(server, {
    cors: {
        origin: ALLOWED_ORIGINS.length > 0 ? ALLOWED_ORIGINS : ['http://localhost:3000'],
        methods: ["GET", "POST"],
        credentials: true
    },
    allowEIO3: false,
    transports: ['websocket'],
    pingTimeout: 10000,
    pingInterval: 5000
});

const PORT = process.env.PORT || 3000;

// SECURITY: Configuration constants
const CONFIG = {
    MESSAGE_BUFFER_SIZE: 50,
    DJ_SYNC_DRIFT_TOLERANCE: 2000,
    DJ_CLEANUP_INTERVAL: 10000,
    PASSWORD_MIN_LENGTH: 8,
    USERNAME_MAX_LENGTH: 50,
    MESSAGE_MAX_LENGTH: 500,
    ANNOUNCEMENT_MAX_LENGTH: 200,
    MAX_STREAMS: 10
};

// SECURITY: Input validation functions
function validatePassword(password) {
    if (!password || password.length < CONFIG.PASSWORD_MIN_LENGTH) {
        return { valid: false, error: `Password must be at least ${CONFIG.PASSWORD_MIN_LENGTH} characters` };
    }
    if (!/[A-Z]/.test(password)) {
        return { valid: false, error: 'Password must contain at least one uppercase letter' };
    }
    if (!/[0-9]/.test(password)) {
        return { valid: false, error: 'Password must contain at least one number' };
    }
    return { valid: true };
}

function sanitizeText(text, maxLength = 500) {
    if (typeof text !== 'string') return '';
    return text.substring(0, maxLength).trim();
}

function sanitizeUsername(username) {
    if (typeof username !== 'string') return null;
    const clean = username.trim();
    if (clean.length < 2 || clean.length > CONFIG.USERNAME_MAX_LENGTH) return null;
    if (!/^[a-zA-Z0-9_-]+$/.test(clean)) return null;
    return clean;
}

function isValidImageUrl(url) {
    try {
        const parsed = new URL(url);
        return ['http:', 'https:'].includes(parsed.protocol) && /\.(gif|jpg|jpeg|png|webp)$/i.test(parsed.pathname);
    } catch {
        return false;
    }
}

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // Restrict script sources to trusted origins only. Avoid 'unsafe-eval' and 'unsafe-inline'.
            scriptSrc: ["'self'", "https://w.soundcloud.com", "https://api.soundcloud.com"],
            // Avoid allowing inline styles; require nonces/hashes if inline styles are needed.
            styleSrc: ["'self'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:", "https:", "blob:"],
            connectSrc: ["'self'", "wss:", "https:"],
            frameSrc: ["'self'", "https://w.soundcloud.com"], // Allow SoundCloud Widget
            mediaSrc: ["'self'", "blob:"],
            objectSrc: ["'none'"],
        },
    },
    // Cross-Origin-Embedder-Policy (COEP) can break external iframes; disable or relax it
    crossOriginEmbedderPolicy: false,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check for Render
app.get('/health', (req, res) => res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    users: Object.keys(roomState.users).length,
    djActive: !!roomState.djId
}));

// Force DB Load on start
usersDb.load()
    .then(() => console.log("[DB] Users database loaded and ready."))
    .then(() => seedStaff())
    .catch(err => console.error("[DB] Failed to load:", err));

async function seedStaff() {
    try {
        let staffData;
        try { staffData = require('./staffData'); } catch (e) { return; }
        for (const user of staffData) {
            const existing = await usersDb.findOne({ username: user.username });
            if (!existing) await usersDb.insert(user);
        }
        console.log('[Seed] Staff verification complete.');
    } catch (err) { console.error('[Seed] Error during seeding:', err); }
}

// Periodic cleanup
setInterval(() => {
    if (roomState.djId && !roomState.users[roomState.djId]) {
        roomState.djId = null;
        roomState.djUsername = null;
        io.emit('djChanged', { djId: null });
    }
    // Cleanup stale voice users and streams
    Object.keys(roomState.voiceUsers).forEach(socketId => {
        if (!io.sockets.sockets.get(socketId)) delete roomState.voiceUsers[socketId];
    });
    Object.keys(roomState.streams).forEach(socketId => {
        if (!io.sockets.sockets.get(socketId)) delete roomState.streams[socketId];
    });

    // Cleanup Rate Limits
    const now = Date.now();
    for (const [id, record] of socketRateLimits) {
        if (now - record.lastReset > RATE_LIMIT_WINDOW * 2) {
            socketRateLimits.delete(id);
        }
    }
}, CONFIG.DJ_CLEANUP_INTERVAL);

// Helper: Populate Friends
async function getPopulatedFriends(friendUsernames) {
    if (!friendUsernames || friendUsernames.length === 0) return [];
    const friendDocs = await usersDb.find({ username: { $in: friendUsernames } });
    const friendMap = {};
    friendDocs.forEach(f => { friendMap[f.username] = f; });

    return friendUsernames.map(name => {
        const f = friendMap[name];
        if (!f) return null;
        return {
            username: f.username,
            badge: f.badge || 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif',
            nameStyle: f.nameStyle || '',
            isOnline: Object.values(roomState.users).some(u => u.name === f.username)
        };
    }).filter(Boolean);
}

function addMessageToBuffer(msg) {
    roomState.messages.push(msg);
    if (roomState.messages.length > CONFIG.MESSAGE_BUFFER_SIZE) roomState.messages.shift();
}

function getUniqueUsers() {
    const unique = {};
    Object.values(roomState.users).forEach(u => { if (!unique[u.name]) unique[u.name] = u; });
    return Object.values(unique);
}

// --- Periodic Sync Broadcast (Every 5 seconds) ---
// Ensures all listeners stay synced even if they miss an update
setInterval(() => {
    if (roomState.djId && roomState.currentTrack) {
        io.emit('roomSync', {
            ...roomState,
            serverTime: Date.now()
        });
    }
}, 5000);

io.on('connection', (socket) => {
    socket.emit('init', {
        state: { ...roomState, users: getUniqueUsers(), serverTime: roomState.lastUpdateAt || Date.now() },
        yourId: socket.id,
        serverNow: Date.now() // For clock skew compensation
    });

    socket.on('register', async ({ username, password }, callback) => {
        if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limit exceeded. Please wait.' });

        let callbackCalled = false;
        const safeCallback = (data) => {
            if (callbackCalled) return;
            callbackCalled = true;
            callback?.(data);
        };

        try {
            const cleanUsername = sanitizeUsername(username);
            if (!cleanUsername || !password) return safeCallback({ error: 'Invalid username or password' });

            const pwValidation = validatePassword(password);
            if (!pwValidation.valid) return safeCallback({ error: pwValidation.error });

            if (await usersDb.findOne({ username: cleanUsername })) return safeCallback({ error: 'Username already exists' });

            const hashedPassword = await bcrypt.hash(password, 10);
            await usersDb.insert({
                username: cleanUsername, password: hashedPassword,
                badge: 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif',
                nameStyle: '', hasPremiumPack: false, hasThemePack: false, friends: [], pendingRequests: []
            });
            safeCallback({ success: true });
        } catch (err) {
            console.error('[Register] Error:', err.message);
            safeCallback({ error: 'Registration failed' });
        }
    });

    socket.on('login', async ({ username, password }, callback) => {
        if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limit exceeded. Please wait.' });

        let callbackCalled = false;
        const safeCallback = (data) => {
            if (callbackCalled) return;
            callbackCalled = true;
            callback?.(data);
        };

        try {
            const cleanUsername = sanitizeUsername(username);
            if (!cleanUsername || !password) return safeCallback({ error: 'Invalid credentials' });

            const user = await usersDb.findOne({ username: cleanUsername });
            if (!user || !(await bcrypt.compare(password, user.password))) return safeCallback({ error: 'Invalid credentials' });

            const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
            const friends = await getPopulatedFriends(user.friends);
            safeCallback({
                token,
                user: {
                    username: user.username, badge: user.badge, nameStyle: user.nameStyle,
                    hasPremiumPack: user.hasPremiumPack || false, hasThemePack: user.hasThemePack || false,
                    friends, pendingRequests: user.pendingRequests || []
                }
            });
        } catch (err) {
            console.error('[Login] Error:', err.message);
            safeCallback({ error: 'Login failed' });
        }
    });

    socket.on('authenticate', async (token, callback) => {
        let callbackCalled = false;
        const safeCallback = (data) => {
            if (callbackCalled) return;
            callbackCalled = true;
            callback?.(data);
        };

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            if (user) {
                const friends = await getPopulatedFriends(user.friends);

                // DJ RESTORATION LOGIC
                if (roomState.djUsername === user.username) {
                    roomState.djId = socket.id;
                    io.emit('djChanged', { djId: socket.id, djName: user.username });
                }

                roomState.users[socket.id] = {
                    id: socket.id, dbId: user._id, name: user.username,
                    badge: user.badge || 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif',
                    nameStyle: user.nameStyle || '', status: user.status || '',
                    hasPremiumPack: user.hasPremiumPack || false, hasThemePack: user.hasThemePack || false,
                    hasHellBoneStyle: user.hasHellBoneStyle || false,
                    friends, pendingRequests: user.pendingRequests || [],
                    isAuthenticated: true
                };
                io.emit('userUpdate', getUniqueUsers());
                const responseData = { ...roomState.users[socket.id], username: user.username };
                socket.emit('authSuccess', responseData);
                safeCallback({ success: true, user: responseData });
                const joinMsg = { userName: 'SYSTEM', text: `${user.username} entered.`, timestamp: new Date().toLocaleTimeString(), isSystem: true };
                addMessageToBuffer(joinMsg);
                io.emit('newMessage', joinMsg);
            } else {
                safeCallback({ success: false });
            }
        } catch (err) {
            console.error('[Authenticate] Error:', err.message);
            safeCallback({ success: false });
        }
    });

    socket.on('updateProfile', async ({ token, badge, password, nameStyle, status }, callback) => {
        if (!checkRateLimit(socket.id)) return callback?.({ error: 'Rate limit exceeded. Please wait.' });

        let callbackCalled = false;
        const safeCallback = (data) => {
            if (callbackCalled) return;
            callbackCalled = true;
            callback?.(data);
        };

        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            let update = {};

            if (badge) {
                if (!isValidImageUrl(badge)) return safeCallback({ error: 'Invalid badge URL' });
                update.badge = badge;
            }
            if (password) {
                const pwValidation = validatePassword(password);
                if (!pwValidation.valid) return safeCallback({ error: pwValidation.error });
                update.password = await bcrypt.hash(password, 10);
            }
            if (nameStyle !== undefined) update.nameStyle = sanitizeText(nameStyle, 50);
            if (status !== undefined) update.status = sanitizeText(status, 100);

            await usersDb.update({ _id: decoded.id }, { $set: update });
            const updatedUser = await usersDb.findOne({ _id: decoded.id });
            if (roomState.users[socket.id]) {
                roomState.users[socket.id].badge = updatedUser.badge;
                roomState.users[socket.id].nameStyle = updatedUser.nameStyle;
                roomState.users[socket.id].status = updatedUser.status || '';
                io.emit('userPartialUpdate', { id: socket.id, ...update });
            }
            safeCallback({ success: true, user: updatedUser });
        } catch (err) {
            console.error('[UpdateProfile] Error:', err.message);
            safeCallback({ error: 'Failed to update profile' });
        }
    });

    socket.on('getFriends', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            if (user) {
                const friends = await getPopulatedFriends(user.friends);
                callback?.({ friends, pending: user.pendingRequests || [] });
            }
        } catch (err) {
            console.error('[GetFriends] Error:', err.message);
            callback?.({ error: 'Authentication failed' });
        }
    });

    socket.on('sendFriendRequest', async ({ token, targetUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const cleanTarget = sanitizeUsername(targetUsername);
            if (!cleanTarget) return callback?.({ error: 'Invalid username' });

            const target = await usersDb.findOne({ username: cleanTarget });
            if (!target) return callback?.({ error: 'User not found' });
            if (target.username === decoded.username) return callback?.({ error: 'Cannot friend yourself' });

            await usersDb.update({ _id: target._id }, { $addToSet: { pendingRequests: decoded.username } });
            callback?.({ success: true });
        } catch (err) {
            console.error('[SendFriendRequest] Error:', err.message);
            callback?.({ error: 'Failed to send friend request' });
        }
    });

    socket.on('acceptFriend', async ({ token, requesterUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const cleanRequester = sanitizeUsername(requesterUsername);
            if (!cleanRequester) return callback?.({ error: 'Invalid username' });

            await usersDb.update({ _id: decoded.id }, { $pull: { pendingRequests: cleanRequester }, $addToSet: { friends: cleanRequester } });
            await usersDb.update({ username: cleanRequester }, { $addToSet: { friends: decoded.username } });
            callback?.({ success: true });
        } catch (err) {
            console.error('[AcceptFriend] Error:', err.message);
            callback?.({ error: 'Failed to accept friend request' });
        }
    });

    socket.on('adminKick', ({ token, targetSocketId }, callback) => {
        try {
            // SECURITY: Type validation
            if (typeof token !== 'string' || typeof targetSocketId !== 'string') {
                return callback?.({ error: 'Invalid parameters' });
            }
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) return callback?.({ error: 'Forbidden' });
            const target = io.sockets.sockets.get(targetSocketId);
            if (target) { target.disconnect(); callback?.({ success: true }); }
        } catch (err) {
            console.error('[AdminKick] Error:', err.message);
            callback?.({ error: 'Authentication failed' });
        }
    });

    socket.on('adminAnnouncement', ({ token, text }, callback) => {
        try {
            // SECURITY: Type validation
            if (typeof token !== 'string') {
                return callback?.({ error: 'Invalid parameters' });
            }
            if (text !== null && text !== undefined && typeof text !== 'string') {
                return callback?.({ error: 'Invalid parameters' });
            }
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) return callback?.({ error: 'Forbidden' });
            roomState.announcement = text ? sanitizeText(text, CONFIG.ANNOUNCEMENT_MAX_LENGTH) : null;
            io.emit('roomUpdate', { ...roomState, serverTime: Date.now() });
            callback?.({ success: true });
        } catch (err) {
            console.error('[AdminAnnouncement] Error:', err.message);
            callback?.({ error: 'Authentication failed' });
        }
    });

    socket.on('adminResetDj', ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const isAdditionalAdmin = ADDITIONAL_ADMINS.includes(decoded.username);
            if (decoded.username !== ADMIN_USER && !isAdditionalAdmin) return callback?.({ error: 'Forbidden' });
            roomState.djId = null;
            roomState.djUsername = null;
            io.emit('djChanged', { djId: null });
            callback?.({ success: true });
        } catch (err) {
            console.error('[AdminResetDj] Error:', err.message);
            callback?.({ error: 'Authentication failed' });
        }
    });

    socket.on('sendMessage', (data) => {
        if (!checkRateLimit(socket.id)) {
            return socket.emit('newMessage', {
                isSystem: true,
                text: '⚠️ You are sending messages too fast.',
                timestamp: new Date().toLocaleTimeString()
            });
        }
        const user = roomState.users[socket.id];
        const cleanText = sanitizeText((data && data.text) ? data.text : '', CONFIG.MESSAGE_MAX_LENGTH);
        if (!cleanText) {
            return socket.emit('newMessage', {
                isSystem: true,
                text: '⚠️ Message invalid or empty.',
                timestamp: new Date().toLocaleTimeString()
            });
        }
        const msg = {
            userName: user ? user.name : 'Guest', badge: user ? user.badge : null,
            nameStyle: user ? user.nameStyle : '', text: cleanText, timestamp: new Date().toLocaleTimeString()
        };
        addMessageToBuffer(msg);
        io.emit('newMessage', msg);
    });

    socket.on('privateMessage', ({ targetName, text }) => {
        const sender = roomState.users[socket.id];
        if (!sender?.isAuthenticated) return;

        if (!checkRateLimit(socket.id)) {
            return socket.emit('privateMessage', {
                isSystem: true,
                text: '⚠️ You are sending messages too fast.',
                timestamp: new Date().toLocaleTimeString()
            });
        }

        const cleanText = sanitizeText(text, CONFIG.MESSAGE_MAX_LENGTH);
        if (!cleanText) {
            return socket.emit('privateMessage', {
                isSystem: true,
                text: '⚠️ Message invalid or empty.',
                timestamp: new Date().toLocaleTimeString()
            });
        }

        const msg = { from: sender.name, to: targetName, text: cleanText, timestamp: new Date().toLocaleTimeString() };
        Object.values(roomState.users).filter(u => u.name === targetName || u.name === sender.name).forEach(u => io.to(u.id).emit('privateMessage', msg));
    });

    socket.on('requestDJ', () => {
        if (!checkRateLimit(socket.id)) return;
        const user = roomState.users[socket.id];
        if (!user) return;

        if (roomState.djId && roomState.djId !== socket.id) {
            // Booth is occupied. Enforce dismissal and notify
            socket.emit('djChanged', { djId: roomState.djId, djName: roomState.djUsername });
            socket.emit('newMessage', {
                isSystem: true,
                text: `[!] BOOTH BUSY: ${roomState.djUsername || 'Someone'} is already at the booth.`,
                timestamp: new Date().toLocaleTimeString()
            });
            return;
        }

        roomState.djId = socket.id;
        roomState.djUsername = user.name;
        console.log(`[DJ] Assigned: ${roomState.djUsername}`);
        io.emit('djChanged', { djId: socket.id, djName: user.name });
    });

    socket.on('djUpdate', (update) => {
        const user = roomState.users[socket.id];
        const isIdMatch = socket.id === roomState.djId;
        const isNameMatch = user && user.name === roomState.djUsername;

        if (isIdMatch || isNameMatch) {
            // Session healing: Update DJ ID if name matches but ID changed
            if (!isIdMatch && isNameMatch) {
                console.log(`[DJ] Session healed for ${user.name}`);
                roomState.djId = socket.id;
                io.emit('djChanged', { djId: socket.id, djName: user.name });
            }

            const now = Date.now();
            const wasPlaying = roomState.isPlaying;

            // Update track info
            roomState.currentTrack = update.currentTrack || update.track || roomState.currentTrack;
            roomState.trackTitle = update.trackTitle || roomState.trackTitle;

            // Authoritative Playback Logic
            if (update.isPlaying) {
                if (!wasPlaying || Math.abs((now - roomState.startedAt) - update.seekPosition) > 2000) {
                    // Start or forced sync if drift > 2s
                    roomState.startedAt = now - (update.seekPosition || 0);
                }
                roomState.isPlaying = true;
            } else {
                roomState.pausedAt = update.seekPosition || 0;
                roomState.isPlaying = false;
            }

            roomState.currentTheme = update.currentTheme || update.theme || roomState.currentTheme;
            roomState.lastUpdateAt = now;

            // Broadcast authoritative state
            io.emit('roomUpdate', {
                ...roomState,
                serverTime: now
            });
        } else {
            console.warn(`[DJ] Update rejected from ${socket.id} (Not DJ)`);
        }
    });

    socket.on('disconnect', () => {
        const user = roomState.users[socket.id];
        if (user) {
            delete roomState.users[socket.id];
            // REMOVED IMMEDIATE DJ CLEAR. Rely on 10s interval for timeout.

            delete roomState.voiceUsers[socket.id];
            delete roomState.streams[socket.id];
            io.emit('userUpdate', getUniqueUsers());
        }
    });

    // --- Voice/Stream ---
    socket.on('voice-join', () => {
        const u = roomState.users[socket.id];
        if (u) {
            roomState.voiceUsers[socket.id] = { id: socket.id, name: u.name, badge: u.badge, nameStyle: u.nameStyle };
            io.emit('voice-update', Object.values(roomState.voiceUsers));
            socket.emit('voice-peer-list', Object.keys(roomState.voiceUsers).filter(id => id !== socket.id));
        }
    });
    socket.on('voice-signal', ({ to, signal }) => io.to(to).emit('voice-signal', { from: socket.id, signal }));

    socket.on('stream-start', () => {
        const u = roomState.users[socket.id];
        if (u && Object.keys(roomState.streams).length < 10) {
            roomState.streams[socket.id] = { streamerId: socket.id, streamerName: u.name };
            io.emit('stream-update', Object.values(roomState.streams));
            u.isLive = true;
            io.emit('userPartialUpdate', { id: socket.id, isLive: true });
        }
    });
    socket.on('stream-stop', () => {
        if (roomState.streams[socket.id]) {
            delete roomState.streams[socket.id];
            io.emit('stream-update', Object.values(roomState.streams));
            if (roomState.users[socket.id]) { roomState.users[socket.id].isLive = false; io.emit('userPartialUpdate', { id: socket.id, isLive: false }); }
        }
    });
    socket.on('stream-join', (streamerId) => {
        io.to(streamerId).emit('stream-peer-join', socket.id);
    });
    socket.on('stream-signal', ({ to, signal, streamerId }) => io.to(to).emit('stream-signal', { from: socket.id, signal, streamerId }));


});

server.listen(PORT, () => {
    console.log(`\n✓ TheDigitalRoom server running on port ${PORT}`);
    console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`✓ JWT_SECRET configured: ${JWT_SECRET ? 'YES' : 'NO'}`);
    // Mask ADMIN_USER to avoid leaking account identifiers in logs
    const adminDisplay = ADMIN_USER ? (ADMIN_USER.length > 2 ? `${ADMIN_USER[0]}*** (len=${ADMIN_USER.length})` : '***') : 'NOT SET';
    console.log(`✓ ADMIN_USER: ${adminDisplay}`);
    console.log(`✓ Helmet.js security headers enabled`);
    console.log(`✓ Rate limiting enabled`);
    console.log(`\n🚀 Ready to accept connections!\n`);
});

process.on('uncaughtException', (err) => {
    console.error('[FATAL] Uncaught Exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (err) => {
    console.error('[FATAL] Unhandled Rejection:', err);
    process.exit(1);
});
