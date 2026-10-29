// The lantern hall on starhermit:scene, as the browser build's HallRenderer
// (js/game.js) drew it: a 4:3 view under the card on tall desktop windows
// (wider than 1024 and taller than 900 logical px; collapsed elsewhere, as
// the old CSS hid #canvas-holder), with the call ball on its pole under a
// warm point light, the 5×5 card tiles mirroring the card (marked amber,
// markable pale gold), the hanging lanterns in rows (an InstancedMesh, ribbed
// lathe lanterns with caps on detailed looks), the floor disc, the lacquered
// board, rising dust motes, fog from 12 to 26 and the theme's tint. Clicking
// a tile marks its cell.
//
// Gaps and changes from three.js: light intensities, the key light's fitted
// shadow box and RoomEnvironment are the page's (minor 28); the post
// chain is renderer.ao / bloom / grade / antialias (the grade is
// hall-post.js's GradeShader in display space); the old adaptive
// resolution, pixel-ratio cap and frame-rate meter are the runtime's. The
// view sits in its rectangle through setViewOffset, as the old canvas sat
// between the page's other elements.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, CylinderGeometry,
  DirectionalLight, ExtrudeGeometry, Fog, HemisphereLight, InstancedMesh, LatheGeometry, Mesh, MeshLambertMaterial,
  MeshPhysicalMaterial, MeshStandardMaterial, Object3D, PerspectiveCamera, PMREMGenerator, PointLight, Points, PointsMaterial,
  Raycaster, RepeatWrapping, RoomEnvironment, Shape, SphereGeometry, SRGBColorSpace, Vector2, Vector3, pointerToNdc, renderer, scene,
  type Material, type Texture,
} from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { THEMES } from "../js/content.js";
import { LANTERN_COUNT, type Look } from "./quality.ts";

const PI = Math.PI;
const CELLS = 25, GRID = 5;
type Theme = (typeof THEMES)[number];

// -- procedural assets -------------------------------------------------------------------------
/** Lacquered boards in concentric rings with grain (greyscale: the theme's floor colour tints it), in 512-px units. */
function floorTexture(size: number): Texture {
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d")!;
  ctx.scale(size / 512, size / 512);
  let seed = 11;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  ctx.fillStyle = "#d8d8d8";
  ctx.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 1400; i++) {
    const x = rnd() * 512, y = rnd() * 512, l = 20 + rnd() * 90, v = 190 + Math.floor(rnd() * 60);
    ctx.strokeStyle = `rgba(${v},${v},${v},0.35)`;
    ctx.lineWidth = 0.6 + rnd() * 1.4;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + l, y + (rnd() - 0.5) * 3); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(40,40,40,0.55)";
  ctx.lineWidth = 2;
  for (let y = 0; y <= 512; y += 64) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(512, y); ctx.stroke(); }
  for (let row = 0; row < 8; row++) {
    const off = (row % 2) * 128;
    for (let x = off; x <= 512; x += 256) { ctx.beginPath(); ctx.moveTo(x, row * 64); ctx.lineTo(x, row * 64 + 64); ctx.stroke(); }
  }
  const tex = new CanvasTexture(c);
  tex.colorSpace = SRGBColorSpace;
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.repeat.set(3, 3);
  tex.anisotropy = 4;
  return tex;
}
/** Lambert (Low), Standard (Balanced), Physical with `phys`'s clearcoat (High/Ultra). */
function hallMaterial(kind: string, params: Record<string, unknown>, phys?: Record<string, unknown>): Material {
  if (kind === "lambert") {
    const { roughness: _r, metalness: _m, ...rest } = params;
    return new MeshLambertMaterial(rest);
  }
  if (kind === "physical" && phys) return new MeshPhysicalMaterial({ ...params, ...phys });
  return new MeshStandardMaterial(params);
}
const MOTE_CAP = 300;
/** Warm dust motes spread deterministically through the hall (drawn `n` of them). */
function moteGeometry(): BufferGeometry {
  const pos = new Float32Array(MOTE_CAP * 3);
  for (let i = 0; i < MOTE_CAP; i++) {
    pos[i * 3] = ((i * 73) % 100) / 100 * 12 - 6;
    pos[i * 3 + 1] = ((i * 37) % 100) / 100 * 5;
    pos[i * 3 + 2] = ((i * 53) % 100) / 100 * 6 - 3.5;
  }
  const geo = new BufferGeometry();
  geo.setAttribute("position", new BufferAttribute(pos, 3));
  return geo;
}
/** Rounded, bevelled card tile (lies flat, top face at y = 0.08); `k` is the geometry LOD. */
function tileGeometry(k: number): BufferGeometry {
  const s = 0.29, r = 0.08;
  const sh = new Shape();
  sh.moveTo(-s + r, -s); sh.lineTo(s - r, -s); sh.quadraticCurveTo(s, -s, s, -s + r);
  sh.lineTo(s, s - r); sh.quadraticCurveTo(s, s, s - r, s); sh.lineTo(-s + r, s);
  sh.quadraticCurveTo(-s, s, -s, s - r); sh.lineTo(-s, -s + r); sh.quadraticCurveTo(-s, -s, -s + r, -s);
  const geo = new ExtrudeGeometry(sh, { depth: 0.04, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02,
    bevelSegments: Math.max(1, Math.round(2 * k)), curveSegments: Math.max(2, Math.round(4 * k)) });
  geo.rotateX(-PI / 2);
  geo.translate(0, 0.02, 0);
  return geo;
}
/** Paper lantern profile (lathe), ribbed. */
function lanternGeometry(k: number): BufferGeometry {
  const pts: Vector2[] = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12, y = (t - 0.5) * 0.7;
    const rib = 1 + 0.035 * Math.cos(t * PI * 12);
    pts.push(new Vector2(Math.max(0.06, Math.sin(t * PI) * 0.3 * rib + 0.06 * (1 - Math.sin(t * PI))), y));
  }
  return new LatheGeometry(pts, Math.max(8, Math.round(16 * k)));
}

// -- the scene ---------------------------------------------------------------------------------------
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
const camera = new PerspectiveCamera(42, 4 / 3, 0.1, 100);
const cameraHome = new Vector3(0, 4.4, 9.2);
const cameraLook = new Vector3(0, 0.8, 0);
camera.position.copy(cameraHome);
camera.lookAt(cameraLook);

// Key light: warm directional with a shadow box fitted tightly around card, ball and pole.
const key = new DirectionalLight(0xfff2dd, 3.2);
key.position.set(4, 8, 5);
key.target.position.set(0, 0.6, 1.2);
Object.assign(key.shadow.camera, { left: -3.4, right: 3.4, top: 3.4, bottom: -3.4, near: 4, far: 16 });
key.shadow.camera.updateProjectionMatrix();
key.shadow.bias = -0.0004;
key.shadow.normalBias = 0.02;
key.shadow.radius = 3;
const hemi = new HemisphereLight(0x8899bb, 0x443355, 1.6);
// Warm glow over the call ball.
const ballLight = new PointLight(0xffc370, 30, 12, 1.8);
ballLight.position.set(0, 3.4, 1.5);
let ballLightBase = 30;
// Lantern-row fill from behind, tinted by the theme.
const lanternFill = new PointLight(0xffb454, 8, 14, 1.6);
lanternFill.position.set(0, 2.2, -3.2);
scene.add(key, key.target, hemi, ballLight, lanternFill);

const floor = new Mesh(new CylinderGeometry(7.5, 7.5, 0.2, 64), new MeshStandardMaterial({ color: 0x2b2135, roughness: 0.9 }) as Material);
floor.position.y = -0.1;
floor.receiveShadow = true;
const board = new Mesh(new BoxGeometry(3.95, 0.06, 3.95), new MeshPhysicalMaterial({ color: 0x5a1c1c, roughness: 0.45, clearcoat: 0.8, clearcoatRoughness: 0.2 }) as Material);
board.position.set(0, 0, 1.9);
board.receiveShadow = true;
// The call ball: the number drawn into one canvas used as its map and emissive map.
const ballCanvas = new OffscreenCanvas(256, 256);
const ballTexture = new CanvasTexture(ballCanvas);
ballTexture.colorSpace = SRGBColorSpace;
const ballParams = (): Record<string, unknown> => ({ color: 0xfff4e0, roughness: 0.3, map: ballTexture, emissive: 0xffffff, emissiveMap: ballTexture, emissiveIntensity: 0.85 });
const ball = new Mesh(new SphereGeometry(0.85, 48, 32), new MeshPhysicalMaterial(ballParams()) as Material);
ball.position.set(0, 2.6, 0);
ball.rotation.y = -PI / 2; // the number faces the camera
ball.castShadow = true;
const pole = new Mesh(new CylinderGeometry(0.05, 0.05, 2.2, 12), new MeshStandardMaterial({ color: 0x554433, roughness: 0.8 }) as Material);
pole.position.set(0, 1.0, 0);
pole.castShadow = true;
// The 3D card (the click layer mirroring the UI card).
const boxGeo = new BoxGeometry(0.62, 0.08, 0.62);
boxGeo.translate(0, 0.04, 0);
let tileGeo: BufferGeometry | null = null;
const cells: Mesh[] = [];
for (let i = 0; i < CELLS; i++) {
  const r = Math.floor(i / GRID), c = i % GRID;
  const m = new Mesh(boxGeo, new MeshPhysicalMaterial({ color: 0x2b3a67, roughness: 0.6 }) as Material);
  m.position.set((c - 2) * 0.72, 0, 1.9 + (r - 2) * 0.72);
  m.castShadow = true;
  m.receiveShadow = true;
  m.userData = { cell: i };
  cells.push(m);
}
const moteGeo = moteGeometry();
const motes = new Points(moteGeo, new PointsMaterial({ color: 0xffc98a, size: 0.05, transparent: true, opacity: 0.6, depthWrite: false, blending: AdditiveBlending }));
motes.renderOrder = -10;
scene.add(floor, board, ball, pole, ...cells, motes);

let lanterns: InstancedMesh | null = null;
let lanternCaps: InstancedMesh | null = null;
let lanternData: { x: number; y: number; z: number; phase: number }[] = [];
let look: Look | null = null;
let theme: Theme = THEMES[0]!;
let lanternColor = theme.lantern;
let floorTex: Texture | null = null;
let envTex: Texture | null = null;
let reducedMotion = false;
let budgetKey = "";
let marksKey = "";

function disposeMat(m: Material): void { try { m.dispose(); } catch { /* gone */ } }
function buildLanterns(): void {
  for (const m of [lanterns, lanternCaps]) if (m) { scene.remove(m); m.geometry.dispose(); disposeMat(m.material as Material); }
  lanterns = lanternCaps = null;
  if (!look) return;
  const count = LANTERN_COUNT[look.lanterns];
  const detailed = look.detailed;
  const b = look.budget;
  const k = b.segments;
  let geo: BufferGeometry;
  if (detailed) geo = lanternGeometry(k);
  else { geo = new SphereGeometry(0.28, Math.max(6, Math.round(12 * k)), Math.max(5, Math.round(10 * k))); geo.scale(1, 1.25, 1); }
  const mat = hallMaterial(b.material, { color: lanternColor, emissive: lanternColor, emissiveIntensity: detailed ? 2.2 : 1.5, roughness: 0.5 });
  lanterns = new InstancedMesh(geo, mat, count);
  if (detailed) {
    const capGeo = new CylinderGeometry(0.1, 0.12, 0.06, Math.max(6, Math.round(10 * k)));
    lanternCaps = new InstancedMesh(capGeo, hallMaterial(b.material, { color: 0x2a1a14, roughness: 0.5, metalness: 0.3 }), count * 2);
  }
  lanternData = [];
  const rows = Math.ceil(count / 8);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / 8), col = i % 8;
    lanternData.push({ x: (col - 3.5) * 1.5 + (row % 2) * 0.75, y: 3.5 + ((i * 37) % 10) / 16, z: -1.6 - row * (3.4 / Math.max(1, rows)), phase: (i * 0.77) % (PI * 2) });
  }
  placeLanterns(0);
  scene.add(lanterns);
  if (lanternCaps) scene.add(lanternCaps);
}
const dummy = new Object3D();
function placeLanterns(t: number): void {
  if (!lanterns) return;
  for (let i = 0; i < lanternData.length; i++) {
    const d = lanternData[i]!;
    const x = d.x + (t ? Math.sin(t * 0.6 + d.phase) * 0.08 : 0);
    const y = d.y + (t ? Math.sin(t * 0.8 + d.phase) * 0.05 : 0);
    const tilt = t ? Math.sin(t * 0.6 + d.phase) * 0.05 : 0;
    dummy.position.set(x, y, d.z);
    dummy.rotation.set(0, 0, tilt);
    dummy.updateMatrix();
    lanterns.setMatrixAt(i, dummy.matrix);
    if (lanternCaps) {
      for (const [kk, dy] of [[0, 0.36], [1, -0.36]] as const) {
        dummy.position.set(x - Math.sin(tilt) * dy, y + dy, d.z);
        dummy.updateMatrix();
        lanternCaps.setMatrixAt(i * 2 + kk, dummy.matrix);
      }
    }
  }
  lanterns.instanceMatrix.needsUpdate = true;
  if (lanternCaps) lanternCaps.instanceMatrix.needsUpdate = true;
}

function applyTheme(): void {
  scene.background = new Color(theme.bg);
  scene.fog = new Fog(theme.bg, 12, 26);
  const fm = floor.material as MeshStandardMaterial;
  fm.color.setHex(theme.floor);
  if (fm.map) fm.color.multiplyScalar(1.3); // the texture is mid-grey
  lanternFill.color.setHex(theme.lantern);
  lanternColor = theme.lantern;
  if (lanterns) {
    const m = lanterns.material as MeshStandardMaterial;
    m.color.setHex(theme.lantern);
    m.emissive.setHex(theme.lantern);
  }
}
/** Rebuilds the hall's meshes for a look's budget (materials keep their colours). */
function applyBudget(): void {
  const b = look!.budget;
  const seg = (n: number, min: number): number => Math.max(min, Math.round(n * b.segments));
  const swap = (mesh: Mesh, params: Record<string, unknown>, phys?: Record<string, unknown>): void => {
    const old = mesh.material as MeshStandardMaterial;
    const next = hallMaterial(b.material, params, phys) as MeshStandardMaterial;
    if (old.emissive && next.emissive) next.emissive.copy(old.emissive);
    mesh.material = next;
    disposeMat(old);
  };
  floor.geometry.dispose();
  floor.geometry = new CylinderGeometry(7.5, 7.5, 0.2, seg(64, 16));
  swap(floor, { color: theme.floor, roughness: 0.9 });
  if (floorTex) { floorTex.dispose(); floorTex = null; }
  swap(board, { color: 0x5a1c1c, roughness: 0.45 }, { clearcoat: 0.8, clearcoatRoughness: 0.2 });
  ball.geometry.dispose();
  ball.geometry = new SphereGeometry(0.85, seg(48, 16), seg(32, 10));
  swap(ball, ballParams(), {});
  pole.geometry.dispose();
  pole.geometry = new CylinderGeometry(0.05, 0.05, 2.2, seg(12, 6));
  swap(pole, { color: 0x554433, roughness: 0.8 });
  if (tileGeo) { tileGeo.dispose(); tileGeo = null; }
  for (const m of cells) swap(m, { color: (m.material as MeshStandardMaterial).color.getHex(), roughness: 0.6 }, {});
  marksKey = "";
}

/** Applies a quality look (from the runtime's tier) live. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  look = next;
  const b = next.budget;
  const bk = [b.material, b.segments, b.floor].join("|");
  if (bk !== budgetKey) { budgetKey = bk; applyBudget(); }
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  key.castShadow = shadows;
  if (shadows) key.shadow.mapSize = next.shadows;
  const detailed = next.detailed;
  buildLanterns();
  // Surface detail: textured floor, lacquered board, bevelled glossy tiles, brass pole, glossy ball.
  if (detailed && !floorTex) floorTex = floorTexture(b.floor);
  const fm = floor.material as MeshStandardMaterial;
  fm.map = detailed ? floorTex : null;
  fm.roughness = detailed ? 0.55 : 0.9;
  board.visible = detailed;
  if (detailed && !tileGeo) tileGeo = tileGeometry(b.segments);
  for (const m of cells) {
    m.geometry = detailed ? tileGeo! : boxGeo;
    const mm = m.material as MeshPhysicalMaterial;
    if ("clearcoat" in mm) { mm.clearcoat = detailed ? 0.8 : 0; mm.clearcoatRoughness = 0.15; }
    if ("roughness" in mm) mm.roughness = detailed ? 0.42 : 0.6;
  }
  const bm = ball.material as MeshPhysicalMaterial;
  if ("clearcoat" in bm) { bm.clearcoat = detailed ? 1 : 0; bm.clearcoatRoughness = 0.08; }
  bm.emissiveIntensity = detailed ? 0.3 : 0.85;
  const pm = pole.material as MeshStandardMaterial;
  pm.color.setHex(detailed ? 0xb08d57 : 0x554433);
  if ("metalness" in pm) { pm.metalness = detailed ? 0.85 : 0; pm.roughness = detailed ? 0.32 : 0.8; }
  motes.visible = next.animated;
  ballLightBase = detailed ? 14 : 30;
  ballLight.intensity = ballLightBase;
  ballLight.position.set(0, detailed ? 4.2 : 3.4, detailed ? 2.6 : 1.5);
  lanternFill.visible = detailed;
  // Reflections: RoomEnvironment image-based lighting.
  if (next.reflections && !envTex) {
    try {
      const room = new RoomEnvironment(renderer);
      room.position.y = -3.5; // three r183+
      envTex = new PMREMGenerator(renderer).fromScene(room, 0.04).texture;
    }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); }
  }
  scene.environment = next.reflections ? envTex : null;
  scene.environmentIntensity = 0.22;
  const hi = next.ao === "high";
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: 0.7, radius: 0.5, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: hi ? 16 : 8, resolution: b.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: hi ? 6 : 4, rings: 2, samples: hi ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only lantern paper, the ball's lit face and highlights bloom (UnrealBloomPass 0.45, 0.25, 2.0).
  renderer.bloom = next.bloom ? { strength: 0.45, radius: 0.25, threshold: 2.0, resolution: b.bloomRes } : null;
  // hall-post.js GradeShader (linear, before the output): a 0.22 S-curve, saturation 1.1,
  // warm highlights / cool shadows, the s * 0.97 + 0.02 lift with over-range light kept, the 0.26 vignette.
  renderer.grade = next.grade ? {
    space: "linear", contrast: 0.22, saturation: 1.1,
    shadows: [0.95, 0.97, 1.06], highlights: [1.05, 1.0, 0.94], split: [0.2, 0.8], levels: [0.97, 0.02], overRange: "keep",
    vignette: { amount: 0.26, inner: 0.3, outer: 0.85 },
  } : null;
  renderer.antialias = next.antialias;
  applyTheme();
  marksKey = "";
}

// -- the game's calls --------------------------------------------------------------------------------
let active = false;
let view: { x: number; y: number; w: number; h: number } | null = null;
/** Whether the hall draws (the play screen only). */
export function setActive(on: boolean): void { active = on; sync(); }
/** The hall's rectangle in window pixels, or null when collapsed (compact layouts). */
export function setView(rect: { x: number; y: number; w: number; h: number } | null, W: number, H: number): void {
  const next = rect && rect.w >= 8 && rect.h >= 8 ? rect : null;
  const same = (!next && !view) || (!!next && !!view && Math.abs(next.x - view.x) < 0.5 && Math.abs(next.y - view.y) < 0.5 && Math.abs(next.w - view.w) < 0.5 && Math.abs(next.h - view.h) < 0.5);
  if (!same || winW !== W || winH !== H) {
    view = next;
    winW = W; winH = H;
    // The window shows the hall's w × h image at (x, y): the image spans -x .. W-x.
    if (view) { camera.aspect = view.w / view.h; camera.updateProjectionMatrix(); }
    if (view) camera.setViewOffset(view.w, view.h, -view.x, -view.y, W, H);
  }
  sync();
}
let winW = 0, winH = 0;
function sync(): void { renderer.camera = active && view ? camera : null; }
export function hallRect(): { x: number; y: number; w: number; h: number } | null { return active ? view : null; }
export function setReducedMotion(on: boolean): void { reducedMotion = on; }
export function resetCamera(): void {
  camera.position.copy(cameraHome);
  camera.lookAt(cameraLook);
}
/** A round's theme. */
export function startRound(themeId: string): void {
  theme = THEMES.find((t) => t.id === themeId) || THEMES[0]!;
  applyTheme();
  marksKey = "";
}
let ballPop = 0;
/** The current call on the ball (0: blank). */
export function showCall(value: number): void {
  const ctx = ballCanvas.getContext("2d")!;
  const S = 256;
  ctx.fillStyle = "#fff2dc";
  ctx.fillRect(0, 0, S, S);
  if (value > 0) {
    // A lettered band like a real bingo ball.
    ctx.fillStyle = "#c0392b";
    ctx.fillRect(0, S * 0.3, S, S * 0.08);
    ctx.fillRect(0, S * 0.62, S, S * 0.08);
    ctx.fillStyle = "#1a2040";
    ctx.font = `bold ${S / 2}px sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText(String(value), S / 2, S * 0.53);
  }
  ballTexture.needsUpdate = true;
  ballPop = reducedMotion ? 0 : 1;
}
/** The 3D card's colours from the local seat's marks and markable cells. */
export function syncCells(marks: boolean[], markable: Set<number>): void {
  const k = marks.map((m, i) => (m ? "m" : markable.has(i) ? "c" : "-")).join("");
  if (k === marksKey) return;
  marksKey = k;
  for (let i = 0; i < CELLS; i++) {
    const mat = cells[i]!.material as MeshStandardMaterial;
    if (marks[i]) { mat.color.setHex(0xffb454); mat.emissive?.setHex(0x663300); }
    else if (markable.has(i)) { mat.color.setHex(0xffd7a0); mat.emissive?.setHex(0x553a00); }
    else { mat.color.setHex(0x2b3a67); mat.emissive?.setHex(0x000000); }
  }
}
const ray = new Raycaster();
/** The card cell under a window point in the hall's view, or -1. */
export function pick(x: number, y: number): number {
  if (!active || !view) return -1;
  if (x < view.x || y < view.y || x > view.x + view.w || y > view.y + view.h) return -1;
  ray.setFromCamera(pointerToNdc(x, y), camera);
  const hits = ray.intersectObjects(cells, false);
  return hits.length ? (hits[0]!.object.userData.cell as number) : -1;
}

let time = 0;
/** Each rendered frame: the lantern sway, the ball's bob and pop, the light flicker and the rising motes. */
export function update(dtIn: number): void {
  if (!active || !view || !look) return;
  const dt = Math.min(0.05, Math.max(0, dtIn));
  const moving = look.animated && !reducedMotion;
  if (moving) {
    time += dt;
    const t = time;
    placeLanterns(t);
    ball.position.y = 2.6 + Math.sin(t * 1.1) * 0.04;
    ball.rotation.y = -PI / 2 + Math.sin(t * 0.4) * 0.12;
    ballLight.intensity = ballLightBase * (0.94 + 0.06 * Math.sin(t * 7.3) * Math.sin(t * 3.1));
    const n = Math.min(MOTE_CAP, look.budget.motes);
    moteGeo.setDrawRange(0, n);
    const p = moteGeo.getAttribute("position") as BufferAttribute;
    const arr = p.array as Float32Array;
    for (let i = 0; i < n; i++) {
      let y = arr[i * 3 + 1]! + 0.004 * dt * 60;
      if (y > 5) y = 0;
      arr[i * 3 + 1] = y;
    }
    p.needsUpdate = true;
  }
  if (ballPop > 0) {
    ballPop = Math.max(0, ballPop - 0.04 * dt * 60);
    ball.scale.setScalar(1 + Math.sin(ballPop * PI) * 0.25);
  }
}
