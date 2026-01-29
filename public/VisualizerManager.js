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

                // --- Simplex Noise Helper ---
                vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec3 permute(vec3 x) { return mod289(((x*34.0)+1.0)*x); }
                float snoise(vec2 v) {
                    const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
                    vec2 i  = floor(v + dot(v, C.yy) );
                    vec2 x0 = v -   i + dot(i, C.xx);
                    vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
                    vec4 x12 = x0.xyxy + C.xxzz;
                    x12.xy -= i1;
                    i = mod289(i);
                    vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0 )) + i.x + vec3(0.0, i1.x, 1.0 ));
                    vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
                    m = m*m ; m = m*m ;
                    vec3 x = 2.0 * fract(p * C.www) - 1.0;
                    vec3 h = abs(x) - 0.5;
                    vec3 ox = floor(x + 0.5);
                    vec3 a0 = x - ox;
                    m *= 1.79284291400159 - 0.85373472095314 * ( a0*a0 + h*h );
                    vec3 g;
                    g.x  = a0.x  * x0.x  + h.x  * x0.y;
                    g.yz = a0.yz * x12.xz + h.yz * x12.yw;
                    return 130.0 * dot(m, g);
                }

                void main() {
                    vec2 uv = vUv;
                    vec2 centeredUv = uv - 0.5;
                    float dist = length(centeredUv);
                    float angle = atan(centeredUv.y, centeredUv.x);

                    // --- MilkDrop Warp Equations (v1.1 Elite) ---
                    float noise = snoise(uv * 3.0 + uTime * 0.1) * 0.1 * uMid;
                    float zoom = 1.0 - (uBass * 0.04 + 0.01 + noise);
                    float rot = uTreble * 0.05 * sin(uTime * 0.2 + uRandomSeed * 6.28);
                    
                    float r = dist * zoom;
                    float a = angle + rot + (sin(dist * 15.0 - uTime) * uMid * 0.08);
                    
                    vec2 warpedUv = vec2(cos(a), sin(a)) * r + 0.5;
                    
                    // --- Chromatic Aberration in Feedback ---
                    float shift = 0.002 + (uTreble * 0.005);
                    vec4 prevR = texture2D(uTexture, warpedUv + vec2(shift, 0.0));
                    vec4 prevG = texture2D(uTexture, warpedUv);
                    vec4 prevB = texture2D(uTexture, warpedUv - vec2(shift, 0.0));
                    
                    // --- Procedural Color Injection ---
                    float beam = smoothstep(0.02, 0.0, abs(sin(uv.x * 12.0 + uTime * 0.5) * 0.15 - centeredUv.y));
                    vec3 baseColor = vec3(0.01, 0.002, 0.03) * (sin(uTime * 0.5) * 0.5 + 0.5);
                    
                    // Audio Peaks
                    vec3 peakColor = vec3(0.0);
                    if(uBass > 0.15) {
                        float hue = fract(uTime * 0.1 + uRandomSeed);
                        vec3 rainbow = 0.5 + 0.5 * cos(6.28 * (hue + vec3(0,0.33,0.67)));
                        peakColor += rainbow * uBass * beam * 2.5;
                    }
                    
                    // Decay & Blend (Elite Tuning)
                    vec3 prevFrame = vec3(prevR.r, prevG.g, prevB.b);
                    vec3 finalColor = prevFrame * 0.985 + (baseColor * beam) + peakColor;
                    
                    // Bass Impact Flash
                    finalColor += vec3(uBass * uBass * 0.2);

                    gl_FragColor = vec4(clamp(finalColor, 0.0, 1.0), 1.0);
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

        // Force an initial resize to ensure buffers are valid
        setTimeout(() => this.onResize(), 100);
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
        // Burst of time to jump patterns
        this.warpMaterial.uniforms.uTime.value += Math.random() * 10.0;
        console.log('[MILKDROP] Preset Randomized & Ignited.');
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
