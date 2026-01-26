class VoiceManager {
    constructor(socket) {
        this.socket = socket;
        this.localStream = null;
        this.peers = {}; // socketId -> RTCPeerConnection
        this.isJoined = false;
        this.isMuted = false;
        this.isDeafened = false;

        this.setupSocketListeners();
    }

    setupSocketListeners() {
        this.socket.on('voice-peer-list', (peerIds) => {
            console.log('[VOICE] Initializing calls to peers:', peerIds);
            peerIds.forEach(id => this.initiateCall(id));
        });

        this.socket.on('voice-signal', async ({ from, signal }) => {
            if (!this.peers[from] && signal.type === 'offer') {
                this.createPeerConnection(from);
            }

            if (!this.peers[from]) return;

            if (signal.type === 'offer' || signal.type === 'answer') {
                try {
                    await this.peers[from].setRemoteDescription(new RTCSessionDescription(signal));
                    if (signal.type === 'offer') {
                        const answer = await this.peers[from].createAnswer();
                        await this.peers[from].setLocalDescription(answer);
                        this.socket.emit('voice-signal', { to: from, signal: answer });
                    }
                } catch (err) {
                    console.error('[VOICE] SDP Error:', err);
                }
            } else if (signal.type === 'candidate' && signal.candidate) {
                try {
                    await this.peers[from].addIceCandidate(new RTCIceCandidate(signal.candidate));
                } catch (e) {
                    console.warn('[VOICE] ICE Candidate Error:', e);
                }
            }
        });

        this.socket.on('voice-update', (users) => {
            if (window.updateVoiceUI) window.updateVoiceUI(users);
        });
    }

    async getAudioDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.filter(d => d.kind === 'audioinput');
        } catch (e) {
            console.error('[VOICE] Failed to enumerate devices:', e);
            return [];
        }
    }

    async join(deviceId = null) {
        try {
            console.log('[VOICE] Requesting microphone access... DeviceId:', deviceId);
            const constraints = {
                audio: deviceId ? { deviceId: { exact: deviceId } } : true,
                video: false
            };
            this.localStream = await navigator.mediaDevices.getUserMedia(constraints);
            this.isJoined = true;
            this.socket.emit('voice-join');
            return true;
        } catch (err) {
            console.error('[VOICE] Access denied or error:', err);

            // If specific device failed, try default
            if (deviceId) {
                console.warn('[VOICE] Specific device failed, falling back to default...');
                return this.join(null);
            }

            alert("Microphone access is required for voice chat. Please check permissions.");
            return false;
        }
    }

    async setAudioInput(deviceId) {
        if (!this.isJoined) return;

        try {
            console.log('[VOICE] Switching audio input to:', deviceId);
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: { exact: deviceId } },
                video: false
            });

            const newTrack = newStream.getAudioTracks()[0];

            // Replace track for all peers
            for (const pc of Object.values(this.peers)) {
                const senders = pc.getSenders();
                const audioSender = senders.find(s => s.track && s.track.kind === 'audio');
                if (audioSender) {
                    await audioSender.replaceTrack(newTrack);
                }
            }

            // Stop old tracks
            if (this.localStream) {
                this.localStream.getTracks().forEach(track => track.stop());
            }

            this.localStream = newStream;

            // Re-apply mute state if needed
            if (this.isMuted) {
                this.localStream.getAudioTracks().forEach(track => track.enabled = false);
            }

            return true;
        } catch (e) {
            console.error('[VOICE] Failed to switch audio input:', e);
            alert("Failed to switch microphone. Make sure the device is connected.");
            return false;
        }
    }

    leave() {
        this.isJoined = false;
        this.socket.emit('voice-leave');
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        Object.keys(this.peers).forEach(id => {
            this.peers[id].close();
            delete this.peers[id];
        });
        if (window.updateVoiceUI) window.updateVoiceUI([]);
    }

    createPeerConnection(peerId) {
        console.log('[VOICE] Creating PeerConnection for:', peerId);
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('voice-signal', {
                    to: peerId,
                    signal: { type: 'candidate', candidate: event.candidate }
                });
            }
        };

        pc.ontrack = (event) => {
            console.log('[VOICE] Received remote track from:', peerId);
            const remoteAudio = new Audio();
            remoteAudio.srcObject = event.streams[0];
            remoteAudio.autoplay = true;
            if (this.isDeafened) remoteAudio.muted = true;
            this.peers[peerId].audioElement = remoteAudio;
        };

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
                console.log('[VOICE] Peer disconnected:', peerId);
                if (this.peers[peerId]) {
                    if (this.peers[peerId].audioElement) {
                        this.peers[peerId].audioElement.srcObject = null;
                        this.peers[peerId].audioElement.remove();
                    }
                    delete this.peers[peerId];
                }
            }
        };

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
        }

        this.peers[peerId] = pc;
        return pc;
    }

    async initiateCall(peerId) {
        const pc = this.createPeerConnection(peerId);
        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.socket.emit('voice-signal', { to: peerId, signal: offer });
        } catch (err) {
            console.error('[VOICE] Failed to create offer:', err);
        }
    }

    toggleMute() {
        this.isMuted = !this.isMuted;
        if (this.localStream) {
            this.localStream.getAudioTracks().forEach(track => track.enabled = !this.isMuted);
        }
        this.updateState();
        return this.isMuted;
    }

    toggleDeafen() {
        this.isDeafened = !this.isDeafened;
        Object.values(this.peers).forEach(peer => {
            if (peer.audioElement) peer.audioElement.muted = this.isDeafened;
        });
        this.updateState();
        return this.isDeafened;
    }

    updateState() {
        this.socket.emit('voice-state-update', {
            muted: this.isMuted,
            deafened: this.isDeafened
        });
    }
}

window.VoiceManager = VoiceManager;
