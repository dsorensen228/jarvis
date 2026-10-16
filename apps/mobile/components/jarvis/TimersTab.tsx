import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';

import { formatTimerClock, useTimer } from '../../contexts/TimerContext';
import { useTheme } from '../../contexts/ThemeContext';

function pad2(value: string) {
  return value.padStart(2, '0');
}

/** Strip to up to 2 digits while typing; no leading-zero padding. */
function sanitizeTwoDigitInput(value: string) {
  return value.replace(/\D/g, '').slice(0, 2);
}

/** On blur: clamp and pad (hours 0–99, minutes/seconds 0–59). */
function finalizeTimePart(raw: string, max: number) {
  const digits = raw.replace(/\D/g, '');
  const n = parseInt(digits === '' ? '0' : digits, 10);
  const clamped = Math.min(max, Math.max(0, Number.isNaN(n) ? 0 : n));
  return pad2(String(clamped));
}

function splitDuration(totalMs: number) {
  const totalSeconds = Math.max(0, Math.round(totalMs / 1000));
  const totalMinutes = Math.floor(totalSeconds / 60);
  return {
    minutes: Math.floor(totalMinutes % 60)
      .toString()
      .padStart(2, '0'),
    seconds: (totalSeconds % 60).toString().padStart(2, '0'),
    hours: Math.floor(totalMinutes / 60)
      .toString()
      .padStart(2, '0'),
  };
}

export function TimersTab() {
  const { colors } = useTheme();
  const {
    status,
    durationMs,
    remainingMs,
    startTimer,
    pauseTimer,
    resumeTimer,
    cancelTimer,
    dismissAlarm,
  } = useTimer();
  const [hours, setHours] = useState('00');
  const [minutes, setMinutes] = useState('10');
  const [seconds, setSeconds] = useState('00');

  const hasActiveTimer = status !== 'idle';
  const displayDuration = durationMs > 0 ? durationMs : 0;
  const durationParts = splitDuration(displayDuration);

  const start = () => {
    const totalMs =
      (parseInt(hours || '0', 10) * 3600 +
        parseInt(minutes || '0', 10) * 60 +
        parseInt(seconds || '0', 10)) *
      1000;

    if (totalMs <= 0) {
      return;
    }

    startTimer(totalMs);
  };

  if (status === 'alarming') {
    return (
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.centerWrap}>
          <View
            style={[
              styles.heroCard,
              {
                backgroundColor: colors.surface,
                borderColor: colors.accent,
              },
            ]}
          >
            <Text style={[styles.kicker, { color: colors.accent }]}>Timer</Text>
            <Text style={[styles.alarmTitle, { color: colors.text }]}>Time&apos;s up</Text>
            <Text style={[styles.clock, { color: colors.text }]}>00:00</Text>
            <Text style={[styles.meta, { color: colors.textMuted }]}>
              Your timer has completed. The alarm will stop automatically after 30
              seconds if you leave it alone.
            </Text>
            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: colors.accent }]}
              onPress={dismissAlarm}
            >
              <Text style={styles.primaryButtonText}>Dismiss timer</Text>
            </TouchableOpacity>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  if (hasActiveTimer) {
    return (
      <KeyboardAvoidingView
        style={[styles.container, { backgroundColor: colors.background }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.centerWrap}>
          <View
            style={[
              styles.heroCard,
              {
                backgroundColor: colors.surface,
                borderColor: colors.border,
              },
            ]}
          >
            <Text style={[styles.kicker, { color: colors.textMuted }]}>Timer</Text>
            <Text style={[styles.statusTitle, { color: colors.text }]}>
              {status === 'paused' ? 'Paused' : 'Counting down'}
            </Text>
            <Text style={[styles.clock, { color: colors.text }]}>
              {formatTimerClock(remainingMs)}
            </Text>
            <Text style={[styles.meta, { color: colors.textMuted }]}>
              Set for {durationParts.hours}:{durationParts.minutes}:{durationParts.seconds}
            </Text>
            <View style={styles.actionRow}>
              <TouchableOpacity
                style={[styles.primaryButton, { backgroundColor: colors.accent }]}
                onPress={status === 'paused' ? resumeTimer : pauseTimer}
              >
                <Text style={styles.primaryButtonText}>
                  {status === 'paused' ? 'Resume' : 'Pause'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[
                  styles.secondaryButton,
                  {
                    backgroundColor: '#090909',
                    borderColor: colors.border,
                  },
                ]}
                onPress={cancelTimer}
              >
                <Text style={[styles.secondaryButtonText, { color: colors.text }]}>
                  Cancel
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.centerWrap}>
        <View
          style={[
            styles.heroCard,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <Text style={[styles.kicker, { color: colors.textMuted }]}>Timer</Text>
          <Text style={[styles.statusTitle, { color: colors.text }]}>Set a timer</Text>
          <Text style={[styles.meta, { color: colors.textMuted }]}>
            Start one timer, leave the page if you want, and keep an eye on it from
            anywhere in the app.
          </Text>

          <View style={styles.timeRow}>
            <View style={styles.timeBlock}>
              <TextInput
                style={[
                  styles.timeInput,
                  {
                    backgroundColor: '#090909',
                    borderColor: colors.border,
                    color: colors.text,
                  },
                ]}
                value={hours}
                onChangeText={(value) => setHours(sanitizeTwoDigitInput(value))}
                onBlur={() => setHours((h) => finalizeTimePart(h, 99))}
                keyboardType="number-pad"
                maxLength={2}
                selectTextOnFocus
              />
              <Text style={[styles.timeLabel, { color: colors.textMuted }]}>hours</Text>
            </View>

            <Text style={[styles.separator, { color: colors.textMuted }]}>:</Text>

            <View style={styles.timeBlock}>
              <TextInput
                style={[
                  styles.timeInput,
                  {
                    backgroundColor: '#090909',
                    borderColor: colors.border,
                    color: colors.text,
                  },
                ]}
                value={minutes}
                onChangeText={(value) => setMinutes(sanitizeTwoDigitInput(value))}
                onBlur={() => setMinutes((m) => finalizeTimePart(m, 59))}
                keyboardType="number-pad"
                maxLength={2}
                selectTextOnFocus
              />
              <Text style={[styles.timeLabel, { color: colors.textMuted }]}>minutes</Text>
            </View>

            <Text style={[styles.separator, { color: colors.textMuted }]}>:</Text>

            <View style={styles.timeBlock}>
              <TextInput
                style={[
                  styles.timeInput,
                  {
                    backgroundColor: '#090909',
                    borderColor: colors.border,
                    color: colors.text,
                  },
                ]}
                value={seconds}
                onChangeText={(value) => setSeconds(sanitizeTwoDigitInput(value))}
                onBlur={() => setSeconds((s) => finalizeTimePart(s, 59))}
                keyboardType="number-pad"
                maxLength={2}
                selectTextOnFocus
              />
              <Text style={[styles.timeLabel, { color: colors.textMuted }]}>seconds</Text>
            </View>
          </View>

          <View style={styles.quickRow}>
            {[5, 10, 15, 25].map((preset) => (
              <TouchableOpacity
                key={preset}
                style={[
                  styles.quickChip,
                  {
                    backgroundColor: '#090909',
                    borderColor: colors.border,
                  },
                ]}
                onPress={() => {
                  setHours('00');
                  setMinutes(pad2(String(preset)));
                  setSeconds('00');
                }}
              >
                <Text style={[styles.quickChipText, { color: colors.text }]}>
                  {preset}m
                </Text>
              </TouchableOpacity>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.primaryButton, { backgroundColor: colors.accent }]}
            onPress={start}
          >
            <Text style={styles.primaryButtonText}>Start timer</Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minWidth: 0,
  },
  centerWrap: {
    flex: 1,
    justifyContent: 'center',
    minWidth: 0,
    padding: 20,
  },
  heroCard: {
    width: '100%',
    maxWidth: '100%',
    minWidth: 0,
    borderWidth: 1,
    borderRadius: 28,
    padding: 24,
    gap: 20,
  },
  kicker: {
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  statusTitle: {
    fontSize: 28,
    fontWeight: '700',
  },
  alarmTitle: {
    fontSize: 32,
    fontWeight: '800',
  },
  meta: {
    fontSize: 15,
    lineHeight: 22,
  },
  clock: {
    fontSize: 72,
    lineHeight: 78,
    fontWeight: '800',
    letterSpacing: -2,
  },
  timeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    minWidth: 0,
  },
  timeBlock: {
    flex: 1,
    minWidth: 0,
    alignItems: 'center',
    gap: 8,
  },
  timeInput: {
    width: '100%',
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 18,
    fontSize: 34,
    fontWeight: '700',
    textAlign: 'center',
  },
  timeLabel: {
    fontSize: 13,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
  },
  separator: {
    fontSize: 34,
    fontWeight: '700',
    paddingTop: 2,
  },
  quickRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  quickChip: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  quickChipText: {
    fontSize: 14,
    fontWeight: '600',
  },
  actionRow: {
    flexDirection: 'row',
    gap: 12,
    minWidth: 0,
  },
  primaryButton: {
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    minWidth: 0,
  },
  primaryButtonText: {
    color: '#f2ebff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
    flex: 1,
    minWidth: 0,
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: '700',
  },
});
