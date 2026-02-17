/**
 * Multi-canvas compare renderer:
 * - left canvas: occupancy voxels
 * - right canvases: 1 or 2 point cloud views (camera pose synced from left every frame)
 * - controls are bound to the shared bottom pane so interaction works from any view
 *
 * Supports dynamic pointcloud swapping via setPointCloud(viewIndex, data).
 */
import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import { turboColormap, normalizeHeight } from '../utils/turboColormap.js';

const FLIP_LEFT_RIGHT = true;
const DEFAULT_MAX_IDLE_DEVICE_PIXEL_RATIO = 2;
const DEFAULT_ACTIVE_PIXEL_RATIO = 1;
const DEFAULT_INTERACTION_HOLD_MS = 180;

function clampPositive(value, fallback, min = 0.5, max = 4) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return fallback;
  return Math.min(max, Math.max(min, num));
}

function getSafeDevicePixelRatio(maxDevicePixelRatio = DEFAULT_MAX_IDLE_DEVICE_PIXEL_RATIO) {
  const dpr = Number(window.devicePixelRatio || 1);
  const safeDeviceDpr = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const safeMax = clampPositive(maxDevicePixelRatio, DEFAULT_MAX_IDLE_DEVICE_PIXEL_RATIO);
  return Math.min(safeDeviceDpr, safeMax);
}

function disposeObject3DTree(root) {
  if (!root || typeof root.traverse !== 'function') return;
  root.traverse((node) => {
    if (node.geometry && typeof node.geometry.dispose === 'function') {
      node.geometry.dispose();
    }
    if (node.material) {
      const mats = Array.isArray(node.material) ? node.material : [node.material];
      mats.forEach((mat) => {
        if (mat && typeof mat.dispose === 'function') mat.dispose();
      });
    }
  });
}

function sizeCanvasRenderer(renderer, canvas) {
  const rect = canvas.getBoundingClientRect();
  const wCss = Math.max(1, Math.floor(rect.width));
  const hCss = Math.max(1, Math.floor(rect.height));
  renderer.setSize(wCss, hCss, false);
  return { wCss, hCss };
}

function visualizeOccupancyWithCubes(occupancyData, options = {}) {
  const gridShape = occupancyData.gridShape;
  const bounds = occupancyData.bounds;
  const occupancy = occupancyData.occupancy;
  const occupancyBits = occupancyData.occupancyBits;
  const occEncoding = occupancyData.encoding || (occupancyBits ? 'bitset' : 'raw');
  const [nx, ny, nz] = gridShape;
  const [xMin, xMax] = bounds.x;
  const [yMin, yMax] = bounds.y;
  const [zMin, zMax] = bounds.z;

  const voxelSizeX = (xMax - xMin) / nx;
  const voxelSizeY = (yMax - yMin) / ny;
  const voxelSizeZ = (zMax - zMin) / nz;
  const defaultZFilterMin = zMin;
  const defaultZFilterMax = Math.min(zMax, 3.5);

  let threshold = Number(options.threshold);
  if (!Number.isFinite(threshold)) threshold = 0.5;
  threshold = Math.max(0, threshold);

  let zFilterMin = Number(options.zFilterMin);
  if (!Number.isFinite(zFilterMin)) zFilterMin = defaultZFilterMin;

  let zFilterMax = Number(options.zFilterMax);
  if (!Number.isFinite(zFilterMax)) zFilterMax = defaultZFilterMax;

  const dropTopLayers = Math.max(0, Math.floor(Number(options.dropTopLayers) || 0));
  if (dropTopLayers > 0) {
    zFilterMax -= dropTopLayers * voxelSizeZ;
  }

  // Keep filter range sane even for extreme URL values.
  zFilterMin = Math.max(zMin, zFilterMin);
  zFilterMax = Math.min(zMax, zFilterMax);
  if (zFilterMax <= zFilterMin) {
    zFilterMax = Math.min(zMax, zFilterMin + voxelSizeZ);
  }

  const binSize = 0.1;
  const voxelsByZBin = new Map();
  const xyStride = nz * ny;
  const addVoxel = (x, y, z) => {
    const worldZ = zMin + (z + 0.5) * voxelSizeZ;
    if (worldZ < zFilterMin || worldZ > zFilterMax) return;

    const zBin = Math.floor(worldZ / binSize);
    let arr = voxelsByZBin.get(zBin);
    if (!arr) {
      arr = [];
      voxelsByZBin.set(zBin, arr);
    }
    arr.push({ x, y, z, worldZ });
  };

  if (occEncoding === 'bitset') {
    const numVoxels = Number(occupancyData.numVoxels) || (nx * ny * nz);
    const bakeThreshold = Number(occupancyData.bakeThreshold);
    if (Number.isFinite(bakeThreshold) && Math.abs(threshold - bakeThreshold) > 1e-9) {
      console.warn(
        `Bitset occupancy was baked at threshold=${bakeThreshold}; URL threshold=${threshold} cannot change selection.`
      );
    }

    for (let byteIdx = 0; byteIdx < occupancyBits.length; byteIdx++) {
      const byteVal = occupancyBits[byteIdx];
      if (byteVal === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if ((byteVal & (1 << bit)) === 0) continue;
        const idx = (byteIdx << 3) + bit;
        if (idx >= numVoxels) break;
        const x = Math.floor(idx / xyStride);
        const rem = idx - x * xyStride;
        const y = Math.floor(rem / nz);
        const z = rem - y * nz;
        addVoxel(x, y, z);
      }
    }
  } else {
    // z + y*nz + x*nz*ny
    for (let x = 0; x < nx; x++) {
      for (let y = 0; y < ny; y++) {
        for (let z = 0; z < nz; z++) {
          const idx = z + y * nz + x * nz * ny;
          if (idx >= occupancy.length) continue;
          const p = occupancy[idx];
          if (p <= threshold) continue;
          addVoxel(x, y, z);
        }
      }
    }
  }

  const group = new THREE.Group();
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const matrix = new THREE.Matrix4();

  voxelsByZBin.forEach((voxels) => {
    const cubeCount = voxels.length;
    if (!cubeCount) return;

    const avgWorldZ = voxels[0].worldZ;
    const zSpan = Math.max(1e-6, zFilterMax - zFilterMin);
    const t = Math.max(0, Math.min(1, (avgWorldZ - zFilterMin) / zSpan));
    const [r, g, b] = turboColormap(t);

    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(r, g, b),
      side: THREE.DoubleSide,
    });

    const instanced = new THREE.InstancedMesh(geometry, material, cubeCount);
    instanced.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < cubeCount; i++) {
      const { x, y, z, worldZ } = voxels[i];

      // Match occupancy 3D convention: swap X/Y for BEV yx view.
      const worldX = yMin + (y + 0.5) * voxelSizeY;
      const worldY = xMin + (x + 0.5) * voxelSizeX;

      matrix.makeScale(voxelSizeY, voxelSizeX, voxelSizeZ);
      matrix.setPosition(worldX, worldY, worldZ);
      instanced.setMatrixAt(i, matrix);
    }

    instanced.instanceMatrix.needsUpdate = true;
    group.add(instanced);
  });

  return group;
}

function buildPointCloud(points, count, bounds, opts = {}) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));

  // Height colors (optional)
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const z = points[i * 3 + 2];
    const t = normalizeHeight(z, bounds.z);
    const [r, g, b] = turboColormap(t);
    colors[i * 3 + 0] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();

  const material = new THREE.PointsMaterial({
    size: Number(opts.size ?? 2.0),
    sizeAttenuation: false,
    color: opts.color ?? 0x66ccff,
    vertexColors: Boolean(opts.vertexColors ?? false),
    transparent: true,
    opacity: 0.95,
  });

  const pts = new THREE.Points(geometry, material);
  if (FLIP_LEFT_RIGHT) {
    pts.scale.x = -1;
  }
  pts.frustumCulled = false;
  return pts;
}

export class CompareMultiViewRenderer {
  constructor(canvases, occupancyData, pointCloudDatas = [], occRenderOptions = {}, perfOptions = {}) {
    this.canvases = canvases; // { occ, pcA, pcB }
    this.occ = occupancyData;
    this.occRenderOptions = occRenderOptions;
    this.perfOptions = perfOptions;

    this.rendererOcc = null;
    this.rendererPc = [null, null];

    this.cameraOcc = null;
    this.cameraPc = [null, null];
    this.controls = null;

    this.sceneOcc = new THREE.Scene();
    this.scenePc = [new THREE.Scene(), new THREE.Scene()];
    this.pcObjects = [null, null];

    this.animationId = null;
    this._resizeObserver = null;
    this._resizeRaf = 0;
    this._onWindowResize = null;
    this._lastCssSizes = { occW: 0, occH: 0, pc0W: 0, pc0H: 0, pc1W: 0, pc1H: 0 };
    this._currentPixelRatio = null;
    this._lastInteractionTs = 0;
    this._isPointerInteracting = false;
    this._onControlsStart = null;
    this._onControlsChange = null;
    this._onControlsEnd = null;

    const maxDevicePixelRatio = clampPositive(
      this.perfOptions.maxDevicePixelRatio,
      DEFAULT_MAX_IDLE_DEVICE_PIXEL_RATIO
    );
    const deviceCappedDpr = getSafeDevicePixelRatio(maxDevicePixelRatio);
    const fixedPixelRatio = clampPositive(this.perfOptions.fixedPixelRatio, NaN);
    const requestedIdlePixelRatio = clampPositive(this.perfOptions.idlePixelRatio, NaN);
    const requestedActivePixelRatio = clampPositive(this.perfOptions.activePixelRatio, NaN);

    if (Number.isFinite(fixedPixelRatio)) {
      const forced = Math.min(deviceCappedDpr, fixedPixelRatio);
      this._idlePixelRatio = forced;
      this._activePixelRatio = forced;
    } else {
      const idle = Number.isFinite(requestedIdlePixelRatio)
        ? Math.min(deviceCappedDpr, requestedIdlePixelRatio)
        : deviceCappedDpr;
      const activeDefault = Math.min(idle, DEFAULT_ACTIVE_PIXEL_RATIO);
      const active = Number.isFinite(requestedActivePixelRatio)
        ? Math.min(idle, requestedActivePixelRatio)
        : activeDefault;
      this._idlePixelRatio = idle;
      this._activePixelRatio = active;
    }
    const holdMs = Number(this.perfOptions.interactionHoldMs);
    this._interactionHoldMs = Number.isFinite(holdMs)
      ? Math.max(0, Math.floor(holdMs))
      : DEFAULT_INTERACTION_HOLD_MS;

    this.moveSpeed = 0.5;
    this.rotateSpeed = 0.02;
    this.keys = {
      ArrowUp: false,
      ArrowDown: false,
      ArrowLeft: false,
      ArrowRight: false,
      KeyW: false,
      KeyA: false,
      KeyS: false,
      KeyD: false,
      KeyQ: false,
      KeyE: false,
    };

    this.init(pointCloudDatas);
  }

  init(pointCloudDatas) {
    this.rendererOcc = new THREE.WebGLRenderer({
      canvas: this.canvases.occ,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.rendererOcc.setClearColor(0x1a1a1a, 1.0);

    this.rendererPc[0] = new THREE.WebGLRenderer({
      canvas: this.canvases.pcA,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.rendererPc[0].setClearColor(0x1a1a1a, 1.0);

    // pcB is optional (3-pane mode). If missing/null, we just skip it.
    if (this.canvases.pcB) {
      this.rendererPc[1] = new THREE.WebGLRenderer({
        canvas: this.canvases.pcB,
        antialias: true,
        alpha: false,
        powerPreference: 'high-performance',
      });
      this.rendererPc[1].setClearColor(0x1a1a1a, 1.0);
    }
    this._applyPixelRatio(this._idlePixelRatio, false);

    this.sceneOcc.background = new THREE.Color(0x1a1a1a);
    this.scenePc[0].background = new THREE.Color(0x1a1a1a);
    this.scenePc[1].background = new THREE.Color(0x1a1a1a);

    const { bounds } = this.occ;
    const centerX = (bounds.x[0] + bounds.x[1]) / 2;
    const centerY = (bounds.y[0] + bounds.y[1]) / 2;

    const sizeX = bounds.x[1] - bounds.x[0];
    const sizeY = bounds.y[1] - bounds.y[0];
    const sizeZ = bounds.z[1] - bounds.z[0];
    const maxSize = Math.max(sizeX, sizeY, sizeZ);

    this.cameraOcc = new THREE.PerspectiveCamera(50, 1, 0.1, maxSize * 20 + 100);
    this.cameraOcc.up.set(0, 0, 1);
    this.cameraPc[0] = new THREE.PerspectiveCamera(50, 1, 0.1, maxSize * 20 + 100);
    this.cameraPc[0].up.set(0, 0, 1);
    this.cameraPc[1] = new THREE.PerspectiveCamera(50, 1, 0.1, maxSize * 20 + 100);
    this.cameraPc[1].up.set(0, 0, 1);

    const eyeHeight = 1.5;
    this.cameraOcc.position.set(centerY, centerX, eyeHeight);
    this.cameraOcc.lookAt(centerY, centerX + sizeX * 0.3, eyeHeight);

    for (let i = 0; i < 2; i++) {
      this.cameraPc[i].position.copy(this.cameraOcc.position);
      this.cameraPc[i].quaternion.copy(this.cameraOcc.quaternion);
    }

    const controlsDomElement = this.canvases.occ?.parentElement || this.rendererOcc.domElement;
    this.controls = new OrbitControls(this.cameraOcc, controlsDomElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.05;
    this.controls.target.set(centerY, centerX + sizeX * 0.3, eyeHeight);
    this.controls.enableRotate = true;
    this.controls.minAzimuthAngle = -Infinity;
    this.controls.maxAzimuthAngle = Infinity;
    this.controls.minPolarAngle = 0;
    this.controls.maxPolarAngle = Math.PI;
    this._onControlsStart = () => {
      this._isPointerInteracting = true;
      this._markInteraction();
    };
    this._onControlsChange = () => this._markInteraction();
    this._onControlsEnd = () => {
      this._isPointerInteracting = false;
      this._markInteraction();
    };
    this.controls.addEventListener('start', this._onControlsStart);
    this.controls.addEventListener('change', this._onControlsChange);
    this.controls.addEventListener('end', this._onControlsEnd);

    // Build occupancy scene
    const occGroup = visualizeOccupancyWithCubes(
      this.occ,
      this.occRenderOptions
    );
    if (FLIP_LEFT_RIGHT) {
      occGroup.scale.x = -1;
    }
    this.sceneOcc.add(occGroup);
    this.sceneOcc.add(new THREE.AxesHelper(5));

    // Init pointcloud views (if provided)
    this.setPointCloud(0, pointCloudDatas[0] ?? null);
    this.setPointCloud(1, pointCloudDatas[1] ?? null);
    this.scenePc[0].add(new THREE.AxesHelper(5));
    this.scenePc[1].add(new THREE.AxesHelper(5));

    // Key listeners
    this.handleKeyDown = (event) => {
      const key = event.code || event.key;
      if (key in this.keys) {
        this.keys[key] = true;
        this._markInteraction();
        event.preventDefault();
      }
    };
    this.handleKeyUp = (event) => {
      const key = event.code || event.key;
      if (key in this.keys) {
        this.keys[key] = false;
        this._markInteraction();
        event.preventDefault();
      }
    };
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);

    this._onWindowResize = () => this.onResize();
    window.addEventListener('resize', this._onWindowResize, { passive: true });
    this._installResizeObserver();
    this.onResize();
    this.animate();
  }

  dispose() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.animationId = null;
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = 0;

    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    if (this._onWindowResize) {
      window.removeEventListener('resize', this._onWindowResize);
      this._onWindowResize = null;
    }

    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }

    if (this.controls) {
      if (this._onControlsStart) this.controls.removeEventListener('start', this._onControlsStart);
      if (this._onControlsChange) this.controls.removeEventListener('change', this._onControlsChange);
      if (this._onControlsEnd) this.controls.removeEventListener('end', this._onControlsEnd);
      this._onControlsStart = null;
      this._onControlsChange = null;
      this._onControlsEnd = null;
    }
    this.controls?.dispose?.();
    this.controls = null;

    this.pcObjects.forEach((obj, idx) => {
      if (!obj) return;
      this.scenePc[idx]?.remove?.(obj);
      disposeObject3DTree(obj);
      this.pcObjects[idx] = null;
    });
    disposeObject3DTree(this.sceneOcc);
    disposeObject3DTree(this.scenePc[0]);
    disposeObject3DTree(this.scenePc[1]);

    const renderers = [this.rendererOcc, this.rendererPc[0], this.rendererPc[1]];
    renderers.forEach((renderer) => {
      if (!renderer) return;
      renderer.dispose?.();
      renderer.forceContextLoss?.();
    });
    this.rendererOcc = null;
    this.rendererPc = [null, null];
  }

  setPointCloud(viewIndex, pcData) {
    if (viewIndex !== 0 && viewIndex !== 1) return;

    // If this view is not present (e.g. pcB canvas missing), ignore.
    if (viewIndex === 1 && !this.canvases.pcB) return;

    // Remove old object
    const old = this.pcObjects[viewIndex];
    if (old) {
      this.scenePc[viewIndex].remove(old);
      old.geometry?.dispose?.();
      old.material?.dispose?.();
      this.pcObjects[viewIndex] = null;
    }
    if (!pcData) return;

    const obj = buildPointCloud(pcData.points, pcData.count, pcData.bounds, {
      size: 2.0,
      color: viewIndex === 0 ? 0x66ccff : 0xffcc66,
      vertexColors: false,
    });
    this.scenePc[viewIndex].add(obj);
    this.pcObjects[viewIndex] = obj;

    console.log('Pointcloud view updated:', {
      viewIndex,
      count: pcData.count,
      bounds: pcData.bounds,
      source: pcData.source,
    });
  }

  _installResizeObserver() {
    if (!('ResizeObserver' in window)) return;
    const schedule = () => {
      if (this._resizeRaf) return;
      this._resizeRaf = requestAnimationFrame(() => {
        this._resizeRaf = 0;
        this.onResize();
      });
    };
    this._resizeObserver = new ResizeObserver(() => schedule());
    const observe = (el) => { if (el) this._resizeObserver.observe(el); };
    observe(this.canvases.occ);
    observe(this.canvases.pcA);
    observe(this.canvases.pcB);
    observe(this.canvases.occ?.parentElement);
    observe(this.canvases.pcA?.parentElement);
    observe(this.canvases.pcB?.parentElement);
  }

  _markInteraction() {
    this._lastInteractionTs = performance.now();
  }

  _isKeyboardInteracting() {
    return this.keys.ArrowUp
      || this.keys.ArrowDown
      || this.keys.ArrowLeft
      || this.keys.ArrowRight
      || this.keys.KeyW
      || this.keys.KeyA
      || this.keys.KeyS
      || this.keys.KeyD
      || this.keys.KeyQ
      || this.keys.KeyE;
  }

  _applyPixelRatio(nextDpr, runResize = true) {
    const safeNext = clampPositive(nextDpr, 1);
    if (this._currentPixelRatio !== null && Math.abs(this._currentPixelRatio - safeNext) < 1e-3) {
      return;
    }
    this._currentPixelRatio = safeNext;
    this.rendererOcc?.setPixelRatio(safeNext);
    this.rendererPc[0]?.setPixelRatio(safeNext);
    this.rendererPc[1]?.setPixelRatio(safeNext);
    if (runResize) this.onResize();
  }

  onResize() {
    const occ = sizeCanvasRenderer(this.rendererOcc, this.canvases.occ);
    const pc0 = sizeCanvasRenderer(this.rendererPc[0], this.canvases.pcA);

    this.cameraOcc.aspect = occ.wCss / occ.hCss;
    this.cameraOcc.updateProjectionMatrix();
    this.cameraPc[0].aspect = pc0.wCss / pc0.hCss;
    this.cameraPc[0].updateProjectionMatrix();

    let pc1 = { wCss: 0, hCss: 0 };
    if (this.canvases.pcB && this.rendererPc[1]) {
      pc1 = sizeCanvasRenderer(this.rendererPc[1], this.canvases.pcB);
      this.cameraPc[1].aspect = pc1.wCss / pc1.hCss;
      this.cameraPc[1].updateProjectionMatrix();
    }

    this._lastCssSizes = {
      occW: occ.wCss, occH: occ.hCss,
      pc0W: pc0.wCss, pc0H: pc0.hCss,
      pc1W: pc1.wCss, pc1H: pc1.hCss,
    };
  }

  animate() {
    this.animationId = requestAnimationFrame(() => this.animate());

    // Cheap per-frame resize check (for iframe/layout edge cases)
    const oRect = this.canvases.occ.getBoundingClientRect();
    const aRect = this.canvases.pcA.getBoundingClientRect();
    const bRect = this.canvases.pcB ? this.canvases.pcB.getBoundingClientRect() : null;

    const occW = Math.max(1, Math.floor(oRect.width));
    const occH = Math.max(1, Math.floor(oRect.height));
    const pc0W = Math.max(1, Math.floor(aRect.width));
    const pc0H = Math.max(1, Math.floor(aRect.height));
    const pc1W = bRect ? Math.max(1, Math.floor(bRect.width)) : 0;
    const pc1H = bRect ? Math.max(1, Math.floor(bRect.height)) : 0;

    const s = this._lastCssSizes;
    if (occW !== s.occW || occH !== s.occH || pc0W !== s.pc0W || pc0H !== s.pc0H || pc1W !== s.pc1W || pc1H !== s.pc1H) {
      this.onResize();
    }

    const now = performance.now();
    const keyboardInteracting = this._isKeyboardInteracting();
    if (keyboardInteracting) this._markInteraction();
    const interactionRecentlyActive = (now - this._lastInteractionTs) <= this._interactionHoldMs;
    const useActiveDpr = this._isPointerInteracting || keyboardInteracting || interactionRecentlyActive;
    this._applyPixelRatio(useActiveDpr ? this._activePixelRatio : this._idlePixelRatio);

    const direction = new THREE.Vector3();
    const right = new THREE.Vector3();
    this.cameraOcc.getWorldDirection(direction);
    right.crossVectors(direction, this.cameraOcc.up).normalize();

    if (this.keys.ArrowUp || this.keys.KeyW) {
      this.cameraOcc.position.addScaledVector(direction, this.moveSpeed);
      this.controls.target.addScaledVector(direction, this.moveSpeed);
    }
    if (this.keys.ArrowDown || this.keys.KeyS) {
      this.cameraOcc.position.addScaledVector(direction, -this.moveSpeed);
      this.controls.target.addScaledVector(direction, -this.moveSpeed);
    }
    if (this.keys.ArrowLeft || this.keys.KeyA) {
      this.cameraOcc.position.addScaledVector(right, -this.moveSpeed);
      this.controls.target.addScaledVector(right, -this.moveSpeed);
    }
    if (this.keys.ArrowRight || this.keys.KeyD) {
      this.cameraOcc.position.addScaledVector(right, this.moveSpeed);
      this.controls.target.addScaledVector(right, this.moveSpeed);
    }
    if (this.keys.KeyQ || this.keys.KeyE) {
      const upAxis = this.cameraOcc.up;
      const angle = this.keys.KeyQ ? this.rotateSpeed : -this.rotateSpeed;
      const lookOffset = new THREE.Vector3().subVectors(this.controls.target, this.cameraOcc.position);
      lookOffset.applyAxisAngle(upAxis, angle);
      this.controls.target.copy(this.cameraOcc.position).add(lookOffset);
    }

    this.controls.update();

    // Sync all pointcloud cameras from occupancy camera
    for (let i = 0; i < 2; i++) {
      this.cameraPc[i].position.copy(this.cameraOcc.position);
      this.cameraPc[i].quaternion.copy(this.cameraOcc.quaternion);
    }

    this.rendererOcc.render(this.sceneOcc, this.cameraOcc);
    this.rendererPc[0].render(this.scenePc[0], this.cameraPc[0]);
    if (this.canvases.pcB && this.rendererPc[1]) {
      this.rendererPc[1].render(this.scenePc[1], this.cameraPc[1]);
    }
  }
}
