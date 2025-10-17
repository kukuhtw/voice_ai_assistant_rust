// avatar.ts
// frontend/src/avatar.ts
// avatar.ts
// frontend/src/avatar.ts
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type MouthTargets = {
  meshes: THREE.Mesh[];
  dicts: Array<Record<string, number> | undefined>;
  indices: number[];              // index morph target per mesh, -1 bila tidak ada
  jawNode?: THREE.Object3D;       // fallback node rahang (tak terlihat)
};

export class TalkingAvatar {
  private renderer!: THREE.WebGLRenderer;
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private controls!: OrbitControls;
  private clock = new THREE.Clock();
  private mixer?: THREE.AnimationMixer;

  private mouth: MouthTargets = { meshes: [], dicts: [], indices: [] };

  private analyser?: AnalyserNode;
  private dataArray?: Uint8Array;
  private audioCtx?: AudioContext;

  // Atur path GLB kamu (RPM female)
  private modelUrlFemale = "https://models.readyplayer.me/68f22154b3dcc5b5f86d6782.glb";
  private modelUrlMale   = "https://models.readyplayer.me/68f22390e831796787040291.glb";

  constructor(private canvas: HTMLCanvasElement) {}

  /** Opsional: setel ulang URL model saat runtime */
  setModelUrls(femaleUrl?: string, maleUrl?: string) {
    if (femaleUrl) this.modelUrlFemale = femaleUrl;
    if (maleUrl) this.modelUrlMale = maleUrl;
  }

  async init() {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setSize(this.canvas.clientWidth, this.canvas.clientHeight, false);
    // Linear to sRGB (Three r152+)
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = null;

    // Kamera default: close-up wajah
    this.camera = new THREE.PerspectiveCamera(
      40,
      Math.max(1, this.canvas.clientWidth) / Math.max(1, this.canvas.clientHeight),
      0.01,
      100
    );
    this.camera.position.set(0, 1.6, 1.25); // cukup dekat ke wajah

    // Pencahayaan sederhana
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.0);
    hemi.position.set(0, 1, 0);
    this.scene.add(hemi);

    const dir = new THREE.DirectionalLight(0xffffff, 1.2);
    dir.position.set(2, 3, 2);
    this.scene.add(dir);

    // Orbit controls, batasi jarak supaya tetap close-up
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.minDistance = 1.0;
    this.controls.maxDistance = 2.2;
    this.controls.target.set(0, 1.55, 0);

    // Resize observer yang lebih akurat daripada event window resize saja
    const ro = new ResizeObserver(() => this.onResize());
    ro.observe(this.canvas);

    window.addEventListener("resize", () => this.onResize());

    // Muat model default & mulai render loop
    await this.loadModel("female");
    this.animate();
  }

  async loadModel(kind: "female" | "male") {
    // Bersihkan selain lampu & kamera
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const obj = this.scene.children[i];
      if (!(obj instanceof THREE.Light) && obj !== this.camera) this.scene.remove(obj);
    }

    // Penting untuk CDN (RPM): izinkan cross-origin
    const loader = new GLTFLoader().setCrossOrigin("anonymous");
    const url = kind === "female" ? this.modelUrlFemale : this.modelUrlMale;

    try {
      const gltf = await loader.loadAsync(url);
      const root = gltf.scene;

      // Normalisasi material & map color space
      root.traverse((n: any) => {
        if (n.isMesh) {
          n.castShadow = true;
          n.frustumCulled = false;
          if (n.material) {
            const mat = n.material;
            if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
            if (mat.emissiveMap) mat.emissiveMap.colorSpace = THREE.SRGBColorSpace;
            if (mat.roughnessMap) mat.roughnessMap.colorSpace = THREE.LinearSRGBColorSpace as any;
            if (mat.metalnessMap) mat.metalnessMap.colorSpace = THREE.LinearSRGBColorSpace as any;
          }
        }
      });

      this.scene.add(root);

      // Animasi idle (jika ada)
      if (gltf.animations?.length) {
        this.mixer = new THREE.AnimationMixer(root);
        const clip = THREE.AnimationClip.findByName(gltf.animations, "Idle") || gltf.animations[0];
        if (clip) this.mixer.clipAction(clip).play();
      } else {
        this.mixer = undefined;
      }

      // Deteksi target mulut
      this.mouth = this.findMouthTargets(root);

      // Debug daftar morph target di console
      this.debugMorphTargets(root);

      // Jika tidak ada blendshape valid & tidak ada node "jaw", buat fallback node tak terlihat
      const hasValidMorph = this.mouth.indices.some((i) => i >= 0);
      if (!hasValidMorph && !this.mouth.jawNode) {
        const jawHelper = new THREE.Object3D();
        jawHelper.name = "jaw_helper";
        // posisikan kira-kira di pangkal rahang
        jawHelper.position.set(0, 1.35, 0);
        root.add(jawHelper);
        this.mouth = { meshes: [], dicts: [], indices: [], jawNode: jawHelper };
      }

      // Framing wajah default
      this.controls.target.set(0, 1.55, 0);
      this.camera.position.set(0, 1.6, 1.25);
      this.controls.update();
    } catch (e) {
      console.warn("Load GLB gagal, pakai fallback head:", e);
      this.addFallbackHead();
    }
  }

  /** Sambungkan audio <audio> ke analyser agar mulut sinkron */
  attachAudioAnalyser(mediaEl: HTMLMediaElement) {
    const Ctx = (window.AudioContext || (window as any).webkitAudioContext);
    const ctx = new Ctx();
    this.audioCtx = ctx;

    const src = ctx.createMediaElementSource(mediaEl);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);

    src.connect(analyser);
    analyser.connect(ctx.destination);

    this.analyser = analyser;
    this.dataArray = dataArray;
    // iOS/Safari memerlukan resume setelah gesture
    ctx.resume().catch(() => {});
  }

  // ---------- Loop render ----------
  private animate = () => {
    requestAnimationFrame(this.animate);
    const dt = this.clock.getDelta();
    if (this.mixer) this.mixer.update(dt);
    this.controls.update();

    const loud = this.getLoudness();
    this.driveMouth(loud);

    this.renderer.render(this.scene, this.camera);
  };

  private getLoudness(): number {
    if (!this.analyser || !this.dataArray) return 0;
    this.analyser.getByteTimeDomainData(this.dataArray);
    // RMS sederhana
    let sum = 0;
    for (let i = 0; i < this.dataArray.length; i++) {
      const v = (this.dataArray[i] - 128) / 128; // -1..1
      sum += v * v;
    }
    const rms = Math.sqrt(sum / this.dataArray.length);
    // threshold kecil + gain supaya responsif
    return THREE.MathUtils.clamp((rms - 0.01) * 6.0, 0, 1);
  }

  private driveMouth(amount: number) {
    // Morph target (prioritas utama)
    if (this.mouth.meshes.length) {
      for (let i = 0; i < this.mouth.meshes.length; i++) {
        const mesh = this.mouth.meshes[i] as any;
        const idx = this.mouth.indices[i];
        if (idx >= 0 && mesh.morphTargetInfluences) {
          const cur = mesh.morphTargetInfluences[idx] || 0;
          mesh.morphTargetInfluences[idx] = THREE.MathUtils.lerp(cur, amount, 0.35);
        }
      }
    }
    // Fallback: rotasi node rahang tak terlihat
    if (this.mouth.jawNode) {
      const cur = this.mouth.jawNode.rotation.x;
      const target = -amount * 0.5; // buka ke bawah
      this.mouth.jawNode.rotation.x = THREE.MathUtils.lerp(cur, target, 0.35);
    }
  }

  // ---------- Deteksi target mulut ----------
  private findMouthTargets(root: THREE.Object3D): MouthTargets {
    const meshes: THREE.Mesh[] = [];
    const dicts: Array<Record<string, number> | undefined> = [];
    const indices: number[] = [];
    let jawNode: THREE.Object3D | undefined;

    // Kandidat nama morph target umum (termasuk ARKit/viseme populer)
    const candidates = [
      "jawopen", "jaw_open", "jaw",
      "mouthopen", "mouth_open",
      "open",
      "viseme_aa", "viseme_ah", "aa", "ah",
      "mouthOpen", "MouthOpen"
    ];

    root.traverse((n: any) => {
      // Simpan node yang namanya mengandung "jaw" sebagai fallback
      if (n?.name && typeof n.name === "string" && n.name.toLowerCase().includes("jaw")) {
        jawNode = jawNode ?? n;
      }

      if (n.isMesh && n.morphTargetDictionary && n.morphTargetInfluences) {
        const dict = n.morphTargetDictionary as Record<string, number>;
        const names = Object.keys(dict);
        const key = names.find((k) => {
          const lk = k.toLowerCase();
          return candidates.some((c) => lk.includes(c));
        });

        meshes.push(n);
        dicts.push(dict);
        indices.push(key ? dict[key] : -1);
      }
    });

    return { meshes, dicts, indices, jawNode };
  }

  // ---------- Fallback head (tanpa mesh kotak terlihat) ----------
  private addFallbackHead() {
    const head = new THREE.Group();

    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 32, 32),
      new THREE.MeshStandardMaterial({ color: 0xf0c8a0, roughness: 0.7 })
    );
    sphere.position.y = 1.6;
    head.add(sphere);

    // Node rahang tak terlihat
    const jawHelper = new THREE.Object3D();
    jawHelper.name = "jaw_helper_fallback";
    jawHelper.position.set(0, 1.35, 0);
    head.add(jawHelper);

    this.scene.add(head);
    this.mouth = { meshes: [], dicts: [], indices: [], jawNode: jawHelper };

    // Framing
    this.controls.target.set(0, 1.55, 0);
    this.camera.position.set(0, 1.6, 1.25);
    this.controls.update();
  }

  // Debug helper: tampilkan nama morph target di console
  private debugMorphTargets(root: THREE.Object3D) {
    const hits: Array<{ mesh: string; keys: string[] }> = [];
    root.traverse((n: any) => {
      if (n.isMesh && n.morphTargetDictionary) {
        hits.push({ mesh: n.name || "(unnamed)", keys: Object.keys(n.morphTargetDictionary) });
      }
    });
    if (hits.length) {
      console.group("[MorphTargets]");
      hits.forEach((h) => console.log(h.mesh, h.keys));
      console.groupEnd();
    } else {
      console.log("[MorphTargets] Tidak ditemukan.");
    }
  }

  private onResize() {
    const w = Math.max(1, this.canvas.clientWidth);
    const h = Math.max(1, this.canvas.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  getAudioContext() {
    return this.audioCtx;
  }
}

