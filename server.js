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
    seekPosition: 0,
    announcement: null,
    djId: null,
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

// Health check for Render
app.get('/health', (req, res) => res.status(200).send('OK'));

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Force DB Load on start
usersDb.load()
    .then(() => console.log("[DB] Users database loaded and ready."))
    .then(() => seedStaff())
    .catch(err => console.error("[DB] Failed to load:", err));

async function seedStaff() {
    try {
        let staffData;
        try {
            staffData = require('./staffData');
        } catch (e) {
            console.log('[Seed] No staffData.js found, skipping seed.');
            return;
        }

        console.log('[Seed] Verifying staff accounts...');
        for (const user of staffData) {
            const existing = await usersDb.findOne({ username: user.username });
            if (!existing) {
                await usersDb.insert(user);
                console.log(`[Seed] Restored staff member: ${user.username}`);
            }
        }
        console.log('[Seed] Staff verification complete.');
    } catch (err) {
        console.error('[Seed] Error during seeding:', err);
    }
}

// Periodic cleanup
setInterval(() => {
    if (roomState.djId && !roomState.users[roomState.djId]) {
        console.log("Cleanup: Removing ghost DJ", roomState.djId);
        roomState.djId = null;
        io.emit('djChanged', { djId: null });
    }
}, 5000);

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Standard GET / for health checks
app.get('/health', (req, res) => res.status(200).send('OK'));

// --- Social API ---
app.get('/api/friends/list', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Unauthorized' });
        const decoded = jwt.verify(token, JWT_SECRET);

        const user = await usersDb.findOne({ _id: decoded.id });
        const friendDetails = await usersDb.find({ username: { $in: user.friends || [] } });

        const friends = friendDetails.map(f => ({
            username: f.username,
            badge: f.badge,
            nameStyle: f.nameStyle,
            isOnline: Object.values(roomState.users).some(u => u.name === f.username)
        }));

        res.json({ friends, pending: user.pendingRequests || [] });
    } catch (err) {
        res.status(500).json({ error: 'Failed' });
    }
});

function addMessageToBuffer(msg) {
    roomState.messages.push(msg);
    if (roomState.messages.length > 50) roomState.messages.shift();
}

function getUniqueUsers() {
    const unique = {};
    Object.values(roomState.users).forEach(u => {
        if (!unique[u.name]) unique[u.name] = u;
    });
    return Object.values(unique);
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.emit('init', {
        state: { ...roomState, users: getUniqueUsers() },
        yourId: socket.id
    });

    // --- Socket-Sync Auth ---
    socket.on('register', async ({ username, password }, callback) => {
        try {
            if (!username || !password) {
                if (typeof callback === 'function') return callback({ error: 'Username/Password required' });
                return;
            }
            const existing = await usersDb.findOne({ username });
            if (existing) {
                if (typeof callback === 'function') return callback({ error: 'User exists' });
                return;
            }
            const hashedPassword = await bcrypt.hash(password, 10);
            await usersDb.insert({
                username, password: hashedPassword,
                badge: 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif',
                nameStyle: '', hasPremiumPack: false, hasThemePack: false, friends: [], pendingRequests: []
            });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Server error' });
        }
    });

    socket.on('login', async ({ username, password }, callback) => {
        try {
            const user = await usersDb.findOne({ username });
            if (!user || !(await bcrypt.compare(password, user.password))) {
                if (typeof callback === 'function') return callback({ error: 'Invalid' });
                return;
            }
            const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
            if (typeof callback === 'function') {
                callback({
                    token,
                    user: {
                        username: user.username, badge: user.badge, nameStyle: user.nameStyle,
                        hasPremiumPack: user.hasPremiumPack || false, hasThemePack: user.hasThemePack || false,
                        friends: user.friends || [], pendingRequests: user.pendingRequests || []
                    }
                });
            }
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Server error' });
        }
    });

    socket.on('authenticate', async (token, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            if (user) {
                roomState.users[socket.id] = {
                    id: socket.id, dbId: user._id, name: user.username,
                    badge: user.badge || 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif',
                    nameStyle: user.nameStyle || '', status: user.status || '',
                    hasPremiumPack: user.hasPremiumPack || false, hasThemePack: user.hasThemePack || false,
                    hasWarlockStyle: user.hasWarlockStyle || false,
                    friends: user.friends || [], pendingRequests: user.pendingRequests || [],
                    isAuthenticated: true
                };
                io.emit('userUpdate', getUniqueUsers());
                const responseData = {
                    username: user.username, badge: user.badge, nameStyle: user.nameStyle,
                    status: user.status || '', hasPremiumPack: user.hasPremiumPack || false,
                    hasThemePack: user.hasThemePack || false, hasWarlockStyle: user.hasWarlockStyle || false,
                    friends: user.friends || [], pendingRequests: user.pendingRequests || []
                };
                socket.emit('authSuccess', responseData);
                if (typeof callback === 'function') callback({ success: true, user: responseData });

                // Join broadcast
                const joinMsg = { userName: 'SYSTEM', text: `${user.username} entered.`, timestamp: new Date().toLocaleTimeString(), isSystem: true };
                addMessageToBuffer(joinMsg);
                io.emit('newMessage', joinMsg);
            }
        } catch (err) {
            if (typeof callback === 'function') callback({ success: false });
        }
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
                io.emit('userPartialUpdate', { id: socket.id, badge: updatedUser.badge, nameStyle: updatedUser.nameStyle, status: updatedUser.status || '' });
            }
            if (typeof callback === 'function') callback({ success: true, user: updatedUser });
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Failed' });
        }
    });

    socket.on('unlockPremium', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            await usersDb.update({ _id: decoded.id }, { $set: { hasPremiumPack: true } });
            if (roomState.users[socket.id]) {
                roomState.users[socket.id].hasPremiumPack = true;
                io.emit('userPartialUpdate', { id: socket.id, hasPremiumPack: true });
            }
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Failed' }); }
    });

    socket.on('unlockThemePack', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            await usersDb.update({ _id: decoded.id }, { $set: { hasThemePack: true } });
            if (roomState.users[socket.id]) {
                roomState.users[socket.id].hasThemePack = true;
                io.emit('userPartialUpdate', { id: socket.id, hasThemePack: true });
            }
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Failed' }); }
    });

    socket.on('unlockWarlock', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            await usersDb.update({ _id: decoded.id }, { $set: { hasWarlockStyle: true } });
            if (roomState.users[socket.id]) {
                roomState.users[socket.id].hasWarlockStyle = true;
                io.emit('userPartialUpdate', { id: socket.id, hasWarlockStyle: true });
            }
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Failed' }); }
    });

    // --- Social Socket Events ---
    socket.on('getFriends', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            if (user && typeof callback === 'function') {
                callback({ friends: user.friends || [], pending: user.pendingRequests || [] });
            }
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Auth failed' }); }
    });

    socket.on('sendFriendRequest', async ({ token, targetUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const sender = await usersDb.findOne({ _id: decoded.id });
            const target = await usersDb.findOne({ username: targetUsername });
            if (!target) { if (typeof callback === 'function') return callback({ error: 'User not found' }); return; }
            if (target.username === sender.username) { if (typeof callback === 'function') return callback({ error: 'Cannot add yourself' }); return; }
            await usersDb.update({ _id: target._id }, { $addToSet: { pendingRequests: sender.username } });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Failed' }); }
    });

    socket.on('acceptFriend', async ({ token, requesterUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            const requester = await usersDb.findOne({ username: requesterUsername });
            if (!user || !requester) { if (typeof callback === 'function') return callback({ error: 'User not found' }); return; }
            await usersDb.update({ _id: user._id }, { $pull: { pendingRequests: requesterUsername }, $addToSet: { friends: requesterUsername } });
            await usersDb.update({ username: requesterUsername }, { $addToSet: { friends: decoded.username } });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Auth failed' }); }
    });

    // --- Admin Socket Events ---
    socket.on('adminKick', ({ token, targetSocketId }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) { if (typeof callback === 'function') return callback({ error: 'Forbidden' }); return; }
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) { targetSocket.disconnect(); if (typeof callback === 'function') callback({ success: true }); }
            else { if (typeof callback === 'function') callback({ error: 'User not online' }); }
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Auth failed' }); }
    });

    socket.on('adminAnnouncement', ({ token, text }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) { if (typeof callback === 'function') return callback({ error: 'Forbidden' }); return; }
            roomState.announcement = text || null;
            io.emit('roomUpdate', { ...roomState, serverTime: Date.now() });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Auth failed' }); }
    });

    socket.on('adminClearChat', ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) { if (typeof callback === 'function') return callback({ error: 'Forbidden' }); return; }
            roomState.messages = [];
            addMessageToBuffer({ userName: 'SYSTEM', text: 'Chat history cleared by Admin.', timestamp: new Date().toLocaleTimeString(), isSystem: true });
            io.emit('init', { state: { ...roomState, users: getUniqueUsers() }, yourId: null });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Auth failed' }); }
    });

    socket.on('adminResetDj', ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER && decoded.username !== 'kaid') {
                if (typeof callback === 'function') return callback({ error: 'Forbidden' });
                return;
            }
            roomState.djId = null;
            io.emit('djChanged', { djId: null });
            io.emit('newMessage', { userName: 'SYSTEM', text: 'DJ booth has been reset by an administrator.', isSystem: true });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) { if (typeof callback === 'function') callback({ error: 'Auth failed' }); }
    });

    socket.on('sendMessage', (data) => {
        const user = roomState.users[socket.id];
        const msg = {
            userId: socket.id, userName: user ? user.name : 'Guest',
            badge: user ? user.badge : data.badge,
            nameStyle: user ? user.nameStyle : (data.nameStyle || ''),
            text: data.text, timestamp: new Date().toLocaleTimeString()
        };
        addMessageToBuffer(msg);
        io.emit('newMessage', msg);
    });

    socket.on('privateMessage', ({ targetName, text }) => {
        const sender = roomState.users[socket.id];
        if (!sender || !sender.isAuthenticated) return;
        const msgData = { from: sender.name, to: targetName, text, timestamp: new Date().toLocaleTimeString() };
        Object.values(roomState.users).filter(u => u.name === targetName || u.name === sender.name).forEach(u => io.to(u.id).emit('privateMessage', msgData));
    });

    socket.on('requestDJ', () => {
        const user = roomState.users[socket.id];
        if (!roomState.djId && user) {
            roomState.djId = socket.id;
            io.emit('djChanged', { djId: roomState.djId, djName: user.name });
            io.emit('newMessage', { userName: 'SYSTEM', text: `${user.name} is now the DJ!`, isSystem: true });
        }
    });

    socket.on('djUpdate', (update) => {
        if (socket.id === roomState.djId) {
            roomState = { ...roomState, ...update, lastUpdateAt: Date.now() };
            socket.broadcast.emit('roomUpdate', { ...roomState, serverTime: roomState.lastUpdateAt });
        }
    });

    socket.on('disconnect', () => {
        const user = roomState.users[socket.id];
        if (user) {
            delete roomState.users[socket.id];
            if (roomState.djId === socket.id) { roomState.djId = null; io.emit('djChanged', { djId: null }); }
            if (roomState.voiceUsers[socket.id]) { delete roomState.voiceUsers[socket.id]; io.emit('voice-update', Object.values(roomState.voiceUsers)); }
            if (roomState.streams[socket.id]) { delete roomState.streams[socket.id]; io.emit('stream-update', Object.values(roomState.streams)); }
            io.emit('newMessage', { userName: 'SYSTEM', text: `${user.name} left.`, isSystem: true });
            io.emit('userUpdate', getUniqueUsers());
        }
    });

    // --- Voice/Stream ---
    socket.on('voice-join', () => {
        const user = roomState.users[socket.id];
        if (user) {
            roomState.voiceUsers[socket.id] = { id: socket.id, name: user.name, badge: user.badge, nameStyle: user.nameStyle, muted: false, deafened: false };
            io.emit('voice-update', Object.values(roomState.voiceUsers));
            socket.emit('voice-peer-list', Object.keys(roomState.voiceUsers).filter(id => id !== socket.id));
        }
    });
    socket.on('voice-signal', ({ to, signal }) => io.to(to).emit('voice-signal', { from: socket.id, signal }));

    socket.on('stream-start', () => {
        const user = roomState.users[socket.id];
        if (user && Object.keys(roomState.streams).length < 10) {
            roomState.streams[socket.id] = { streamerId: socket.id, streamerName: user.name };
            io.emit('stream-update', Object.values(roomState.streams));
            user.isLive = true;
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
    socket.on('stream-signal', ({ to, signal, streamerId }) => io.to(to).emit('stream-signal', { from: socket.id, signal, streamerId }));
});

server.listen(PORT, () => console.log(`TheDigitalRoom is alive at http://localhost:${PORT}`));

// Global Error Handling
process.on('uncaughtException', (err) => console.error('CRITICAL ERROR:', err));
process.on('unhandledRejection', (err) => console.error('CRITICAL REJECTION:', err));

// Cache Buster: 20260126235800
