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
    currentTheme: null, // Shared room aesthetic
    currentVibe: 'WELCOME TO THE DIGITAL ROOM', // Shared scrolling text
    announcement: null, // Persistent room-wide news
    djId: null,
    users: {},
    messages: [], // Chat history buffer
    voiceUsers: {} // Voice channel participants
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
usersDb.load().then(() => console.log("[DB] Users database loaded and ready."));

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

app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    console.log(`[AUTH] Registration attempt received: ${username}`);
    console.log(`[AUTH] Database check starting...`);
    try {
        if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

        const existing = await usersDb.findOne({ username });
        if (existing) return res.status(400).json({ error: 'Username already exists' });
        console.log(`[AUTH] User check passed. Hashing password...`);

        const hashedPassword = await bcrypt.hash(password, 10);
        const newUser = await usersDb.insert({
            username,
            password: hashedPassword,
            badge: 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif',
            nameStyle: '',
            hasPremiumPack: false,
            friends: [],
            pendingRequests: []
        });
        console.log(`[AUTH] Registration complete for: ${username}`);

        res.json({ success: true, message: 'User registered! Please login.' });
    } catch (err) {
        console.error('Registration API Error:', err);
        res.status(500).json({ error: 'Server error during registration' });
    }
});

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await usersDb.findOne({ username });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
        res.json({
            token,
            user: {
                username: user.username,
                badge: user.badge,
                nameStyle: user.nameStyle,
                hasPremiumPack: user.hasPremiumPack || false,
                hasThemePack: user.hasThemePack || false, // Theme Pack Extra
                friends: user.friends || [],
                pendingRequests: user.pendingRequests || []
            }
        });
    } catch (err) {
        res.status(500).json({ error: 'Server error during login' });
    }
});

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

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Initial user setup
    roomState.users[socket.id] = {
        id: socket.id,
        name: `User_${socket.id.substring(0, 4)}`,
        badge: 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHJndzEyam0yZnB4ZzR6NHRxZzR6NHRxZzR6NHRxZzR6NHRxZzR6JnB0X2lkPWdpcGh5X2dpZl9zZWFyY2gmZXA9djFfZ2lmX3NlYXJjaCZyaWQ9Z2lwaHkuZ2lmJmN0PWc/3o7TKMGpxPAb3NGoPC/giphy.gif'
    };

    // Send current state to the new user
    socket.emit('init', {
        state: roomState,
        yourId: socket.id
    });

    // --- Socket-Sync Auth Rehaul ---
    socket.on('register', async ({ username, password }, callback) => {
        console.log(`[SOCKET-AUTH] Registration attempt: ${username}`);
        try {
            if (!username || !password) return callback({ error: 'Username and password required' });
            await usersDb.load();
            const existing = await usersDb.findOne({ username });
            if (existing) {
                console.warn(`[SOCKET-AUTH] User exists: ${username}`);
                return callback({ error: 'Username already exists' });
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
            callback({ success: true, message: 'User registered! Please login.' });
        } catch (err) {
            console.error('[SOCKET-AUTH] Reg Error:', err);
            callback({ error: 'Server error during registration' });
        }
    });

    socket.on('login', async ({ username, password }, callback) => {
        console.log(`[SOCKET-AUTH] Login attempt: ${username}`);
        try {
            await usersDb.load();
            const user = await usersDb.findOne({ username });
            if (!user || !(await bcrypt.compare(password, user.password))) {
                return callback({ error: 'Invalid credentials' });
            }
            const token = jwt.sign({ id: user._id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
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
        } catch (err) {
            console.error('[SOCKET-AUTH] Login Error:', err);
            callback({ error: 'Server error during login' });
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
        } catch (err) {
            console.error('[SOCKET-AUTH] Profile Update Error:', err);
            callback({ error: 'Auth failed' });
        }
    });

    socket.on('unlockPremium', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            await usersDb.update({ _id: decoded.id }, { $set: { hasPremiumPack: true } });
            callback({ success: true });
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    socket.on('unlockThemePack', async ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            await usersDb.update({ _id: decoded.id }, { $set: { hasThemePack: true } });
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
            if (!user) return callback({ error: 'User not found' });

            const friends = await Promise.all((user.friends || []).map(async username => {
                const f = await usersDb.findOne({ username });
                const isOnline = Object.values(roomState.users).some(u => u.name === username);
                return {
                    username: f.username,
                    badge: f.badge,
                    nameStyle: f.nameStyle,
                    isOnline
                };
            }));
            callback({ friends, pending: user.pendingRequests || [] });
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    socket.on('sendFriendRequest', async ({ token, targetUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username === targetUsername) return callback({ error: 'Cannot add yourself' });

            const target = await usersDb.findOne({ username: targetUsername });
            if (!target) return callback({ error: 'User not found' });

            if ((target.pendingRequests || []).includes(decoded.username)) return callback({ error: 'Request already sent' });
            if ((target.friends || []).includes(decoded.username)) return callback({ error: 'Already friends' });

            await usersDb.update({ username: targetUsername }, { $push: { pendingRequests: decoded.username } });
            callback({ success: true });
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    socket.on('acceptFriend', async ({ token, requesterUsername }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            await usersDb.update({ _id: decoded.id }, { $pull: { pendingRequests: requesterUsername }, $push: { friends: requesterUsername } });
            await usersDb.update({ username: requesterUsername }, { $push: { friends: decoded.username } });
            callback({ success: true });
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    // --- Admin Socket Events ---
    socket.on('adminKick', ({ token, targetSocketId }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) return callback({ error: 'Forbidden' });

            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (targetSocket) {
                targetSocket.disconnect();
                callback({ success: true });
            } else {
                callback({ error: 'User not online' });
            }
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    socket.on('adminAnnouncement', ({ token, text }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) return callback({ error: 'Forbidden' });

            roomState.announcement = text || null;
            io.emit('roomUpdate', roomState);
            callback({ success: true });
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    socket.on('adminClearChat', ({ token }, callback) => {
        try {
            const decoded = jwt.verify(token, JWT_SECRET);
            if (decoded.username !== ADMIN_USER) return callback({ error: 'Forbidden' });

            roomState.messages = [];
            addMessageToBuffer({ userName: 'SYSTEM', text: 'Chat history cleared by Admin.', timestamp: new Date().toLocaleTimeString(), isSystem: true });
            io.emit('init', { state: roomState, yourId: null });
            callback({ success: true });
        } catch (err) {
            callback({ error: 'Auth failed' });
        }
    });

    // Handle Socket Authentication
    socket.on('authenticate', async (token) => {
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
                io.emit('userUpdate', Object.values(roomState.users));
                socket.emit('authSuccess', {
                    username: user.username,
                    badge: user.badge,
                    nameStyle: user.nameStyle,
                    status: user.status || '',
                    hasPremiumPack: user.hasPremiumPack || false,
                    hasThemePack: user.hasThemePack || false,
                    friends: user.friends || [],
                    pendingRequests: user.pendingRequests || []
                });
            }
        } catch (err) {
            socket.emit('authError', 'Invalid session');
        }
    });

    // Notify others
    io.emit('userUpdate', Object.values(roomState.users));

    // Broadcast join message
    const joinMsg = {
        userName: 'SYSTEM',
        text: `${roomState.users[socket.id].name} has entered the room.`,
        timestamp: new Date().toLocaleTimeString(),
        isSystem: true
    };
    addMessageToBuffer(joinMsg);
    io.emit('newMessage', joinMsg);

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
            roomState.currentTheme = update.theme !== undefined ? update.theme : roomState.currentTheme;
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

        io.emit('userUpdate', Object.values(roomState.users));
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
            // Tell the new joiner to initiate calls to existing users
            const otherUsers = Object.keys(roomState.voiceUsers).filter(id => id !== socket.id);
            socket.emit('voice-peer-list', otherUsers);
        }
    });

    socket.on('voice-leave', () => {
        if (roomState.voiceUsers[socket.id]) {
            console.log(`[VOICE] ${roomState.voiceUsers[socket.id].name} left voice channel.`);
            delete roomState.voiceUsers[socket.id];
            io.emit('voice-update', Object.values(roomState.voiceUsers));
        }
    });

    socket.on('voice-signal', ({ to, signal }) => {
        // Relay signal to specific user
        io.to(to).emit('voice-signal', {
            from: socket.id,
            signal
        });
    });

    socket.on('voice-state-update', (state) => {
        if (roomState.voiceUsers[socket.id]) {
            roomState.voiceUsers[socket.id].muted = state.muted;
            roomState.voiceUsers[socket.id].deafened = state.deafened;
            io.emit('voice-update', Object.values(roomState.voiceUsers));
        }
    });
});

server.listen(PORT, () => {
    console.log(`TheDigitalRoom is alive at http://localhost:${PORT}`);
});
