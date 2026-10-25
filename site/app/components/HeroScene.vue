<script setup lang="ts">
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const emit = defineEmits<{ ready: [] }>();

const container = useTemplateRef<HTMLDivElement>('container');
const colorMode = useColorMode();

// 4色の柔らかい光源を動かすグラデーション, 粒状の質感を加算
const backgroundShader = /* glsl */ `
	uniform vec3 uColor1;
	uniform vec3 uColor2;
	uniform vec3 uColor3;
	uniform vec3 uColor4;
	uniform float uTime;
	uniform vec2 uResolution;
	varying vec2 vUv;

	float hash(vec2 p) {
		vec3 q = fract(vec3(p.xyx) * 0.1031);
		q += dot(q, q.yzx + 33.33);
		return fract((q.x + q.y) * q.z);
	}

	float blob(vec2 uv, vec2 center) {
		return exp(-6.0 * dot(uv - center, uv - center));
	}

	void main() {
		float aspect = uResolution.x / uResolution.y;
		vec2 uv = vec2(vUv.x * aspect, vUv.y);
		float t = uTime * 0.05;
		float w1 = blob(uv, vec2(aspect * (0.2 + 0.1 * sin(t * 1.3)), 0.8 + 0.1 * cos(t)));
		float w2 = blob(uv, vec2(aspect * (0.75 + 0.1 * cos(t * 0.9)), 0.75 + 0.12 * sin(t * 1.1)));
		float w3 = blob(uv, vec2(aspect * (0.55 + 0.12 * sin(t * 0.7)), 0.2 + 0.1 * cos(t * 1.4)));
		float w4 = blob(uv, vec2(aspect * (0.1 + 0.08 * cos(t * 1.2)), 0.15 + 0.1 * sin(t * 0.8)));
		vec3 color = (uColor1 * w1 + uColor2 * w2 + uColor3 * w3 + uColor4 * w4 + uColor2 * 0.15) / (w1 + w2 + w3 + w4 + 0.15);
		color += (hash(gl_FragCoord.xy) - 0.5) * 0.025;
		gl_FragColor = vec4(color, 1.0);
		#include <colorspace_fragment>
	}
`;

// CSSの色指定をThree.jsの色へ, color-mix等も解決
function readColor(probe: HTMLElement, name: string) {
	probe.style.color = `var(${name})`;
	const canvas = document.createElement('canvas');
	canvas.width = canvas.height = 1;
	const context = canvas.getContext('2d')!;
	context.fillStyle = getComputedStyle(probe).color;
	context.fillRect(0, 0, 1, 1);
	const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
	return new THREE.Color().setRGB(r! / 255, g! / 255, b! / 255, THREE.SRGBColorSpace);
}

let cleanup: (() => void) | undefined;
let disposed = false;

onMounted(async () => {
	const element = container.value;
	if (!element) return;

	const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.toneMapping = THREE.NeutralToneMapping;
	element.appendChild(renderer.domElement);

	const scene = new THREE.Scene();
	const pmrem = new THREE.PMREMGenerator(renderer);
	scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

	const gltf = await new GLTFLoader().loadAsync('/models/hero.glb');
	if (disposed) {
		pmrem.dispose();
		renderer.dispose();
		renderer.domElement.remove();
		return;
	}

	const source = gltf.cameras[0] as THREE.PerspectiveCamera | undefined;
	const camera = source ? source.clone() : new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 100);
	camera.far = 200;
	scene.add(camera);
	const baseFov = camera.fov;
	const baseAspect = 16 / 9;

	// 透過の屈折先として不透明な背景面をカメラに固定
	const backgroundMaterial = new THREE.ShaderMaterial({
		uniforms: {
			uColor1: { value: new THREE.Color() },
			uColor2: { value: new THREE.Color() },
			uColor3: { value: new THREE.Color() },
			uColor4: { value: new THREE.Color() },
			uTime: { value: 0 },
			uResolution: { value: new THREE.Vector2(1, 1) },
		},
		vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
		fragmentShader: backgroundShader,
		toneMapped: false,
		depthWrite: false,
	});
	const backgroundPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), backgroundMaterial);
	backgroundPlane.position.z = -120;
	backgroundPlane.renderOrder = -1;
	camera.add(backgroundPlane);

	const glass = new THREE.MeshPhysicalMaterial({
		vertexColors: true,
		transmission: 1,
		thickness: 0.9,
		roughness: 0.06,
		ior: 1.32,
		iridescence: 1,
		iridescenceIOR: 1.35,
		iridescenceThicknessRange: [120, 640],
		clearcoat: 1,
		clearcoatRoughness: 0.05,
		envMapIntensity: 1.1,
	});

	const pivot = new THREE.Group();
	gltf.scene.traverse((object) => {
		if (object instanceof THREE.Mesh) object.material = glass;
	});
	pivot.add(gltf.scene);
	scene.add(pivot);

	const probe = document.createElement('span');
	probe.hidden = true;
	element.appendChild(probe);

	// _toneの値ごとに透過色を設定
	function applyPalette() {
		const uniforms = backgroundMaterial.uniforms;
		for (const index of [1, 2, 3, 4]) uniforms[`uColor${index}`]!.value.copy(readColor(probe, `--c-hero-gradient-${index}`));
		const tones = [0, 1, 2].map((index) => readColor(probe, `--c-hero-tone-${index}`).lerp(new THREE.Color(1, 1, 1), 0.55));
		gltf.scene.traverse((object) => {
			if (!(object instanceof THREE.Mesh)) return;
			const geometry = object.geometry as THREE.BufferGeometry;
			const tone = geometry.getAttribute('_tone');
			if (!tone) return;
			const colors = new Float32Array(tone.count * 3);
			for (let i = 0; i < tone.count; i++) tones[Math.round(tone.getX(i))]!.toArray(colors, i * 3);
			geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
		});
	}

	function resize() {
		const { clientWidth: width, clientHeight: height } = element!;
		renderer.setSize(width, height, false);
		renderer.domElement.style.width = '100%';
		renderer.domElement.style.height = '100%';
		camera.aspect = width / height;
		// 幅の狭い画面では水平画角を維持
		const horizontal = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseFov) / 2) * baseAspect);
		camera.fov = camera.aspect < baseAspect ? THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(horizontal / 2) / camera.aspect)) : baseFov;
		camera.updateProjectionMatrix();
		const planeHeight = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * -backgroundPlane.position.z;
		backgroundPlane.scale.set(planeHeight * camera.aspect, planeHeight, 1);
		backgroundMaterial.uniforms.uResolution!.value.set(width, height);
	}

	const pointer = new THREE.Vector2();
	function onPointerMove(event: PointerEvent) {
		pointer.set((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
	}

	const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
	const clock = new THREE.Clock();
	let visible = true;
	let frame = 0;

	function render() {
		const t = clock.getElapsedTime();
		if (!reduceMotion) {
			pivot.rotation.y = THREE.MathUtils.lerp(pivot.rotation.y, Math.sin(t * 0.25) * 0.15 + pointer.x * 0.1, 0.05);
			pivot.rotation.x = THREE.MathUtils.lerp(pivot.rotation.x, Math.cos(t * 0.2) * 0.06 + pointer.y * 0.06, 0.05);
			pivot.position.y = Math.sin(t * 0.5) * 0.15;
			backgroundMaterial.uniforms.uTime!.value = t;
		}
		renderer.render(scene, camera);
	}

	function loop() {
		if (visible) render();
		frame = reduceMotion ? 0 : requestAnimationFrame(loop);
	}

	const stopColorWatch = watch(
		() => colorMode.value,
		() =>
			nextTick(() => {
				applyPalette();
				render();
			}),
	);
	const resizeObserver = new ResizeObserver(() => {
		resize();
		render();
	});
	resizeObserver.observe(element);
	const intersectionObserver = new IntersectionObserver(([entry]) => (visible = Boolean(entry?.isIntersecting)));
	intersectionObserver.observe(element);
	window.addEventListener('pointermove', onPointerMove, { passive: true });

	applyPalette();
	resize();
	loop();
	emit('ready');

	cleanup = () => {
		cancelAnimationFrame(frame);
		stopColorWatch();
		resizeObserver.disconnect();
		intersectionObserver.disconnect();
		window.removeEventListener('pointermove', onPointerMove);
		gltf.scene.traverse((object) => {
			if (object instanceof THREE.Mesh) object.geometry.dispose();
		});
		glass.dispose();
		backgroundMaterial.dispose();
		backgroundPlane.geometry.dispose();
		scene.environment?.dispose();
		pmrem.dispose();
		renderer.dispose();
		renderer.domElement.remove();
		probe.remove();
	};
});

onBeforeUnmount(() => {
	disposed = true;
	cleanup?.();
});
</script>

<template>
	<div ref="container" class="absolute inset-0" aria-hidden="true" />
</template>
