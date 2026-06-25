/*
 * scene.js — three.js low-poly reactor core
 * 一顆 flat-shaded icosahedron + wireframe，顏色由外部（分數色）驅動：
 * setReactor(hexColor, energy) — energy 越高（分數越低）越攪動、越亮、轉越快。
 * initHero() 失敗回傳 null，由 app.js 切換靜態 fallback。
 */
import * as THREE from 'three';

const DEEP = new THREE.Color('#262c33');

export async function initHero(canvas) {
  if (!canvas) return null;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  } catch (e) {
    return null; // 無 WebGL
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
  camera.position.set(0, 0, 6.2);

  // ---- core mesh (low-poly, flat shaded) ----
  const geo = new THREE.IcosahedronGeometry(1.7, 1);
  const mat = new THREE.MeshStandardMaterial({
    color: new THREE.Color('#76ABAE'),
    emissive: new THREE.Color('#76ABAE'),
    emissiveIntensity: 0.2,
    metalness: 0.35,
    roughness: 0.45,
    flatShading: true,
  });
  const core = new THREE.Mesh(geo, mat);
  scene.add(core);

  const wire = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo),
    new THREE.LineBasicMaterial({ color: new THREE.Color('#76ABAE'), transparent: true, opacity: 0.35 })
  );
  core.add(wire);

  const cage = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(2.55, 0)),
    new THREE.LineBasicMaterial({ color: new THREE.Color('#76ABAE'), transparent: true, opacity: 0.14 })
  );
  scene.add(cage);

  // ---- particle dust ----
  const dustGeo = new THREE.BufferGeometry();
  const N = 90;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 3 + Math.random() * 2.5;
    const a = Math.random() * Math.PI * 2;
    const b = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(b) * Math.cos(a);
    pos[i * 3 + 1] = r * Math.sin(b) * Math.sin(a);
    pos[i * 3 + 2] = r * Math.cos(b);
  }
  dustGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const dust = new THREE.Points(dustGeo, new THREE.PointsMaterial({ color: new THREE.Color('#76ABAE'), size: 0.035, transparent: true, opacity: 0.5 }));
  scene.add(dust);

  // ---- lights ----
  scene.add(new THREE.AmbientLight(0xffffff, 0.35));
  const tealLight = new THREE.PointLight(0x76abae, 2.4, 30); tealLight.position.set(-4, 3, 4); scene.add(tealLight);
  const orangeLight = new THREE.PointLight(0xff5722, 1.6, 30); orangeLight.position.set(4, -3, 3); scene.add(orangeLight);

  // ---- externally driven state ----
  const targetColor = new THREE.Color('#76ABAE');
  const curColor = new THREE.Color('#76ABAE');
  let targetEnergy = 0.2, curEnergy = 0.2;

  // ---- pointer parallax ----
  const mouse = { x: 0, y: 0 };
  const onMove = (e) => {
    const r = canvas.getBoundingClientRect();
    mouse.x = ((e.clientX - r.left) / r.width - 0.5) * 2;
    mouse.y = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  window.addEventListener('pointermove', onMove);

  // ---- resize ----
  function resize() {
    const parent = canvas.parentElement;
    const w = parent.clientWidth, h = parent.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas.parentElement);
  resize();

  // ---- animation loop ----
  let raf, t = 0;
  function tick() {
    raf = requestAnimationFrame(tick);
    t += 0.016;

    curColor.lerp(targetColor, 0.06);
    curEnergy += (targetEnergy - curEnergy) * 0.06;
    const e = curEnergy;

    mat.color.copy(DEEP).lerp(curColor, 0.6);
    mat.emissive.copy(curColor);
    mat.emissiveIntensity = 0.18 + e * 0.7 + Math.sin(t * (2 + e * 4)) * (0.04 + e * 0.1);
    wire.material.color.copy(curColor);
    cage.material.color.copy(curColor);
    dust.material.color.copy(curColor);

    const speed = 0.0025 + e * 0.005;
    core.rotation.y += speed;
    core.rotation.x += speed * 0.4;
    cage.rotation.y -= 0.0015;
    cage.rotation.x += 0.0008;
    dust.rotation.y += 0.0006;

    const s = 1 + Math.sin(t * (1.5 + e * 3)) * (0.012 + e * 0.035);
    core.scale.setScalar(s);

    camera.position.x += (mouse.x * 0.6 - camera.position.x) * 0.05;
    camera.position.y += (-mouse.y * 0.5 - camera.position.y) * 0.05;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }
  tick();

  return {
    setReactor(hex, energy) {
      if (hex) targetColor.set(hex);
      if (typeof energy === 'number') targetEnergy = Math.max(0, Math.min(1, energy));
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      ro.disconnect();
      renderer.dispose();
    },
  };
}
