const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { usersDb } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'myspace_secret_key_123';
const ADMIN_USER = process.env.ADMIN_USER || 'mayne';

let roomState = {
    currentTrack: '', // No default track
    isPlaying: false,
    seekPosition: 0,
    currentVibe: 'WELCOME TO THE DIGITAL ROOM', // Shared scrolling text
    announcement: null, // Persistent room-wide news
    djId: null,
    users: {},
    messages: [], // Chat history buffer
    voiceUsers: {}, // Voice channel participants
    streams: {} // Screen share state Map: { streamerId: { streamerId, streamerName } }
};

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    allowEIO3: true,
    transports: ['websocket'],
    pingTimeout: 10000,
    pingInterval: 5000,
    perMessageDeflate: {
        threshold: 1024 // Only compress messages larger than 1KB
    }
});

const PORT = process.env.PORT || 3000;

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
                // Remove _id to let db assign a new one, or keep it if we want ID persistence (nedb preserves it if valid)
                // However, user data from extract already has _id. NeDB usually accepts provided _id.
                await usersDb.insert(user);
                console.log(`[Seed] Restored staff member: ${user.username}`);
            }
        }
        console.log('[Seed] Staff verification complete.');
    } catch (err) {
        console.error('[Seed] Error during seeding:', err);
    }
}

// Periodic cleanup: ensures djId isn't pointing to a ghost session
setInterval(() => {
    if (roomState.djId && !roomState.users[roomState.djId]) {
        console.log("Cleanup: Removing ghost DJ", roomState.djId);
        roomState.djId = null;
        io.emit('djChanged', { djId: null });
    }
}, 5000);

app.use(express.json({ limit: '2mb' }));
// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth Endpoints ---

// --- Legacy REST Auth Endpoints Removed (Site now uses Socket-based Auth) ---

app.post('/api/update-profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Unauthorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        const { badge, password, nameStyle } = req.body;

        let update = {};
        if (badge) update.badge = badge;
        if (password) update.password = await bcrypt.hash(password, 10);
        if (nameStyle !== undefined) update.nameStyle = nameStyle;

        await usersDb.update({ _id: decoded.id }, { $set: update });
        const updatedUser = await usersDb.findOne({ _id: decoded.id });

        res.json({
            success: true,
            user: {
                username: updatedUser.username,
                badge: updatedUser.badge,
                nameStyle: updatedUser.nameStyle,
                hasPremiumPack: updatedUser.hasPremiumPack || false,
                friends: updatedUser.friends || [],
                pendingRequests: updatedUser.pendingRequests || []
            }
        });
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
});

app.post('/api/unlock-premium', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Unauthorized' });

        const decoded = jwt.verify(token, JWT_SECRET);
        await usersDb.update({ _id: decoded.id }, { $set: { hasPremiumPack: true } });

        res.json({ success: true, hasPremiumPack: true });
    } catch (err) {
        res.status(401).json({ error: 'Failed to unlock' });
    }
});

// --- Friends API ---

app.post('/api/friends/request', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Unauthorized' });
        const decoded = jwt.verify(token, JWT_SECRET);
        const { targetUsername } = req.body;

        const sender = await usersDb.findOne({ _id: decoded.id });
        const target = await usersDb.findOne({ username: targetUsername });

        if (!target) return res.status(404).json({ error: 'User not found' });
        if (sender.username === targetUsername) return res.status(400).json({ error: 'Cannot add yourself' });
        if (sender.friends?.includes(targetUsername)) return res.status(400).json({ error: 'Already friends' });

        await usersDb.update({ username: targetUsername }, { $addToSet: { pendingRequests: sender.username } });
        res.json({ success: true, message: 'Request sent!' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to send request' });
    }
});

app.post('/api/friends/accept', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        if (!token) return res.status(401).json({ error: 'Unauthorized' });
        const decoded = jwt.verify(token, JWT_SECRET);
        const { requesterUsername } = req.body;

        const responder = await usersDb.findOne({ _id: decoded.id });

        await usersDb.update({ _id: decoded.id }, {
            $pull: { pendingRequests: requesterUsername },
            $addToSet: { friends: requesterUsername }
        });
        await usersDb.update({ username: requesterUsername }, {
            $addToSet: { friends: responder.username }
        });

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Failed to accept' });
    }
});

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
        res.status(500).json({ error: 'Failed to list friends' });
    }
});

// --- Admin API ---

app.post('/api/admin/kick', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.username !== ADMIN_USER) return res.status(403).json({ error: 'Forbidden' });

        const { targetSocketId } = req.body;
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
            targetSocket.disconnect();
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'User not online' });
        }
    } catch (err) {
        res.status(401).json({ error: 'Unauthorized' });
    }
});

app.post('/api/admin/clear-chat', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.username !== ADMIN_USER) return res.status(403).json({ error: 'Forbidden' });

        roomState.messages = [];
        const clearMsg = { userName: 'SYSTEM', text: 'Chat history cleared by Admin.', timestamp: new Date().toLocaleTimeString(), isSystem: true };
        addMessageToBuffer(clearMsg);
        io.emit('init', { state: roomState, yourId: null }); // Hard refresh for all
        res.json({ success: true });
    } catch (err) {
        res.status(401).json({ error: 'Unauthorized' });
    }
});

app.post('/api/admin/announcement', async (req, res) => {
    try {
        const token = req.headers.authorization?.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.username !== ADMIN_USER) return res.status(403).json({ error: 'Forbidden' });

        const { text } = req.body;
        roomState.announcement = text || null;
        io.emit('roomUpdate', roomState);
        res.json({ success: true });
    } catch (err) {
        res.status(401).json({ error: 'Unauthorized' });
    }
});

// State management

function addMessageToBuffer(msg) {
    roomState.messages.push(msg);
    if (roomState.messages.length > 50) {
        roomState.messages.shift();
    }
}

function getUniqueUsers() {
    const unique = {};
    Object.values(roomState.users).forEach(u => {
        if (!unique[u.name]) {
            unique[u.name] = u;
        }
    });
    return Object.values(unique);
}

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Initial user setup - NO LONGER ADDING GUESTS TO roomState.users
    // Users are only added to the active list after successful 'authenticate'

    // Send current state to the new user

    // Send current state to the new user - using unique users for the list
    socket.emit('init', {
        state: {
            ...roomState,
            users: getUniqueUsers()
        },
        yourId: socket.id
    });

    // --- Socket-Sync Auth Rehaul ---
    socket.on('register', async ({ username, password }, callback) => {
        console.log(`[SOCKET-AUTH] Registration attempt: ${username}`);
        try {
            if (!username || !password) {
                if (typeof callback === 'function') return callback({ error: 'Username and password required' });
                return;
            }
            const existing = await usersDb.findOne({ username });
            if (existing) {
                console.warn(`[SOCKET-AUTH] User exists: ${username}`);
                if (typeof callback === 'function') return callback({ error: 'Username already exists' });
                return;
            }
            const hashedPassword = await bcrypt.hash(password, 10);
            await usersDb.insert({
                username,
                password: hashedPassword,
                badge: 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif',
                nameStyle: '',
                hasPremiumPack: false,
                hasThemePack: false, // Theme Pack Extra
                friends: [],
                pendingRequests: []
            });
            console.log(`[SOCKET-AUTH] Registration success: ${username}`);
            if (typeof callback === 'function') callback({ success: true, message: 'User registered! Please login.' });
        } catch (err) {
            console.error('[SOCKET-AUTH] Reg Error:', err);
            if (typeof callback === 'function') callback({ error: 'Server error during registration' });
        }
    });

    socket.on('login', async ({ username, password }, callback) => {
        console.log(`[SOCKET-AUTH] Login attempt: ${username}`);
        try {
            const user = await usersDb.findOne({ username });
            if (!user || !(await bcrypt.compare(password, user.password))) {
                if (typeof callback === 'function') return callback({ error: 'Invalid credentials' });
                return;
            }
            const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
            if (typeof callback === 'function') {
                callback({
                    token,
                    user: {
                        username: user.username,
                        badge: user.badge,
                        nameStyle: user.nameStyle,
                        hasPremiumPack: user.hasPremiumPack || false,
                        hasThemePack: user.hasThemePack || false,
                        friends: user.friends || [],
                        pendingRequests: user.pendingRequests || []
                    }
                });
            }
        } catch (err) {
            console.error('[SOCKET-AUTH] Login Error:', err);
            if (typeof callback === 'function') callback({ error: 'Server error during login' });
        }
    });

    socket.on('updateProfile', async ({ token, badge, password, nameStyle, status }, callback) => {
        console.log(`[SOCKET-AUTH] Profile update attempt...`);
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            let update = {};
            if (badge) update.badge = badge;
            if (password) update.password = await bcrypt.hash(password, 10);
            if (nameStyle !== undefined) update.nameStyle = nameStyle;
            if (status !== undefined) update.status = status;

            await usersDb.update({ _id: decoded.id }, { $set: update });
            const updatedUser = await usersDb.findOne({ _id: decoded.id });

            // Update in-memory user if they are currently online
            if (roomState.users[socket.id]) {
                roomState.users[socket.id].badge = updatedUser.badge;
                roomState.users[socket.id].nameStyle = updatedUser.nameStyle;
                roomState.users[socket.id].status = updatedUser.status || '';

                // Delta Update
                io.emit('userPartialUpdate', {
                    id: socket.id,
                    badge: updatedUser.badge,
                    nameStyle: updatedUser.nameStyle,
                    status: updatedUser.status || ''
                });
            }

            if (typeof callback === 'function') {
                callback({
                    success: true,
                    user: {
                        username: updatedUser.username,
                        badge: updatedUser.badge,
                        nameStyle: updatedUser.nameStyle,
                        status: updatedUser.status || '',
                        hasPremiumPack: updatedUser.hasPremiumPack || false,
                        hasThemePack: updatedUser.hasThemePack || false, // Theme Pack Extra
                        friends: updatedUser.friends || [],
                        pendingRequests: updatedUser.pendingRequests || []
                    }
                });
            }
        } catch (err) {
            console.error('[SOCKET-AUTH] Profile Update Error:', err);
            if (typeof callback === 'function') callback({ error: 'Auth failed' });
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

            callback({ success: true });
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    socket.on('unlockThemePack', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            await usersDb.update({ _id: decoded.id }, { $set: { hasThemePack: true } });

            if (roomState.users[socket.id]) {
                roomState.users[socket.id].hasThemePack = true;
                io.emit('userPartialUpdate', { id: socket.id, hasThemePack: true });
            }

            callback({ success: true });
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    socket.on('unlockWarlock', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            await usersDb.update({ _id: decoded.id }, { $set: { hasWarlockStyle: true } });

            if (roomState.users[socket.id]) {
                roomState.users[socket.id].hasWarlockStyle = true;
                io.emit('userPartialUpdate', { id: socket.id, hasWarlockStyle: true });
            }

            callback({ success: true });
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    // --- Social Socket Events ---
    socket.on('getFriends', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            if (user && typeof callback === 'function') {
                callback({
                    friends: user.friends || [],
                    pending: user.pendingRequests || []
                });
            }
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Auth failed' });
        }
    });

    socket.on('sendFriendRequest', async ({ token, targetUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const sender = await usersDb.findOne({ _id: decoded.id });
            const target = await usersDb.findOne({ username: targetUsername });

            if (!target) {
                if (typeof callback === 'function') return callback({ error: 'User not found' });
                return;
            }
            if (target.username === sender.username) {
                if (typeof callback === 'function') return callback({ error: 'Cannot add yourself' });
                return;
            }

            await usersDb.update({ _id: target._id }, { $addToSet: { pendingRequests: sender.username } });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Failed' });
        }
    });

    socket.on('acceptFriend', async ({ token, requesterUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            const requester = await usersDb.findOne({ username: requesterUsername });

            if (!user || !requester) {
                if (typeof callback === 'function') return callback({ error: 'User not found' });
                return;
            }

            // Mutual relationship - simplified for now, assuming friends is array of strings or objects
            // Let's stick to the current structure in userPartialUpdate which expects objects sometimes but server logic was using strings?
            // Wait, looking at getFriends, it was fetching details. Let's keep it consistent.

            await usersDb.update({ _id: user._id }, {
                $pull: { pendingRequests: requesterUsername },
                $addToSet: { friends: requesterUsername }
            });
            await usersDb.update({ username: requesterUsername }, {
                $addToSet: { friends: decoded.username }
            });

            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Auth failed' });
        }
    });

    // --- Admin Socket Events ---
    socket.on('adminKick', ({ token, targetSocketId }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) {
                if (typeof callback === 'function') return callback({ error: 'Forbidden' });
                return;
            }

            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                targetSocket.disconnect();
                if (typeof callback === 'function') callback({ success: true });
            } else {
                if (typeof callback === 'function') callback({ error: 'User not online' });
            }
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Auth failed' });
        }
    });

    socket.on('adminAnnouncement', ({ token, text }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) {
                if (typeof callback === 'function') return callback({ error: 'Forbidden' });
                return;
            }

            roomState.announcement = text || null;
            io.emit('roomUpdate', roomState);
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Auth failed' });
        }
    });

    socket.on('adminClearChat', ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) {
                if (typeof callback === 'function') return callback({ error: 'Forbidden' });
                return;
            }

            roomState.messages = [];
            addMessageToBuffer({ userName: 'SYSTEM', text: 'Chat history cleared by Admin.', timestamp: new Date().toLocaleTimeString(), isSystem: true });
            io.emit('init', { state: roomState, yourId: null });
            if (typeof callback === 'function') callback({ success: true });
        } catch (err) {
            if (typeof callback === 'function') callback({ error: 'Auth failed' });
        }
    });

    // Handle Socket Authentication
    socket.on('authenticate', async (token, callback) => {
        try {
            await usersDb.load();
            const decoded = jwt.verify(token, JWT_SECRET);
            const user = await usersDb.findOne({ _id: decoded.id });
            if (user) {
                // Update room state with persistent user info
                roomState.users[socket.id] = {
                    id: socket.id,
                    dbId: user._id,
                    name: user.username,
                    badge: user.badge || 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif',
                    nameStyle: user.nameStyle || '',
                    status: user.status || '',
                    hasPremiumPack: user.hasPremiumPack || false,
                    hasThemePack: user.hasThemePack || false,
                    friends: user.friends || [],
                    pendingRequests: user.pendingRequests || [],
                    isAuthenticated: true
                };
                io.emit('userUpdate', getUniqueUsers());

                const responseData = {
                    username: user.username,
                    badge: user.badge,
                    nameStyle: user.nameStyle,
                    status: user.status || '',
                    hasPremiumPack: user.hasPremiumPack || false,
                    hasThemePack: user.hasThemePack || false,
                    friends: user.friends || [],
                    pendingRequests: user.pendingRequests || []
                };

                socket.emit('authSuccess', responseData);
                if (typeof callback === 'function') callback({ success: true, user: responseData });
            } else {
                throw new Error('User not found');
            }
        } catch (err) {
            console.warn(`[AUTH] Refused session for socket ${socket.id}: ${err.message}`);
            socket.emit('authError', 'Invalid session');
            if (typeof callback === 'function') callback({ success: false, error: 'Invalid session' });
        }
    });

    // Broadcast join message
    if (roomState.users[socket.id]) {
        const joinMsg = {
            userName: 'SYSTEM',
            text: `${roomState.users[socket.id].name} has entered the room.`,
            timestamp: new Date().toLocaleTimeString(),
            isSystem: true
        };
        addMessageToBuffer(joinMsg);
        io.emit('newMessage', joinMsg);
    }

    // Handle Chat
    socket.on('sendMessage', (data) => {
        const user = roomState.users[socket.id];
        const messageData = {
            userId: socket.id,
            userName: user ? user.name : 'Guest',
            badge: user ? user.badge : data.badge,
            nameStyle: user ? user.nameStyle : (data.nameStyle || ''),
            text: data.text,
            timestamp: new Date().toLocaleTimeString()
        };
        addMessageToBuffer(messageData);
        io.emit('newMessage', messageData);
    });

    // --- TheChatBox: Direct Messaging ---
    socket.on('privateMessage', ({ targetName, text }) => {
        const sender = roomState.users[socket.id];
        if (!sender || !sender.isAuthenticated) return;

        console.log(`[CHATBOX] ${sender.name} -> ${targetName}: ${text}`);

        const msgData = {
            from: sender.name,
            to: targetName,
            text: text,
            timestamp: new Date().toLocaleTimeString()
        };

        // Find all sockets for targetName (multi-tab support)
        const targetSockets = Object.values(roomState.users)
            .filter(u => u.name === targetName)
            .map(u => u.id);

        // Find all sockets for sender (multi-tab sync)
        const senderSockets = Object.values(roomState.users)
            .filter(u => u.name === sender.name)
            .map(u => u.id);

        // Deliver to recipient(s)
        targetSockets.forEach(sid => io.to(sid).emit('privateMessage', msgData));

        // Deliver to sender(s) so sent messages show up in all tabs
        senderSockets.forEach(sid => io.to(sid).emit('privateMessage', msgData));
    });

    socket.on('changeName', (newName) => {
        const user = roomState.users[socket.id];
        if (user && user.isAuthenticated) {
            const authChangeNameMsg = { userName: 'SYSTEM', text: 'You cannot change your name while logged in. Update your profile settings instead.', isSystem: true };
            addMessageToBuffer(authChangeNameMsg); // Add to buffer even if only sent to one user
            return socket.emit('newMessage', authChangeNameMsg);
        }

        if (newName && newName.length < 20) {
            const oldName = roomState.users[socket.id].name;
            roomState.users[socket.id].name = newName;

            // Delta Update
            io.emit('userPartialUpdate', {
                id: socket.id,
                name: newName
            });

            const nameMsg = {
                userName: 'SYSTEM',
                text: `${oldName} is now known as ${newName}.`,
                timestamp: new Date().toLocaleTimeString(),
                isSystem: true
            };
            addMessageToBuffer(nameMsg);
            io.emit('newMessage', nameMsg);
        }
    });

    // Handle DJ control request
    socket.on('requestDJ', () => {
        const user = roomState.users[socket.id];
        if (!roomState.djId && user) {
            roomState.djId = socket.id;
            io.emit('djChanged', { djId: roomState.djId, djName: user.name });
            console.log(`New DJ: ${user.name} (${socket.id})`);

            // Send direct confirmation to the new DJ
            const djConfirmMsg = {
                userName: 'SYSTEM',
                text: 'HELL YEAH! You are now the DJ. Use the MASTER GAIN box to load some tunes.',
                timestamp: new Date().toLocaleTimeString(),
                isSystem: true
            };
            addMessageToBuffer(djConfirmMsg); // Add to buffer even if only sent to one user
            socket.emit('newMessage', djConfirmMsg);

            const djMsg = {
                userName: 'SYSTEM',
                text: `${user.name} is now the DJ!`,
                timestamp: new Date().toLocaleTimeString(),
                isSystem: true
            };
            addMessageToBuffer(djMsg);
            io.emit('newMessage', djMsg); // Broadcast to all
        }
    });

    // DJ sync updates
    socket.on('djUpdate', (update) => {
        if (socket.id === roomState.djId) {
            roomState.currentTrack = update.track || roomState.currentTrack;
            roomState.isPlaying = update.isPlaying !== undefined ? update.isPlaying : roomState.isPlaying;
            roomState.seekPosition = update.seekPosition !== undefined ? update.seekPosition : roomState.seekPosition;
            roomState.currentVibe = update.vibe !== undefined ? update.vibe : roomState.currentVibe;

            roomState.lastUpdateAt = Date.now(); // Server-side precision timestamp

            // Broadcast the update with a high-fidelity 'sentAt' timestamp
            socket.broadcast.emit('roomUpdate', {
                ...roomState,
                serverTime: roomState.lastUpdateAt
            });
        }
    });


    socket.on('reportPing', (ping) => {
        if (roomState.users[socket.id]) {
            roomState.users[socket.id].ping = ping;
            // Delta Update for Ping - Much more efficient
            io.emit('userPartialUpdate', {
                id: socket.id,
                ping: ping
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        const user = roomState.users[socket.id];
        const nameOnExit = user ? user.name : 'Unknown User';

        if (user) {
            delete roomState.users[socket.id];

            if (roomState.djId === socket.id) {
                roomState.djId = null;
                io.emit('djChanged', { djId: null });
            }

            // --- BUG FIX: Voice Chat Cleanup ---
            if (roomState.voiceUsers[socket.id]) {
                console.log(`[VOICE] Cleanup: ${roomState.voiceUsers[socket.id].name} disconnected.`);
                delete roomState.voiceUsers[socket.id];
                io.emit('voice-update', Object.values(roomState.voiceUsers));
            }

            const leaveMsg = {
                userName: 'SYSTEM',
                text: `${nameOnExit} has left the room.`,
                timestamp: new Date().toLocaleTimeString(),
                isSystem: true
            };
            addMessageToBuffer(leaveMsg);
            io.emit('newMessage', leaveMsg);

            // Multi-Stream Cleanup
            if (roomState.streams[socket.id]) {
                console.log(`[STREAM] Cleanup: ${roomState.streams[socket.id].streamerName} disconnected.`);
                delete roomState.streams[socket.id];
                io.emit('stream-update', Object.values(roomState.streams));
            }

            io.emit('userUpdate', getUniqueUsers());
        }
    });

    // --- Voice Chat Signaling ---
    socket.on('voice-join', () => {
        const user = roomState.users[socket.id];
        if (user) {
            roomState.voiceUsers[socket.id] = {
                id: socket.id,
                name: user.name,
                badge: user.badge,
                nameStyle: user.nameStyle,
                muted: false,
                deafened: false
            };
            console.log(`[VOICE] ${user.name} joined voice channel.`);
            io.emit('voice-update', Object.values(roomState.voiceUsers));
            const otherUsers = Object.keys(roomState.voiceUsers).filter(id => id !== socket.id);
            socket.emit('voice-peer-list', otherUsers);
        }
    });

    socket.on('voice-leave', () => {
        if (roomState.voiceUsers[socket.id]) {
            delete roomState.voiceUsers[socket.id];
            io.emit('voice-update', Object.values(roomState.voiceUsers));
        }
    });

    socket.on('voice-state-update', (state) => {
        if (roomState.voiceUsers[socket.id]) {
            roomState.voiceUsers[socket.id].muted = state.muted;
            roomState.voiceUsers[socket.id].deafened = state.deafened;
            io.emit('voice-update', Object.values(roomState.voiceUsers));
        }
    });

    socket.on('voice-signal', ({ to, signal }) => {
        io.to(to).emit('voice-signal', { from: socket.id, signal });
    });

    // --- Multi-Stream Signaling (v2.0) ---
    socket.on('stream-start', () => {
        const user = roomState.users[socket.id];
        if (user) {
            const activeCount = Object.keys(roomState.streams).length;
            if (activeCount >= 10 && !roomState.streams[socket.id]) {
                return socket.emit('newMessage', { userName: 'SYSTEM', text: 'MAX 10 STREAMS REACHED.', isSystem: true });
            }
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
            const user = roomState.users[socket.id];
            if (user) {
                user.isLive = false;
                io.emit('userPartialUpdate', { id: socket.id, isLive: false });
            }
        }
    });

    socket.on('stream-join', (streamerId) => {
        if (roomState.streams[streamerId]) {
            io.to(streamerId).emit('stream-peer-join', socket.id);
        }
    });

    socket.on('stream-signal', ({ to, signal, streamerId }) => {
        io.to(to).emit('stream-signal', { from: socket.id, signal, streamerId });
    });
});

server.listen(PORT, () => {
    console.log(`TheDigitalRoom is alive at http://localhost:${PORT}`);
});
// Cache Buster: 20260126184458
