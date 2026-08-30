/**
 * GLBViewer — production GLB / GLTF product viewer
 * =============================================================================
 * A dependency-free (besides three.js) ES module viewer. It is a PLAYER, not
 * a compressor: it never modifies, converts, or re-encodes the assets it is
 * given. It automatically detects and decodes whichever combination of
 * Draco geometry compression / KTX2 (Basis Universal) texture compression /
 * Meshopt compression a given GLB or glTF actually uses, and renders normal,
 * uncompressed assets exactly the same way.
 *
 * Usage:
 *
 *   import { GLBViewer } from './js/viewer.js';
 *
 *   const viewer = new GLBViewer(document.getElementById('viewer'));
 *   viewer.loadModel('/models/chair.glb');
 *
 *   // Later, to show a different product in the same viewer:
 *   viewer.loadModel('/models/sofa.glb');
 *
 * Multiple independent viewers can exist on the same page (e.g. a product
 * grid) — just instantiate GLBViewer once per container. The expensive
 * Draco / KTX2 / Meshopt decoders are created once and shared automatically
 * between instances; only the renderer, scene, and camera are per-instance.
 * =============================================================================
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* =============================================================================
 * 1. CONFIGURATION
 * -----------------------------------------------------------------------------
 * This is the one place you should normally need to edit. Every value here
 * can also be overridden per-instance via the second argument to
 * `new GLBViewer(container, overrides)`, but the defaults below are sane for
 * a typical e-commerce product shot.
 * ========================================================================== */
export const CONFIG = {
	// ---- Compression decoder locations -----------------------------------
	// Point these at wherever you host the decoder files (see README.md for
	// exact instructions), or leave the jsDelivr CDN paths below — they are
	// pinned to the exact three.js version this file was written against,
	// so they will not change under you.
	dracoDecoderPath: 'https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/draco/gltf/',
	ktx2TranscoderPath: 'https://cdn.jsdelivr.net/npm/three@0.185.1/examples/jsm/libs/basis/',

	// ---- Look & feel -------------------------------------------------------
	backgroundColor: 0xffffff,      // clean e-commerce white, per spec
	cameraFov: 40,                  // vertical field of view, degrees
	framingPadding: 1.4,            // >1 = extra breathing room around the model
	minDistanceFactor: 0.45,        // zoom-in limit, relative to the fitted distance
	maxDistanceFactor: 1.5,           // zoom-out limit, relative to the fitted distance
	dampingFactor: 0.08,            // orbit inertia; lower = "floatier"
	enableShadows: true,
	shadowMapSize: 512,            // balance of quality vs. mobile GPU cost
	ShadowCameraNear: 0.5,
	ShadowCameraFar: 100,
	shadowBias: -0.0005,
	shadowNormalBias: 0.03,         // ... keep the rest same
	maxPixelRatio: 2,               // never render at more than 2x device pixels
	resetAnimationMs: 650,          // Reset View tween duration
	toneMappingExposure: 1.0,
	environmentIntensity: 1.0,      // strength of the studio reflections/IBL
	keyLightIntensity: 0.1,         // primary shadow-casting light
};

/* =============================================================================
 * 2. SHARED / LAZILY-INITIALIZED DECODERS
 * -----------------------------------------------------------------------------
 * Draco and KTX2 decoders spin up a WASM module (and, for Draco, a worker
 * pool) the first time they're used. Sharing one instance of each across
 * every GLBViewer on the page avoids paying that cost more than once, and
 * matches the pattern used in three.js's own examples.
 * ========================================================================== */
let sharedDracoLoader = null;
function getDracoLoader() {
	if (!sharedDracoLoader) {
		sharedDracoLoader = new DRACOLoader();
		sharedDracoLoader.setDecoderPath(CONFIG.dracoDecoderPath);
		// Begin fetching/instantiating the decoder immediately rather than
		// waiting for the first compressed model to request it.
		sharedDracoLoader.preload();
	}
	return sharedDracoLoader;
}

let sharedKTX2Loader = null;
let ktx2SupportedRenderer = null;
function getKTX2Loader(renderer) {
	if (!sharedKTX2Loader) {
		sharedKTX2Loader = new KTX2Loader();
		sharedKTX2Loader.setTranscoderPath(CONFIG.ktx2TranscoderPath);
	}
	// detectSupport() asks the GPU which compressed texture formats it can
	// read natively. It's cheap and safe to re-run if a different renderer
	// shows up, but in the overwhelmingly common case (one WebGL context per
	// page) this only runs once.
	if (ktx2SupportedRenderer !== renderer) {
		sharedKTX2Loader.detectSupport(renderer);
		ktx2SupportedRenderer = renderer;
	}
	return sharedKTX2Loader;
}

/* =============================================================================
 * Small standalone helpers
 * ========================================================================== */
function easeInOutCubic(t) {
	return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Recursively frees geometry/material/texture GPU memory for an Object3D. */
function disposeObject3D(root) {
	root.traverse((node) => {
		if (node.isMesh || node.isPoints || node.isLine) {
			node.geometry?.dispose();
			const materials = Array.isArray(node.material) ? node.material : [node.material];
			materials.forEach(disposeMaterial);
		}
	});
}

function disposeMaterial(material) {
	if (!material) return;
	// Scan every property generically rather than naming each texture slot
	// (map, normalMap, roughnessMap, ...) so this stays correct even as
	// glTF extensions add new material properties.
	for (const key of Object.keys(material)) {
		const value = material[key];
		if (value && value.isTexture && typeof value.dispose === 'function') {
			value.dispose();
		}
	}
	material.dispose();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function icon(pathData, viewBox = '0 0 24 24') {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', viewBox);
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	const path = document.createElementNS(SVG_NS, 'path');
	path.setAttribute('d', pathData);
	path.setAttribute('fill', 'currentColor');
	svg.appendChild(path);
	return svg;
}

const ICONS = {
	reset: 'M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6a6 6 0 0 1-6 6 6 6 0 0 1-6-6H4a8 8 0 0 0 8 8 8 8 0 0 0 8-8 8 8 0 0 0-8-8z',
	expand: 'M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM4 14h2v4h4v2H4v-6zm14 4v-4h2v6h-6v-2h4z',
	shrink: 'M9 4h2v6H5V8h4V4zm6 0h2v4h4v2h-6V4zM5 15h4v-4h2v6H5v-2zm10 2v-4h6v2h-4v4h-2v-2z',
};

/* =============================================================================
 * 3. THE VIEWER CLASS
 * ========================================================================== */
export class GLBViewer {
	/**
	 * @param {HTMLElement} container - An empty(ish) element the viewer will
	 *   take over. Give it a defined width/height in your page's CSS
	 *   (e.g. `#viewer { width: 100%; height: 480px; }`) — see README.md.
	 * @param {Partial<typeof CONFIG>} [overrides] - Optional per-instance
	 *   overrides of the CONFIG defaults above.
	 */
	constructor(container, overrides = {}) {
		if (!(container instanceof HTMLElement)) {
			throw new Error('GLBViewer: `container` must be an HTMLElement.');
		}

		this.container = container;
		this.options = Object.assign({}, CONFIG, overrides);

		this.currentModel = null;
		this.initialCameraPosition = new THREE.Vector3();
		this.initialTarget = new THREE.Vector3();
		this.activeTween = null;
		this._loadToken = 0;

		this._running = false;
		this._rafId = null;
		this._tabVisible = typeof document !== 'undefined' ? !document.hidden : true;
		this._inViewport = true;

		this.renderer = null; // set in _initThree(); stays null if WebGL fails

		this._buildDom();
		this._initThree();
		this._bindEvents();

		if (this.renderer) {
			this._resize();
			this._startLoop();
		}
	}

	/* ---------------------------------------------------------------------
	 * DOM scaffolding: canvas host, loading/error overlays, control buttons.
	 * Built in JS so integrating the viewer is just `<div id="viewer"></div>`.
	 * ------------------------------------------------------------------- */
	_buildDom() {
		const c = this.container;
		c.classList.add('glbv-container');
		c.innerHTML = '';

		this._canvasHost = document.createElement('div');
		this._canvasHost.className = 'glbv-canvas-host';
		c.appendChild(this._canvasHost);

		this._loadingEl = document.createElement('div');
		this._loadingEl.className = 'glbv-loading';
		const spinner = document.createElement('div');
		spinner.className = 'glbv-spinner';
		this._loadingTextEl = document.createElement('div');
		this._loadingTextEl.className = 'glbv-loading-text';
		this._loadingTextEl.textContent = 'Loading 3D Model…';
		this._loadingEl.append(spinner, this._loadingTextEl);
		c.appendChild(this._loadingEl);

		this._errorEl = document.createElement('div');
		this._errorEl.className = 'glbv-error';
		this._errorEl.hidden = true;
		this._errorTextEl = document.createElement('div');
		this._errorTextEl.className = 'glbv-error-text';
		this._errorEl.appendChild(this._errorTextEl);
		c.appendChild(this._errorEl);

		this._controlsEl = document.createElement('div');
		this._controlsEl.className = 'glbv-controls';

		this._resetBtn = document.createElement('button');
		this._resetBtn.type = 'button';
		this._resetBtn.className = 'glbv-btn glbv-reset';
		this._resetBtn.setAttribute('aria-label', 'Reset view');
		this._resetBtn.title = 'Reset view';
		this._resetBtn.appendChild(icon(ICONS.reset));

		this._fullscreenBtn = document.createElement('button');
		this._fullscreenBtn.type = 'button';
		this._fullscreenBtn.className = 'glbv-btn glbv-fullscreen';
		this._fullscreenBtn.setAttribute('aria-label', 'Fullscreen');
		this._fullscreenBtn.title = 'Fullscreen';
		this._fullscreenIconEl = icon(ICONS.expand);
		this._fullscreenBtn.appendChild(this._fullscreenIconEl);

		this._controlsEl.append(this._resetBtn, this._fullscreenBtn);
		c.appendChild(this._controlsEl);

		// Fullscreen isn't available on every browser (notably iPhone Safari
		// for arbitrary elements) — hide the button rather than ship a
		// dead control.
		const fsSupported = !!(
			c.requestFullscreen ||
			c.webkitRequestFullscreen ||
			document.fullscreenEnabled ||
			document.webkitFullscreenEnabled
		);
		this._fullscreenBtn.hidden = !fsSupported;
	}

	/* ---------------------------------------------------------------------
	 * 1/3/4/5. Renderer, scene, camera, lighting/environment, controls,
	 * loaders — all created once per viewer instance.
	 * ------------------------------------------------------------------- */
	_initThree() {
		const opts = this.options;

		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(opts.backgroundColor);
		this.scene.environmentIntensity = opts.environmentIntensity;

		this.camera = new THREE.PerspectiveCamera(opts.cameraFov, 1, 0.1, 1000);
		this.camera.position.set(0, 1, 3);

		let renderer;
		try {
			renderer = new THREE.WebGLRenderer({
				antialias: true,
				alpha: true,
				powerPreference: 'high-performance',
			});
		} catch (err) {
			console.error('[GLBViewer] WebGL is not available:', err);
			this._showError('3D preview is not supported on this browser/device.');
			return;
		}

		this.renderer = renderer;
		renderer.outputColorSpace = THREE.SRGBColorSpace;
		renderer.toneMapping = THREE.ACESFilmicToneMapping;
		renderer.toneMappingExposure = opts.toneMappingExposure;
		if (opts.enableShadows) {
			renderer.shadowMap.enabled = true;
			renderer.shadowMap.type = THREE.VSMShadowMap;
		}
		renderer.domElement.classList.add('glbv-canvas');
		this._canvasHost.appendChild(renderer.domElement);

		// Soft studio-style image-based lighting for realistic reflections,
		// without ever showing anything but flat white behind the model
		// (scene.environment drives lighting/reflections independently of
		// scene.background, which is what's actually visible).
		const pmremGenerator = new THREE.PMREMGenerator(renderer);
		this.scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
		pmremGenerator.dispose();

		// Single key light: provides the ground-contact shadow and a touch
		// of directional highlight on top of the environment's soft fill.
		const keyLight = new THREE.DirectionalLight(0xffffff, opts.keyLightIntensity);
		keyLight.castShadow = opts.enableShadows;
		if (opts.enableShadows) {
			keyLight.shadow.mapSize.set(opts.shadowMapSize, opts.shadowMapSize);
			keyLight.shadow.bias = -0.0003;
			keyLight.shadow.normalBias = 0.02;
			keyLight.shadow.radius = 8;
			keyLight.shadow.blurSamples = 20;
		}
		this.scene.add(keyLight, keyLight.target);
		this.keyLight = keyLight;

		// Invisible "contact shadow" floor: only the shadow it catches is
		// visible, so the white background is never interrupted by a
		// visible plane edge or color mismatch.
		const floor = new THREE.Mesh(
			new THREE.PlaneGeometry(1, 1),
			new THREE.ShadowMaterial({ opacity: 0.17 })
		);
		floor.rotation.x = -Math.PI / 2;
		floor.receiveShadow = opts.enableShadows;
		this.scene.add(floor);
		this.floor = floor;

		this.modelGroup = new THREE.Group();
		this.scene.add(this.modelGroup);

		// ---- Controls: damped orbit, natural (non-inverted) vertical drag,
		// clamped so the camera can never flip past the poles. ----
		const controls = new OrbitControls(this.camera, renderer.domElement);
		controls.enableDamping = true;
		controls.dampingFactor = opts.dampingFactor;
		controls.minPolarAngle = 0.15;
		controls.maxPolarAngle = Math.PI - 0.15;
		controls.screenSpacePanning = true;
		// Defaults already match the spec exactly:
		//   mouse:  LEFT = rotate, WHEEL = dolly, RIGHT = pan
		//   touch:  ONE finger = rotate, TWO fingers = dolly + pan
		this.controls = controls;

		// ---- Loaders: GLTFLoader wired to the shared Draco/KTX2/Meshopt
		// decoders. GLTFLoader inspects each asset's extensionsUsed and only
		// invokes the decoder that asset actually needs, so the exact same
		// loader instance transparently handles uncompressed, Draco-only,
		// KTX2-only, and Draco+KTX2 assets with no per-file branching. ----
		this.gltfLoader = new GLTFLoader();
		this.gltfLoader.setDRACOLoader(getDracoLoader());
		this.gltfLoader.setKTX2Loader(getKTX2Loader(renderer));
		this.gltfLoader.setMeshoptDecoder(MeshoptDecoder);
	}

	_bindEvents() {
		this._resizeObserver = new ResizeObserver(() => this._resize());
		this._resizeObserver.observe(this.container);

		this._onVisibilityChange = () => {
			this._tabVisible = !document.hidden;
			this._syncLoopState();
		};
		document.addEventListener('visibilitychange', this._onVisibilityChange);

		if ('IntersectionObserver' in window) {
			this._intersectionObserver = new IntersectionObserver(
				(entries) => {
					const entry = entries[entries.length - 1];
					this._inViewport = entry.isIntersecting;
					this._syncLoopState();
				},
				{ threshold: 0.01 }
			);
			this._intersectionObserver.observe(this.container);
		}

		this._onResetClick = () => this.resetView();
		this._resetBtn.addEventListener('click', this._onResetClick);

		this._onFullscreenClick = () => this.toggleFullscreen();
		this._fullscreenBtn.addEventListener('click', this._onFullscreenClick);

		this._onFullscreenChange = () => {
			const isFs = this._isFullscreen();
			this._fullscreenIconEl.replaceWith(icon(isFs ? ICONS.shrink : ICONS.expand));
			this._fullscreenIconEl = this._fullscreenBtn.querySelector('svg');
			this._fullscreenBtn.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
			this._fullscreenBtn.setAttribute('aria-label', this._fullscreenBtn.title);
			// A handful of browsers don't fire ResizeObserver reliably across
			// the fullscreen transition — force a resize as a safety net.
			requestAnimationFrame(() => this._resize());
		};
		document.addEventListener('fullscreenchange', this._onFullscreenChange);
		document.addEventListener('webkitfullscreenchange', this._onFullscreenChange);
	}

	/* ---------------------------------------------------------------------
	 * 9/12. Responsive resize handling.
	 * ------------------------------------------------------------------- */
	_resize() {
		if (!this.renderer) return;
		const width = this._canvasHost.clientWidth;
		const height = this._canvasHost.clientHeight;
		if (width === 0 || height === 0) return;

		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();
		this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.options.maxPixelRatio));
		this.renderer.setSize(width, height, false);
	}

	/* ---------------------------------------------------------------------
	 * 13. Animation loop — continuous rAF (simple and reliable), but paused
	 * automatically when the tab is hidden or the viewer scrolls off-screen.
	 * ------------------------------------------------------------------- */
	_startLoop() {
		if (this._running) return;
		this._running = true;
		const animate = () => {
			this._rafId = requestAnimationFrame(animate);
			if (this.activeTween) this._stepTween();
			this.controls.update(); // required for damping
			this.renderer.render(this.scene, this.camera);
		};
		this._rafId = requestAnimationFrame(animate);
	}

	_stopLoop() {
		this._running = false;
		if (this._rafId !== null) cancelAnimationFrame(this._rafId);
		this._rafId = null;
	}

	_syncLoopState() {
		if (this._tabVisible && this._inViewport) this._startLoop();
		else this._stopLoop();
	}

	/* ---------------------------------------------------------------------
	 * 6/10/11. Public API: load (and automatically frame) a model by URL.
	 * ------------------------------------------------------------------- */
	async loadModel(url) {
		if (!this.renderer) return;
		if (typeof url !== 'string' || !url) {
			throw new Error('GLBViewer.loadModel(url): a model URL is required.');
		}

		const token = ++this._loadToken; // guards against out-of-order responses
		this._hideError();
		this._showLoading();

		let gltf;
		try {
			gltf = await new Promise((resolve, reject) => {
				this.gltfLoader.load(
					url,
					resolve,
					(xhr) => {
						if (token !== this._loadToken) return;
						if (xhr.lengthComputable && xhr.total > 0) {
							this._setLoadingProgress(Math.round((xhr.loaded / xhr.total) * 100));
						}
					},
					reject
				);
			});
		} catch (error) {
			if (token !== this._loadToken) return; // superseded, ignore
			console.error('[GLBViewer] Failed to load model:', url, error);
			this._hideLoading();
			this._showError('This 3D model could not be loaded.');
			throw error;
		}

		if (token !== this._loadToken) return; // a newer loadModel() call won the race

		const model = gltf.scene || gltf.scenes[0];
		model.traverse((node) => {
			if (node.isMesh) {
				node.castShadow = this.options.enableShadows;
				node.receiveShadow = this.options.enableShadows;
			}
		});

		// Pre-compile shaders off the visible render loop so the model
		// doesn't visibly stutter/pop on the frame it first appears.
		try {
			await this.renderer.compileAsync(model, this.camera, this.scene);
		} catch (error) {
			console.error('[GLBViewer] Shader pre-compile failed (continuing anyway):', error);
		}
		if (token !== this._loadToken) return;

		this._disposeCurrentModel();
		this.modelGroup.add(model);
		this.currentModel = model;
		this._frameModel(model);
		this._hideLoading();

		return gltf;
	}

	/**
	 * Centers the model horizontally, grounds it at y = 0, and positions the
	 * camera to frame it completely — regardless of the model's own size,
	 * aspect ratio, or origin/pivot offsets.
	 */
	_frameModel(model) {
		const box = new THREE.Box3().setFromObject(model);
		if (box.isEmpty()) return; // model had no renderable geometry

		const size = box.getSize(new THREE.Vector3());
		const center = box.getCenter(new THREE.Vector3());

		// Re-center & ground the model without assuming its export origin
		// was already correct.
		model.position.x -= center.x;
		model.position.z -= center.z;
		model.position.y -= box.min.y;

		const maxDim = Math.max(size.x, size.y, size.z) || 1;

		// Scale near/far to the model so both tiny and room-sized products
		// render without near-clipping or far-plane z-fighting.
		this.camera.near = Math.max(maxDim * 0.01, 0.001);
		this.camera.far = maxDim * 1000;
		this.camera.updateProjectionMatrix();

		// Distance needed to fit the model both vertically and horizontally,
		// accounting for the viewport's current aspect ratio.
		const vFov = THREE.MathUtils.degToRad(this.camera.fov);
		const fitHeightDistance = maxDim / 2 / Math.tan(vFov / 2);
		const fitWidthDistance = fitHeightDistance / this.camera.aspect;
		const distance = this.options.framingPadding * Math.max(fitHeightDistance, fitWidthDistance);

		const target = new THREE.Vector3(0, size.y / 2, 0);
		const direction = new THREE.Vector3(1, 0.65, 1).normalize();
		const position = target.clone().addScaledVector(direction, distance);

		this.camera.position.copy(position);
		this.controls.target.copy(target);
		this.controls.minDistance = distance * this.options.minDistanceFactor;
		this.controls.maxDistance = distance * this.options.maxDistanceFactor;
		this.controls.update();

		this.initialCameraPosition.copy(position);
		this.initialTarget.copy(target);

		// Scale the ground plane and the key light's shadow frustum to the
		// model so the contact shadow always looks correctly sized/sharp.
		const floorSize = maxDim * 20;
		this.floor.scale.set(floorSize, floorSize, 1);
		this.floor.position.set(0, 0, 0);

		const shadowExtent = maxDim * 0.9;
		this.keyLight.position.set(target.x + maxDim, target.y + maxDim * 6, target.z + maxDim);
		this.keyLight.target.position.copy(target);
		this.keyLight.target.updateMatrixWorld();
		const cam = this.keyLight.shadow.camera;
		cam.left = -shadowExtent;
		cam.right = shadowExtent;
		cam.top = shadowExtent;
		cam.bottom = -shadowExtent;
		cam.near = 0.1;
		cam.far = maxDim * 6;
		cam.updateProjectionMatrix();
	}

	/* ---------------------------------------------------------------------
	 * 19. Reset View — smoothly animates back to the auto-framed camera
	 * position rather than snapping instantly.
	 * ------------------------------------------------------------------- */
	resetView() {
		if (!this.renderer || !this.currentModel) return;
		this.controls.enabled = false;
		this.activeTween = {
			startPos: this.camera.position.clone(),
			startTarget: this.controls.target.clone(),
			startTime: performance.now(),
			duration: this.options.resetAnimationMs,
		};
	}

	_stepTween() {
		const tw = this.activeTween;
		const elapsed = performance.now() - tw.startTime;
		const t = Math.min(elapsed / tw.duration, 1);
		const eased = easeInOutCubic(t);

		this.camera.position.lerpVectors(tw.startPos, this.initialCameraPosition, eased);
		this.controls.target.lerpVectors(tw.startTarget, this.initialTarget, eased);

		if (t >= 1) {
			this.activeTween = null;
			this.controls.enabled = true;
		}
	}

	/* ---------------------------------------------------------------------
	 * 18. Fullscreen.
	 * ------------------------------------------------------------------- */
	_isFullscreen() {
		return !!(document.fullscreenElement || document.webkitFullscreenElement);
	}

	toggleFullscreen() {
		const el = this.container;
		if (!this._isFullscreen()) {
			const request = el.requestFullscreen || el.webkitRequestFullscreen;
			if (request) {
				const result = request.call(el);
				if (result && typeof result.catch === 'function') {
					result.catch((err) => console.error('[GLBViewer] Fullscreen request failed:', err));
				}
			}
		} else {
			const exit = document.exitFullscreen || document.webkitExitFullscreen;
			if (exit) exit.call(document);
		}
	}

	/* ---------------------------------------------------------------------
	 * 11. Loading / error UI.
	 * ------------------------------------------------------------------- */
	_showLoading() {
		this._loadingTextEl.textContent = 'Loading 3D Model…';
		this._loadingEl.hidden = false;
		this._loadingEl.classList.add('is-visible');
	}
	_setLoadingProgress(pct) {
		this._loadingTextEl.textContent = `Loading 3D Model… ${pct}%`;
	}
	_hideLoading() {
		this._loadingEl.classList.remove('is-visible');
		this._loadingEl.hidden = true;
	}
	_showError(message) {
		this._errorTextEl.textContent = message;
		this._errorEl.hidden = false;
	}
	_hideError() {
		this._errorEl.hidden = true;
	}

	/* ---------------------------------------------------------------------
	 * 14. Disposal — of the current model, and of the whole viewer.
	 * ------------------------------------------------------------------- */
	_disposeCurrentModel() {
		if (!this.currentModel) return;
		this.modelGroup.remove(this.currentModel);
		disposeObject3D(this.currentModel);
		this.currentModel = null;
	}

	/** Fully tears down this viewer instance: stops rendering, disconnects
	 * observers, frees GPU resources, and empties the container. Call this
	 * if you remove the viewer's container from the page (e.g. in a
	 * single-page app) to avoid leaking GPU memory and event listeners. */
	dispose() {
		this._stopLoop();
		this._resizeObserver?.disconnect();
		this._intersectionObserver?.disconnect();
		document.removeEventListener('visibilitychange', this._onVisibilityChange);
		document.removeEventListener('fullscreenchange', this._onFullscreenChange);
		document.removeEventListener('webkitfullscreenchange', this._onFullscreenChange);

		this._disposeCurrentModel();
		this.floor?.geometry.dispose();
		this.floor?.material.dispose();
		this.scene?.environment?.dispose();
		this.renderer?.dispose();

		this.container.innerHTML = '';
		this.container.classList.remove('glbv-container');
	}
}