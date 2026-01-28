class StreamManager {
    constructor(socket) {
        this.socket = socket;
        this.localStream = null;
        this.broadcasterPeers = {}; // socketId -> RTCPeerConnection (when broadcasting)
        this.watchedStreams = {}; // streamerId -> { pc: RTCPeerConnection, videoElement: HTMLVideoElement }
        this.isStreaming = false;

        this.setupSocketListeners();
    }

    setupSocketListeners() {
        this.socket.on('stream-peer-join', (peerId) => {
            console.log('[STREAM] Join request from:', peerId);
            this.initiateCall(peerId);
        });

        this.socket.on('stream-signal', async ({ from, signal, streamerId }) => {
            if (!streamerId) return;
            console.log(`[STREAM] Signal from ${from}, type: ${signal?.type}, streamerId: ${streamerId}`);

            // Case 1: Signal is for a stream I am BROADCASTING (from a viewer to me)
            if (streamerId === this.socket.id) {
                const pc = this.broadcasterPeers[from];
                if (pc) await this.handleSDP(pc, from, signal, streamerId);
            }
            // Case 2: Signal is for a stream I am WATCHING (from a broadcaster to me)
            else {
                if (!this.watchedStreams[streamerId] && signal.type === 'offer') {
                    this.createViewerPeerConnection(streamerId, from);
                }
                const peerData = this.watchedStreams[streamerId];
                if (peerData) await this.handleSDP(peerData.pc, from, signal, streamerId);
            }
        });

        this.socket.on('stream-update', (activeStreams) => {
            if (window.onStreamsUpdate) window.onStreamsUpdate(activeStreams);
            // Cleanup watched streams if they are no longer active
            const activeIds = (activeStreams || []).map(s => s.streamerId);
            Object.keys(this.watchedStreams).forEach(id => {
                if (!activeIds.includes(id)) {
                    console.log(`[STREAM] Watch cleanup: Streamer ${id} is no longer live.`);
                    this.stopWatching(id);
                }
            });
        });
    }

    async handleSDP(pc, from, signal, streamerId = null) {
        if (signal.type === 'offer' || signal.type === 'answer') {
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
                if (signal.type === 'offer') {
                    const answer = await pc.createAnswer();
                    await pc.setLocalDescription(answer);
                    this.socket.emit('stream-signal', { to: from, signal: answer, streamerId });
                }
            } catch (err) {
                console.error('[STREAM] SDP Error:', err);
            }
        } else if (signal.type === 'candidate' && signal.candidate) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
            } catch (e) {
                console.warn('[STREAM] ICE Candidate Error:', e);
            }
        }
    }

    async startShare(targetFPS = 60) {
        try {
            console.log(`[STREAM] Requesting screen share... (1080p/${targetFPS}fps/Hi-Fi Audio)`);
            const constraints = {
                video: {
                    width: { ideal: 1920, max: 1920 },
                    height: { ideal: 1080, max: 1080 },
                    frameRate: { ideal: targetFPS, max: targetFPS }
                },
                audio: {
                    echoCancellation: true,
                    noiseSuppression: false,
                    autoGainControl: false,
                    channelCount: 2
                }
            };

            this.localStream = await navigator.mediaDevices.getDisplayMedia(constraints);

            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                await videoTrack.applyConstraints({ frameRate: { ideal: targetFPS } }).catch(() => { });
                // Optimization: Use 'motion' for high FPS to prioritize fluidity, 'detail' for standard
                if ('contentHint' in videoTrack) {
                    videoTrack.contentHint = targetFPS > 60 ? 'motion' : 'detail';
                }
            }

            this.isStreaming = true;
            this.targetFPS = targetFPS; // Store for initiateCall
            this.socket.emit('stream-start');

            this.localStream.getVideoTracks()[0].onended = () => this.stopShare();

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
        Object.keys(this.broadcasterPeers).forEach(id => {
            this.broadcasterPeers[id].close();
            delete this.broadcasterPeers[id];
        });
        if (window.onLocalStream) window.onLocalStream(null);
    }

    joinStream(streamerId) {
        if (this.watchedStreams[streamerId]) return;
        this.socket.emit('stream-join', streamerId);
        if (window.addSystemMessage) {
            window.addSystemMessage("📡 CONNECTING TO SIGNAL... [TIP: Use the volume slider on the stream card if it overlaps with room music]");
        }
    }

    stopWatching(streamerId) {
        const peerData = this.watchedStreams[streamerId];
        if (peerData) {
            peerData.pc.close();
            if (peerData.videoElement) peerData.videoElement.remove();
            delete this.watchedStreams[streamerId];
        }
        if (window.onStreamStop) window.onStreamStop(streamerId);
    }

    createBroadcasterPeerConnection(peerId) {
        console.log('[STREAM] Creating Broadcaster PC for:', peerId);
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('stream-signal', {
                    to: peerId,
                    signal: { type: 'candidate', candidate: event.candidate },
                    streamerId: this.socket.id
                });
            }
        };

        if (this.localStream) {
            this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));
        }

        this.broadcasterPeers[peerId] = pc;
        return pc;
    }

    createViewerPeerConnection(streamerId, fromId) {
        console.log('[STREAM] Creating Viewer PC for streamer:', streamerId);
        const pc = new RTCPeerConnection({
            iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
        });

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.socket.emit('stream-signal', {
                    to: fromId,
                    signal: { type: 'candidate', candidate: event.candidate },
                    streamerId
                });
            }
        };

        pc.ontrack = (event) => {
            console.log('[STREAM] Received track from streamer:', streamerId);
            if (window.onRemoteStream) window.onRemoteStream(event.streams[0], streamerId);
        };

        pc.oniceconnectionstatechange = () => {
            if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') {
                this.stopWatching(streamerId);
            }
        };

        this.watchedStreams[streamerId] = { pc };
        return pc;
    }

    async initiateCall(peerId) {
        const pc = this.createBroadcasterPeerConnection(peerId);
        try {
            let offer = await pc.createOffer();
            if (offer.sdp) {
                offer.sdp = this.setVideoBitrate(offer.sdp, 10000); // BOOSTED: 10Mbps (Nitro Quality)
                offer.sdp = this.setAudioBitrate(offer.sdp, 510);   // BOOSTED: 510kbps (Hi-Fi)
                offer = new RTCSessionDescription({ type: offer.type, sdp: offer.sdp });
            }
            await pc.setLocalDescription(offer);

            const senders = pc.getSenders();
            senders.forEach(sender => {
                if (sender.track && sender.track.kind === 'video') {
                    const params = sender.getParameters();
                    if (!params.encodings) params.encodings = [{}];

                    // PERFORMANCE BOOST: Prioritize framerate over resolution for 120FPS
                    params.degradationPreference = 'maintain-framerate';
                    params.encodings[0].maxFramerate = this.targetFPS || 60;
                    params.encodings[0].priority = 'high';
                    params.encodings[0].networkPriority = 'high';

                    sender.setParameters(params).catch(() => { });
                }
            });

            this.socket.emit('stream-signal', { to: peerId, signal: offer, streamerId: this.socket.id });
        } catch (err) {
            console.error('[STREAM] Failed to create offer:', err);
        }
    }

    setVideoBitrate(sdp, bitrate) {
        const lines = sdp.split('\n');
        let lineIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('m=video') === 0) { lineIndex = i; break; }
        }
        if (lineIndex === -1) return sdp;
        lineIndex++;
        while (lineIndex < lines.length && lines[lineIndex].indexOf('m=') === -1) {
            if (lines[lineIndex].indexOf('c=') === 0) {
                lines.splice(lineIndex + 1, 0, 'b=AS:' + bitrate);
                return lines.join('\n');
            }
            lineIndex++;
        }
        return sdp;
    }

    setAudioBitrate(sdp, bitrate) {
        let lines = sdp.split('\n');
        let audioLine = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].indexOf('m=audio') === 0) { audioLine = i; break; }
        }
        if (audioLine !== -1) {
            for (let i = audioLine; i < lines.length && (lines[i].indexOf('m=') !== 0 || i === audioLine); i++) {
                if (lines[i].indexOf('c=') === 0) {
                    lines.splice(i + 1, 0, 'b=AS:' + bitrate);
                    break;
                }
            }
        }
        sdp = lines.join('\n');
        sdp = sdp.replace(/a=fmtp:(\d+) (.*)/g, (match, pt, params) => {
            if (params.indexOf('opus') !== -1 || sdp.indexOf('a=rtpmap:' + pt + ' opus/48000/2') !== -1) {
                return `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=510000;cbr=1;usedtx=0`;
            }
            return match;
        });
        return sdp;
    }
}

window.StreamManager = StreamManager;
