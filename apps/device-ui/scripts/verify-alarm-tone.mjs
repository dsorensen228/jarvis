/**
 * Contract: morning alarm must be hard to sleep through at max Web Audio relative
 * volume (unity gain), not the old subtle sine at ~0.045 peak.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tonePath = path.join(__dirname, '..', 'src', 'timer', 'alarmTone.ts');
const source = fs.readFileSync(tonePath, 'utf8');

function fail(msg) {
  console.error(`verify-alarm-tone: ${msg}`);
  process.exit(1);
}

const peakMatch = source.match(/PEAK_GAIN\s*=\s*([0-9.]+)/);
if (!peakMatch) fail('missing PEAK_GAIN constant');
const peak = Number(peakMatch[1]);
if (!(peak >= 0.9 && peak <= 1.0)) {
  fail(`PEAK_GAIN must be near unity (0.9–1.0) for max relative volume; got ${peak}`);
}

if (/exponentialRampToValueAtTime\(\s*0\.0?45\b/.test(source)) {
  fail('legacy quiet peak gain 0.045 must not remain');
}

if (
  !/osc\.type\s*=\s*['"]square['"]/.test(source) &&
  !/OSC_TYPE[^=]*=\s*['"]square['"]/.test(source)
) {
  fail('alarm timbre must use square (or OSC_TYPE square) for attention-getting harmonics');
}

const lowMatch = source.match(/LOW_HZ\s*=\s*([0-9.]+)/);
const highMatch = source.match(/HIGH_HZ\s*=\s*([0-9.]+)/);
if (!lowMatch || !highMatch) fail('missing LOW_HZ / HIGH_HZ');
const low = Number(lowMatch[1]);
const high = Number(highMatch[1]);
if (!(low >= 800 && high > low && high <= 1600)) {
  fail(`expected assertive mid/high alarm band (800–1600 Hz); got ${low}/${high}`);
}

if (!/PATTERN_STEPS/.test(source) || !/STEP_MS/.test(source)) {
  fail('expected PATTERN_STEPS + STEP_MS paired beep pattern (not only a single soft blip loop)');
}
if (!/\brest\b/.test(source)) {
  fail('pattern must include a rest step so the alarm is pulsed, not a continuous tone');
}

console.log('verify-alarm-tone: ok');
