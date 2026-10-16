import { Ionicons } from '@expo/vector-icons';
import React, { useEffect, useState } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { formatTimerClock, useTimer } from '../../contexts/TimerContext';
import { useTheme } from '../../contexts/ThemeContext';
import { formatTimerDuration, formatTimerFinish } from '@/lib/timerFormat';
import { durationFromParts, MAX_TIMER_MS, splitDuration, timePart } from '@/lib/timerState';

const PRESETS = [60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 25 * 60_000, 60 * 60_000];
export function TimersTab() {
  const { colors } = useTheme();
  const timer = useTimer();
  const { width } = useWindowDimensions();
  const [parts, setParts] = useState(['00', '10', '00']);
  const [label, setLabel] = useState('');
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    if (!timer.ready || seeded) return;
    if (timer.durationMs) setParts(splitDuration(timer.durationMs));
    setLabel(timer.label); setSeeded(true);
  }, [timer.ready, timer.durationMs, timer.label, seeded]);
  useEffect(() => { setConfirmRestart(false); }, [timer.status]);
  const active = timer.status !== 'idle';
  const ringing = timer.status === 'alarming';
  const chosenDuration = durationFromParts(...parts as [string, string, string]);
  const ringSize = Math.min(252, Math.max(200, width - 84));
  const circumference = 2 * Math.PI * 106;
  const progress = timer.durationMs ? Math.max(0, Math.min(1, timer.remainingMs / timer.durationMs)) : 0;
  const start = () => { if (!timer.ready || !chosenDuration) return; Keyboard.dismiss(); timer.startTimer(chosenDuration, label); };
  const button = (title: string, onPress: () => void, options: { primary?: boolean; disabled?: boolean; icon?: React.ComponentProps<typeof Ionicons>['name'] } = {}) => (
    <Pressable accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: !!options.disabled }} disabled={options.disabled}
      onPress={onPress} style={({ pressed }) => [styles.button, { borderColor: options.primary ? colors.accent : colors.borderLight,
        backgroundColor: options.primary ? colors.accent : colors.surfaceElevated, opacity: options.disabled ? 0.4 : pressed ? 0.75 : 1 }]}>
      {options.icon && <Ionicons name={options.icon} size={19} color={options.primary ? '#fff' : colors.text} />}
      <Text style={[styles.buttonText, { color: options.primary ? '#fff' : colors.text }]}>{title}</Text>
    </Pressable>
  );
  return (
    <KeyboardAvoidingView style={[styles.fill, { backgroundColor: colors.background }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>
        <View style={styles.content}>
          <View style={styles.heading}>
            <View style={[styles.iconBadge, { backgroundColor: `${colors.accent}20` }]}><Ionicons name="timer-outline" size={26} color={colors.accentMuted} /></View>
            <Text style={[styles.title, { color: colors.text }]}>Timer</Text>
          </View>
          <View style={[styles.card, { borderColor: ringing ? colors.accent : colors.border, backgroundColor: colors.surface }]}>
            {active ? <>
              <View style={styles.center}>
                <Text accessibilityLiveRegion="polite" style={[styles.eyebrow, { color: ringing ? colors.accentMuted : colors.textMuted }]}>
                  {ringing ? "Time’s up" : timer.status === 'paused' ? 'Paused' : 'Counting down'}
                </Text>
                <Text numberOfLines={2} style={[styles.timerLabel, { color: colors.text }]}>{timer.label || 'Timer'}</Text>
              </View>
              <View style={[styles.ring, { width: ringSize, height: ringSize }]}>
                <Svg width="100%" height="100%" viewBox="0 0 240 240" accessible={false}>
                  <Circle cx="120" cy="120" r="106" stroke={colors.borderLight} strokeWidth="9" fill="none" />
                  <Circle cx="120" cy="120" r="106" stroke={timer.status === 'paused' ? colors.textMuted : colors.accentMuted}
                    strokeWidth="9" fill="none" strokeLinecap="round" strokeDasharray={`${circumference} ${circumference}`}
                    strokeDashoffset={circumference * (1 - (ringing ? 1 : progress))} rotation="-90" origin="120,120" />
                </Svg>
                <View style={styles.ringCenter}>
                  <Ionicons name={ringing ? 'notifications-outline' : timer.status === 'paused' ? 'pause' : 'hourglass-outline'} size={24} color={colors.accentMuted} />
                  <Text adjustsFontSizeToFit numberOfLines={1} style={[styles.clock, { color: colors.text }]}>{formatTimerClock(timer.remainingMs)}</Text>
                  <Text style={[styles.small, { color: colors.textMuted }]}>{ringing ? timer.silenced ? 'Sound stopped' : 'Alarm sounding' : `${formatTimerDuration(timer.durationMs)} total`}</Text>
                </View>
              </View>
              {timer.status === 'running' && <Text style={[styles.finish, { color: colors.textMuted }]}>Finishes at {formatTimerFinish(timer.endAtMs!)}</Text>}
              {ringing ? <>
                {button('Done', timer.dismissAlarm, { primary: true, icon: 'checkmark' })}
                <View style={styles.actions}>{button('Repeat timer', timer.restartTimer, { icon: 'refresh' })}{button('Start 1 minute', () => timer.startTimer(60_000, timer.label))}</View>
                {!timer.silenced && <Pressable accessibilityRole="button" onPress={timer.silenceAlarm} style={styles.textButton}><Text style={{ color: colors.textMuted }}>Silence sound</Text></Pressable>}
              </> : <>
                <View style={styles.actions}>
                  {button(timer.status === 'paused' ? 'Resume' : 'Pause', timer.status === 'paused' ? timer.resumeTimer : timer.pauseTimer, { primary: true, icon: timer.status === 'paused' ? 'play' : 'pause' })}
                  {button('+1 minute', timer.addMinute, { disabled: timer.durationMs >= MAX_TIMER_MS, icon: 'add' })}
                </View>
                {confirmRestart ? <View style={[styles.confirm, { borderColor: colors.borderLight }]}>
                  <Text style={[styles.small, { color: colors.text }]}>Start {formatTimerDuration(timer.durationMs)} again?</Text>
                  <View style={styles.actions}>{button('Cancel restart', () => setConfirmRestart(false))}{button('Restart', () => { timer.restartTimer(); setConfirmRestart(false); }, { primary: true })}</View>
                </View> : <View style={styles.actions}>{button('Restart', () => setConfirmRestart(true), { icon: 'refresh' })}{button('Cancel', timer.cancelTimer, { icon: 'close' })}</View>}
              </>}
            </> : <>
              <TextInput accessibilityLabel="Timer label" placeholder="Timer name (optional)" placeholderTextColor={colors.textMuted}
                value={label} onChangeText={setLabel} maxLength={60} returnKeyType="done"
                style={[styles.labelInput, { color: colors.text, borderColor: colors.borderLight, backgroundColor: colors.surfaceElevated }]} />
              <Text style={[styles.eyebrow, { color: colors.textMuted }]}>Presets</Text>
              <View style={styles.presets}>{PRESETS.map(ms => <Pressable key={ms} accessibilityRole="button" accessibilityState={{ selected: ms === chosenDuration }}
                onPress={() => { Keyboard.dismiss(); setParts(splitDuration(ms)); }}
                style={({ pressed }) => [styles.preset, { backgroundColor: ms === chosenDuration ? `${colors.accent}25` : colors.surfaceElevated,
                  borderColor: ms === chosenDuration ? colors.accent : colors.borderLight, opacity: pressed ? 0.7 : 1 }]}>
                <Text style={[styles.presetText, { color: ms === chosenDuration ? colors.accentMuted : colors.text }]}>{formatTimerDuration(ms)}</Text>
              </Pressable>)}</View>
              <Text style={[styles.eyebrow, { color: colors.textMuted }]}>Duration</Text>
              <View style={styles.timeRow}>{['Hours', 'Minutes', 'Seconds'].map((name, index) => <React.Fragment key={name}>
                {index > 0 && <Text style={[styles.separator, { color: colors.textMuted }]}>:</Text>}
                <View style={styles.timePart}>
                  <TextInput accessibilityLabel={name} keyboardType="number-pad" inputMode="numeric" selectTextOnFocus maxLength={2}
                    value={parts[index]} onChangeText={raw => setParts(old => old.map((part, i) => i === index ? raw.replace(/\D/g, '').slice(0, 2) : part))}
                    onBlur={() => setParts(old => old.map((part, i) => i === index ? String(timePart(part, i === 0 ? 99 : 59)).padStart(2, '0') : part))}
                    onSubmitEditing={start} style={[styles.numberInput, { color: colors.text, backgroundColor: colors.surfaceElevated, borderColor: colors.borderLight }]} />
                  <Text style={[styles.partLabel, { color: colors.textMuted }]}>{name}</Text>
                </View>
              </React.Fragment>)}</View>
              {chosenDuration === 0 && <Text accessibilityLiveRegion="polite" style={[styles.small, { color: colors.textMuted }]}>Choose at least one second to start.</Text>}
              {button(timer.ready ? `Start ${formatTimerDuration(chosenDuration)}` : 'Restoring timer…', start, { primary: true, disabled: !timer.ready || !chosenDuration, icon: 'play' })}
              {timer.recentDurations.length > 0 && <>
                <Text style={[styles.eyebrow, { color: colors.textMuted }]}>Recent durations</Text>
                <View style={styles.recents}>{timer.recentDurations.map(ms => <Pressable accessibilityRole="button" key={ms} onPress={() => setParts(splitDuration(ms))}
                  style={[styles.recent, { borderColor: colors.borderLight }]}><Ionicons name="time-outline" color={colors.textMuted} size={14} /><Text style={{ color: colors.text }}>{formatTimerDuration(ms)}</Text></Pressable>)}</View>
              </>}
            </>}
          </View>
          {timer.warning && <Text accessibilityRole="alert" style={[styles.hint, { color: colors.error }]}>{timer.warning}</Text>}
          {timer.canConfigureNotifications && button('Alert settings', timer.openNotificationSettings, { icon: 'settings-outline' })}
          <Text style={[styles.hint, { color: colors.textMuted }]}>{Platform.OS === 'android'
            ? 'Background alerts use Android notification and alarm permissions.'
            : Platform.OS === 'web' ? 'Keep this tab open for sound. Closed tabs cannot alert you.' : 'Keep Jarvis open to hear the timer finish.'}</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 }, scroll: { flexGrow: 1, padding: 16, paddingBottom: 32 },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', gap: 16 }, heading: { flexDirection: 'row', gap: 14, alignItems: 'center', paddingVertical: 8 },
  iconBadge: { width: 50, height: 50, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 27, fontWeight: '800' },
  card: { borderWidth: 1, borderRadius: 26, padding: 20, gap: 18, minWidth: 0 },
  eyebrow: { fontSize: 11, fontWeight: '800', letterSpacing: 1.2, textTransform: 'uppercase' },
  labelInput: { borderWidth: 1, borderRadius: 14, minHeight: 48, paddingHorizontal: 13, fontSize: 15 },
  presets: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 }, preset: { flexGrow: 1, flexBasis: '28%', minWidth: 64, borderWidth: 1, borderRadius: 14, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  presetText: { fontSize: 16, fontWeight: '700' }, timeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 5 },
  timePart: { flex: 1, minWidth: 0, alignItems: 'center', gap: 7 }, numberInput: { width: '100%', borderWidth: 1, borderRadius: 14, paddingVertical: 14, textAlign: 'center', fontSize: 30, fontWeight: '700', fontVariant: ['tabular-nums'] },
  separator: { fontSize: 25, paddingTop: 13 }, partLabel: { fontSize: 11 },
  button: { flexGrow: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, minHeight: 48, paddingVertical: 12 },
  buttonText: { fontSize: 14, fontWeight: '700', textAlign: 'center', flexShrink: 1 }, actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  center: { alignItems: 'center', gap: 6 }, timerLabel: { fontSize: 23, fontWeight: '700', textAlign: 'center' },
  ring: { alignSelf: 'center' }, ringCenter: { position: 'absolute', top: 0, bottom: 0, left: 22, right: 22, alignItems: 'center', justifyContent: 'center', gap: 8 },
  clock: { fontSize: 44, fontWeight: '800', fontVariant: ['tabular-nums'], letterSpacing: -1 },
  small: { fontSize: 13, lineHeight: 19 }, finish: { textAlign: 'center', fontSize: 14, lineHeight: 20 },
  hint: { fontSize: 12, lineHeight: 18, paddingHorizontal: 8, textAlign: 'center' }, recents: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  recent: { borderWidth: 1, borderRadius: 99, paddingHorizontal: 12, minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: 6 },
  textButton: { alignItems: 'center', minHeight: 42, justifyContent: 'center' }, confirm: { borderWidth: 1, borderRadius: 16, padding: 12, gap: 12 },
});
