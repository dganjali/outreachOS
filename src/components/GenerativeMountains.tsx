import { useRef, useEffect } from 'react';
import * as THREE from 'three';

/**
 * GenerativeMountains
 *
 * A slowly-undulating particle terrain for the landing hero, generated with a
 * Perlin-noise vertex shader (three.js). Rendered as a field of soft dots -
 * mostly white with subtle green highlights on the crests - over the dark hero
 * gradient, fading out at the top (horizon) so it dissolves cleanly.
 *
 * Built to run on all devices:
 *  - sizes to its CONTAINER (ResizeObserver), not the window
 *  - skips entirely if WebGL is unavailable (the CSS gradient behind it shows)
 *  - honours prefers-reduced-motion (renders a single static frame, no loop)
 *  - pauses the render loop when scrolled offscreen or the tab is hidden
 *  - caps the device pixel ratio and only reacts to fine pointers (mouse/pen)
 */
export function GenerativeMountains({ className }: { className?: string }) {
  const mountRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const currentMount = mountRef.current;
    if (!currentMount) return;

    // Bail out gracefully if the browser/device can't do WebGL.
    const probe = document.createElement('canvas');
    const hasWebGL = !!(
      probe.getContext('webgl2') ||
      probe.getContext('webgl') ||
      probe.getContext('experimental-webgl')
    );
    if (!hasWebGL) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const finePointer = window.matchMedia('(pointer: fine)').matches;
    const pixelRatio = Math.min(window.devicePixelRatio, 2);

    const width = currentMount.clientWidth || 1;
    const height = currentMount.clientHeight || 1;

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 100);
    camera.position.set(0, 1.5, 3);
    camera.rotation.x = -0.3;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(pixelRatio);
    renderer.domElement.style.width = '100%';
    renderer.domElement.style.height = '100%';
    renderer.domElement.style.display = 'block';
    currentMount.appendChild(renderer.domElement);

    const geometry = new THREE.PlaneGeometry(12, 8, 140, 140);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        time: { value: 0 },
        pointLightPosition: { value: new THREE.Vector3(0, 0, 5) },
        pixelRatio: { value: pixelRatio },
        size: { value: 6.0 },
        // mostly white dots with a restrained green highlight on the crests
        baseColor: { value: new THREE.Color('#d7e3dd') },
        crestColor: { value: new THREE.Color('#3fd089') },
      },
      vertexShader: `
        uniform float time;
        uniform float size;
        uniform float pixelRatio;
        varying float vDisplacement;
        varying vec3 vNormal;
        varying vec3 vPosition;

        // --- PERLIN NOISE FUNCTIONS ---
        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec4 permute(vec4 x) { return mod289(((x*34.0)+1.0)*x); }
        vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
        float snoise(vec3 v) {
            const vec2 C = vec2(1.0/6.0, 1.0/3.0);
            const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
            vec3 i = floor(v + dot(v, C.yyy));
            vec3 x0 = v - i + dot(i, C.xxx);
            vec3 g = step(x0.yzx, x0.xyz);
            vec3 l = 1.0 - g;
            vec3 i1 = min(g.xyz, l.zxy);
            vec3 i2 = max(g.xyz, l.zxy);
            vec3 x1 = x0 - i1 + C.xxx;
            vec3 x2 = x0 - i2 + C.yyy;
            vec3 x3 = x0 - D.yyy;
            i = mod289(i);
            vec4 p = permute(permute(permute(
                      i.z + vec4(0.0, i1.z, i2.z, 1.0))
                    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
                    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
            float n_ = 0.142857142857;
            vec3 ns = n_ * D.wyz - D.xzx;
            vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
            vec4 x_ = floor(j * ns.z);
            vec4 y_ = floor(j - 7.0 * x_);
            vec4 x = x_ * ns.x + ns.yyyy;
            vec4 y = y_ * ns.x + ns.yyyy;
            vec4 h = 1.0 - abs(x) - abs(y);
            vec4 b0 = vec4(x.xy, y.xy);
            vec4 b1 = vec4(x.zw, y.zw);
            vec4 s0 = floor(b0) * 2.0 + 1.0;
            vec4 s1 = floor(b1) * 2.0 + 1.0;
            vec4 sh = -step(h, vec4(0.0));
            vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
            vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
            vec3 p0 = vec3(a0.xy, h.x);
            vec3 p1 = vec3(a0.zw, h.y);
            vec3 p2 = vec3(a1.xy, h.z);
            vec3 p3 = vec3(a1.zw, h.w);
            vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
            p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
            vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
            m = m * m;
            return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
        }

        void main() {
            vNormal = normal;
            vPosition = position;

            float noiseFreq = 0.8;
            float noiseAmp = 0.6;

            // Layer 1: Base shape
            float displacement = snoise(vec3(position.x * noiseFreq, position.y * noiseFreq - time * 0.2, 0.0)) * noiseAmp;
            // Layer 2: Detail
            displacement += snoise(vec3(position.x * noiseFreq * 2.0, position.y * noiseFreq * 2.0 - time * 0.2, 0.0)) * (noiseAmp * 0.5);
            vDisplacement = displacement;

            vec3 newPosition = position + normal * displacement;
            vec4 mvPosition = modelViewMatrix * vec4(newPosition, 1.0);
            gl_Position = projectionMatrix * mvPosition;

            // perspective-scaled point size (nearer dots larger)
            gl_PointSize = size * pixelRatio * (1.0 / -mvPosition.z);
        }
      `,
      fragmentShader: `
        uniform vec3 baseColor;
        uniform vec3 crestColor;
        uniform vec3 pointLightPosition;
        varying float vDisplacement;
        varying vec3 vNormal;
        varying vec3 vPosition;

        void main() {
            // round, soft-edged dot
            vec2 uv = gl_PointCoord - 0.5;
            float d = length(uv);
            if (d > 0.5) discard;
            float dot_alpha = smoothstep(0.5, 0.32, d);

            // height factor: crests greener, valleys whiter
            float h = clamp(vDisplacement * 0.6 + 0.5, 0.0, 1.0);

            // gentle light interaction so crests facing the light catch the green
            vec3 normal = normalize(vNormal);
            vec3 lightDir = normalize(pointLightPosition - vPosition);
            float diffuse = max(dot(normal, lightDir), 0.0);

            vec3 color = mix(baseColor, crestColor, smoothstep(0.45, 0.95, h) * (0.45 + 0.55 * diffuse));

            // overall brightness: valleys dimmer, crests luminous
            float lum = 0.42 + 0.58 * h;

            // fade into the dark gradient toward the horizon (far = +y) and trim the very near edge
            float horizon = 1.0 - smoothstep(0.0, 3.6, vPosition.y);
            float nearTrim = smoothstep(-4.2, -3.4, vPosition.y);

            float alpha = dot_alpha * horizon * nearTrim * lum;
            gl_FragColor = vec4(color * lum, alpha);
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    points.rotation.x = -Math.PI / 2;
    scene.add(points);

    const target = new THREE.Vector3(0, 0, 5);
    const current = new THREE.Vector3(0, 0, 5);

    const renderOnce = () => renderer.render(scene, camera);

    let frameId = 0;
    let running = false;
    const animate = (t: number) => {
      material.uniforms.time.value = t * 0.0003;
      current.lerp(target, 0.06);
      material.uniforms.pointLightPosition.value.copy(current);
      renderer.render(scene, camera);
      frameId = requestAnimationFrame(animate);
    };

    const start = () => {
      if (running || reduceMotion) return;
      running = true;
      frameId = requestAnimationFrame(animate);
    };
    const stop = () => {
      running = false;
      if (frameId) cancelAnimationFrame(frameId);
      frameId = 0;
    };

    if (reduceMotion) {
      // Static, fully-formed terrain - no animation loop.
      material.uniforms.time.value = 1.0;
      renderOnce();
    } else {
      start();
    }

    // Resize to the container (handles rotation, responsive breakpoints, etc.).
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const w = Math.max(1, Math.floor(entry.contentRect.width));
      const h = Math.max(1, Math.floor(entry.contentRect.height));
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      if (reduceMotion) renderOnce();
    });
    ro.observe(currentMount);

    // Pause when the hero is scrolled out of view (battery / perf).
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        if (entry.isIntersecting) start();
        else stop();
      },
      { threshold: 0 }
    );
    io.observe(currentMount);

    const onVisibility = () => {
      if (document.hidden) stop();
      else if (!reduceMotion) start();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Light follows a fine pointer only; touch devices keep the default lighting.
    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      const x = (e.clientX / window.innerWidth) * 2 - 1;
      const y = -(e.clientY / window.innerHeight) * 2 + 1;
      target.set(x * 5, 2, 2 - y * 2);
    };
    if (finePointer) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
    }

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      if (finePointer) window.removeEventListener('pointermove', onPointerMove);
      if (renderer.domElement.parentNode === currentMount) {
        currentMount.removeChild(renderer.domElement);
      }
      geometry.dispose();
      material.dispose();
      renderer.dispose();
    };
  }, []);

  return <div ref={mountRef} aria-hidden className={className} />;
}

export default GenerativeMountains;
