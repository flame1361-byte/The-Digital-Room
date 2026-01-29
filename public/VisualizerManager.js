class VisualizerManager {
    constructor() {
        this.canvas = document.getElementById('visualizer-canvas');
        if (!this.canvas) return;

        this.scene = new THREE.Scene();
        this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });

        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

        this.camera.position.z = 5;

        this.analyser = null;
        this.dataArray = null;
        this.audioContext = null;

        this.geometry = new THREE.IcosahedronGeometry(2, 64);
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                uTime: { value: 0 },
                uIntensity: { value: 0 },
                uColor: { value: new THREE.Color(0x00ffcc) }
            },
            vertexShader: `
                varying vec2 vUv;
                varying float vDisplacement;
                uniform float uTime;
                uniform float uIntensity;

                // Classic 3D Noise by Ashima Arts
                vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
                vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
                vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
                vec3 fade(vec3 t) { return t*t*t*(t*(t*6.0-15.0)+10.0); }

                float pnoise(vec3 P, vec3 rep) {
                    vec3 Pi0 = mod(floor(P), rep); vec3 Pi1 = mod(Pi0 + vec3(1.0), rep);
                    Pi0 = mod289(Pi0); Pi1 = mod289(Pi1);
                    vec3 Pf0 = fract(P); vec3 Pf1 = Pf0 - vec3(1.0);
                    vec4 ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x); vec4 iy = vec4(Pi0.yy, Pi1.yy);
                    vec4 iz0 = Pi0.zzzz; vec4 iz1 = Pi1.zzzz;
                    vec4 ixy = permute(permute(ix) + iy); vec4 ixy0 = permute(ixy + iz0); vec4 ixy1 = permute(ixy + iz1);
                    vec4 gx0 = ixy0 / 7.0; vec4 gy0 = fract(floor(gx0) / 7.0) - 0.5; gx0 = fract(gx0);
                    vec4 gz0 = vec4(0.5) - abs(gx0) - abs(gy0); vec4 sz0 = step(gz0, vec4(0.0));
                    gx0 -= sz0 * (step(0.0, gx0) - 0.5); gy0 -= sz0 * (step(0.0, gy0) - 0.5);
                    vec4 gx1 = ixy1 / 7.0; vec4 gy1 = fract(floor(gx1) / 7.0) - 0.5; gx1 = fract(gx1);
                    vec4 gz1 = vec4(0.5) - abs(gx1) - abs(gy1); vec4 sz1 = step(gz1, vec4(0.0));
                    gx1 -= sz1 * (step(0.0, gx1) - 0.5); gy1 -= sz1 * (step(0.0, gy1) - 0.5);
                    vec3 g000 = vec3(gx0.x,gy0.x,gz0.x); vec3 g100 = vec3(gx0.y,gy0.y,gz0.y);
                    vec3 g010 = vec3(gx0.z,gy0.z,gz0.z); vec3 g110 = vec3(gx0.w,gy0.w,gz0.w);
                    vec3 g001 = vec3(gx1.x,gy1.x,gz1.x); vec3 g101 = vec3(gx1.y,gy1.y,gz1.y);
                    vec3 g011 = vec3(gx1.z,gy1.z,gz1.z); vec3 g111 = vec3(gx1.w,gy1.w,gz1.w);
                    vec4 norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g100, g100), dot(g010, g010), dot(g110, g110)));
                    g000 *= norm0.x; g100 *= norm0.y; g010 *= norm0.z; g110 *= norm0.w;
                    vec4 norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g101, g101), dot(g011, g011), dot(g111, g111)));
                    g001 *= norm1.x; g101 *= norm1.y; g011 *= norm1.z; g111 *= norm1.w;
                    float n000 = dot(g000, Pf0); float n100 = dot(g100, vec3(Pf1.x, Pf0.yz));
                    float n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z)); float n110 = dot(g110, vec3(Pf1.xy, Pf0.z));
                    float n001 = dot(g001, vec3(Pf0.xy, Pf1.z)); float n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z));
                    float n011 = dot(g011, vec3(Pf0.x, Pf1.yz)); float n111 = dot(g111, Pf1);
                    vec3 fade_xyz = fade(Pf0);
                    vec4 n_z = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fade_xyz.z);
                    vec2 n_yz = mix(n_z.xy, n_z.zw, fade_xyz.y);
                    return 2.2 * mix(n_yz.x, n_yz.y, fade_xyz.x);
                }

                void main() {
                    vUv = uv;
                    vDisplacement = pnoise(position + uTime * 0.5, vec3(10.0)) * uIntensity;
                    vec3 newPosition = position + normal * vDisplacement;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(newPosition, 1.0);
                }
            `,
            fragmentShader: `
                varying vec2 vUv;
                varying float vDisplacement;
                uniform vec3 uColor;

                void main() {
                    float dist = distance(vUv, vec2(0.5));
                    vec3 color = uColor * (vDisplacement + 0.5);
                    gl_FragColor = vec4(color, 0.6);
                }
            `,
            transparent: true,
            wireframe: true
        });

        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.scene.add(this.mesh);

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
            this.analyser.fftSize = 256;
            source.connect(this.analyser);

            const bufferLength = this.analyser.frequencyBinCount;
            this.dataArray = new Uint8Array(bufferLength);
            console.log('[VISUALIZER] Audio sync established via Mic capture.');
        } catch (err) {
            console.warn('[VISUALIZER] Audio sync failed:', err);
        }
    }

    onResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    randomize() {
        this.material.uniforms.uColor.value.setHex(Math.random() * 0xffffff);
        this.mesh.rotation.x = Math.random() * Math.PI;
        this.mesh.rotation.y = Math.random() * Math.PI;
        console.log('[VISUALIZER] Randomized colors and orientation.');
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        let intensity = 0.5;
        if (this.analyser) {
            this.analyser.getByteFrequencyData(this.dataArray);
            let sum = 0;
            for (let i = 0; i < this.dataArray.length; i++) {
                sum += this.dataArray[i];
            }
            intensity = (sum / this.dataArray.length) / 40; // Normalize
        }

        this.material.uniforms.uTime.value += 0.01;
        this.material.uniforms.uIntensity.value = intensity;
        this.mesh.rotation.y += 0.005;
        this.mesh.rotation.z += 0.002;

        this.renderer.render(this.scene, this.camera);
    }
}

window.VisualizerManager = VisualizerManager;
