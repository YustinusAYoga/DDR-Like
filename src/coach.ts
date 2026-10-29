import * as THREE from 'three';
import type { Point, TargetPose } from './game';

type BodyMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
const UP = new THREE.Vector3(0, 1, 0);

/** A deliberately simple mannequin; every visible limb uses the scoring pose. */
export class CoachRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.8, 1.8, 1.8, -1.8, 0.1, 30);
  private readonly shirt = new THREE.MeshStandardMaterial({ color: '#b7f66b', roughness: 0.42, metalness: 0.15 });
  private readonly white = new THREE.MeshStandardMaterial({ color: '#f2f6ff', roughness: 0.36, metalness: 0.2 });
  private readonly dark = new THREE.MeshStandardMaterial({ color: '#273448', roughness: 0.6 });
  private readonly accent = new THREE.MeshStandardMaterial({ color: '#64e9e9', emissive: '#20696d', emissiveIntensity: 0.4, roughness: 0.3 });
  private readonly sphere = new THREE.SphereGeometry(1, 16, 12);
  private readonly cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
  private readonly parts: Record<string, BodyMesh> = {};
  private readonly ringMaterial = new THREE.MeshBasicMaterial({ color: '#a5ed65', transparent: true, opacity: 0.5, side: THREE.DoubleSide });
  private lastWidth = 0;
  private lastHeight = 0;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'low-power' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.scene.background = new THREE.Color('#0e1420');
    this.camera.position.set(0, 0.12, 7);
    this.camera.lookAt(0, 0, 0);

    this.scene.add(new THREE.HemisphereLight('#d8f4ff', '#24304a', 2.8));
    const key = new THREE.DirectionalLight('#ffffff', 3);
    key.position.set(-3, 5, 4);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#62c4ff', 2);
    rim.position.set(3, 1, -2);
    this.scene.add(rim);

    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(1.38, 64),
      new THREE.MeshStandardMaterial({ color: '#1c2839', roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -1.43, 0);
    this.scene.add(floor);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.2, 1.215, 64), this.ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(0, -1.425, 0);
    this.scene.add(ring);
    const inner = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 0.858, 64),
      new THREE.MeshBasicMaterial({ color: '#364d65', side: THREE.DoubleSide }),
    );
    inner.rotation.x = -Math.PI / 2;
    inner.position.set(0, -1.424, 0);
    this.scene.add(inner);

    this.part('torso', this.cylinder, this.shirt);
    this.part('hips', this.sphere, this.dark);
    this.part('neck', this.cylinder, this.white);
    this.part('head', this.sphere, this.white);
    this.part('visor', this.sphere, this.dark);
    for (const side of ['left', 'right']) {
      this.part(`${side}UpperArm`, this.cylinder, this.shirt);
      this.part(`${side}Forearm`, this.cylinder, this.white);
      this.part(`${side}Thigh`, this.cylinder, this.dark);
      this.part(`${side}Shin`, this.cylinder, this.white);
      for (const joint of ['Shoulder', 'Elbow', 'Hip', 'Knee']) {
        this.part(`${side}${joint}`, this.sphere, joint === 'Shoulder' ? this.shirt : this.dark);
      }
      this.part(`${side}Hand`, this.sphere, this.accent);
      this.part(`${side}Foot`, this.sphere, this.dark);
    }
  }

  private part(name: string, geometry: THREE.BufferGeometry, material: THREE.MeshStandardMaterial): void {
    const mesh = new THREE.Mesh(geometry, material);
    this.parts[name] = mesh;
    this.scene.add(mesh);
  }

  private point(point: Point): THREE.Vector3 {
    return new THREE.Vector3((point.x - 0.5) * 3.2, (0.5 - point.y) * 3.2, 0);
  }

  private ball(name: string, position: THREE.Vector3, x: number, y = x, z = x): void {
    const mesh = this.parts[name];
    if (!mesh) return;
    mesh.position.copy(position);
    mesh.scale.set(x, y, z);
  }

  private bone(name: string, from: THREE.Vector3, to: THREE.Vector3, radius: number, depth = radius): void {
    const mesh = this.parts[name];
    if (!mesh) return;
    const direction = new THREE.Vector3().subVectors(to, from);
    const length = direction.length();
    mesh.position.copy(from).add(to).multiplyScalar(0.5);
    mesh.scale.set(radius, Math.max(length, 0.001), depth);
    if (length > 0.001) mesh.quaternion.setFromUnitVectors(UP, direction.divideScalar(length));
  }

  render(pose: TargetPose, beatPhase: number, color: string): void {
    if (this.disposed) return;
    const width = Math.max(1, this.canvas.clientWidth);
    const height = Math.max(1, this.canvas.clientHeight);
    if (width !== this.lastWidth || height !== this.lastHeight) {
      this.lastWidth = width;
      this.lastHeight = height;
      this.renderer.setSize(width, height, false);
      const halfHeight = Math.max(1.72, 1.55 / (width / height));
      this.camera.left = -halfHeight * width / height;
      this.camera.right = halfHeight * width / height;
      this.camera.top = halfHeight;
      this.camera.bottom = -halfHeight;
      this.camera.updateProjectionMatrix();
    }
    this.shirt.color.set(color);
    this.ringMaterial.opacity = 0.28 + 0.4 * Math.exp(-Math.max(0, beatPhase) * 7);

    const shoulder = this.point(pose.leftShoulder).add(this.point(pose.rightShoulder)).multiplyScalar(0.5);
    const hip = this.point(pose.leftHip).add(this.point(pose.rightHip)).multiplyScalar(0.5);
    this.bone('torso', hip, shoulder, 0.23, 0.15);
    this.ball('hips', hip, 0.23, 0.13, 0.15);
    const head = shoulder.clone().add(new THREE.Vector3(0, 0.31, 0));
    this.bone('neck', shoulder, head, 0.075);
    this.ball('head', head, 0.185, 0.215, 0.17);
    this.ball('visor', head.clone().add(new THREE.Vector3(0, 0.015, 0.145)), 0.135, 0.066, 0.04);

    for (const side of ['left', 'right'] as const) {
      const s = this.point(pose[`${side}Shoulder`]);
      const e = this.point(pose[`${side}Elbow`]);
      const w = this.point(pose[`${side}Wrist`]);
      const h = this.point(pose[`${side}Hip`]);
      const k = this.point(pose[`${side}Knee`]);
      const a = this.point(pose[`${side}Ankle`]);
      this.bone(`${side}UpperArm`, s, e, 0.082);
      this.bone(`${side}Forearm`, e, w, 0.065);
      this.bone(`${side}Thigh`, h, k, 0.105);
      this.bone(`${side}Shin`, k, a, 0.077);
      this.ball(`${side}Shoulder`, s, 0.092);
      this.ball(`${side}Elbow`, e, 0.073);
      this.ball(`${side}Hand`, w, 0.078, 0.095, 0.066);
      this.ball(`${side}Hip`, h, 0.105);
      this.ball(`${side}Knee`, k, 0.084);
      this.ball(`${side}Foot`, a.clone().add(new THREE.Vector3(0, -0.025, 0.035)), 0.105, 0.064, 0.16);
    }
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();
    this.scene.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        geometries.add(object.geometry as THREE.BufferGeometry);
        const material = object.material as THREE.Material | THREE.Material[];
        for (const item of Array.isArray(material) ? material : [material]) materials.add(item);
      }
    });
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    this.renderer.dispose();
    this.scene.clear();
  }
}
