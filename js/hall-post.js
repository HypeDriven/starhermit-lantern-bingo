// Post-processing + image-based lighting for the 3D hall. Loaded on demand (dynamic import)
// only when a preset needs it, so Low never fetches these addons. Addons are vendored from
// three r185 (same revision as js/three.module.js) under js/vendor/three/addons/.
import * as THREE from './three.module.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// Colour grade + vignette (display-space colours in, display-space out): gentle S-curve,
// a touch more saturation, warm highlights / cool shadows, lifted blacks for legibility.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.26 } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = src.rgb;
      vec3 lc = clamp(c, 0.0, 1.0);
      vec3 s = mix(lc, lc * lc * (3.0 - 2.0 * lc), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.95, 0.97, 1.06), vec3(1.05, 1.0, 0.94), smoothstep(0.2, 0.8, l));
      s = s * 0.97 + 0.02;
      c = mix(c, s + max(c - 1.0, 0.0), uAmount);
      float d = length(vUv - 0.5);
      c *= 1.0 - uVignette * smoothstep(0.3, 0.85, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

/** Build the composer for resolved graphics `g`; returns null when no pass is needed. */
export function buildComposer(renderer, scene, camera, g, w, h, pixelRatio) {
  if (!g.post) return null;
  const pw = Math.max(1, Math.round(w * pixelRatio)), ph = Math.max(1, Math.round(h * pixelRatio));
  const target = new THREE.WebGLRenderTarget(pw, ph, {
    type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
  });
  const composer = new EffectComposer(renderer, target);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(w, h);
  composer.addPass(new RenderPass(scene, camera));
  if (g.ao !== 'off') {
    const ao = new GTAOPass(scene, camera, pw, ph);
    ao.output = GTAOPass.OUTPUT.Default;
    ao.blendIntensity = 0.7;
    ao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1.5, thickness: 1.0, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
    ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
    composer.addPass(ao);
  }
  if (g.bloom === 'on') {
    // High threshold: only lantern paper, the call ball's lit face and highlights bloom.
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.45, 0.25, 2.0));
  }
  if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
  composer.addPass(new OutputPass());
  if (g.antialias === 'smaa') composer.addPass(new SMAAPass());
  if (g.antialias === 'fxaa') composer.addPass(new FXAAPass());
  return composer;
}

/** PMREM-filtered RoomEnvironment for scene.environment (caller disposes the texture). */
export function buildEnvironment(renderer) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const tex = pmrem.fromScene(room, 0.04).texture;
  room.dispose?.();
  pmrem.dispose();
  return tex;
}
