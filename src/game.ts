/** Coordinates use a square/isotropic image plane: x right, y down. */
export interface Point {
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
}

export interface TargetPose {
  readonly leftShoulder: Point;
  readonly rightShoulder: Point;
  readonly leftElbow: Point;
  readonly rightElbow: Point;
  readonly leftWrist: Point;
  readonly rightWrist: Point;
  readonly leftHip: Point;
  readonly rightHip: Point;
  readonly leftKnee: Point;
  readonly rightKnee: Point;
  readonly leftAnkle: Point;
  readonly rightAnkle: Point;
}

export interface RoutineMove {
  readonly id: string;
  readonly name: string;
  readonly startBeat: number;
  readonly durationBeats: number;
  readonly energy: number;
}

export type Judgment = "Perfect" | "Good" | "OK" | "Miss" | "Tracking";

const library = [
  { id: "step-touch", name: "Step touch", energy: 0.25 },
  { id: "side-reach", name: "Side reach", energy: 0.45 },
  { id: "sky-reach", name: "Reach high", energy: 0.85 },
  { id: "wide-arms", name: "Open wide", energy: 0.65 },
] as const;

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * A deliberately small standing-only phrase library. Similar energy sections
 * repeat the same 16-beat motif instead of generating unlearnable random moves.
 * `energy` is an optional evenly spaced track envelope in [0, 1].
 */
export function generateRoutine(
  durationSec: number,
  bpm: number,
  offsetSec: number,
  energy?: readonly number[],
): RoutineMove[] {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
  if (!Number.isFinite(bpm) || bpm <= 0 || !Number.isFinite(offsetSec)) {
    throw new RangeError("BPM must be positive and timing values must be finite.");
  }
  const totalBeats = Math.max(0, (durationSec - offsetSec) * bpm / 60);
  // The prototype intentionally bounds routines to avoid accidental huge arrays.
  if (totalBeats > 100_000) throw new RangeError("Track is too long.");
  const result: RoutineMove[] = [];
  for (let startBeat = 0; startBeat < totalBeats - 1e-8; startBeat += 4) {
    const phraseIndex = Math.floor(startBeat / 4);
    const blockStartSec = offsetSec + Math.floor(startBeat / 16) * 16 * 60 / bpm;
    let level = 0.5;
    if (energy && energy.length > 0) {
      const index = clamp(Math.floor(blockStartSec / durationSec * energy.length), 0, energy.length - 1);
      const sample = energy[index];
      if (sample !== undefined && Number.isFinite(sample)) level = clamp(sample, 0, 1);
    }
    const motif = level < 0.35 ? [0, 1, 0, 3] : level > 0.7 ? [2, 3, 1, 2] : [0, 3, 1, 2];
    const move = library[motif[phraseIndex % 4] ?? 0] ?? library[0];
    result.push({ ...move, startBeat, durationBeats: Math.min(4, totalBeats - startBeat) });
  }
  return result;
}

const point = (x: number, y: number): Point => ({ x, y, confidence: 1 });

function neutral(): TargetPose {
  return {
    leftShoulder: point(0.60, 0.29), rightShoulder: point(0.40, 0.29),
    leftElbow: point(0.63, 0.43), rightElbow: point(0.37, 0.43),
    leftWrist: point(0.65, 0.56), rightWrist: point(0.35, 0.56),
    leftHip: point(0.56, 0.51), rightHip: point(0.44, 0.51),
    leftKnee: point(0.57, 0.70), rightKnee: point(0.43, 0.70),
    leftAnkle: point(0.58, 0.90), rightAnkle: point(0.42, 0.90),
  };
}

const ease = (value: number): number => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

/** Sample absolute beat position. Every phrase returns to a planted neutral pose. */
export function targetPoseAt(move: RoutineMove, beat: number): TargetPose {
  const base = neutral();
  const phase = clamp(beat - move.startBeat, 0, move.durationBeats);
  const strength = ease(Math.min(phase / 0.55, (move.durationBeats - phase) / 0.55));
  const sway = Math.sin(phase * Math.PI / 2) * 0.035;
  let desired: TargetPose = base;

  if (move.id === "wide-arms") {
    desired = { ...base,
      leftElbow: point(0.74, 0.29), leftWrist: point(0.89, 0.29),
      rightElbow: point(0.26, 0.29), rightWrist: point(0.11, 0.29),
      leftAnkle: point(0.64, 0.90), rightAnkle: point(0.36, 0.90),
    };
  } else if (move.id === "sky-reach") {
    desired = { ...base,
      leftElbow: point(0.66, 0.16), leftWrist: point(0.70, 0.035),
      rightElbow: point(0.34, 0.16), rightWrist: point(0.30, 0.035),
      leftAnkle: point(0.64, 0.90), rightAnkle: point(0.36, 0.90),
    };
  } else if (move.id === "side-reach") {
    desired = { ...base,
      leftElbow: point(0.73, 0.23), leftWrist: point(0.85, 0.17),
      rightElbow: point(0.31, 0.41), rightWrist: point(0.43, 0.44),
      leftKnee: point(0.61, 0.70), leftAnkle: point(0.69, 0.90),
    };
  } else {
    // Slow side-to-side weight shifts; feet remain on the ground.
    desired = { ...base,
      leftElbow: point(0.69, 0.40), leftWrist: point(0.59, 0.44),
      rightElbow: point(0.31, 0.40), rightWrist: point(0.41, 0.44),
      leftKnee: point(0.58 + sway, 0.70), rightKnee: point(0.42 + sway, 0.70),
      leftAnkle: point(0.63, 0.90), rightAnkle: point(0.37, 0.90),
    };
  }

  const result = { ...base };
  for (const joint of Object.keys(base) as (keyof TargetPose)[]) {
    result[joint] = point(
      base[joint].x + (desired[joint].x - base[joint].x) * strength,
      base[joint].y + (desired[joint].y - base[joint].y) * strength,
    );
  }
  return result;
}

type Joint = keyof TargetPose;
type FeatureSpec = { readonly joints: readonly Joint[]; readonly weight: number; readonly group: "upper" | "lower" };
const features: readonly FeatureSpec[] = [
  { joints: ["leftShoulder", "leftElbow"], weight: 1.5, group: "upper" },
  { joints: ["leftElbow", "leftWrist"], weight: 1.5, group: "upper" },
  { joints: ["rightShoulder", "rightElbow"], weight: 1.5, group: "upper" },
  { joints: ["rightElbow", "rightWrist"], weight: 1.5, group: "upper" },
  { joints: ["leftHip", "leftKnee"], weight: 1, group: "lower" },
  { joints: ["leftKnee", "leftAnkle"], weight: 1, group: "lower" },
  { joints: ["rightHip", "rightKnee"], weight: 1, group: "lower" },
  { joints: ["rightKnee", "rightAnkle"], weight: 1, group: "lower" },
  { joints: ["leftShoulder", "leftElbow", "leftWrist"], weight: 0.7, group: "upper" },
  { joints: ["rightShoulder", "rightElbow", "rightWrist"], weight: 0.7, group: "upper" },
  { joints: ["leftHip", "leftKnee", "leftAnkle"], weight: 0.7, group: "lower" },
  { joints: ["rightHip", "rightKnee", "rightAnkle"], weight: 0.7, group: "lower" },
];

function featureVector(pose: Partial<TargetPose>, joints: readonly Joint[]): readonly [number, number, number] | null {
  const points = joints.map(joint => pose[joint]);
  if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.confidence) || p.confidence < 0.6)) return null;
  const first = points[0];
  const second = points[1];
  if (!first || !second) return null;
  let x = second.x - first.x;
  let y = second.y - first.y;
  const length = Math.hypot(x, y);
  if (length < 1e-6) return null;
  const confidence = Math.min(...points.map(p => p?.confidence ?? 0), 1);
  if (joints.length === 2) return [x / length, y / length, confidence];
  const third = points[2];
  if (!third) return null;
  x = third.x - second.x;
  y = third.y - second.y;
  const nextLength = Math.hypot(x, y);
  if (nextLength < 1e-6) return null;
  const cosine = clamp(((first.x - second.x) * x + (first.y - second.y) * y) / (length * nextLength), -1, 1);
  return [cosine, Math.sqrt(Math.max(0, 1 - cosine * cosine)), confidence];
}

/** Translation/scale invariant; pass isotropic coordinates, not stretched x/y. */
export function scorePose(target: TargetPose, player: Partial<TargetPose>): { similarity: number | null; coverage: number } {
  let total = 0;
  let visible = 0;
  let denominator = 0;
  let numerator = 0;
  const groups = { upper: { total: 0, visible: 0 }, lower: { total: 0, visible: 0 } };
  for (const feature of features) {
    const expected = featureVector(target, feature.joints);
    if (!expected) continue;
    total += feature.weight;
    groups[feature.group].total += feature.weight;
    const observed = featureVector(player, feature.joints);
    if (!observed) continue;
    visible += feature.weight;
    groups[feature.group].visible += feature.weight;
    const cosine = clamp(expected[0] * observed[0] + expected[1] * observed[1], -1, 1);
    const score = Math.max(0, 1 - Math.acos(cosine) / (Math.PI / 3));
    const weight = feature.weight * observed[2];
    denominator += weight;
    numerator += weight * score;
  }
  const coverage = total > 0 ? visible / total : 0;
  const groupCovered = Object.values(groups).every(g => g.total > 0 && g.visible / g.total >= 0.65);
  return {
    similarity: coverage >= 0.75 && groupCovered && denominator > 0 ? clamp(numerator / denominator, 0, 1) : null,
    coverage,
  };
}

export function gradeScore(similarity: number | null): Judgment {
  if (similarity === null || !Number.isFinite(similarity)) return "Tracking";
  if (similarity >= 0.9) return "Perfect";
  if (similarity >= 0.75) return "Good";
  if (similarity >= 0.55) return "OK";
  return "Miss";
}
