class VisualizerManager {
    constructor() {
        this.canvas = document.getElementById('visualizer-canvas');
        if (!this.canvas) return;

        this.container = this.canvas.parentElement;
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.setPixelRatio(1); // Performance over res for feedback

        // Ping-Pong Buffers for Feedback
        this.renderTarget1 = new THREE.WebGLRenderTarget(this.container.clientWidth, this.container.clientHeight);
        this.renderTarget2 = new THREE.WebGLRenderTarget(this.container.clientWidth, this.container.clientHeight);
        this.currentBuffer = this.renderTarget1;
        this.prevBuffer = this.renderTarget2;

        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        // Audio Data
        this.analyser = null;
        this.dataArray = null;
        this.audioContext = null;
        this.bands = { bass: 0, mid: 0, treble: 0, volume: 0 };

        // Warp Shader Material
        this.warpMaterial = new THREE.ShaderMaterial({
            uniforms: {
                uTexture: { value: null },
                uTime: { value: 0 },
                uBass: { value: 0 },
                uMid: { value: 0 },
                uTreble: { value: 0 },
                uResolution: { value: new THREE.Vector2(this.container.clientWidth, this.container.clientHeight) },
                uRandomSeed: { value: Math.random() }
            },
            vertexShader: `
                varying vec2 vUv;
                void main() {
                    vUv = uv;
                    gl_Position = vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D uTexture;
                uniform float uTime;
                uniform float uBass;
                uniform float uMid;
                uniform float uTreble;
                uniform vec2 uResolution;
                uniform float uRandomSeed;
                varying vec2 vUv;

                void main() {
                    vec2 uv = vUv;
                    
                    // --- MilkDrop Warp Equations ---
                    vec2 centeredUv = uv - 0.5;
                    float dist = length(centeredUv);
                    float angle = atan(centeredUv.y, centeredUv.x);

                    // Zoom driven by Bass
                    float zoom = 1.0 - (uBass * 0.05 + 0.01);
                    
                    // Rotation driven by Treble
                    float rot = uTreble * 0.02 * sin(uTime * 0.5);
                    
                    // Polar Warp
                    float r = dist * zoom;
                    float a = angle + rot + (sin(dist * 10.0 - uTime) * uMid * 0.05);
                    
                    vec2 warpedUv = vec2(cos(a), sin(a)) * r + 0.5;
                    
                    // Edge Bleed / Fade
                    vec4 prevFrame = texture2D(uTexture, warpedUv);
                    
                    // Procedural Color Injection
                    float beam = smoothstep(0.01, 0.0, abs(sin(uv.x * 20.0 + uTime) * 0.1 - centeredUv.y));
                    vec3 newColor = vec3(0.0);
                    if(uBass > 0.5) {
                        newColor += vec3(uBass * 0.5, 0.0, uBass) * beam;
                    }
                    
                    // Decay & Blend
                    vec3 finalColor = prevFrame.rgb * 0.96 + newColor * 0.4;
                    
                    // Flash on heavy bass
                    finalColor += vec3(uBass * 0.1);

                    gl_FragColor = vec4(finalColor, 1.0);
                }
            `
        });

        this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.warpMaterial);
        this.scene.add(this.quad);

        window.addEventListener('resize', () => this.onResize());
        window.addEventListener('keydown', (e) => {
            if (e.key.toLowerCase() === 'r') this.randomize();
        });

        this.animate();
    }

    async initAudioSync() {
        if (this.audioContext) return;
        try {
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            const source = this.audioContext.createMediaStreamSource(stream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 512;
            source.connect(this.analyser);
            this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            console.log('[MILKDROP] Audio Analysis Active.');
        } catch (err) {
            console.warn('[MILKDROP] Audio restricted:', err);
        }
    }

    updateBands() {
        if (!this.analyser) return;
        this.analyser.getByteFrequencyData(this.dataArray);

        let bass = 0, mid = 0, treble = 0;
        const binCount = this.dataArray.length;

        for (let i = 0; i < binCount * 0.1; i++) bass += this.dataArray[i];
        for (let i = binCount * 0.1; i < binCount * 0.5; i++) mid += this.dataArray[i];
        for (let i = binCount * 0.5; i < binCount; i++) treble += this.dataArray[i];

        this.bands.bass = (bass / (binCount * 0.1)) / 255;
        this.bands.mid = (mid / (binCount * 0.4)) / 255;
        this.bands.treble = (treble / (binCount * 0.5)) / 255;

        this.warpMaterial.uniforms.uBass.value = this.bands.bass;
        this.warpMaterial.uniforms.uMid.value = this.bands.mid;
        this.warpMaterial.uniforms.uTreble.value = this.bands.treble;
    }

    onResize() {
        if (!this.container) return;
        const w = this.container.clientWidth;
        const h = this.container.clientHeight;
        this.renderer.setSize(w, h);
        this.renderTarget1.setSize(w, h);
        this.renderTarget2.setSize(w, h);
        this.warpMaterial.uniforms.uResolution.value.set(w, h);
    }

    randomize() {
        this.warpMaterial.uniforms.uRandomSeed.value = Math.random();
        console.log('[MILKDROP] Preset Randomized.');
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        this.updateBands();
        this.warpMaterial.uniforms.uTime.value += 0.01;

        // --- Ping-Pong Render Pass ---
        this.warpMaterial.uniforms.uTexture.value = this.prevBuffer.texture;

        this.renderer.setRenderTarget(this.currentBuffer);
        this.renderer.render(this.scene, this.camera);

        this.renderer.setRenderTarget(null);
        this.renderer.render(this.scene, this.camera);

        // Swap
        let temp = this.currentBuffer;
        this.currentBuffer = this.prevBuffer;
        this.prevBuffer = temp;
    }
}

window.VisualizerManager = VisualizerManager;
