/**
 * Cosine distance between two vectors.
 *
 * Returns 1 - cos(θ) where θ is the angle between the vectors.
 *   0 = identical direction
 *   1 = orthogonal
 *   2 = opposite direction
 */
export function cosineDistance(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(
      `Vector length mismatch: a has ${a.length} elements, b has ${b.length}`,
    );
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0) {
    throw new Error("Vector a is a zero vector");
  }
  if (normB === 0) {
    throw new Error("Vector b is a zero vector");
  }

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));

  // Clamp to [-1, 1] to guard against floating-point overshoot
  if (similarity > 1) {
    return 0;
  }
  if (similarity < -1) {
    return 2;
  }

  return 1 - similarity;
}
