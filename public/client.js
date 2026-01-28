// --- Global Catch to prevent "Nothing Happens" bugs ---
window.onerror = function (msg, url, lineNo, columnNo, error) {
    console.error('GLOBAL ERROR:', msg, 'at line:', lineNo);
    // addSystemMessage(`FATAL SCRIPT ERROR: ${msg} (Line ${lineNo})`);
    return false;
};

const socket = io({
    transports: ['websocket', 'polling'],
    upgrade: true
});

// SoundCloud Widget Init (With Retry)
let widget = null;
function initWidget(retries = 5) {
    const widgetIframe = document.getElementById('sc-widget');
    if (widgetIframe && typeof SC !== 'undefined') {
        try {
            widget = SC.Widget(widgetIframe);
            console.log('[SC] Widget initialized successfully.');
        } catch (e) {
            console.error('[SC] Widget init failed:', e);
        }
    } else if (retries > 0) {
        console.warn(`[SC] Widget not ready. Retrying... (${retries})`);
        setTimeout(() => initWidget(retries - 1), 1000);
    } else {
        console.error('[SC] FATAL: SC Widget failed to load.');
    }
}
// Start init
initWidget();

const chatMessages = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const sendBtn = document.getElementById('send-btn');
const usersContainer = document.getElementById('users-container');
const changeNameBtn = document.getElementById('change-name-btn');
const claimDjBtn = document.getElementById('claim-dj-btn');
const djStatus = document.getElementById('dj-status');
const djToolset = document.getElementById('dj-toolset');
const trackUrlInput = document.getElementById('track-url-input');
const loadTrackBtn = document.getElementById('load-track-btn');
const volumeKnob = document.getElementById('volume-knob');
const knobIndicator = document.querySelector('.knob-indicator');
const volumePct = document.getElementById('volume-pct');
const currentTrackLabel = document.getElementById('current-track-name');
const currentDjLabel = document.getElementById('current-dj-name');
const audioUnlockOverlay = document.getElementById('audio-unlock-overlay');

// Theme Engine Elements
const themesGrid = document.getElementById('themes-grid-modal');
const tabThemes = document.getElementById('tab-themes');
const tabThemesBtn = document.getElementById('tab-themes-btn');
const tabAdmin = document.getElementById('tab-admin');
const tabAdminBtn = document.getElementById('tab-admin-btn');
const tabProfile = document.getElementById('tab-profile');
const tabProfileBtn = document.getElementById('tab-profile-btn');
const tabSocial = document.getElementById('tab-social');
const tabSocialBtn = document.getElementById('tab-social-btn');
const connStatus = document.getElementById('conn-status');

// Auth DOM
const modalOverlay = document.getElementById('modal-overlay');
const loginModal = document.getElementById('login-modal');
const registerModal = document.getElementById('register-modal');
const settingsModal = document.getElementById('settings-modal');
const loginNavBtn = document.getElementById('login-nav-btn');
const logoutNavBtn = document.getElementById('logout-nav-btn');
const userDisplay = document.getElementById('user-display');
const nameStyleSelect = document.getElementById('settings-name-style');
const statusInput = document.getElementById('settings-status');
const premiumShop = document.getElementById('premium-shop');
const claimPremiumBtn = document.getElementById('claim-premium-btn');

// Social DOM
const friendUsernameInput = document.getElementById('friend-username-input');
const sendFriendRequestBtn = document.getElementById('send-friend-request-btn');
const pendingRequestsList = document.getElementById('pending-requests-list');
const friendsListModal = document.getElementById('friends-list-modal');
const topFriendsGrid = document.getElementById('top-friends-grid');

// Admin DOM
const adminClearChatBtn = document.getElementById('admin-clear-chat-btn');
const adminResetDjBtn = document.getElementById('admin-reset-dj-btn');
const adminUserList = document.getElementById('admin-user-list');

// Announcement DOM
const announcementBanner = document.getElementById('announcement-banner');
const adminAnnInput = document.getElementById('admin-ann-input');
const adminAnnSetBtn = document.getElementById('admin-ann-set-btn');
const adminAnnClearBtn = document.getElementById('admin-ann-clear-btn');

// Voice DOM
const voiceJoinBtn = document.getElementById('voice-join-btn');
const voiceLeaveBtn = document.getElementById('voice-leave-btn');
const voiceMuteBtn = document.getElementById('voice-mute-btn');
const voiceDeafenBtn = document.getElementById('voice-deafen-btn');
const voiceUsersContainer = document.getElementById('voice-users-container');
const voiceControlsExtra = document.getElementById('voice-controls-extra');
const voiceInputSelect = document.getElementById('voice-input-select');

const voiceManager = new VoiceManager(socket);
window.voiceManager = voiceManager;
const streamManager = new StreamManager(socket);
window.streamManager = streamManager;

// Stream DOM
const streamViewport = document.getElementById('stream-viewport');
const streamerNameEl = document.getElementById('streamer-name');
const remoteVideo = document.getElementById('remote-stream-video');
const streamStatusMsg = document.getElementById('stream-status-msg');
const joinStreamBtn = document.getElementById('join-stream-btn');
const leaveStreamBtn = document.getElementById('leave-stream-btn');
const streamStartBtn = document.getElementById('stream-start-btn');
const streamStopBtn = document.getElementById('stream-stop-btn');
const streamSelectorModal = document.getElementById('stream-selector-modal');
const streamSelectorList = document.getElementById('stream-selector-list');
const closeStreamSelectorBtns = document.querySelectorAll('.close-stream-selector');

let myId = null;
let currentUser = null; // Stores { username, badge, token }
let currentRoomState = {
    users: {},
    djId: null,
    messages: [],
    announcement: null,
    lastUpdateAt: 0,
    voiceUsers: {},
    activeStreams: [] // List of current broadcasters
};

// TheChatBox DOM & State
const theChatbox = document.getElementById('the-chatbox');
const chatboxTrigger = document.getElementById('the-chatbox-trigger');
const chatboxClose = document.getElementById('chatbox-close');
const chatboxContactsList = document.getElementById('chatbox-contacts-list');
const chatboxTargetName = document.getElementById('chatbox-target-name');
const theChatboxMessages = document.getElementById('chatbox-messages'); // Renamed to avoid collision
const chatboxInput = document.getElementById('chatbox-input');
const chatboxSend = document.getElementById('chatbox-send');
const chatboxGlobalBadge = document.getElementById('chatbox-global-badge');

let activeDMs = {}; // { username: [ {from, text, timestamp} ] }
let unreadCounts = {}; // { username: count }
let currentDMTarget = null;
let chatboxVisible = false;

let isDJ = false;
let djHeartbeat = null; // Interval for DJ position broadcasts
let syncLock = false;
let volume = parseInt(localStorage.getItem('droom_volume')) || 100; // Persisted volume state
let isDraggingKnob = false;
let lastY = 0;
let serverTimeOffset = 0; // Local - Server time difference

// --- Initialization ---

socket.on('connect', () => {
    if (connStatus) {
        connStatus.textContent = '[ONLINE]';
        connStatus.style.color = '#00ff00';
    }
    console.log('Connected to server');

    // Setup Audio Unlock Interaction
    if (audioUnlockOverlay) {
        audioUnlockOverlay.onclick = () => {
            console.log('[AUDIO] User interaction captured. Unlocking...');
            widget.play();
            audioUnlockOverlay.style.display = 'none';
        };
    }
});

socket.on('disconnect', () => {
    if (connStatus) {
        connStatus.textContent = '[OFFLINE]';
        connStatus.style.color = '#ff0000';
    }
});

socket.on('init', (data) => {
    // Calculate Clock Skew: Local = Server + Offset
    // Offset = Local - Server
    if (data.serverNow) {
        serverTimeOffset = Date.now() - data.serverNow;
        console.log('[TIME] Sync complete. Offset:', serverTimeOffset, 'ms');
    }

    myId = data.yourId;
    currentRoomState = data.state;
    updateUI();

    // Render Chat History
    if (data.state.messages && chatMessages) {
        chatMessages.innerHTML = ''; // Clear initial welcome
        data.state.messages.forEach(msg => renderMessage(msg));
    }


    renderAnnouncement(data.state.announcement);

    // LOAD PERSISTENT THEME (Independent Choice)
    const localTheme = localStorage.getItem('droom_theme');
    if (localTheme) {
        try {
            applyTheme(JSON.parse(localTheme), false);
            console.log("[THEME] Restored independent theme from storage.");
        } catch (e) {
            console.error("[THEME] Failed to parse local theme:", e);
        }
    } else if (data.state.currentTheme) {
        // Fallback to room default only if no choice made
        applyTheme(data.state.currentTheme, false);
    }

    // Auto-authenticate if token exists
    const savedToken = localStorage.getItem('droom_token');
    if (savedToken) {
        socket.emit('authenticate', savedToken);
    } else {
        // Force Login Modal if not authenticated
        modalOverlay.style.display = 'flex';
        loginModal.style.display = 'block';
        // Hide close buttons to prevent bypass
        document.querySelectorAll('.close-modal').forEach(btn => btn.style.display = 'none');
    }

    // Initial sync
    if (currentRoomState.currentTrack) {
        syncWithDJ(currentRoomState);
    }

    if (currentRoomState.streams) {
        window.onStreamsUpdate(Object.values(currentRoomState.streams));
    }
});

socket.on('authSuccess', (userData) => {
    currentUser = { ...userData, token: localStorage.getItem('droom_token') };
    if (userDisplay) userDisplay.textContent = `Logged in as: ${currentUser.username}`;
    if (loginNavBtn) loginNavBtn.style.display = 'none';
    if (logoutNavBtn) logoutNavBtn.style.display = 'inline-block';

    updatePremiumUI();
    fetchFriends();

    // Unlock Theme Controls for ALL users (Independent Choice)
    if (tabThemesBtn) tabThemesBtn.style.display = 'block';
    const themeEngine = document.getElementById('theme-engine');
    const themeBoxHeader = themeEngine?.previousElementSibling;
    if (themeEngine) themeEngine.style.display = 'block';
    if (themeBoxHeader) themeBoxHeader.style.display = 'block';

    if (currentUser.username === 'mayne') {
        if (tabAdminBtn) tabAdminBtn.style.display = 'block';
    }

    // Update local guest name to be the real name
    socket.emit('changeName', currentUser.username);
    addSystemMessage(`Authentication successful! Welcome back, ${currentUser.username}.`);
});

socket.on('authError', (msg) => {
    localStorage.removeItem('droom_token');
    addSystemMessage(`Auth Error: ${msg}. Please login again.`);
    // Force Re-Login
    modalOverlay.style.display = 'flex';
    loginModal.style.display = 'block';
    document.querySelectorAll('.close-modal').forEach(btn => btn.style.display = 'none');
});

// --- Ping Measurement ---
setInterval(() => {
    const start = Date.now();
    socket.emit('ping', () => {
        const latency = Date.now() - start;
        socket.emit('reportPing', latency);
    });
}, 2000); // Check ping every 2 seconds

socket.on('userUpdate', (users) => {
    if (!usersContainer) return;

    // FULL SYNC: Clear in-memory users and rebuild from server truth
    // This ensures disconnected users are purged from the UI
    currentRoomState.users = {};
    users.forEach(u => {
        currentRoomState.users[u.id] = u;
    });

    renderUserList();
});

socket.on('userPartialUpdate', (delta) => {
    if (!currentRoomState.users || !currentRoomState.users[delta.id]) return;

    // Merge delta into local state
    currentRoomState.users[delta.id] = { ...currentRoomState.users[delta.id], ...delta };

    // If this is ME, update the local currentUser object as well
    if (delta.id === myId && currentUser) {
        currentUser = { ...currentUser, ...delta };
        updatePremiumUI(); // Ensure UI reflects any new unlocks immediately
    }

    // Targeted DOM update would be better, but re-rendering the list is okay for small counts
    // We throttle this to prevent flickering
    requestAnimationFrame(renderUserList);
});

function renderUserList() {
    if (!usersContainer) return;
    requestAnimationFrame(() => {
        const users = Object.values(currentRoomState.users || {});
        usersContainer.innerHTML = '';
        users.forEach(user => {
            const div = document.createElement('div');
            div.className = 'user-item';
            div.style.cursor = 'pointer';
            div.title = `Click to chat with ${user.name}`;
            div.onclick = () => openPrivateChat(user.name);

            // Color-coded ping
            let pingColor = '#00ff00';
            if (user.ping > 120) pingColor = '#ffff00';
            if (user.ping > 250) pingColor = '#ff0000';
            const pingDisplay = user.ping ? `<span style="color: ${pingColor}; font-size: 0.7em; margin-left: 5px; font-family: monospace;">[${user.ping}ms]</span>` : '';

            div.innerHTML = `
                <img src="${user.badge}" class="user-badge" />
                <div style="display: flex; flex-direction: column;">
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <span class="${user.nameStyle || ''}">${user.name}</span>
                        ${pingDisplay}
                        ${user.id === currentRoomState.djId ? '<span class="blinker" style="color:yellow; font-size: 0.6rem;">[DJ]</span>' : ''}
                        ${user.name === 'mayne' ? '<span class="creator-badge" title="ROOM ARCHITECT">★</span>' : ''}
                        ${user.name === 'kaid' ? '<span class="co-owner-badge" title="CO-OWNER">♦</span>' : ''}
                        ${user.name === 'mummy' ? '<span class="co-admin-badge" title="CO-ADMIN">⚡</span>' : ''}
                        ${user.isLive ? '<span class="blinker" style="color:#ff0055; font-size: 0.6rem; margin-left: 5px;">[LIVE]</span>' : ''}
                    </div>
                     <span style="font-size: 0.6rem; color: #aaa; font-style: italic;">${user.status || ''}</span>
                 </div>
                 <div style="margin-left: auto; display: flex; gap: 5px;">
                     ${user.isLive ? `<button onclick="event.stopPropagation(); streamManager.joinStream('${user.id}')" style="background:#ff0055; color:white; font-size:0.5rem; padding: 2px 5px; border:none; cursor:pointer;">WATCH</button>` : ''}
                 </div>
             `;
            usersContainer.appendChild(div);
        });
    });
}

// Periodically sync friends list presence (throttled)
setInterval(() => {
    if (currentUser) fetchFriends();
}, 10000);

socket.on('djChanged', (data) => {
    currentRoomState.djId = data.djId;
    isDJ = (myId === data.djId);

    // Manage DJ heartbeat
    if (isDJ && !djHeartbeat) {
        console.log('[DJ] Starting heartbeat...');
        djHeartbeat = setInterval(emitDJUpdate, 2000);
    } else if (!isDJ && djHeartbeat) {
        console.log('[DJ] Stopping heartbeat...');
        clearInterval(djHeartbeat);
        djHeartbeat = null;
    }

    if (data.djId) {
        if (djStatus) djStatus.textContent = `DJ: ${data.djName || 'Someone'}`;
        if (currentDjLabel) currentDjLabel.textContent = data.djName || 'Someone';
        addSystemMessage(`${data.djName || 'Someone'} is now the DJ!`);
    } else {
        if (djStatus) djStatus.textContent = `NO DJ CONNECTED`;
        if (currentDjLabel) currentDjLabel.textContent = 'None';
        addSystemMessage(`The DJ has left the booth.`);
    }

    updateUI(); // Centralize UI updates
});

// Periodic sync from server (catches drift and late joiners)
socket.on('roomSync', (state) => {
    if (isDJ) return;
    currentRoomState = { ...currentRoomState, ...state };
    syncWithDJ(currentRoomState);
});

socket.on('roomUpdate', (state) => {
    if (isDJ) return; // I am the source of truth

    currentRoomState = { ...currentRoomState, ...state };

    if (state.trackTitle) {
        currentTrackLabel.textContent = state.trackTitle;
    }

    // Apply shared theme if it exists and is different
    if (state.currentTheme) {
        applyTheme(state.currentTheme, false);
    }

    renderAnnouncement(state.announcement);
    syncWithDJ(currentRoomState);
});

// --- Volume Knob Logic ---

if (volumeKnob) {
    volumeKnob.onmousedown = (e) => {
        isDraggingKnob = true;
        lastY = e.clientY;
        document.body.style.cursor = 'ns-resize';
    };
}

window.onmousemove = (e) => {
    if (!isDraggingKnob) return;

    const deltaY = lastY - e.clientY;
    lastY = e.clientY;

    volume = Math.min(100, Math.max(0, volume + deltaY));
    updateVolumeUI();
};

window.onmouseup = () => {
    isDraggingKnob = false;
    document.body.style.cursor = 'default';
};

function updateVolumeUI() {
    requestAnimationFrame(() => {
        // Rotation: -135deg (0%) to 135deg (100%)
        const rotation = ((volume / 100) * 270) - 135;
        if (knobIndicator) knobIndicator.style.transform = `rotate(${rotation}deg)`;
        if (volumePct) volumePct.textContent = `${Math.round(volume)}%`;
        if (widget) widget.setVolume(volume);

        // Persist Choice
        localStorage.setItem('droom_volume', volume);
    });
}

// Set initial visual state
updateVolumeUI();


function applyTheme(theme) {
    const root = document.documentElement;
    root.style.setProperty('--bg-color', theme.bg);
    root.style.setProperty('--panel-bg', theme.panel);
    root.style.setProperty('--border-color', theme.border);
    root.style.setProperty('--accent-color', theme.accent);
    root.style.setProperty('--text-color', theme.text);

    // Dynamic header gradient based on theme colors
    const headerGradient = `linear-gradient(90deg, ${theme.border}, ${theme.accent})`;
    root.style.setProperty('--header-gradient', headerGradient);

    document.body.style.backgroundImage = theme.bgImage ? `url(${theme.bgImage})` : 'none';
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundAttachment = 'fixed';

    // PERSIST LOCALLY: Save the user's choice
    localStorage.setItem('droom_theme', JSON.stringify(theme));
}

// --- Preset Themes Gallery ---

const presets = [
    { name: "HotDog Stand", bg: "#FF0000", panel: "#FFFF00", border: "#FFFFFF", accent: "#FF0000", text: "#000000" },
    { name: "Winamp Classic", bg: "#2E2E2E", panel: "#4A4A4A", border: "#111111", accent: "#3BFF3B", text: "#3BFF3B" },
    { name: "Emerald Forest", bg: "#0a1f0a", panel: "#1a331a", border: "#2ecc71", accent: "#57d9a3", text: "#e8f5e9" },
    { name: "Obsidian Vibe", bg: "#050505", panel: "#111111", border: "#333333", accent: "#888888", text: "#dddddd" },
    { name: "Electric Sunset", bg: "#1a0b1a", panel: "#2d162d", border: "#ff9f43", accent: "#ff6b6b", text: "#ffffff" },
    { name: "Cyberpunk 97", bg: "#000000", panel: "#300030", border: "#FF00FF", accent: "#00FFFF", text: "#00FF00" },
    { name: "Ice Blue", bg: "#003366", panel: "#004080", border: "#00FFFF", accent: "#FFFFFF", text: "#FFFFFF" },
    { name: "Toxic", bg: "#051105", panel: "#102010", border: "#00AA00", accent: "#00FF00", text: "#00FF00" },
    { name: "GeoCities Gold", bg: "#FFFFE0", panel: "#FFFACD", border: "#DAA520", accent: "#0000FF", text: "#000000" },
    { name: "Vaporwave", bg: "#220033", panel: "#330044", border: "#ff71ce", accent: "#01cdfe", text: "#b967ff" },
    { name: "Solarized", bg: "#002b36", panel: "#073642", border: "#586e75", accent: "#268bd2", text: "#839496" },
    { name: "Pumpkin", bg: "#221100", panel: "#331100", border: "#FF8800", accent: "#FFDD00", text: "#FF8800" },
    { name: "Deep Sea", bg: "#000022", panel: "#000033", border: "#0000FF", accent: "#00FFFF", text: "#FFFFFF" },
    { name: "Royal", bg: "#4B0082", panel: "#8B008B", border: "#FFD700", accent: "#FFD700", text: "#FFFFFF" },
    { name: "Inferno", bg: "#110000", panel: "#220000", border: "#FF0000", accent: "#FF8800", text: "#FFFF00" },
    { name: "Forest", bg: "#002200", panel: "#003300", border: "#228B22", accent: "#ADFF2F", text: "#FFFFFF" },
    { name: "Sunset", bg: "#FF4500", panel: "#FF6347", border: "#FFD700", accent: "#FFFFFF", text: "#FFFFFF" },
    { name: "Ocean", bg: "#1E90FF", panel: "#00BFFF", border: "#FFFFFF", accent: "#0047AB", text: "#000000" },
    { name: "Cyber-Goth", bg: "#0c001a", panel: "#1c0032", border: "#ff00ff", accent: "#00ffff", text: "#ffffff", premium: true },
    { name: "Tokyo Drift", bg: "#000b1a", panel: "#001a33", border: "#00ffff", accent: "#00ff00", text: "#ffffff", premium: true },
    { name: "Rose Gold Luxe", bg: "#1a0f0f", panel: "#2d1b1b", border: "#b76e79", accent: "#ffcfd2", text: "#ffffff", premium: true },
    { name: "Deep Space", bg: "#05000a", panel: "#0d011a", border: "#6a0dad", accent: "#9b30ff", text: "#ffffff", premium: true },
    { name: "Ocean Breeze", bg: "#001a1a", panel: "#002d2d", border: "#00ced1", accent: "#7fffd4", text: "#ffffff", premium: true },
    { name: "Blood Moon", bg: "#1a0000", panel: "#2d0000", border: "#8b0000", accent: "#ff0000", text: "#ffffff", premium: true }
];

const applyPreset = (theme) => {
    applyTheme({ ...theme, bgImage: '' });
    addSystemMessage(`Independent theme set to: ${theme.name}`);
};


function initThemeGallery() {
    if (!themesGrid) return;
    themesGrid.innerHTML = '';

    presets.forEach(theme => {
        const card = document.createElement('div');
        card.className = 'theme-card';
        card.dataset.theme = theme.name;

        card.innerHTML = `
            <div class="theme-card-title">${theme.name}</div>
            <div class="theme-card-palette">
                <div class="palette-strip" style="background: ${theme.bg};"></div>
                <div class="palette-strip" style="background: ${theme.panel};"></div>
                <div class="palette-strip" style="background: ${theme.border};"></div>
                <div class="palette-strip" style="background: ${theme.accent};"></div>
            </div>
        `;

        card.onclick = () => {
            applyPreset(theme);
            const cards = themesGrid.querySelectorAll('.theme-card');
            cards.forEach(c => c.classList.remove('active'));
            card.classList.add('active');
        };
        themesGrid.appendChild(card);
    });
}

initThemeGallery();

// --- Chat Logic ---

sendBtn.onclick = sendMessage;
chatInput.onkeypress = (e) => { if (e.key === 'Enter') sendMessage(); };

changeNameBtn.onclick = () => {
    const newName = showGuestNameModal(); // This will be async-ish via UI
};

function showGuestNameModal() {
    let modal = document.getElementById('guest-name-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'guest-name-modal';
        modal.innerHTML = `
            <div style="position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.8); display:flex; justify-content:center; align-items:center; z-index:9999;">
                <div style="background:var(--panel-bg); padding:20px; border:1px solid var(--border-color); width:300px; text-align:center;">
                    <h3 style="color:var(--accent-color); margin-top:0;">CHOOSE NAME</h3>
                    <input type="text" id="guest-name-input" placeholder="CoolGuest_99" style="width:100%; padding:10px; margin:10px 0; background:#000; color:#fff; border:1px solid #444;">
                    <button id="guest-name-submit" style="width:100%; background:var(--accent-color); border:none; padding:10px; cursor:pointer; font-weight:bold;">SET NAME</button>
                    <button id="guest-name-cancel" style="width:100%; background:transparent; border:1px solid #666; color:#aaa; padding:5px; margin-top:5px; cursor:pointer;">CANCEL</button>
                </div>
            </div>
        `;
        document.body.appendChild(modal);

        const close = () => modal.style.display = 'none';

        document.getElementById('guest-name-submit').onclick = () => {
            const input = document.getElementById('guest-name-input');
            const name = input.value.trim();
            if (name) {
                socket.emit('changeName', name);
                close();
            }
        };
        document.getElementById('guest-name-cancel').onclick = close;
    }
    modal.style.display = 'flex';
}

function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    // DJ commands
    if (isDJ) {
        if (text.startsWith('/play ')) {
            const url = text.replace('/play ', '');
            widget.load(url, {
                auto_play: true,
                callback: () => widget.setVolume(volume)
            });
            // BROADCAST THE CHANGE
            socket.emit('djUpdate', { currentTrack: url, isPlaying: true, seekPosition: 0 });
            chatInput.value = '';
            return;
        }
    }

    const msgData = {
        userName: currentUser ? currentUser.username : 'Guest',
        text,
        badge: currentUser ? currentUser.badge : null,
        nameStyle: currentUser ? currentUser.nameStyle : null,
        status: currentUser ? currentUser.status : null,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        localEcho: true // Mark as optimistic
    };

    // Instant local render (Optimistic UI)
    renderMessage(msgData);
    chatInput.value = '';

    socket.emit('sendMessage', msgData);
}

socket.on('newMessage', (msg) => {
    // If we're the sender, we've already rendered this (optimistic update)
    if (currentUser && msg.userName === currentUser.username && !msg.isSystem) {
        // Find and remove the "loading/echo" styling if any, or just skip
        return;
    }
    renderMessage(msg);
});

function renderMessage(msg) {
    requestAnimationFrame(() => {
        const msgDiv = document.createElement('div');
        msgDiv.className = `msg ${msg.isSystem ? 'system' : ''}`;

        // Add PFP to chat message if not a system message
        const pfpHtml = msg.isSystem ? '' : `<img src="${msg.badge || 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6JnB0X2lkPWdpcGh5X2dpZl9zZWFyY2gmZXA9djFfZ2lmX3NlYXJjaCZyaWQ9Z2lwaHkuZ2lmJmN0PWc/3o7TKMGpxPAb3NGoPC/giphy.gif'}" class="chat-pfp" />`;

        msgDiv.innerHTML = `
            ${pfpHtml}
            <div class="msg-content">
                <span class="time">[${msg.timestamp}]</span> 
                <span class="name ${msg.nameStyle || ''}">${msg.userName}${msg.userName === 'mayne' ? ' <span class="creator-tag">[SERVER CREATOR]</span>' : ''}${msg.userName === 'kaid' ? ' <span class="co-owner-tag">[CO-OWNER]</span>' : ''}${msg.userName === 'mummy' ? ' <span class="co-admin-tag">[CO-ADMIN]</span>' : ''}:</span> 
                ${msg.status ? `<span class="chat-status">[${msg.status}]</span>` : ''}
                <span class="text">${msg.text}</span>
            </div>
        `;
        chatMessages.appendChild(msgDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    });
}

function addSystemMessage(text) {
    const msg = {
        userName: 'SYSTEM',
        text: text,
        timestamp: new Date().toLocaleTimeString(),
        isSystem: true
    };
    renderMessage(msg);
}

// --- DJ Control logic ---

// --- Auth UI Logic ---

const showModal = (modal) => {
    if (!modalOverlay || !modal) return;
    modalOverlay.style.display = 'flex';
    if (loginModal) loginModal.style.display = 'none';
    if (registerModal) registerModal.style.display = 'none';
    if (settingsModal) settingsModal.style.display = 'none';
    modal.style.display = 'block';
};

const closeModal = () => {
    if (modalOverlay) modalOverlay.style.display = 'none';
};

if (loginNavBtn) {
    loginNavBtn.onclick = () => {
        if (!currentUser) showModal(loginModal);
    };
}

if (logoutNavBtn) {
    logoutNavBtn.onclick = () => {
        localStorage.removeItem('droom_token');
        location.reload();
    };
}

document.querySelectorAll('.close-modal').forEach(btn => btn.onclick = closeModal);

const showRegBtn = document.getElementById('show-register');
if (showRegBtn) {
    showRegBtn.onclick = () => showModal(registerModal);
}

// Login Submit
const loginSubmitBtn = document.getElementById('login-submit');
if (loginSubmitBtn) {
    loginSubmitBtn.onclick = async () => {
        const usernameEl = document.getElementById('login-user');
        const passwordEl = document.getElementById('login-pass');
        if (!usernameEl || !passwordEl) return;

        const username = usernameEl.value.trim();
        const password = passwordEl.value;

        try {
            socket.emit('login', { username, password }, (res) => {
                if (res.token) {
                    localStorage.setItem('droom_token', res.token);
                    socket.emit('authenticate', res.token);
                    closeModal();
                } else {
                    alert(res.error || 'Login failed');
                }
            });
        } catch (err) {
            alert('CRITICAL: Socket connection issue.');
        }
    };
}

// Register Submit
const regSubmitBtn = document.getElementById('reg-submit');
if (regSubmitBtn) {
    regSubmitBtn.onclick = async () => {
        const usernameEl = document.getElementById('reg-user');
        const passwordEl = document.getElementById('reg-pass');
        if (!usernameEl || !passwordEl) return;

        const username = usernameEl.value.trim();
        const password = passwordEl.value;

        if (!username || !password) {
            alert("Username and password required.");
            return;
        }

        const originalText = regSubmitBtn.textContent;
        regSubmitBtn.textContent = 'WORKING...';
        regSubmitBtn.disabled = true;

        socket.emit('register', { username, password }, (res) => {
            regSubmitBtn.textContent = originalText;
            regSubmitBtn.disabled = false;

            if (res.success) {
                alert(res.message);
                showModal(loginModal);
            } else {
                alert(res.error || 'Registration failed');
            }
        });
    };
}

// Repurposing change-name-btn for logged in users
changeNameBtn.onclick = () => {
    if (currentUser) {
        // Reset file input when opening
        document.getElementById('settings-pfp-file').value = '';
        nameStyleSelect.value = currentUser.nameStyle || '';
        if (statusInput) statusInput.value = currentUser.status || '';
        updatePremiumUI();
        showModal(settingsModal);
    } else {
        showGuestNameModal();
    }
};

// Settings Submit
const settingsSubmitBtn = document.getElementById('settings-submit');
if (settingsSubmitBtn) {
    settingsSubmitBtn.onclick = async () => {
        const fileInput = document.getElementById('settings-pfp-file');
        const nameStyle = nameStyleSelect.value;
        const status = statusInput ? statusInput.value.trim() : '';
        const password = document.getElementById('settings-pass').value;

        // Check if selecting premium without pack
        if (nameStyle && ['name-gold', 'name-matrix', 'name-ghost', 'name-rainbow-v2', 'name-cherry-blossom'].includes(nameStyle) && !currentUser.hasPremiumPack) {
            return alert("💎 ACCESS DENIED: High-tier styles require the PREMIUM PACK.");
        }

        // Check if selecting Demon's Eyes without being mayne
        if (nameStyle === 'name-demon-eyes' && currentUser.username !== 'mayne') {
            return alert("👿 ACCESS DENIED: This style is for the SERVER OWNER only.");
        }

        // Exclusive Co-Owner Style validation
        if (nameStyle === 'name-co-owner-luck' && currentUser.username !== 'kaid') {
            alert("This style is exclusive to the Co-Owner!");
            return;
        }

        // Hell & Bone Mythic Validation
        if (nameStyle === 'name-hell-bone' && !currentUser.hasHellBoneStyle && !['mayne', 'kaid'].includes(currentUser.username)) {
            alert("💀 THIS STYLE IS RESERVED FOR HELL & BONE OWNERS. PLEASE VISIT THE MYTHIC SHOP.");
            return;
        }

        if (nameStyle === 'name-mummy-exclusive' && currentUser.username !== 'mummy') {
            alert("🚨 THIS STYLE IS RESERVED FOR CO-ADMIN (mummy)!");
            return;
        }

        const originalText = settingsSubmitBtn.textContent;
        settingsSubmitBtn.textContent = 'SAVING...';
        settingsSubmitBtn.disabled = true;

        let badge = null;
        if (fileInput.files && fileInput.files[0]) {
            const file = fileInput.files[0];
            badge = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = (e) => resolve(e.target.result);
                reader.readAsDataURL(file);
            });
        }

        const payload = { token: currentUser.token, password, nameStyle, status };
        if (badge) payload.badge = badge;

        socket.emit('updateProfile', payload, (res) => {
            settingsSubmitBtn.textContent = originalText;
            settingsSubmitBtn.disabled = false;

            if (res.success) {
                currentUser = { ...res.user, token: currentUser.token };
                addSystemMessage("Profile updated successfully!");
                closeModal();
            } else {
                alert(res.error || 'Update failed');
            }
        });
    };
}

// Real-Time Status Updates (v2.0)
if (statusInput) {
    statusInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const status = statusInput.value.trim();
            socket.emit('updateProfile', { token: currentUser.token, status });
            addSystemMessage("Status updated!");
        }
    });

    statusInput.addEventListener('blur', () => {
        if (currentUser && statusInput.value.trim() !== (currentUser.status || '')) {
            const status = statusInput.value.trim();
            socket.emit('updateProfile', { token: currentUser.token, status });
        }
    });
}

if (nameStyleSelect) {
    nameStyleSelect.onchange = () => {
        const nameStyle = nameStyleSelect.value;
        // Basic validation for premium styles (already handled in submit but good for real-time too)
        if (nameStyle && ['name-gold', 'name-matrix', 'name-ghost', 'name-rainbow-v2', 'name-cherry-blossom'].includes(nameStyle) && !currentUser.hasPremiumPack) {
            return alert("💎 PREMIUM PACK REQUIRED");
        }
        socket.emit('updateProfile', { token: currentUser.token, nameStyle });
        addSystemMessage("Style updated!");
    };
}

if (claimPremiumBtn) {
    claimPremiumBtn.onclick = async () => {
        const originalText = claimPremiumBtn.textContent;
        claimPremiumBtn.textContent = 'LOADING...';

        socket.emit('unlockPremium', { token: currentUser.token }, (res) => {
            if (res.success) {
                currentUser.hasPremiumPack = true;
                updatePremiumUI();
                alert("👑 PREMIUM PACK UNLOCKED! Enjoy your new styles.");
            } else {
                claimPremiumBtn.textContent = originalText;
                alert(res.error || "Failed to unlock premium.");
            }
        });
    };
}



function updatePremiumUI() {
    if (!currentUser) return;

    const isPremium = currentUser.hasPremiumPack;
    const isCoOwner = currentUser.username === 'kaid';

    premiumShop.style.display = isPremium ? 'none' : 'block';

    // Manage dropdown options
    const premiumOptions = nameStyleSelect.querySelectorAll('option');
    premiumOptions.forEach(opt => {
        if (['name-gold', 'name-matrix', 'name-ghost', 'name-rainbow-v2', 'name-cherry-blossom'].includes(opt.value)) {
            if (isPremium) {
                opt.disabled = false;
                opt.textContent = opt.textContent.replace(' (PREMIUM)', '');
            } else {
                opt.disabled = true;
            }
        }

        // Exclusive Co-Owner style
        if (opt.value === 'name-co-owner-luck') {
            opt.style.display = isCoOwner ? 'block' : 'none';
        }

        // Exclusive Owner style (mayne)
        if (opt.value === 'name-demon-eyes') {
            opt.style.display = currentUser.username === 'mayne' ? 'block' : 'none';
        }

        // Exclusive Mummy style
        if (opt.value === 'name-mummy-exclusive') {
            opt.style.display = currentUser.username === 'mummy' ? 'block' : 'none';
        }
    });
}

// --- Social System Logic ---

tabProfileBtn.onclick = () => {
    tabProfileBtn.classList.add('active');
    tabSocialBtn.classList.remove('active');
    tabThemesBtn.classList.remove('active');
    tabAdminBtn.classList.remove('active');
    tabProfile.style.display = 'block';
    tabSocial.style.display = 'none';
    tabThemes.style.display = 'none';
    tabAdmin.style.display = 'none';
};

tabSocialBtn.onclick = () => {
    tabSocialBtn.classList.add('active');
    tabProfileBtn.classList.remove('active');
    tabThemesBtn.classList.remove('active');
    tabAdminBtn.classList.remove('active');
    tabProfile.style.display = 'none';
    tabSocial.style.display = 'block';
    tabThemes.style.display = 'none';
    tabAdmin.style.display = 'none';
    fetchFriends();
};

tabThemesBtn.onclick = () => {
    tabThemesBtn.classList.add('active');
    tabProfileBtn.classList.remove('active');
    tabSocialBtn.classList.remove('active');
    tabAdminBtn.classList.remove('active');
    tabProfile.style.display = 'none';
    tabSocial.style.display = 'none';
    tabThemes.style.display = 'block';
    tabAdmin.style.display = 'none';
    initThemeGallery();
};

sendFriendRequestBtn.onclick = async () => {
    const targetUsername = friendUsernameInput.value.trim();
    if (!targetUsername || !currentUser) return;

    socket.emit('sendFriendRequest', { token: currentUser.token, targetUsername }, (res) => {
        if (res.success) {
            alert("Request sent to " + targetUsername);
            friendUsernameInput.value = '';
        } else {
            alert(res.error || "Failed to send request");
        }
    });
};

async function fetchFriends() {
    if (!currentUser) return;
    socket.emit('getFriends', { token: currentUser.token }, (data) => {
        if (!data.error) {
            renderFriendsLists(data.friends, data.pending);
        }
    });
}

async function acceptFriend(requesterUsername) {
    if (!currentUser) return;
    socket.emit('acceptFriend', { token: currentUser.token, requesterUsername }, (res) => {
        if (res.success) {
            fetchFriends();
        }
    });
}
window.acceptFriend = acceptFriend;

function renderFriendsLists(friends, pending) {
    requestAnimationFrame(() => {
        // Render Modal Pending
        if (pendingRequestsList) {
            pendingRequestsList.innerHTML = pending.length ? '' : '<div style="color: #666; padding: 5px;">NO PENDING REQUESTS</div>';
            pending.forEach(req => {
                const div = document.createElement('div');
                div.className = 'pending-item';
                div.innerHTML = `
                    <span>${req}</span>
                    <button onclick="acceptFriend('${req}')">ACCEPT</button>
                `;
                pendingRequestsList.appendChild(div);
            });
        }

        // Render Modal Friends
        if (friendsListModal) {
            friendsListModal.innerHTML = friends.length ? '' : '<div style="color: #666; padding: 5px;">NO FRIENDS YET</div>';
            friends.forEach(f => {
                const div = document.createElement('div');
                div.className = 'modal-friend-item';
                div.innerHTML = `
                    <div style="display:flex; align-items:center; gap:5px;">
                        <img src="${f.badge}" style="width:20px; height:20px; border-radius:50%;" />
                        <span class="${f.nameStyle}">${f.username}</span>
                        <span style="font-size:0.5rem; color:${f.isOnline ? '#0f0' : '#555'}">[${f.isOnline ? 'ONLINE' : 'OFFLINE'}]</span>
                    </div>
                `;
                friendsListModal.appendChild(div);
            });
        }

        // Update Top Friends Grid (Sidebar)
        if (topFriendsGrid) {
            topFriendsGrid.innerHTML = friends.length ? '' : '<div style="grid-column: span 3; text-align: center; font-size: 0.6rem; color: #666; padding: 10px;">ADD FRIENDS IN SETTINGS</div>';
            friends.slice(0, 9).forEach(f => {
                const name = typeof f === 'string' ? f : (f.username || 'Unknown');
                const badge = typeof f === 'string' ? 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif' : (f.badge || 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/L88y6SAsjGvNmsC4Eq/giphy.gif');
                const style = typeof f === 'string' ? '' : (f.nameStyle || '');

                const div = document.createElement('div');
                div.className = 'friend-item';
                div.innerHTML = `
                    <img src="${badge}" class="friend-pfp" />
                    <span class="${style}">${name}</span>
                `;
                topFriendsGrid.appendChild(div);
            });
        }
    });
}

// --- Admin System Logic ---

if (tabAdminBtn) {
    tabAdminBtn.onclick = () => {
        tabAdminBtn.classList.add('active');
        if (tabProfileBtn) tabProfileBtn.classList.remove('active');
        if (tabSocialBtn) tabSocialBtn.classList.remove('active');
        if (tabProfile) tabProfile.style.display = 'none';
        if (tabSocial) tabSocial.style.display = 'none';
        if (tabAdmin) tabAdmin.style.display = 'block';
        updateAdminUI();
    };
}

function updateAdminUI() {
    if (!currentUser || currentUser.username !== 'mayne' || !adminUserList) return;

    requestAnimationFrame(() => {
        adminUserList.innerHTML = '';
        Object.values(currentRoomState.users || {}).forEach(u => {
            if (u.id === myId) return;
            const div = document.createElement('div');
            div.className = 'admin-client-item';
            div.innerHTML = `
                <span>${u.name} (${u.id.substring(0, 5)}...)</span>
                <button class="kick-btn" onclick="adminKick('${u.id}')">KICK</button>
            `;
            adminUserList.appendChild(div);
        });
    });
}

async function adminKick(targetSocketId) {
    if (!currentUser) return;
    socket.emit('adminKick', { token: currentUser.token, targetSocketId }, (res) => {
        if (!res.success) alert(res.error);
    });
}
window.adminKick = adminKick;

if (adminAnnSetBtn) {
    adminAnnSetBtn.onclick = async () => {
        const text = adminAnnInput.value.trim();
        if (!text || !currentUser) return;
        socket.emit('adminAnnouncement', { token: currentUser.token, text }, (res) => {
            if (res.success) adminAnnInput.value = '';
            else alert(res.error);
        });
    };
}

if (adminAnnClearBtn) {
    adminAnnClearBtn.onclick = async () => {
        if (!currentUser) return;
        socket.emit('adminAnnouncement', { token: currentUser.token, text: null }, (res) => {
            if (!res.success) alert(res.error);
        });
    };
}

function renderAnnouncement(text) {
    if (!announcementBanner) return;
    requestAnimationFrame(() => {
        if (text) {
            announcementBanner.textContent = `*** ATTENTION: ${text} ***`;
            announcementBanner.style.display = 'block';
        } else {
            announcementBanner.style.display = 'none';
        }
    });
}

if (adminClearChatBtn) {
    adminClearChatBtn.onclick = async () => {
        if (confirm("NUKE ALL CHAT MESSAGES?")) {
            socket.emit('adminClearChat', { token: currentUser.token }, (res) => {
                if (!res.success) alert(res.error);
            });
        }
    };
}

adminResetDjBtn.onclick = () => {
    if (confirm("RESET THE DJ BOOTH? This will remove the current DJ.")) {
        socket.emit('adminResetDj', { token: currentUser.token }, (res) => {
            if (!res.success) alert(res.error);
        });
    }
};

const copyInviteBtn = document.getElementById('copy-invite-btn');
if (copyInviteBtn) {
    copyInviteBtn.onclick = () => {
        const url = window.location.href;
        navigator.clipboard.writeText(url).then(() => {
            const originalText = copyInviteBtn.textContent;
            copyInviteBtn.textContent = 'COPIED!';
            copyInviteBtn.style.color = '#fff';
            setTimeout(() => {
                copyInviteBtn.textContent = originalText;
                copyInviteBtn.style.color = '#0f0';
            }, 2000);
        }).catch(err => {
            console.error('Failed to copy: ', err);
            alert("Copy failed. Please copy the URL manually.");
        });
    };
}

loadTrackBtn.onclick = () => {
    const url = trackUrlInput.value.trim();
    if (url && isDJ) {
        widget.load(url, {
            auto_play: true,
            callback: () => {
                widget.setVolume(volume);
                // Instant update for the room
                emitDJUpdate();
                // Surge heartbeat for faster room catching
                for (let i = 1; i <= 3; i++) {
                    setTimeout(emitDJUpdate, i * 800);
                }
            }
        });
        trackUrlInput.value = '';
    }
};

claimDjBtn.onclick = () => {
    socket.emit('requestDJ');
};

function emitDJUpdate() {
    if (!isDJ || !widget) return;

    widget.isPaused((paused) => {
        widget.getPosition((pos) => {
            widget.getCurrentSound((sound) => {
                const title = sound ? sound.title : currentRoomState.currentTrack;
                socket.emit('djUpdate', {
                    currentTrack: sound ? sound.permalink_url : currentRoomState.currentTrack,
                    trackTitle: title,
                    isPlaying: !paused,
                    seekPosition: pos,
                    currentTheme: currentRoomState.currentTheme
                });
                if (sound) currentTrackLabel.textContent = title;
            });
        });
    });
}

function syncWithDJ(state) {
    if (syncLock || !state.currentTrack || !widget) return;
    syncLock = true;

    const serverNow = Date.now() - serverTimeOffset;
    const targetPos = state.isPlaying ? (serverNow - state.startedAt) : state.pausedAt;

    widget.getCurrentSound((sound) => {
        const soundUrl = sound ? sound.permalink_url : null;

        if (soundUrl !== state.currentTrack) {
            widget.load(state.currentTrack, {
                auto_play: state.isPlaying,
                callback: () => {
                    widget.setVolume(volume);
                    if (state.isPlaying) {
                        widget.seekTo(targetPos);
                        widget.play();
                        setTimeout(() => checkAutoplay(state.isPlaying), 1000);
                    }
                    syncLock = false;
                }
            });
        } else {
            widget.isPaused((paused) => {
                if (state.isPlaying && paused) {
                    widget.play();
                    setTimeout(() => checkAutoplay(true), 1000);
                } else if (!state.isPlaying && !paused) {
                    widget.pause();
                }

                widget.getPosition((currentPos) => {
                    const drift = Math.abs(currentPos - targetPos);
                    if (state.isPlaying && drift > 1500) {
                        widget.seekTo(targetPos);
                    }
                    syncLock = false;
                });
            });
        }
    });
}


function checkAutoplay(shouldBePlaying) {
    widget.isPaused((paused) => {
        if (paused && shouldBePlaying) {
            console.warn('[AUDIO] Playback blocked by browser policy.');
            if (audioUnlockOverlay) audioUnlockOverlay.style.display = 'flex';
        }
    });
}


// --- Widget Event Listeners (For DJ and Sync Enforcement) ---

widget.bind(SC.Widget.Events.READY, () => {
    widget.setVolume(volume); // Ensure volume is applied on ready

    // DJ Bindings: Instant Event-Driven Broadcasts
    widget.bind(SC.Widget.Events.PLAY, () => {
        if (isDJ) {
            emitDJUpdate();
        } else {
            // Enforcement: If listener tries to play, verify if they should be playing
            if (currentRoomState.isPlaying) {
                // Already playing, just let it be or snap to target
                syncWithDJ(currentRoomState);
            } else {
                // Room is paused, listener MUST stay paused
                widget.pause();
            }
        }
    });

    widget.bind(SC.Widget.Events.PAUSE, () => {
        if (isDJ) {
            emitDJUpdate();
        } else {
            // Bulletproof Enforcement: If room is playing, don't let listeners pause!
            if (currentRoomState.isPlaying) {
                widget.play();
                syncWithDJ(currentRoomState);
            }
        }
    });

    widget.bind(SC.Widget.Events.FINISH, () => {
        if (isDJ) {
            emitDJUpdate();
        }
    });

    widget.bind(SC.Widget.Events.SEEK, () => {
        if (isDJ) {
            emitDJUpdate();
        } else {
            // Bulletproof Enforcement: If listener tries to seek, snap them back to DJ
            syncWithDJ(currentRoomState);
        }
    });

    // Still keep a low-frequency pulse for drift correction
    setInterval(() => {
        if (isDJ) emitDJUpdate();
    }, 5000);
});

function updateUI() {
    requestAnimationFrame(() => {
        isDJ = (myId === currentRoomState.djId);
        claimDjBtn.style.display = currentRoomState.djId ? 'none' : 'block';
        djToolset.style.display = isDJ ? 'flex' : 'none';
        if (currentRoomState.djId) {
            djStatus.textContent = `DJ: ${currentRoomState.djUsername || 'CONNECTED'}`;
        }
    });
}

// --- Voice UI Logic ---
if (voiceJoinBtn) {
    voiceJoinBtn.onclick = async () => {
        const savedDeviceId = localStorage.getItem('preferredVoiceDeviceId');
        const success = await voiceManager.join(savedDeviceId);
        if (success) {
            voiceJoinBtn.style.display = 'none';
            voiceLeaveBtn.style.display = 'block';
            voiceControlsExtra.style.display = 'flex';
            addSystemMessage("Connecting to Voice Channel...");
            updateDeviceList();
        }
    };
}

async function updateDeviceList() {
    if (!voiceInputSelect) return;

    const devices = await voiceManager.getAudioDevices();
    const savedDeviceId = localStorage.getItem('preferredVoiceDeviceId');

    voiceInputSelect.innerHTML = '';

    if (devices.length === 0) {
        const opt = document.createElement('option');
        opt.value = "";
        opt.textContent = "NO MICROPHONES FOUND";
        voiceInputSelect.appendChild(opt);
        return;
    }

    devices.forEach(device => {
        const opt = document.createElement('option');
        opt.value = device.deviceId;
        opt.textContent = device.label || `Microphone ${voiceInputSelect.length + 1}`;
        if (device.deviceId === savedDeviceId) {
            opt.selected = true;
        }
        voiceInputSelect.appendChild(opt);
    });
}

if (voiceInputSelect) {
    voiceInputSelect.onchange = async () => {
        const deviceId = voiceInputSelect.value;
        if (deviceId) {
            const success = await voiceManager.setAudioInput(deviceId);
            if (success) {
                localStorage.setItem('preferredVoiceDeviceId', deviceId);
                addSystemMessage("Voice input switched.");
            }
        }
    };
}

if (voiceLeaveBtn) {
    voiceLeaveBtn.onclick = () => {
        voiceManager.leave();
        voiceJoinBtn.style.display = 'block';
        voiceLeaveBtn.style.display = 'none';
        voiceControlsExtra.style.display = 'none';
        addSystemMessage("Disconnected from Voice Channel.");
    };
}

if (voiceMuteBtn) {
    voiceMuteBtn.onclick = () => {
        const muted = voiceManager.toggleMute();
        voiceMuteBtn.classList.toggle('active', muted);
        voiceMuteBtn.textContent = muted ? '🔇' : '🎤';
    };
}

if (voiceDeafenBtn) {
    voiceDeafenBtn.onclick = () => {
        const deafened = voiceManager.toggleDeafen();
        voiceDeafenBtn.classList.toggle('active', deafened);
        voiceDeafenBtn.textContent = deafened ? '❌🎧' : '🎧';
    };
}

// Handle device unplugged/plugged
if (navigator.mediaDevices && navigator.mediaDevices.ondevicechange !== undefined) {
    navigator.mediaDevices.ondevicechange = () => {
        if (voiceManager.isJoined) updateDeviceList();
    };
}

window.updateVoiceUI = (voiceUsers) => {
    if (!voiceUsersContainer) return;
    requestAnimationFrame(() => {
        voiceUsersContainer.innerHTML = '';

        if (!voiceUsers || voiceUsers.length === 0) {
            voiceUsersContainer.innerHTML = '<div style="text-align: center; font-size: 0.6rem; color: #666; padding: 10px;">CHANNEL EMPTY</div>';
            return;
        }

        voiceUsers.forEach(vUser => {
            const avatar = vUser.badge || 'https://i.giphy.com/media/v1.Y2lkPTc5MGI3NjExNHRraWN0YXpwaHlsZzB2ZGR6YnJ4ZzR6NHRxZzR6NHRxZzR6JnB0X2lkPWdpcGh5X2dpZl9zZWFyY2gmZXA9djFfZ2lmX3NlYXJjaCZyaWQ9Z2lwaHkuZ2lmJmN0PWc/3o7TKMGpxPAb3NGoPC/giphy.gif';
            const nameStyle = vUser.nameStyle || '';

            const div = document.createElement('div');
            div.className = 'voice-user-item';
            div.innerHTML = `
                <img src="${avatar}" class="voice-user-avatar" />
                <div class="voice-user-info">
                    <span style="font-weight: bold;" class="${nameStyle}">${vUser.name}</span>
                </div>
                <div class="voice-status-icons">
                    ${vUser.muted ? '<span class="muted-icon">🔇</span>' : ''}
                    ${vUser.deafened ? '<span class="deafened-icon">🎧❌</span>' : ''}
                </div>
            `;
            voiceUsersContainer.appendChild(div);
        });
    });
};

// Initial UI Setup
function initUI() {
    // Hide guest-specific UI elements if any exist
    const guestPfp = document.getElementById('guest-pfp-preview');
    if (guestPfp) {
        guestPfp.style.display = 'none';
        guestPfp.parentNode.removeChild(guestPfp); // Remove it entirely
    }
    const userDisplay = document.getElementById('user-display');
    if (userDisplay && userDisplay.textContent.includes('Guest')) {
        userDisplay.textContent = 'Awaiting Login...';
    }

    // Hide theme controls by default
    if (tabThemesBtn) tabThemesBtn.style.display = 'none';
    const themeEngine = document.getElementById('theme-engine');
    const themeBoxHeader = themeEngine?.previousElementSibling;
    if (themeEngine) themeEngine.style.display = 'none';
    if (themeBoxHeader) themeBoxHeader.style.display = 'none';
}
initUI();

// --- TheChatBox Logic ---

function toggleChatbox() {
    chatboxVisible = !chatboxVisible;
    theChatbox.style.display = chatboxVisible ? 'flex' : 'none';
    if (chatboxVisible) {
        updateChatboxUI();
        chatboxGlobalBadge.style.display = 'none';
        chatboxGlobalBadge.textContent = '0';

        // Reset unread for current target if open
        if (currentDMTarget) {
            unreadCounts[currentDMTarget] = 0;
            updateChatboxUI();
        }
    }
}

chatboxTrigger.onclick = toggleChatbox;
chatboxClose.onclick = toggleChatbox;

function openPrivateChat(username) {
    if (!currentUser) return;
    if (username === currentUser.username) return; // Can't chat with self

    currentDMTarget = username;
    if (!activeDMs[username]) activeDMs[username] = [];
    unreadCounts[username] = 0;

    chatboxVisible = true;
    theChatbox.style.display = 'flex';
    chatboxTargetName.textContent = `CHAT WITH: ${username}`;
    chatboxInput.disabled = false;
    chatboxSend.disabled = false;

    updateChatboxUI();
    chatboxInput.focus();
}

function updateChatboxUI() {
    if (!chatboxContactsList || !theChatboxMessages) return;

    requestAnimationFrame(() => {
        // Render Contacts
        const names = Object.keys(activeDMs);
        chatboxContactsList.innerHTML = names.length ? '' : '<div style="padding: 10px; font-size: 0.6rem; color: #666;">NO ACTIVE CHATS</div>';

        names.forEach(name => {
            const unread = unreadCounts[name] || 0;
            const div = document.createElement('div');
            div.className = `chatbox-contact-item ${name === currentDMTarget ? 'active' : ''}`;
            div.innerHTML = `
                <span>${name}</span>
                ${unread > 0 ? `<span class="contact-badge">${unread}</span>` : ''}
            `;
            div.onclick = (e) => {
                e.stopPropagation();
                openPrivateChat(name);
            };
            chatboxContactsList.appendChild(div);
        });

        // Render Messages for current target
        if (currentDMTarget) {
            theChatboxMessages.innerHTML = '';
            const msgs = activeDMs[currentDMTarget] || [];
            msgs.forEach(m => {
                const isSent = m.from === currentUser.username;
                const div = document.createElement('div');
                div.className = `dm-msg ${isSent ? 'sent' : 'received'}`;
                div.innerHTML = `
                    <div class="dm-text">${m.text}</div>
                    <span class="dm-time">${m.timestamp}</span>
                `;
                theChatboxMessages.appendChild(div);
            });
            theChatboxMessages.scrollTop = theChatboxMessages.scrollHeight;
        }
    });
}

chatboxSend.onclick = sendPrivateMessage;
chatboxInput.onkeypress = (e) => { if (e.key === 'Enter') sendPrivateMessage(); };

function sendPrivateMessage() {
    const text = chatboxInput.value.trim();
    if (!text || !currentDMTarget) return;

    socket.emit('privateMessage', { targetName: currentDMTarget, text: text });
    chatboxInput.value = '';
}

socket.on('privateMessage', (msg) => {
    // Determine who the "other" person is
    const isMe = (currentUser && msg.from === currentUser.username);
    const other = isMe ? msg.to : msg.from;

    if (!activeDMs[other]) activeDMs[other] = [];
    activeDMs[other].push(msg);

    if (!isMe && (!chatboxVisible || currentDMTarget !== other)) {
        unreadCounts[other] = (unreadCounts[other] || 0) + 1;

        // Update global badge
        const totalUnread = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
        if (totalUnread > 0) {
            chatboxGlobalBadge.textContent = totalUnread;
            chatboxGlobalBadge.style.display = 'block';
        }
    }

    if (chatboxVisible) {
        updateChatboxUI();
    }
});

// --- Multi-Stream UI Integration (v2.0) ---

const streamsGrid = document.getElementById('streams-grid');
const streamCountBadge = document.getElementById('stream-count-badge');
const streamsDirectory = document.getElementById('streams-directory');

window.onStreamsUpdate = (activeStreams) => {
    currentRoomState.activeStreams = activeStreams || [];
    if (streamCountBadge) streamCountBadge.textContent = `${currentRoomState.activeStreams.length}/10`;

    // Toggle overall viewport - SHOW if anyone is live, OR if I am broadcasting
    const hasActiveSignals = currentRoomState.activeStreams.length > 0;
    const isBroadcasting = streamManager.isStreaming;

    if (streamViewport) {
        streamViewport.style.display = (hasActiveSignals || isBroadcasting) ? 'block' : 'none';
    }

    // Populate Stream Directory
    if (streamsDirectory) {
        if (currentRoomState.activeStreams.length === 0) {
            streamsDirectory.innerHTML = '<div style="text-align: center; font-size: 0.6rem; color: #666; padding: 10px;">NO ACTIVE STREAMS</div>';
        } else {
            streamsDirectory.innerHTML = '';
            currentRoomState.activeStreams.forEach(s => {
                const div = document.createElement('div');
                div.className = 'user-item';
                div.style = 'justify-content: space-between; padding: 5px 8px; border-bottom: 1px solid rgba(255,255,255,0.05);';

                const isWatching = !!streamManager.watchedStreams[s.streamerId];
                const isMe = s.streamerId === myId;

                div.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 8px; overflow: hidden;">
                        <span class="blinker" style="color: #ff0055; font-size: 0.8rem;">●</span>
                        <span style="font-size: 0.7rem; color: #fff; text-overflow: ellipsis; white-space: nowrap; overflow: hidden;">${s.streamerName}</span>
                    </div>
                    <div style="display: flex; gap: 4px;">
                        ${isMe ?
                        '<span style="font-size: 0.5rem; color: #ff0055; border: 1px solid #ff0055; padding: 1px 4px;">YOU</span>' :
                        `<button onclick="toggleStreamSelector()"
                                style="background: #ff0055; color: white; border: none; font-size: 0.5rem; padding: 2px 6px; cursor: pointer; min-width: 45px;">
                                WATCH
                            </button>`
                    }
                    </div>
                `;
                streamsDirectory.appendChild(div);
            });
        }
    }

    if (streamSelectorModal && streamSelectorModal.style.display === 'flex') {
        updateStreamSelectorUI();
    }

    renderUserList();
};

window.toggleStreamSelector = (show = null) => {
    if (!streamSelectorModal) return;
    const isShowing = show !== null ? show : streamSelectorModal.style.display === 'none';
    streamSelectorModal.style.display = isShowing ? 'flex' : 'none';
    if (isShowing) updateStreamSelectorUI();
};

function updateStreamSelectorUI() {
    if (!streamSelectorList) return;

    if (currentRoomState.activeStreams.length === 0) {
        streamSelectorList.innerHTML = `
            <div style="text-align: center; color: #ff0055; font-size: 0.8rem; padding: 30px; border: 1px dashed rgba(255, 0, 85, 0.3); border-radius: 8px;">
                <span class="blinker">●</span> NO ACTIVE SIGNALS DETECTED
            </div>
        `;
        return;
    }

    streamSelectorList.innerHTML = '';
    currentRoomState.activeStreams.forEach(s => {
        const isWatching = !!streamManager.watchedStreams[s.streamerId];
        const isMe = s.streamerId === myId;

        const div = document.createElement('div');
        div.className = 'stream-selector-item';
        div.innerHTML = `
            <div class="stream-selector-info">
                <div class="streamer-avatar-mini" style="background: ${isMe ? '#ff0055' : '#111'};"></div>
                <div>
                   <div class="streamer-name-modal">${s.streamerName} ${isMe ? '(YOU)' : ''}</div>
                   <div style="font-size: 0.5rem; color: #ff0055;">1080P / 120 FPS / HIFi</div>
                </div>
            </div>
            ${isMe ?
                '<span style="font-size: 0.6rem; color: #ff0055; font-weight: bold;">BROADCASTING</span>' :
                `<button onclick="window.streamManager.${isWatching ? 'stopWatching' : 'joinStream'}('${s.streamerId}'); window.toggleStreamSelector(false);" 
                   class="stream-join-btn-premium ${isWatching ? 'stream-leave-btn-premium' : ''}">
                   ${isWatching ? 'LEAVE' : 'JOIN STREAM'}
                </button>`
            }
        `;
        streamSelectorList.appendChild(div);
    });
}

// Wire close buttons
closeStreamSelectorBtns.forEach(btn => {
    btn.onclick = () => toggleStreamSelector(false);
});

function renderUserList() {
    if (!usersContainer) return;
    usersContainer.innerHTML = '';
    Object.values(currentRoomState.users || {}).forEach(u => {
        const div = document.createElement('div');
        div.className = 'user-item';
        div.style = 'display: flex; align-items: center; padding: 5px; border-bottom: 1px solid rgba(255,255,255,0.05);';
        div.innerHTML = `
            <img src="${u.badge}" style="width: 20px; height: 20px; border-radius: 50%; border: 1px solid #ff00ff; margin-right: 8px;" />
            <span class="${u.nameStyle || ''}" style="font-size: 0.7rem; color: #fff;">${u.name}</span>
            ${u.isLive ? ' <span class="blinker" style="color: #ff0055; font-size: 0.6rem; margin-left: auto;">● LIVE</span>' : ''}
        `;
        usersContainer.appendChild(div);
    });
}

window.onRemoteStream = (stream, streamerId) => {
    if (!streamsGrid) return;

    let container = document.getElementById(`stream-card-${streamerId}`);
    if (!container) {
        container = document.createElement('div');
        container.id = `stream-card-${streamerId}`;
        container.className = 'stream-card';

        const streamerInfo = currentRoomState.activeStreams.find(s => s.streamerId === streamerId);
        let name = streamerInfo ? streamerInfo.streamerName : 'Unknown Streamer';
        if (streamerId === myId && currentUser) name = `YOU (${currentUser.username})`;

        container.innerHTML = `
            <div class="stream-card-header">
                <div style="display: flex; align-items: center; gap: 5px;">
                    <span class="stream-live-tag">LIVE</span>
                    <span class="streamer-name-tag">${name}</span>
                </div>
                <div class="stream-controls-top">
                    <button class="stream-ctrl-btn pip-btn" title="Picture-in-Picture">📺</button>
                    <button class="stream-ctrl-btn fs-btn" title="Full Screen">⛶</button>
                    <button class="stream-ctrl-btn theater-btn" title="Theater Mode">🎭</button>
                    <button class="stream-ctrl-btn close-stream-btn" onclick="streamManager.stopWatching('${streamerId}')" title="Stop Watching">X</button>
                </div>
            </div>
            <div class="video-container">
                <video autoplay playsinline ${streamerId === myId ? 'muted' : ''}></video>
            </div>
            <div class="stream-card-footer">
                 <div class="stream-vol-ctrl">
                     <span class="vol-icon">🔊</span>
                     <input type="range" class="stream-vol-slider" min="0" max="1" step="0.05" value="1">
                 </div>
            </div>
        `;
        streamsGrid.appendChild(container);

        const video = container.querySelector('video');
        const slider = container.querySelector('.stream-vol-slider');
        const theaterBtn = container.querySelector('.theater-btn');
        const pipBtn = container.querySelector('.pip-btn');
        const fsBtn = container.querySelector('.fs-btn');

        video.srcObject = stream;
        if (streamerId === myId) {
            video.muted = true;
            video.volume = 0;
            if (slider) slider.value = 0;
        }

        slider.oninput = (e) => {
            video.volume = e.target.value;
            if (streamerId === myId) video.muted = true; // Stay muted if it's me
        };

        // theater Mode Toggle
        theaterBtn.onclick = () => {
            container.classList.toggle('theater-mode');
            const isTheater = container.classList.contains('theater-mode');
            theaterBtn.textContent = isTheater ? '🖼️' : '🎭';
            if (isTheater) container.scrollIntoView({ behavior: 'smooth' });
        };

        // Picture-in-Picture
        pipBtn.onclick = async () => {
            try {
                if (document.pictureInPictureElement) await document.exitPictureInPicture();
                else await video.requestPictureInPicture();
            } catch (err) { console.error('[STREAM] PiP failed:', err); }
        };

        // Full Screen API
        fsBtn.onclick = () => {
            if (video.requestFullscreen) {
                video.requestFullscreen();
            } else if (video.webkitRequestFullscreen) { /* Safari */
                video.webkitRequestFullscreen();
            } else if (video.msRequestFullscreen) { /* IE11 */
                video.msRequestFullscreen();
            }
        };

        if (streamManager.watchedStreams[streamerId]) {
            streamManager.watchedStreams[streamerId].videoElement = container;
        }
    }
};

window.onLocalStream = (stream) => {
    if (stream) {
        // Just show a placeholder for yourself or a local preview
        setTimeout(() => window.onRemoteStream(stream, myId), 500);
    } else {
        // Cleanup local card
        const card = document.getElementById(`stream-card-${myId}`);
        if (card) card.remove();
    }
};

window.onStreamStop = (streamerId) => {
    const card = document.getElementById(`stream-card-${streamerId}`);
    if (card) card.remove();

    const hasStreams = Object.keys(streamManager.watchedStreams).length > 0;
    if (!hasStreams && !streamManager.isStreaming && streamViewport) {
        streamViewport.style.display = 'none';
    }
};

// Multi-Stream v2.0 Button Wiring
document.addEventListener('DOMContentLoaded', () => {
    const startBtn = document.getElementById('stream-start-btn');
    const stopBtn = document.getElementById('stream-stop-btn');
    const fpsToggle = document.getElementById('stream-120fps-toggle');

    if (startBtn) {
        startBtn.onclick = () => {
            const targetFPS = (fpsToggle && fpsToggle.checked) ? 120 : 60;
            streamManager.startShare(targetFPS);
        };
    }
    if (stopBtn) stopBtn.onclick = () => streamManager.stopShare();
});
