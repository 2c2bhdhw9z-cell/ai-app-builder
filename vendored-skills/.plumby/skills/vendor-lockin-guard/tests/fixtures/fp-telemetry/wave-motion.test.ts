// FALSE POSITIVE guard (M-comment: bare `amplitude`): a physics variable, not an analytics SDK.
// The telemetry check is package-qualified, so a plain word like this must not fire.
export function wave(t: number) {
  const amplitude = 2.5;
  const frequency = 0.1;
  return amplitude * Math.sin(frequency * t);
}
