class StreamManager {
    constructor(socket) {
        this.socket = socket;
        this.localStream = null;
        this.peers = {}; // socketId -> RTCPeerConnection
        this.isStreaming = false;

        this.setupSocketListeners();
    }

    setupSocketListeners() {
        this.socket.on('stream-peer-join', (peerId) => {
            console.log('[STREAM] Join request from:', peerId);
            this.initiateCall(peerId);
        });

        this.socket.on('stream-signal', async ({ from, signal }) => {
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
                        this.socket.emit('stream-signal', { to: from, signal: answer });
                    }
                } catch (err) {
                    console.error('[STREAM] SDP Error:', err);
                }
            } else if (signal.type === 'candidate' && signal.candidate) {
                try {
                    await this.peers[from].addIceCandidate(new RTCIceCandidate(signal.candidate));
                } catch (e) {
                    console.warn('[STREAM] ICE Candidate Error:', e);
                }
            }
        });

        this.socket.on('stream-update', (streamInfo) => {
            if (window.updateStreamUI) window.updateStreamUI(streamInfo);
        });
    }

    async startShare() {
        try {
            console.log('[STREAM] Requesting screen share... (1440p constraints)');
            // Optimized constraints for 1080p Clarity
            const constraints = {
                video: {
                    width: { ideal: 1920, max: 1920 },
                    height: { ideal: 1080, max: 1080 },
                    frameRate: { ideal: 60, max: 60 }
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: false
                }
            };

            this.localStream = await navigator.mediaDevices.getDisplayMedia(constraints);

            // Hardened 60FPS: Apply constraints again after acquisition to ensure browser prioritizes fluency
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                console.log('[STREAM] Hardening 60FPS constraints...');
                try {
                    await videoTrack.applyConstraints({
                        frameRate: { ideal: 60 }
                    });
                } catch (e) {
                    console.warn('[STREAM] Failed to apply 60FPS constraint post-capture:', e);
                }

                // Critical Fix: Force "detail" hint to prevent blurriness during motion
                if ('contentHint' in videoTrack) {
                    videoTrack.contentHint = 'detail';
                }
            }

            this.isStreaming = true;
            this.socket.emit('stream-start');

            // Handle track ending via browser UI
            this.localStream.getVideoTracks()[0].onended = () => this.stopShare();

            // Local preview
            if (window.onLocalStream) window.onLocalStream(this.localStream);

            return true;
        } catch (err) {
            console.error('[STREAM] Share failed:', err);
            return false;
        }
    }

    stopShare() {
        if (!this.isStreaming) return;
        this.isStreaming = false;
        this.socket.emit('stream-stop');
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        Object.keys(this.peers).forEach(id => {
            this.peers[id].close();
            delete this.peers[id];
        });
        if (window.updateStreamUI) window.updateStreamUI(null);
    }

    joinStream() {
        this.socket.emit('stream-join');
    }

    leaveStream() {
        Object.keys(this.peers).forEach(id => {
            this.peers[id].close();
            delete this.peers[id];
        });
        if (window.updateStreamUI) window.updateStreamUI(null, true);
    }

    createPeerConnection(peerId) {
        console.log('[STREAM] Creating PeerConnection for:', peerId);
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('stream-signal', {
                    to: peerId,
                    signal: { type: 'candidate', candidate: event.candidate }
                });
            }
        };

        pc.ontrack = (event) => {
            console.log('[STREAM] Received remote track from:', peerId);
            if (window.onRemoteStream) window.onRemoteStream(event.streams[0]);
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
            let offer = await pc.createOffer();

            // Bitrate Hack: Modify SDP to force 8Mbps
            if (offer.sdp) {
                offer = new RTCSessionDescription({
                    type: offer.type,
                    sdp: this.setBitrate(offer.sdp, 8000)
                });
            }

            await pc.setLocalDescription(offer);
            this.socket.emit('stream-signal', { to: peerId, signal: offer });
        } catch (err) {
            console.error('[STREAM] Failed to create offer:', err);
        }
    }

    setBitrate(sdp, bitrate) {
        const lines = sdp.split('\n');
        let lineIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('m=video') === 0) {
                lineIndex = i;
                break;
            }
        }
        if (lineIndex === -1) return sdp;

        // Skip to next m line or end of sdp
        lineIndex++;
        while (lineIndex < lines.length && lines[lineIndex].indexOf('m=') === -1) {
            if (lines[lineIndex].indexOf('c=') === 0) {
                // Insert b=AS after c= line
                lines.splice(lineIndex + 1, 0, 'b=AS:' + bitrate);
                return lines.join('\n');
            }
            lineIndex++;
        }
        return sdp;
    }
}

window.StreamManager = StreamManager;
