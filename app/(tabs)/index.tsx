import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Keyboard, Pressable, RefreshControl, StyleSheet, Text, TextInput, View } from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { Body, Button, Card, Centered, Chip, ErrorBox, Muted, Screen, Title } from '@/components/ui';
import { colors, font, space } from '@/constants/theme';
import { deleteRecipe, listLibrary, type LibraryItem } from '@/lib/db';
import { setDemoMode, useDemoMode } from '@/lib/demo';
import { resetDemo } from '@/lib/demoDb';
import { DEMO_IDS } from '@/lib/demoData';
import { imports, useImportJob } from '@/lib/importJobs';
import { preferences, usePreferences } from '@/lib/preferences';
import { filterLibrary, type LibraryFilter } from '@/lib/libraryTools';
import { RESTRICTIONS, type Restriction } from '@/lib/restrictions';
import { supabaseConfigured } from '@/lib/supabase';

export default function LibraryScreen() {
  const demo = useDemoMode();
  const prefs = usePreferences();
  const [showRestrictions, setShowRestrictions] = useState(false);
  const job = useImportJob();
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { if (!job || !['queued', 'uploading', 'extracting'].includes(job.stage)) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [job?.id, job?.stage]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('All');
  const loadRun = useRef(0);
  const modeRef = useRef(demo); modeRef.current = demo;
  const [items, setItems] = useState<LibraryItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const run = ++loadRun.current;
    if (!supabaseConfigured && !demo) { setItems([]); setError(null); return; }
    try {
      setError(null);
      const next = await listLibrary();
      if (run === loadRun.current && modeRef.current === demo) setItems(next);
    } catch (e) {
      if (run !== loadRun.current || modeRef.current !== demo) return;
      setError((e as Error).message);
      setItems([]);
    }
  }, [demo]);

  useEffect(() => { if (job?.result || job?.stage === 'ready') void load(); }, [job?.result?.versionId, job?.stage, load]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const onRefresh = async () => { setRefreshing(true); await load(); setRefreshing(false); };

  const startDemo = () => { if (job && job.stage !== 'ready') return; loadRun.current++; imports.dismiss(); resetDemo(); setDemoMode(true); setItems(null); };
  const exitDemo = () => { if (job && job.stage !== 'ready') return; loadRun.current++; imports.dismiss(); setDemoMode(false); resetDemo(); setItems(null); };

  const confirmDelete = (item: LibraryItem) =>
    Alert.alert('Delete recipe?', `"${item.title}" and all its versions will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { try { await deleteRecipe(item.id); await load(); } catch (e) { setError((e as Error).message); } } },
    ]);

  const pending = job && job.stage !== 'ready' ? job : null;
  const visible = filterLibrary((items ?? []).filter(i => i.id !== pending?.recipeId), query, filter);
  const showJob = pending && filter !== 'Recent' && `${pending.inputs.clip.name} ${pending.result?.recipe.title ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());
  const noBackend = !supabaseConfigured && !demo;

  const listHeader = <>
      <View style={s.header}>
        <View style={s.headerRow}>
          <Title>ForkLog</Title>
          {demo ? (
            <Button title="Exit demo" variant="ghost" disabled={!!job && job.stage !== 'ready'} onPress={exitDemo} style={s.headerBtn} />
          ) : (
            <Button title="Demo" variant="ghost" disabled={!!job && job.stage !== 'ready'} onPress={startDemo} style={s.headerBtn} />
          )}
        </View>
        <Muted>Cook it like the video. Keep what you changed.</Muted>
      </View>

      {demo && (
        <Card style={s.demoCard}>
          <View style={s.demoRow}>
            <Chip label="DEMO" tone="active" />
            <View style={{ flex: 1 }}><Body bold>Sample data, scripted coach, device voice.</Body></View>
          </View>
          <Muted size={14}>Import → pick “Use the demo clip”. Cook → watch the chips and corrections appear on each step. Finish → recap diff → save v2 → Versions.</Muted>
          <Button title="Skip to the recap of a finished cook" variant="ghost" onPress={() => router.push(`/recap/${DEMO_IDS.cook}`)} />
        </Card>
      )}

      {noBackend && (
        <Card style={s.demoCard}>
          <Body bold>No backend connected yet</Body>
          <Muted size={14}>Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to .env and restart Expo. Until then the app runs in demo mode.</Muted>
          <Button title="Start the demo" size="lg" disabled={!!job && job.stage !== 'ready'} onPress={startDemo} />
        </Card>
      )}

      <View style={s.meta}><Muted size={14}>Preset guidance:</Muted><Button title="English" disabled={!prefs.loaded} variant={prefs.language === 'en' ? 'primary' : 'ghost'} onPress={() => preferences.setLanguage('en')} /><Button title="Español" disabled={!prefs.loaded} variant={prefs.language === 'es' ? 'primary' : 'ghost'} onPress={() => preferences.setLanguage('es')} /></View>
      <Muted size={13}>Device preference survives demo reset. Source recipe text and ingredient names remain untranslated; camera coaching stays in English.</Muted>
      <Button title={`Ingredient reminders (${prefs.restrictions?.length ?? 0})`} variant="ghost" onPress={() => setShowRestrictions(!showRestrictions)} />
      {showRestrictions && <Card><Body bold>Device ingredient reminders</Body><Muted size={14}>A small name/alias list only. These settings do not certify recipes or detect every allergen.</Muted><View style={s.meta}>{(Object.keys(RESTRICTIONS) as Restriction[]).map(key => <Button key={key} title={RESTRICTIONS[key]} disabled={!prefs.loaded} variant={prefs.restrictions?.includes(key) ? 'primary' : 'ghost'} onPress={() => preferences.setRestrictions(prefs.restrictions.includes(key) ? prefs.restrictions.filter(r => r !== key) : [...prefs.restrictions, key])} />)}</View></Card>}
      {prefs.error && <ErrorBox message={prefs.error} />}
      {error && <ErrorBox message={error} />}

      <TextInput returnKeyType="search" onSubmitEditing={() => Keyboard.dismiss()} value={query} onChangeText={setQuery} placeholder="Search titles or included ingredients" placeholderTextColor={colors.muted} style={{ color: colors.text, padding: space.md, borderWidth: 1, borderColor: colors.border }} />
      <View style={s.meta}>{(['All', 'Recent', 'Processing'] as const).map(f => <Button key={f} title={f} variant={filter === f ? 'primary' : 'ghost'} onPress={() => setFilter(f)} />)}<Button title="Clear" variant="ghost" onPress={() => { setQuery(''); setFilter('All'); }} /></View>
      {filter === 'Recent' && <Muted size={13}>Recent = recipes created in the past 7 days.</Muted>}
      {showJob && <Card><Body bold>{pending.result?.recipe.title ?? pending.inputs.clip.name}</Body>{['queued', 'uploading', 'extracting'].includes(pending.stage) && <ActivityIndicator color={colors.accent} />}<Chip label={pending.stage} tone={pending.stage === 'failed' ? 'bad' : 'active'} /><Muted size={14}>{pending.demo ? 'Scripted demo' : 'Foreground import'} · {Math.max(0, Math.floor((clock - pending.startedAt) / 1000))}s · recipe {pending.result ? 'extracted' : 'not yet confirmed'}</Muted><Muted size={14}>References: {pending.frames ? `${pending.frames.done}/${pending.frames.total} attempts; ${pending.frames.succeeded} ready, ${pending.frames.failed} failed${pending.frames.scripted ? ' (simulated, no uploads)' : ''}` : 'not started'}</Muted>{pending.error && <ErrorBox message={pending.error} />}<Button title="Open import" onPress={() => router.navigate({ pathname: '/import', params: { jobId: pending.id } })} /></Card>}
    </>;
  return (
    <Screen>
      <FlatList
        ListHeaderComponent={listHeader}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        data={visible}
        keyExtractor={i => i.id}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />}
        ListEmptyComponent={
          items === null || noBackend || showJob ? null : (
            <Centered>
              <Text style={s.emptyEmoji}>🍳</Text>
              <Text style={s.emptyTitle}>{query || filter !== 'All' ? 'No matching recipes' : 'No recipes yet'}</Text>
              <Muted>{filter === 'Processing' ? 'No pending imports match this search.' : query || filter === 'Recent' ? 'Clear search or choose All to see more recipes.' : 'Import a cooking video to begin.'}</Muted>
              <Button title="Import a video" size="lg" onPress={() => router.navigate('/import')} />
            </Centered>
          )
        }
        renderItem={({ item }) => (
          <Pressable onLongPress={() => confirmDelete(item)} onPress={() => router.push(`/history/${item.id}`)}>
            <Card>
              <View style={s.row}>
                <Text style={s.cardTitle} numberOfLines={2}>{item.title}</Text>
                <Chip label={item.version_count ? `v${item.latest}` : 'Not extracted'} tone="active" />
              </View>
              {item.source_summary ? <Muted size={15}>{item.source_summary}</Muted> : null}
              <View style={s.meta}>
                {item.best_rating != null && <Chip label={`★ ${item.best_rating}/10`} tone="good" />}
                {job?.stage === 'ready' && job.recipeId === item.id && <Chip label="Recipe ready" tone="good" />}
                {item.version_count > 1 && <Chip label={`${item.version_count} versions`} />}
              </View>
              {job?.stage === 'ready' && job.recipeId === item.id && <Muted size={13}>References: {job.frames?.scripted ? 'demo simulation (no images)' : `${job.frames?.succeeded ?? 0} ready; ${job.frames?.failed ?? 0} failed`}. Recipe readiness is separate.</Muted>}
              {item.version_count === 0 && <Muted>Extraction not confirmed. This retained import has no cookable version yet.</Muted>}
              <View style={s.actions}>
                <Button title="Cook" disabled={item.version_count === 0} size="lg" style={{ flex: 1 }} onPress={() => router.push(`/cook/${item.id}`)} />
                <Button title="Versions" variant="ghost" size="lg" onPress={() => router.push(`/history/${item.id}`)} />
              </View>
            </Card>
          </Pressable>
        )}
      />
    </Screen>
  );
}

const s = StyleSheet.create({
  header: { paddingVertical: space.md, gap: space.xs },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerBtn: { minHeight: 44, paddingHorizontal: space.md },
  demoCard: { marginBottom: space.md, borderColor: colors.accent },
  demoRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  list: { gap: space.md, paddingBottom: 120, flexGrow: 1 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: space.sm },
  cardTitle: { color: colors.text, fontSize: font.big, fontWeight: '700', flex: 1 },
  meta: { flexDirection: 'row', gap: space.sm, flexWrap: 'wrap' },
  actions: { flexDirection: 'row', gap: space.sm, marginTop: space.xs },
  emptyEmoji: { fontSize: 56 },
  emptyTitle: { color: colors.text, fontSize: font.big, fontWeight: '700' },
});
