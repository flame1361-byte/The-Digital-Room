const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { usersDb } = require('./db');

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

const JWT_SECRET = process.env.JWT_SECRET || 'myspace_secret_key_123';
const ADMIN_USER = process.env.ADMIN_USER || 'mayne';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
    allowEIO3: true,
    transports: ['websocket'],
    pingTimeout: 10000,
    pingInterval: 5000
});

const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Health check for Render
app.get('/health', (req, res) => res.status(200).send('OK'));

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
}, 10000);

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
    if (roomState.messages.length > 50) roomState.messages.shift();
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
        try {
            if (!username || !password) return callback?.({ error: 'Required' });
            if (await usersDb.findOne({ username })) return callback?.({ error: 'Exists' });
            const hashedPassword = await bcrypt.hash(password, 10);
            await usersDb.insert({
                username, password: hashedPassword,
                badge: 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif',
                nameStyle: '', hasPremiumPack: false, hasThemePack: false, friends: [], pendingRequests: []
            });
            callback?.({ success: true });
        } catch (err) { callback?.({ error: 'Error' }); }
    });

    socket.on('login', async ({ username, password }, callback) => {
        try {
            const user = await usersDb.findOne({ username });
            if (!user || !(await bcrypt.compare(password, user.password))) return callback?.({ error: 'Invalid' });
            const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
            const friends = await getPopulatedFriends(user.friends);
            callback?.({
                token,
                user: {
                    username: user.username, badge: user.badge, nameStyle: user.nameStyle,
                    hasPremiumPack: user.hasPremiumPack || false, hasThemePack: user.hasThemePack || false,
                    friends, pendingRequests: user.pendingRequests || []
                }
            });
        } catch (err) { callback?.({ error: 'Error' }); }
    });

    socket.on('authenticate', async (token, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            if (user) {
                const friends = await getPopulatedFriends(user.friends);

                // DJ RESTORATION LOGIC
                if (roomState.djUsername === user.username) {
                    roomState.djId = socket.id; // Reclaim the throne
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
                callback?.({ success: true, user: responseData });
                const joinMsg = { userName: 'SYSTEM', text: `${user.username} entered.`, timestamp: new Date().toLocaleTimeString(), isSystem: true };
                addMessageToBuffer(joinMsg);
                io.emit('newMessage', joinMsg);
            }
        } catch (err) { callback?.({ success: false }); }
    });

    socket.on('updateProfile', async ({ token, badge, password, nameStyle, status }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            let update = {};
            if (badge) update.badge = badge;
            if (password) update.password = await bcrypt.hash(password, 10);
            if (nameStyle !== undefined) update.nameStyle = nameStyle;
            if (status !== undefined) update.status = status;
            await usersDb.update({ _id: decoded.id }, { $set: update });
            const updatedUser = await usersDb.findOne({ _id: decoded.id });
            if (roomState.users[socket.id]) {
                roomState.users[socket.id].badge = updatedUser.badge;
                roomState.users[socket.id].nameStyle = updatedUser.nameStyle;
                roomState.users[socket.id].status = updatedUser.status || '';
                io.emit('userPartialUpdate', { id: socket.id, ...update });
            }
            callback?.({ success: true, user: updatedUser });
        } catch (err) { callback?.({ error: 'Failed' }); }
    });

    socket.on('getFriends', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            if (user) {
                const friends = await getPopulatedFriends(user.friends);
                callback?.({ friends, pending: user.pendingRequests || [] });
            }
        } catch (err) { callback?.({ error: 'Auth failed' }); }
    });

    socket.on('sendFriendRequest', async ({ token, targetUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const target = await usersDb.findOne({ username: targetUsername });
            if (!target) return callback?.({ error: 'Not found' });
            if (target.username === decoded.username) return callback?.({ error: 'Self' });
            await usersDb.update({ _id: target._id }, { $addToSet: { pendingRequests: decoded.username } });
            callback?.({ success: true });
        } catch (err) { callback?.({ error: 'Failed' }); }
    });

    socket.on('acceptFriend', async ({ token, requesterUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            await usersDb.update({ _id: decoded.id }, { $pull: { pendingRequests: requesterUsername }, $addToSet: { friends: requesterUsername } });
            await usersDb.update({ username: requesterUsername }, { $addToSet: { friends: decoded.username } });
            callback?.({ success: true });
        } catch (err) { callback?.({ error: 'Auth failed' }); }
    });

    socket.on('adminKick', ({ token, targetSocketId }, callback) => {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.username !== ADMIN_USER) return callback?.({ error: 'Forbidden' });
        const target = io.sockets.sockets.get(targetSocketId);
        if (target) { target.disconnect(); callback?.({ success: true }); }
    });

    socket.on('adminAnnouncement', ({ token, text }, callback) => {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.username !== ADMIN_USER) return callback?.({ error: 'Forbidden' });
        roomState.announcement = text || null;
        io.emit('roomUpdate', { ...roomState, serverTime: Date.now() });
        callback?.({ success: true });
    });

    socket.on('adminResetDj', ({ token }, callback) => {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.username !== ADMIN_USER && decoded.username !== 'kaid') return callback?.({ error: 'Forbidden' });
        roomState.djId = null;
        roomState.djUsername = null;
        io.emit('djChanged', { djId: null });
        callback?.({ success: true });
    });

    socket.on('sendMessage', (data) => {
        const user = roomState.users[socket.id];
        const msg = {
            userName: user ? user.name : 'Guest', badge: user ? user.badge : null,
            nameStyle: user ? user.nameStyle : '', text: data.text, timestamp: new Date().toLocaleTimeString()
        };
        addMessageToBuffer(msg);
        io.emit('newMessage', msg);
    });

    socket.on('privateMessage', ({ targetName, text }) => {
        const sender = roomState.users[socket.id];
        if (!sender?.isAuthenticated) return;
        const msg = { from: sender.name, to: targetName, text, timestamp: new Date().toLocaleTimeString() };
        Object.values(roomState.users).filter(u => u.name === targetName || u.name === sender.name).forEach(u => io.to(u.id).emit('privateMessage', msg));
    });

    socket.on('requestDJ', () => {
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

server.listen(PORT, () => console.log(`TheDigitalRoom is alive at http://localhost:${PORT}`));

process.on('uncaughtException', (err) => console.error('CRITICAL ERROR:', err));
process.on('unhandledRejection', (err) => console.error('CRITICAL REJECTION:', err));
