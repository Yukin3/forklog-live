import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { Body, Button, Card, Chip, ErrorBox, Muted, Screen, Title } from '@/components/ui';
import { colors, font, radius, space } from '@/constants/theme';
import { imports, useImportJob } from '@/lib/importJobs';
import type { Clip as Picked } from '@/lib/importController';
import { useDemoMode } from '@/lib/demo';
import { DEMO_CLIP } from '@/lib/demoData';
import { CONF, VIDEO_LIMITS } from '@/lib/guards';
import { IngredientReview } from '@/components/IngredientReview';
import { ingredientReminders, reminderReviewKey } from '@/lib/restrictions';
import { usePreferences } from '@/lib/preferences';
import { supabaseConfigured } from '@/lib/supabase';

export default function ImportScreen() {
  const demo = useDemoMode();
  const { restrictions = [] } = usePreferences();
  const [reviewAcknowledged, setReviewAcknowledged] = useState('');
  const { autorun, jobId } = useLocalSearchParams<{ autorun?: string; jobId?: string }>();
  const autoran = useRef(false);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [caption, setCaption] = useState('');
  const job = useImportJob();
  const [localError, setError] = useState<string | null>(null);
  const [variation, setVariation] = useState('');
  const [source, setSource] = useState('');
  const [newImport, setNewImport] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const picking = useRef(false);
  const navigating = useRef(false);
  const phase = newImport ? 'idle' : job?.stage ?? 'idle';
  const result = newImport ? null : job?.result;
  const frames = newImport ? null : job?.frames;
  const error = localError ?? (newImport ? null : job?.error);
  useFocusEffect(useCallback(() => { navigating.current = false; if (jobId && job?.id === jobId) setNewImport(false); }, [jobId, job?.id]));
  useEffect(() => {
    if (!job) return;
    const draft = job.reviewed ?? job.draftInputs ?? job.inputs;
    setPicked(draft.clip); setCaption(draft.caption);
    setVariation(draft.variation); setSource(draft.source);
    setNewImport(false);
  }, [job?.id]);

  async function pick() {
    if (picking.current || imports.locked) return;
    picking.current = true;
    try {
    setError(null);
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['videos'], allowsEditing: false, videoMaxDuration: VIDEO_LIMITS.maxSeconds, quality: 1 });
    if (res.canceled || !res.assets[0]) return;
    const a = res.assets[0];
    const durationSec = a.duration != null ? a.duration / 1000 : null;
    if (durationSec && durationSec > VIDEO_LIMITS.maxSeconds) { setError(`That video is ${Math.round(durationSec)} s. Keep it under ${VIDEO_LIMITS.maxSeconds} s.`); return; }
    if (a.fileSize && a.fileSize > VIDEO_LIMITS.maxBytes) { setError(`That video is ${(a.fileSize / 1048576).toFixed(0)} MB. Max is ${VIDEO_LIMITS.maxBytes / 1048576} MB.`); return; }
    const mimeType = a.mimeType ?? (a.uri.toLowerCase().endsWith('.mov') ? 'video/quicktime' : 'video/mp4');
    if (!VIDEO_LIMITS.allowed.includes(mimeType)) { setError(`Unsupported format (${mimeType}). Use MP4 or MOV.`); return; }
    setPicked({ uri: a.uri, mimeType, durationSec, bytes: a.fileSize ?? null, name: a.fileName ?? 'video' });
    } catch (e) { setError(`Could not choose video: ${(e as Error).message}. Try choosing it again.`); }
    finally { picking.current = false; }
  }

  function extract(clip: Picked | null = picked) {
    if (!clip) return;
    if (!supabaseConfigured && !demo) { setError('Backend not configured. Use demo mode from Library.'); return; }
    setError(null);
    if (!imports.start({ clip, caption, variation, source }, demo)) setError('Finish reviewing the active import before starting another.');
    else setNewImport(false);
  }
  useEffect(() => {
    if (!job || !['queued', 'uploading', 'extracting'].includes(job.stage)) return;
    const tick = () => setElapsed(Math.floor((Date.now() - job.startedAt) / 1000));
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [job?.id, job?.stage]);

  // Demo-only: /import?autorun=1 runs the demo clip through the whole flow (used for scripted walkthroughs).
  useEffect(() => {
    if (!demo || autorun !== '1' || autoran.current) return;
    autoran.current = true;
    setPicked(DEMO_CLIP);
    void extract(DEMO_CLIP);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, autorun]);

  function reset() {
    if (imports.locked) return;
    setPicked(null); setCaption(''); setVariation(''); setSource(''); setError(null); setNewImport(true); router.setParams({ jobId: undefined });
  }
  const reviewInputs = () => ({ clip: picked!, caption, variation, source });
  const notesInputs = <>
    <Text style={s.section}>Caption / source / variation notes</Text>
    <TextInput style={s.input} placeholder="Caption" placeholderTextColor={colors.muted} multiline value={caption} onChangeText={v => { setCaption(v); if (!newImport) imports.editInputs({ caption: v }); }} editable={newImport || (!job?.applying && job?.stage !== 'ready')} />
    <TextInput style={s.input} placeholder="Public source attribution (optional)" placeholderTextColor={colors.muted} value={source} onChangeText={v => { setSource(v); if (!newImport) imports.editInputs({ source: v }); }} editable={newImport || (!job?.applying && job?.stage !== 'ready')} />
    <TextInput style={s.input} placeholder="Private variation notes (optional)" placeholderTextColor={colors.muted} multiline value={variation} onChangeText={v => { setVariation(v); if (!newImport) imports.editInputs({ variation: v }); }} editable={newImport || (!job?.applying && job?.stage !== 'ready')} />
    <Muted size={14}>Extraction uses the caption captured at submission. Later edits are unapplied until review: saved as notes, without re-extraction or automatic ingredient changes. Edit ingredients during cooking.</Muted>
  </>;
  if (result && job && !newImport) {
    const r = result.recipe;
    const reminders = ingredientReminders(r.ingredients, restrictions);
    const key = reminderReviewKey(result.versionId, r.ingredients, restrictions);
    const needsReview = reminders.length > 0 && reviewAcknowledged !== key;
    return (
      <Screen>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            <Title>{r.title}</Title>
            <Muted>{r.source_summary}</Muted>
            <View style={s.chips}>
              {r.servings != null && <Chip label={`${r.servings} servings`} />}
              {r.total_minutes != null && <Chip label={`${r.total_minutes} min`} />}
              <Chip label={`${r.steps.length} steps`} />
              {frames && <Chip label={frames.scripted ? `Demo frame progress ${frames.done}/${frames.total} (no images uploaded)` : frames.done < frames.total ? `Processing references ${frames.done}/${frames.total}` : `References: ${frames.succeeded} ready · ${frames.failed} failed`} tone={frames.scripted || frames.done < frames.total ? 'neutral' : frames.failed ? 'warn' : 'good'} />}
            </View>
            {error && <ErrorBox message={error} />}
            {frames && !frames.scripted && frames.failed > 0 && <Muted size={14}>Some references failed. The saved recipe is available; coaching falls back to written visual cues for those steps.</Muted>}
            {r.warnings.map((w, i) => <Chip key={i} label={`⚠ ${w}`} tone="warn" />)}

            {notesInputs}
            <IngredientReview reminders={reminders} acknowledged={!needsReview} onAcknowledge={() => setReviewAcknowledged(key)} onLeave={() => router.navigate('/')} />
            <Chip label={`Recipe: ${job.stage}`} tone="active" />
            <Text style={s.section}>Ingredients</Text>
            <Card>
              {r.ingredients.map((ing, i) => (
                <View key={i} style={s.ingRow}>
                  <Body>{ing.confidence < CONF.recipeQty ? '~' : ''}{ing.qty}{ing.unit ? ` ${ing.unit}` : ''} {ing.name}</Body>
                  <Muted size={13}>{ing.evidence}</Muted>
                </View>
              ))}
              <Muted size={13}>~ = the video didn't say; estimated from what was visible.</Muted>
            </Card>

            <Text style={s.section}>Steps</Text>
            {r.steps.map(st => (
              <Card key={st.n}>
                <View style={s.stepHead}>
                  <Text style={s.stepN}>{st.n}</Text>
                  <View style={{ flex: 1 }}><Body bold>{st.text}</Body></View>
                </View>
                <Muted size={15}>Looks done when: {st.visual_cue}</Muted>
                {st.duration_sec != null && <Muted size={13}>~{Math.round(st.duration_sec / 60) || '<1'} min</Muted>}
              </Card>
            ))}

            {job.stage === 'review-needed' && <Button style={s.wrapButton} title="Confirm review & save notes" loading={job.applying} disabled={!job.referencesDone || needsReview} onPress={() => { if (!needsReview) void imports.applyReview(reviewInputs()); }} />}
            {!job.referencesDone && <Muted>Waiting for reference attempts before copying links to the reviewed version. You can browse Library meanwhile.</Muted>}
            {job.stage === 'failed' && <><Button style={s.wrapButton} title="Check saved result / recover" onPress={() => void imports.retry()} /><Button style={s.wrapButton} title="Leave failed review (retain saved versions)" variant="ghost" onPress={() => { imports.dismiss(); reset(); }} /></>}
            <Button title="Browse library" variant="ghost" onPress={() => router.navigate('/')} />
            {job.stage === 'ready' && <>
              <Button title="Cook reviewed version" size="lg" disabled={needsReview} onPress={() => { if (navigating.current) return; navigating.current = true; router.push({ pathname: '/cook/[recipeId]', params: { recipeId: job.recipeId!, versionId: result.versionId } }); }} />
              <Button title="Open library" variant="ghost" onPress={() => router.navigate('/')} />
              <Button title="Import another video" variant="ghost" onPress={reset} />
            </>}
          </ScrollView>
        </KeyboardAvoidingView>
      </Screen>
    );
  }

  const busy = ['queued', 'uploading', 'extracting'].includes(phase);
  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <View style={s.titleRow}>
            <Title>Import a video</Title>
            {demo && <Chip label="DEMO" tone="active" />}
          </View>
          <Muted>Pick a saved cooking clip (under {VIDEO_LIMITS.maxSeconds / 60} min). ForkLog watches and listens, then writes the recipe.</Muted>
          {error && <ErrorBox message={error} />}

          <Card>
            {picked ? (
              <>
                <Body bold>{picked.name}</Body>
                <View style={s.chips}>
                  {picked.durationSec != null && <Chip label={`${Math.round(picked.durationSec)} s`} />}
                  {picked.bytes != null && <Chip label={`${(picked.bytes / 1048576).toFixed(1)} MB`} />}
                  <Chip label={picked.mimeType.replace('video/', '').toUpperCase()} />
                </View>
                {!busy && <Button style={s.wrapButton} title="Choose a different video" variant="ghost" onPress={pick} />}
              </>
            ) : (
              <>
                {demo && <Button title="Use the demo clip" size="lg" onPress={() => { setError(null); setPicked(DEMO_CLIP); }} />}
                <Button title="Choose video" size="lg" variant={demo ? 'ghost' : 'primary'} onPress={pick} />
              </>
            )}
          </Card>

          {notesInputs}
          <IngredientReview preliminary reminders={ingredientReminders([{ name: caption }], restrictions)} />
          <Muted size={14}>Foreground only: you can browse recipes while the app stays active. Suspension or closing the app may interrupt processing.</Muted>
          {phase === 'failed' && <Button style={s.wrapButton} title="Check saved result / retry upload" onPress={() => void imports.retry()} />}
          {phase === 'failed' && !imports.locked && <Button style={s.wrapButton} title="Leave failed job (retain any server data)" variant="ghost" onPress={() => { imports.dismiss(); reset(); }} />}
          {phase === 'failed' && <Muted>Recovery checks saved versions first. An uncertain extraction is never charged again automatically; saved recipes are retained.</Muted>}
          {busy ? (
            <Card style={s.progress}>
              <ActivityIndicator color={colors.accent} />
              <Body bold>{phase === 'queued' ? 'Queued' : phase === 'uploading' ? `Uploading video… ${elapsed}s` : `Watching the video and writing the recipe… ${elapsed}s`}</Body>
              <Muted size={14}>{phase === 'uploading' ? (demo ? 'Demo: pretending to upload.' : 'Sending to your Supabase bucket.') : demo ? 'Demo: returning the sample recipe.' : 'Usually 30–90 s for a 60 s clip. Gemini can be slower at peak times; you can browse Library while it runs.'}</Muted>
            </Card>
          ) : (
            <Button title="Extract recipe" size="lg" disabled={!picked || phase === 'failed' || imports.locked} onPress={() => void extract()} />
          )}
          <Button title="Browse library" variant="ghost" onPress={() => router.navigate('/')} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const s = StyleSheet.create({
  wrapButton: { flexDirection: 'column', paddingVertical: space.sm },
  scroll: { gap: space.md, paddingVertical: space.md, paddingBottom: 120 },
  titleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  section: { color: colors.text, fontSize: font.big, fontWeight: '700', marginTop: space.sm },
  ingRow: { gap: space.xs },
  stepHead: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  stepN: { color: colors.accent, fontSize: font.big, fontWeight: '800', width: 28 },
  input: { backgroundColor: colors.card, borderColor: colors.border, borderWidth: 1, borderRadius: radius.md, color: colors.text, fontSize: font.body, padding: space.md, minHeight: 96, textAlignVertical: 'top' },
  progress: { alignItems: 'center', paddingVertical: space.lg },
});
