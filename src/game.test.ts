import { describe, expect, it } from "vitest";
import { generateRoutine, gradeScore, scorePose, targetPoseAt, type TargetPose } from "./game";

const phrase = (id: string) => ({ id, name: id, startBeat: 0, durationBeats: 4, energy: 0.5 });

describe("routine generation", () => {
  it("is deterministic and covers the available song beats without overruns", () => {
    const moves = generateRoutine(63, 120, 1);
    expect(moves).toEqual(generateRoutine(63, 120, 1));
    expect(moves[0]?.startBeat).toBe(0);
    expect(moves.at(-1)!.startBeat + moves.at(-1)!.durationBeats).toBe(124);
    moves.slice(1).forEach((move, i) => {
      expect(move.startBeat).toBe(moves[i]!.startBeat + moves[i]!.durationBeats);
    });
    expect(new Set(moves.map(m => m.id)).size).toBeGreaterThan(1);
  });

  it("clips the final phrase, repeats motifs, and responds to track energy", () => {
    const moves = generateRoutine(35, 60, 0);
    expect(moves.at(-1)?.durationBeats).toBe(3);
    expect(moves.slice(0, 4).map(m => m.id)).toEqual(moves.slice(4, 8).map(m => m.id));
    expect(generateRoutine(20, 60, 0, [0]).map(m => m.id)).not.toEqual(generateRoutine(20, 60, 0, [1]).map(m => m.id));
    expect(generateRoutine(3, 120, 4)).toEqual([]);
    expect(() => generateRoutine(60, 0, 0)).toThrow(RangeError);
  });

  it("keeps all target coordinates valid and returns to neutral between moves", () => {
    for (const move of generateRoutine(32, 120, 0)) {
      const start = targetPoseAt(move, move.startBeat);
      const end = targetPoseAt(move, move.startBeat + move.durationBeats);
      expect(start).toEqual(end);
      for (let phase = 0; phase <= move.durationBeats; phase += 0.1) {
        for (const point of Object.values(targetPoseAt(move, move.startBeat + phase))) {
          expect(point.x).toBeGreaterThanOrEqual(0);
          expect(point.x).toBeLessThanOrEqual(1);
          expect(point.y).toBeGreaterThanOrEqual(0);
          expect(point.y).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe("pose scoring", () => {
  const target = targetPoseAt(phrase("sky-reach"), 2);

  it("recognizes identical poses independent of translation and uniform scale", () => {
    const transformed = Object.fromEntries(Object.entries(target).map(([joint, p]) => [joint, { ...p, x: p.x * 2 + 5, y: p.y * 2 - 2 }])) as unknown as TargetPose;
    expect(scorePose(target, transformed).similarity).toBeCloseTo(1);
    expect(scorePose(target, transformed).coverage).toBe(1);
  });

  it("penalizes arms in the wrong direction", () => {
    const wrong = targetPoseAt(phrase("step-touch"), 2);
    expect(scorePose(target, wrong).similarity).toBeLessThan(0.75);
  });

  it("requires both upper and lower body coverage", () => {
    const armOnly = { leftShoulder: target.leftShoulder, leftElbow: target.leftElbow, leftWrist: target.leftWrist };
    expect(scorePose(target, armOnly).similarity).toBeNull();
    const lowConfidence = { ...target, leftAnkle: { ...target.leftAnkle, confidence: 0.1 }, rightAnkle: { ...target.rightAnkle, confidence: 0.1 } };
    expect(scorePose(target, lowConfidence).similarity).toBeNull();
    expect(scorePose(target, {}).coverage).toBe(0);
    expect(gradeScore(null)).toBe("Tracking");
  });

  it("rejects invalid features and uses explicit grade thresholds", () => {
    expect(scorePose(target, { ...target, leftShoulder: { ...target.leftShoulder, x: Number.NaN }, rightShoulder: { ...target.rightShoulder, confidence: Number.NaN } }).similarity).toBeNull();
    expect([0.95, 0.8, 0.6, 0.2].map(gradeScore)).toEqual(["Perfect", "Good", "OK", "Miss"]);
  });
});
