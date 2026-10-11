import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useKeepAwake } from 'expo-keep-awake';
import * as Haptics from 'expo-haptics';
import { Button, Centered, Chip, ErrorBox, Muted } from '@/components/ui';
import { colors, font, radius, space } from '@/constants/theme';
import { activateCookVersion, endCook, getLatestVersion, getVersion, saveVersion, startCook, type VersionRow } from '@/lib/db';
import { useDemoMode } from '@/lib/demo';
import { type CoachEvent, type Recipe } from '@/lib/guards';
import { VisionLoop, type VisionStats } from '@/lib/visionLoop';
import { speaker } from '@/lib/voice';
import { SPOKEN } from '@/prompts';
import { adaptationSummary, hasAdaptations, ingredientDiff, ingredientKey, instructionText, stepOptions } from '@/lib/recipeOptions';
import { requireAdaptationBackend } from '@/lib/supabase';
import { preferences, usePreferences } from '@/lib/preferences';
import { IngredientReview } from '@/components/IngredientReview';
import { ingredientReminders, reminderReviewKey } from '@/lib/restrictions';
import { PRESET_LABELS, UNTRANSLATED, type GuidanceLanguage } from '@/lib/guidancePhrases';
import { answerRecipeQuestion as answer, type QuestionId } from '@/lib/recipeGuidance';

// ----- tap-to-ask (stand-in for the ElevenLabs agent; answers come straight from the recipe) ----------
function AskSheet({ visible, onClose, onAsk, language }: { language: GuidanceLanguage; visible: boolean; onClose: () => void; onAsk: (q: QuestionId) => void }) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={s.sheetHost}>
        <Pressable style={s.sheetBackdrop} onPress={onClose} accessibilityLabel="Close" />
        <SafeAreaView edges={['bottom']} style={s.sheet}>
          <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetContent}>
            <Text style={s.sheetTitle}>{language === 'es' ? 'Guía de la receta' : 'Recipe guidance'}</Text>
            <Muted size={14}>Preset answers from your selected recipe version. Tap a question; no microphone conversation.</Muted>
            <View style={s.controls}><Button title="English" variant={language === 'en' ? 'primary' : 'ghost'} onPress={() => preferences.setLanguage('en')} /><Button title="Español" variant={language === 'es' ? 'primary' : 'ghost'} onPress={() => preferences.setLanguage('es')} /></View>
            <Muted size={14}>{language === 'es' ? UNTRANSLATED : 'Local preset phrases only. Source text, ingredient names and units remain unchanged; camera coaching stays in English.'}</Muted>
            {(Object.keys(PRESET_LABELS[language]) as QuestionId[]).map(id => <Button key={id} style={s.wrapButton} title={PRESET_LABELS[language][id]} variant="ghost" size="lg" onPress={() => onAsk(id)} />)}
          </ScrollView>
          <Button title="Close" onPress={onClose} />
        </SafeAreaView>
      </View>
    </Modal>
  );
}

// ----- screen ---------------------------------------------------------------------------------------
export default function CookScreen() {
  const { recipeId, versionId, step: stepParam } = useLocalSearchParams<{ recipeId: string; versionId?: string; step?: string }>();
  const demo = useDemoMode();
  const { language, restrictions = [], error: preferenceError } = usePreferences();
  useKeepAwake();
  const [perm, requestPerm] = useCameraPermissions();
  const camRef = useRef<CameraView>(null);
  const contentRef = useRef<ScrollView>(null);
  const loopRef = useRef<VisionLoop | null>(null);

  const [version, setVersion] = useState<VersionRow | null>(null);
  const [cookId, setCookId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [camReady, setCamReady] = useState(false);
  const [stepN, setStepN] = useState(() => Math.max(1, Number(stepParam) || 1));
  const stepRef = useRef(stepN);
  stepRef.current = stepN;
  const [detected, setDetected] = useState<Map<string, string | null>>(new Map());
  const [lastEvent, setLastEvent] = useState<CoachEvent | null>(null);
  const [caption, setCaption] = useState<string | null>(null);
  const [stats, setStats] = useState<VisionStats | null>(null);
  const [muted, setMuted] = useState(speaker.isMuted);
  const [asking, setAsking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Recipe | null>(null);
  const [saving, setSaving] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const actionBusy = useRef(false);
  const pendingVersion = useRef<VersionRow | null>(null); // retry attaching without inserting another child
  const [now, setNow] = useState(Date.now());
  const [voiceLoadingAt, setVoiceLoadingAt] = useState<number | null>(null);
  const finishStarted = useRef(false);
  const [actionStartedAt, setActionStartedAt] = useState<number | null>(null);
  const [reviewAcknowledged, setReviewAcknowledged] = useState('');
  const recipe = draft ?? version?.recipe_json;
  const dirty = !!(version && recipe && ingredientDiff(version.recipe_json, recipe).length);

  const reminders = ingredientReminders(recipe?.ingredients ?? [], restrictions);
  const reviewKey = reminderReviewKey(version?.id ?? '', recipe?.ingredients ?? [], restrictions);
  const needsReview = reminders.length > 0 && reviewAcknowledged !== reviewKey;

  const steps = recipe?.steps ?? [];
  const step = steps.find(s => s.n === stepN) ?? steps[0];
  const hasCamera = !!perm?.granted;
  const canRun = demo || (hasCamera && camReady); // demo mode never waits for the camera (simulator, denied permission)

  // 1. Load the recipe version and open a cook row.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = versionId ? await getVersion(versionId) : await getLatestVersion(recipeId);
        if (v.recipe_id !== recipeId) throw new Error('That version belongs to another recipe. Open it from its history.');
        if (cancelled) return;
        setVersion(v);
        const id = await startCook(recipeId, v.id);
        if (!cancelled) setCookId(id);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
  }, [recipeId, versionId]);

  useEffect(() => {
    if (!saving && !finishing && !stats?.processing && voiceLoadingAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [saving, finishing, stats?.processing, voiceLoadingAt]);

  // 2. Prefetch every step's audio, read step 1 once.
  useEffect(() => {
    if (!version || needsReview) return;
    speaker.onLine = setCaption;
    speaker.onLoading = loading => setVoiceLoadingAt(loading ? Date.now() : null);
    const intros = version.recipe_json.steps.map(s => SPOKEN.stepIntro(s.n, instructionText(version.recipe_json, s.n)));
    void speaker.prefetch(intros);
    const first = version.recipe_json.steps.find(s => s.n === stepRef.current) ?? version.recipe_json.steps[0];
    if (first) void speaker.say(SPOKEN.stepIntro(first.n, instructionText(version.recipe_json, first.n)), 'step', undefined, { clamp: false });
    return () => { speaker.onLine = undefined; speaker.onLoading = undefined; setVoiceLoadingAt(null); void speaker.stopAll(); };
  }, [version, needsReview]);

  useEffect(() => { setCaption(null); }, [language]);

  // 3. Coach events → chips + voice. Confidence/safety filtering already happened in VisionLoop.
  const handleEvent = useCallback((ev: CoachEvent, n: number) => {
    if (needsReview || n !== stepRef.current || actionBusy.current) return;
    setLastEvent(ev);
    if (ev.ingredient_added) {
      const name = ev.ingredient_added;
      setDetected(prev => { if (prev.has(name)) return prev; const m = new Map(prev); m.set(name, ev.qty_estimate); return m; });
      void speaker.say(SPOKEN.ingredientNoted(name, ev.qty_estimate), 'alert', `ing:${name}`);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    if (ev.severity === 'stop' && ev.action) {
      void speaker.say(SPOKEN.stop(ev.action), 'stop', `stop:${n}`);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    if (ev.action) {
      void speaker.say(ev.action, 'alert', `dev:${n}`);
    } else if (ev.step_state === 'matches_reference') {
      void speaker.say(SPOKEN.stepMatches(), 'alert', `match:${n}`);
    }
  }, [needsReview]);

  // 4. Start the vision loop once camera (or demo) + cook are ready.
  useEffect(() => {
    if (!version || !cookId || !canRun || dirty || needsReview || editing || saving || finishing) return;
    const loop = new VisionLoop(camRef, version.recipe_json, recipeId, cookId, handleEvent, setStats);
    loopRef.current = loop;
    if (stepRef.current !== 1) loop.setStep(stepRef.current);
    loop.start();
    return () => { loop.stop(); loopRef.current = null; };
  }, [version, cookId, canRun, recipeId, handleEvent, dirty, needsReview, editing, saving, finishing]);

  // Apply a ?step=N param (deep link / "resume") once the recipe is loaded, even if the param arrives after first render.
  useEffect(() => {
    const n = Number(stepParam);
    if (!version || !n || n < 1 || n > version.recipe_json.steps.length || n === stepRef.current) return;
    goStep(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepParam, version]);

  function goStep(n: number) {
    if (actionBusy.current) return;
    if (n < 1 || n > steps.length || n === stepRef.current) return;
    const target = steps[n - 1];
    setStepN(n);
    contentRef.current?.scrollTo({ y: 0, animated: true });
    stepRef.current = n;
    setDetected(new Map());
    setLastEvent(null);
    loopRef.current?.setStep(n);
    speaker.gate.reset();
    const stopped = speaker.stopAll();
    const speechRevision = speaker.revision;
    void stopped.then(() => { if (speaker.revision === speechRevision && !needsReview && stepRef.current === n) return speaker.say(SPOKEN.stepIntro(target.n, recipe ? instructionText(recipe, n) : target.text), 'step', undefined, { clamp: false }); });
    void Haptics.selectionAsync();
  }

  function toggleMute() {
    const m = !muted;
    setMuted(m);
    speaker.setMuted(m);
  }

  function ask(q: QuestionId) {
    setAsking(false);
    if (!recipe || needsReview) return;
    const line = answer(q, recipe, stepN, language);
    setCaption(line); // visible immediately even while speech is loading
    void speaker.say(line, 'alert', undefined, { clamp: false, language, fallbackText: answer(q, recipe, stepN, 'en') });
  }

  function changeIngredient(name: string, values: Partial<Recipe['ingredients'][number]>) {
    if (!version || actionBusy.current || pendingVersion.current) return;
    loopRef.current?.stop();
    void speaker.stopAll();
    setCaption(null); setLastEvent(null); setDetected(new Map());
    setDraft(prev => {
      const source = prev ?? version.recipe_json;
      return { ...source, ingredients: source.ingredients.map(i => ingredientKey(i.name) === ingredientKey(name) ? {
        ...i,
        ...('qty' in values || 'unit' in values ? { source_qty: i.source_qty ?? i.qty, source_unit: i.source_unit ?? i.unit } : {}),
        ...values,
      } : i) };
    });
  }

  async function applyOptions() {
    if (!version || !cookId || !recipe || !dirty || actionBusy.current) return;
    if (recipe.ingredients.some(i => !i.omitted && !i.qty.trim())) { setError('Enter a quantity for each included ingredient, or omit it.'); return; }
    actionBusy.current = true; setSaving(true); setActionStartedAt(Date.now()); setError(null);
    loopRef.current?.stop();
    try {
      await speaker.stopAll();
      await requireAdaptationBackend();
      if (!pendingVersion.current) pendingVersion.current = await saveVersion({
        recipeId, parentId: version.id, recipe, diff: ingredientDiff(version.recipe_json, recipe), rating: null,
        notes: `Intentional choices: ${adaptationSummary(recipe) || 'restored source ingredients'}`,
      });
      await activateCookVersion(cookId, pendingVersion.current.id);
      if (pendingVersion.current.save_warnings?.length) Alert.alert(`Saved v${pendingVersion.current.number}`, pendingVersion.current.save_warnings.join('\n'));
      setVersion(pendingVersion.current); pendingVersion.current = null;
      setDraft(null); setEditing(false); setCaption(null); setLastEvent(null); setDetected(new Map());
    } catch (e) {
      setError(`${(e as Error).message}${pendingVersion.current ? ` Child v${pendingVersion.current.number} is saved, but this cook is still paused. Retry to attach that same version; no duplicate will be created.` : ' Changes remain a draft; retry or undo.'}`);
    } finally { actionBusy.current = false; setSaving(false); setActionStartedAt(null); }
  }

  function finish() {
    if (actionBusy.current) return;
    if (needsReview) { setError('Review the ingredient reminders before continuing.'); return; }
    if (dirty) { setError('Save your ingredient changes or undo the draft before finishing.'); return; }
    actionBusy.current = true; // includes the confirmation dialog, preventing duplicate dialogs
    Alert.alert('Finish cooking?', 'ForkLog will compare your cook to the video.', [
      { text: 'Keep cooking', style: 'cancel', onPress: () => { actionBusy.current = false; } },
      {
        text: "I'm done",
        onPress: async () => {
          finishStarted.current = true; setFinishing(true); setActionStartedAt(Date.now());
          loopRef.current?.stop();
          await speaker.stopAll();
          if (!cookId) { router.back(); return; }
          try { await endCook(cookId); router.replace(`/recap/${cookId}`); }
          catch (e) { setError(`Could not finish the cook: ${(e as Error).message}. Retry when connected.`); actionBusy.current = false; finishStarted.current = false; setFinishing(false); setActionStartedAt(null); }
        },
      },
    ], { cancelable: true, onDismiss: () => { if (!finishStarted.current) actionBusy.current = false; } });
  }

  if (!perm) return <View style={s.root} />;
  if (!perm.granted && !demo) {
    return (
      <View style={s.root}>
        <Centered>
          <Text style={s.permTitle}>ForkLog needs the camera</Text>
          <Muted>It watches your pan to notice ingredients and compare with the video. Nothing is recorded.</Muted>
          <Button title="Allow camera" size="lg" onPress={() => void requestPerm()} />
          <Button title="Back" variant="ghost" onPress={() => router.back()} />
        </Centered>
      </View>
    );
  }

  const expected = recipe && step ? stepOptions(recipe, step.n).expected : [];
  const omitted = recipe && step ? stepOptions(recipe, step.n).omitted : [];
  const extras = [...detected.keys()].filter(d => !expected.some(e => e.toLowerCase() === d.toLowerCase()));
  const isDetected = (name: string) => [...detected.keys()].some(d => d.toLowerCase() === name.toLowerCase());
  const detectedAmount = (name: string) => [...detected.entries()].find(([key]) => ingredientKey(key) === ingredientKey(name))?.[1];
  const banner = caption ?? lastEvent?.deviation ?? null;

  return (
    <View style={s.root}>
      {hasCamera ? (
        <CameraView ref={camRef} style={StyleSheet.absoluteFill} facing="back" animateShutter={false} mute onCameraReady={() => setCamReady(true)} onMountError={e => setError(e.message)} />
      ) : (
        <View style={[StyleSheet.absoluteFill, s.fakeCamera]}>
          <Text style={s.fakeCameraEmoji}>🍳</Text>
          <Text style={s.fakeCameraText}>Camera preview</Text>
          <Muted size={14}>Demo mode: the coach is scripted, no camera needed.</Muted>
          {!perm.granted && <Button title="Use the real camera" variant="ghost" onPress={() => void requestPerm()} />}
        </View>
      )}
      <SafeAreaView style={s.overlay} edges={['top', 'bottom']}>
        <ScrollView ref={contentRef} style={s.cookScroll} contentContainerStyle={s.cookContent}>
          {/* top: step and review */}
          <View style={s.top}>
            <View style={s.topRow}>
              <View style={s.topChips}>
                <Chip label={steps.length ? `Step ${stepN} of ${steps.length}` : 'Loading recipe…'} tone="active" />
                {demo && <Chip label="DEMO" tone="warn" />}
                {!demo && stats?.scripted === true && <Chip label="BACKEND STUB" tone="warn" />}
                {version && <Chip label={`v${version.number}${dirty ? ' · draft' : ''}`} />}
              </View>
              <Pressable onPress={toggleMute} style={s.iconBtn} accessibilityLabel={muted ? 'Unmute coach' : 'Mute coach'}>
                <Text style={s.iconText}>{muted ? '🔇' : '🔊'}</Text>
              </Pressable>
            </View>
            {step && (
              <View style={s.stepBox}>
                <Text style={s.stepText}>{recipe ? instructionText(recipe, step.n) : step.text}</Text>
                {recipe && hasAdaptations(recipe) && <Text style={s.cue}>Source instruction (review for your changes): {step.text}</Text>}
                <Text style={s.cue}>Source visual cue: {step.visual_cue}</Text>
              </View>
            )}
            <IngredientReview reminders={reminders} acknowledged={!needsReview} onAcknowledge={() => setReviewAcknowledged(reviewKey)} onLeave={() => router.back()} />
            {preferenceError && <ErrorBox message={preferenceError} />}
            {error && <ErrorBox message={error} />}
            {dirty && <Muted size={14}>Draft changes: coaching paused until saved. Original v{version?.number} is preserved.</Muted>}
            {demo && recipe && hasAdaptations(recipe) && <Muted size={14}>Adapted DEMO: recipe guidance only. Scripted camera comparisons are disabled.</Muted>}
          </View>

          {/* middle: what the coach is saying */}
          <View style={s.middle}>
            {banner && (
              <View style={[s.banner, lastEvent?.severity === 'stop' && s.bannerStop]}>
                <Text style={s.bannerText}>{banner}</Text>
              </View>
            )}
          </View>

          {/* ingredient controls scroll; step navigation stays reachable */}
          <View style={s.bottom}>
            <View style={s.chipsRow}>
              <View style={s.chips}>
                {[...expected, ...omitted].map(name => <Pressable key={name} style={s.ingredientPill} accessibilityRole="button" accessibilityLabel={`${omitted.includes(name) ? 'Undo omission of' : 'Omit'} ${name}`} disabled={saving || !!pendingVersion.current} onPress={() => changeIngredient(name, { omitted: !omitted.includes(name) })}><Chip label={omitted.includes(name) ? `Omitted · ${name} ↶` : isDetected(name) ? `✓ ${name}${detectedAmount(name) ? ` · ${detectedAmount(name)}` : ''}` : name} tone={omitted.includes(name) ? 'neutral' : isDetected(name) ? 'good' : 'active'} /></Pressable>)}
                {extras.map(name => <View key={name} style={s.ingredientPill}><Chip label={`? ${name}`} tone="warn" /></View>)}
              </View>
              <Pressable disabled={needsReview} onPress={() => setAsking(true)} style={s.mic} accessibilityLabel="Preset recipe guidance">
                <Text style={s.micIcon}>?</Text>
                <Text style={s.micLabel}>Guide</Text>
              </Pressable>
            </View>
            <Button style={s.wrapButton} title="Ingredient choices / quantities" variant="ghost" disabled={!cookId || saving || finishing} onPress={() => { loopRef.current?.stop(); void speaker.stopAll(); setEditing(true); }} />
            {dirty && <View style={s.controls}><Button title={pendingVersion.current ? 'Retry attach saved version' : 'Save child version & apply'} loading={saving} style={[s.wrapButton, { flex: 1, minWidth: 180 }]} onPress={() => void applyOptions()} /><Button title="Undo draft" variant="ghost" disabled={saving || !!pendingVersion.current} onPress={() => { setDraft(null); setError(null); }} /></View>}
            {(saving || finishing) && <Muted size={14}>{saving ? 'Saving and attaching the selected recipe version…' : 'Finishing cook…'} {Math.max(0, Math.floor((now - (actionStartedAt ?? now)) / 1000))}s</Muted>}
            {voiceLoadingAt !== null && <Muted size={14}>Preparing speech… {Math.max(0, Math.floor((now - voiceLoadingAt) / 1000))}s. Recipe guidance is shown above.</Muted>}
          </View>
        </ScrollView>
        <View style={s.controls}>
          <Button style={s.navButton} title="Back" variant="ghost" size="lg" disabled={stepN <= 1} onPress={() => goStep(stepN - 1)} />
          <Button title={stepN >= steps.length ? 'Last step' : 'Next step'} size="lg" style={s.navButton} disabled={!steps.length || stepN >= steps.length} onPress={() => goStep(stepN + 1)} />
          <Button style={s.navButton} title="I'm done" variant="danger" size="lg" loading={finishing} disabled={!cookId || saving || dirty || needsReview} onPress={finish} />
        </View>
        <Text style={s.stats}>
          {canRun ? '● ' : '○ '}
          {demo ? 'demo · ' : stats?.scripted === true ? 'backend STUB_MODE · ' : stats?.scripted == null ? 'backend mode unverified · ' : ''}
          {dirty || editing || needsReview ? 'coaching paused' : stats?.processing ? `Analyzing frame… ${Math.max(0, Math.floor((now - (stats.startedAt ?? now)) / 1000))}s` : stats ? `${stats.sent} sent · ${stats.ok} ok · ${stats.skipped} still${stats.lastLatencyMs != null ? ` · ${stats.lastLatencyMs} ms` : ''}` : canRun ? 'starting' : 'waiting for camera'}
          {stats?.lastError ? ` · ${stats.lastError.slice(0, 40)}` : ''}
        </Text>
      </SafeAreaView>
      <AskSheet language={language} visible={asking} onClose={() => setAsking(false)} onAsk={ask} />
      <Modal visible={editing} transparent animationType="slide" onRequestClose={() => { if (!saving) setEditing(false); }}>
        <KeyboardAvoidingView style={s.sheetHost} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
          <View style={s.sheetBackdrop} />
          <SafeAreaView edges={['bottom']} style={s.sheet}>
            <ScrollView style={s.sheetScroll} contentContainerStyle={s.sheetContent} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
              <Text style={s.sheetTitle}>Intentional ingredient choices</Text>
              <Muted size={14}>Omit or restore ingredients; edit amounts in the existing units. Save a child version to resume coaching. Source steps and reference images stay mapped.</Muted>
              {recipe?.ingredients.map(i => <View key={i.name} style={s.ingredientRow}>
                <Text style={s.cue}>{i.name} · {i.unit || 'quantity'}</Text>
                <View style={s.controls}>
                  <TextInput style={s.quantity} accessibilityLabel={`Quantity of ${i.name}`} value={i.qty} editable={!i.omitted && !saving && !pendingVersion.current} onChangeText={qty => changeIngredient(i.name, { qty })} />
                  <Button title={i.omitted ? 'Undo omission' : 'Omit'} variant="ghost" disabled={saving || !!pendingVersion.current} onPress={() => changeIngredient(i.name, { omitted: !i.omitted })} />
                </View>
              </View>)}
              {preferenceError && <ErrorBox message={preferenceError} />}
              {error && <ErrorBox message={error} />}
              {saving && <Muted size={14}>Saving and attaching the child version… {Math.max(0, Math.floor((now - (actionStartedAt ?? now)) / 1000))}s</Muted>}
              {dirty && <Button style={s.wrapButton} title={pendingVersion.current ? 'Retry attach saved version' : 'Save child version & apply'} loading={saving} onPress={() => void applyOptions()} />}
            </ScrollView>
            <Button title="Return to cook" variant="ghost" disabled={saving} onPress={() => setEditing(false)} />
          </SafeAreaView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  fakeCamera: { backgroundColor: '#15151c', alignItems: 'center', justifyContent: 'center', gap: space.sm, padding: space.lg },
  fakeCameraEmoji: { fontSize: 72 },
  fakeCameraText: { color: colors.muted, fontSize: font.big, fontWeight: '700' },
  overlay: { flex: 1, gap: space.sm, padding: space.md },
  top: { gap: space.sm },
  cookScroll: { flex: 1 },
  cookContent: { gap: space.md, paddingBottom: space.sm },
  topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  topChips: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  iconBtn: { flexShrink: 0, width: 48, height: 48, borderRadius: 24, backgroundColor: colors.overlay, alignItems: 'center', justifyContent: 'center' },
  iconText: { fontSize: 22 },
  stepBox: { backgroundColor: colors.overlay, borderRadius: radius.md, padding: space.md, gap: space.xs },
  stepText: { color: colors.text, fontSize: font.cook, fontWeight: '700', lineHeight: 30 },
  cue: { color: '#d8d8de', fontSize: 18, lineHeight: 24 },
  middle: { alignItems: 'center' },
  banner: { backgroundColor: 'rgba(255,122,26,0.92)', borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm, maxWidth: '92%' },
  bannerStop: { backgroundColor: 'rgba(255,92,92,0.95)' },
  bannerText: { color: '#1a0d00', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  bottom: { gap: space.sm },
  chipsRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  chips: { flex: 1, flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  mic: { width: 76, height: 76, borderRadius: 38, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  micIcon: { fontSize: 26 },
  micLabel: { color: colors.accentText, fontSize: 12, fontWeight: '800' },
  controls: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  wrapButton: { flexDirection: 'column', paddingVertical: space.sm },
  navButton: { flex: 1, minWidth: 100, flexDirection: 'column', paddingVertical: space.sm },
  stats: { color: 'rgba(255,255,255,0.55)', fontSize: 12, textAlign: 'center' },
  permTitle: { color: colors.text, fontSize: font.title, fontWeight: '800', textAlign: 'center' },
  sheetHost: { flex: 1, justifyContent: 'flex-end' },
  sheetBackdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheetScroll: { flexShrink: 1 },
  sheetContent: { gap: space.sm },
  sheet: { maxHeight: '85%', flexShrink: 1, backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, padding: space.lg, paddingBottom: space.xl, gap: space.sm },
  sheetTitle: { color: colors.text, fontSize: font.title, fontWeight: '800' },
  ingredientRow: { gap: space.xs, marginBottom: space.md },
  ingredientPill: { maxWidth: '100%', minHeight: 44, minWidth: 44, justifyContent: 'center' },
  quantity: { flex: 1, minWidth: 100, minHeight: 52, padding: space.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, color: colors.text, fontSize: 18 },
});
