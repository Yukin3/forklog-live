// Local regression checks. Transpile in memory; native modules and cloud calls are explicit mocks.
// Run: node --test scripts/check-finishing.cjs (no install, network, database or generated files).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function loader(mocks = {}, globals = {}, sources = {}) {
  const cache = new Map();
  function load(file) {
    file = path.resolve(root, file);
    if (cache.has(file)) return cache.get(file).exports;
    if (file.endsWith('.json')) return JSON.parse(fs.readFileSync(file, 'utf8'));
    const module = { exports: {} };
    cache.set(file, module);
    const source = sources[path.relative(root, file).replaceAll('\\', '/')] ?? fs.readFileSync(file, 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
    }, fileName: file, reportDiagnostics: true });
    assert.equal((compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, file);
    const req = name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (name.startsWith('https://esm.sh/zod')) return require('zod');
      if (name.startsWith('.') || name.startsWith('@/')) {
        let resolved = name.startsWith('@/') ? path.join(root, name.slice(2)) : path.resolve(path.dirname(file), name);
        if (!path.extname(resolved)) resolved = fs.existsSync(path.join(resolved, 'index.ts')) ? path.join(resolved, 'index.ts') : resolved + (fs.existsSync(resolved + '.ts') ? '.ts' : '.tsx');
        const key = path.relative(root, resolved).replaceAll('\\', '/');
        if (Object.hasOwn(mocks, key)) return mocks[key];
        return load(resolved);
      }
      if (name.startsWith('expo-') || name === 'react-native' || name.startsWith('https://')) throw new Error(`Unmocked external dependency: ${name}`);
      return require(name);
    };
    const context = { require: req, module, exports: module.exports, console, Buffer, Uint8Array,
      atob, setTimeout, clearTimeout, setInterval: () => 1, clearInterval: () => {},
      Date, Response, Request, __DEV__: false, process: { env: {} }, ...globals };
    vm.runInNewContext(compiled.outputText, context, { filename: file });
    return module.exports;
  }
  return load;
}
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
function recipe(load) { return plain(load('lib/demoData.ts').DEMO_RECIPE); }
function omittedRecipe(load) {
  const r = recipe(load);
  r.ingredients.find(i => i.name === 'garlic').omitted = true;
  return r;
}

test('canonical omissions change requirements, retain source references, and undo restores them', () => {
  const load = loader(); const r = recipe(load); const original = plain(r);
  const options = load('lib/recipeOptions.ts');
  r.ingredients.find(i => i.name === 'garlic').omitted = true;
  assert(!options.stepOptions(r, 3).expected.includes('garlic'));
  assert(options.stepOptions(r, 3).allOmitted);
  assert.match(options.instructionText(r, 3), /intentionally omitted/);
  assert.equal(options.ingredientDiff(original, r)[0].type, 'removed');
  assert.deepEqual(r.steps, original.steps);
  r.ingredients.find(i => i.name === 'garlic').omitted = false;
  assert(options.stepOptions(r, 3).expected.includes('garlic'));
  assert.equal(options.ingredientDiff(original, r).length, 0);
  assert.equal(options.hasAdaptations(r), false);
});

test('manual quantities and omissions survive schema parsing and model recap proposals', () => {
  const load = loader(); const r = omittedRecipe(load); const o = load('lib/recipeOptions.ts');
  const soy = r.ingredients.find(i => i.name === 'soy sauce');
  soy.source_qty = soy.qty; soy.source_unit = soy.unit; soy.qty = '1';
  const parsed = load('lib/guards.ts').RecipeSchema.parse(r);
  assert(parsed.ingredients.find(i => i.name === 'garlic').omitted);
  const proposal = recipe(load);
  proposal.steps.reverse();
  const preserved = o.preserveIntentions(parsed, proposal);
  assert.equal(preserved.ingredients.find(i => i.name === 'soy sauce').qty, '1');
  assert(preserved.ingredients.find(i => i.name === 'garlic').omitted);
  assert.deepEqual(plain(preserved.steps.map(s => [s.n, s.ref_frame_sec])), r.steps.map(s => [s.n, s.ref_frame_sec]));
  assert.equal(o.adaptCoachEvent(load('lib/demoData.ts').DEMO_COACH_SCRIPT[3][0].event, r, 3, true), null);
});

test('demo import → child version → cook selected version → recap → history → undo preserves v1', async () => {
  const load = loader(); const { demoDb: db, demoInvoke } = load('lib/demoDb.ts');
  const o = load('lib/recipeOptions.ts');
  const id = await db.createRecipe();
  const extracted = await demoInvoke('extract-recipe', { recipe_id: id });
  const v1 = await db.getVersion(extracted.version_id);
  const before = plain(v1.recipe_json);
  const draft = plain(before); draft.ingredients.find(i => i.name === 'garlic').omitted = true;
  const cookId = await db.startCook(id, v1.id);
  const v2 = await db.saveVersion({ recipeId: id, parentId: v1.id, recipe: draft, diff: o.ingredientDiff(before, draft), rating: null, notes: 'intentional' });
  await db.activateCookVersion(cookId, v2.id);
  assert.equal((await db.getCook(cookId)).base_version_id, v2.id);
  const reopened = await db.getVersion(v2.id); // navigation/reload of the screen, not process persistence
  assert(reopened.recipe_json.ingredients.find(i => i.name === 'garlic').omitted);
  assert.deepEqual(plain((await db.getVersion(v1.id)).recipe_json), before);
  const recap = await demoInvoke('recap', { cook_id: cookId, rating: 8 });
  assert.equal(recap.diff.length, 0);
  assert.match(recap.spoken_recap, /scripted demo cannot measure/);
  assert(recap.proposed_version.ingredients.find(i => i.name === 'garlic').omitted);
  const v3 = await db.saveVersion({ recipeId: id, parentId: v2.id, recipe: recap.proposed_version, diff: recap.diff, rating: 8, notes: '', cookId });
  const repeated = await db.saveVersion({ recipeId: id, parentId: v2.id, recipe: recap.proposed_version, diff: recap.diff, rating: 8, notes: '', cookId });
  assert.equal(repeated.id, v3.id);
  assert.equal((await db.getVersions(id)).length, 3);
  const replay = await db.startCook(id, v2.id);
  const restored = plain(reopened.recipe_json); restored.ingredients.find(i => i.name === 'garlic').omitted = false;
  const v4 = await db.saveVersion({ recipeId: id, parentId: v2.id, recipe: restored, diff: o.ingredientDiff(reopened.recipe_json, restored), rating: null, notes: 'undo' });
  await db.activateCookVersion(replay, v4.id);
  assert(o.stepOptions((await db.getVersion(v4.id)).recipe_json, 3).expected.includes('garlic'));
  assert.deepEqual(plain((await db.getVersion(v1.id)).recipe_json), before);
  await assert.rejects(db.activateCookVersion(cookId, v4.id), /Cannot activate/);
});

function visionSetup({ adapted = false, demo = false, response, capability = async () => {}, sources = {} } = {}) {
  const events = []; const stats = []; const calls = [];
  const load = loader({
    'lib/demo.ts': { isDemoMode: () => demo },
    'lib/supabase.ts': { requireAdaptationBackend: capability, supabase: { functions: { invoke: async (name, opts) => { calls.push(opts.body); return response?.promise ?? { data: { ok: true, event: null }, error: null }; } } } },
    'lib/image.ts': { resizeJpeg: async (_uri, width) => ({ uri: `mock://${width}`, base64: 'AA==' }), base64ToBytes: () => new Uint8Array([0]), deleteQuietly: () => {} },
  }, {}, sources);
  const r = adapted ? omittedRecipe(load) : recipe(load);
  const loop = new (load('lib/visionLoop.ts').VisionLoop)({ current: { takePictureAsync: async () => ({ uri: 'mock://shot' }) } }, r, 'recipe', 'cook', (ev, n) => events.push([ev, n]), s => stats.push(s));
  return { load, loop, events, stats, calls };
}

for (const action of ['change step', 'stop']) test(`late coach result is discarded after ${action}`, async () => {
  const response = deferred(); const { load, loop, events, calls } = visionSetup({ response });
  loop.start(); const request = loop.tick(); await flush();
  assert.equal(calls.length, 1);
  if (action === 'change step') loop.setStep(2); else loop.stop();
  response.resolve({ data: { ok: true, event: load('lib/demoData.ts').DEMO_COACH_SCRIPT[1][0].event }, error: null });
  await request; assert.equal(events.length, 0); loop.stop();
});

test('coach duplicate tick is blocked while request is pending; processing state clears', async () => {
  const response = deferred(); const { loop, calls, stats } = visionSetup({ response });
  loop.start(); const request = loop.tick(); await flush(); await loop.tick();
  assert.equal(calls.length, 1); assert(stats.at(-1).processing);
  response.resolve({ data: { ok: true, event: null }, error: null });
  await request; assert.equal(stats.at(-1).processing, false); loop.stop();
});

test('an incompatible deployment blocks adapted live frames before capture/invoke', async () => {
  const { loop, calls, stats } = visionSetup({ adapted: true, capability: async () => { throw new Error('deployment missing adaptation contract'); } });
  loop.start(); await loop.tick();
  assert.equal(calls.length, 0); assert.match(stats.at(-1).lastError, /deployment missing/); loop.stop();
});

test('adapted scripted demo emits no fabricated camera comparisons', () => {
  const { loop, events } = visionSetup({ adapted: true, demo: true });
  loop.start(); loop.tickDemo(Date.now() + 25_000);
  assert.equal(events.length, 0); loop.stop();
});

function voiceSetup(sources = {}, stop = async () => {}, voices = []) {
  const requests = []; const played = []; const speech = []; const lines = [];
  const load = loader({
    'lib/demo.ts': { isDemoMode: () => false },
    'lib/supabase.ts': { supabase: { functions: { invoke: async (_name, { body }) => { const d = deferred(); requests.push({ text: body.text, ...d }); return d.promise; } } } },
    'lib/image.ts': { base64ToBytes: () => new Uint8Array([0]) },
    'expo-file-system': { Paths: { cache: 'mock://cache' }, File: class { constructor(_p, name) { this.uri = name; } write() {} } },
    'expo-audio': { createAudioPlayer: ({ uri }) => ({ addListener: () => ({ remove() {} }), play: () => played.push(uri), pause() {}, remove() {} }), setAudioModeAsync: async () => {} },
    'expo-speech': { speak: (text, options) => speech.push({ text, options }), stop, getAvailableVoicesAsync: async () => voices },
  }, {}, sources);
  const speaker = load('lib/voice.ts').speaker;
  speaker.onLine = text => lines.push(text);
  const resolveAudio = request => request.resolve({ data: { ok: true, audio_b64: 'AA==' }, error: null });
  return { speaker, requests, played, speech, lines, resolveAudio };
}

for (const action of ['stop', 'mute']) test(`pending voice generation cannot play after ${action}`, async () => {
  const v = voiceSetup(); const saying = v.speaker.say('Old step', 'step');
  assert.equal(v.lines[0], 'Old step');
  if (action === 'stop') await v.speaker.stopAll(); else v.speaker.setMuted(true);
  v.resolveAudio(v.requests[0]); await saying;
  assert.equal(v.played.length, 0); assert.equal(v.speech.length, 0);
});

test('pending speaker serializes same-priority requests and stop alerts interrupt generation', async () => {
  const v = voiceSetup(); const first = v.speaker.say('Old intro', 'step');
  await v.speaker.say('New intro', 'step'); assert.equal(v.requests.length, 1);
  const urgent = v.speaker.say('Pull the pan off the heat.', 'stop'); await flush();
  assert.equal(v.requests.length, 2);
  v.resolveAudio(v.requests[0]); await first; assert.equal(v.played.length, 0);
  v.resolveAudio(v.requests[1]); await urgent; assert.equal(v.played.length, 1);
  await v.speaker.stopAll();
});

test('prefetch and speech share one TTS request per line; failures retain device fallback', async () => {
  const v = voiceSetup(); const prefetched = v.speaker.prefetch(['Same line']); const saying = v.speaker.say('Same line', 'step');
  assert.equal(v.requests.length, 1); v.resolveAudio(v.requests[0]); await Promise.all([prefetched, saying]);
  assert.equal(v.played.length, 1); await v.speaker.stopAll();
  const fallback = v.speaker.say('Fallback line', 'step');
  v.requests[1].reject(new Error('mock unavailable')); await fallback;
  assert.equal(v.speech[0].text, 'Fallback line');
});

test('reference processing reports failures separately from attempted completion', async () => {
  let upload = 0; const reports = [];
  const load = loader({
    'lib/demo.ts': { isDemoMode: () => false },
    'expo-video-thumbnails': { getThumbnailAsync: async () => ({ uri: 'mock://thumb' }) },
    'lib/image.ts': { resizeJpeg: async () => ({ uri: 'mock://small', base64: 'AA==' }), base64ToArrayBuffer: () => new ArrayBuffer(1), deleteQuietly: () => {} },
    'lib/supabase.ts': { supabase: { storage: { from: () => ({ upload: async () => ({ error: upload++ === 0 ? { message: 'mock failure' } : null }) }) }, from: () => ({ upsert: async () => ({ error: null }) }) } },
  });
  const r = recipe(load); r.steps = r.steps.slice(0, 2);
  await load('lib/refFrames.ts').uploadRefFrames('mock://video', 'recipe', 'version', r, p => reports.push(p));
  assert.deepEqual(plain(reports.at(-1)), { done: 2, total: 2, succeeded: 1, failed: 1, scripted: false });
});

test('shared guards/options/prompts are synchronized with app copies', () => {
  for (const [app, shared] of [['lib/guards.ts', 'supabase/functions/_shared/guards.ts'], ['lib/recipeOptions.ts', 'supabase/functions/_shared/recipeOptions.ts'], ['prompts/index.ts', 'supabase/functions/_shared/prompts.ts']]) {
    const normalize = file => fs.readFileSync(path.join(root, file), 'utf8').replaceAll('\r\n', '\n').replace("'https://esm.sh/zod@3'", "'zod'").replace("'./guards.ts'", "'./guards'");
    assert.equal(normalize(app), normalize(shared), `${app} differs from ${shared}`);
  }
});

// Fluent local Supabase mock. All reads/writes below affect these arrays only.
function mockDatabase(tables, failWrite = () => false) {
  const writes = [];
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.operation = 'read'; }
    select() { return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    is(key, value) { return this.eq(key, value); }
    not(key, _op, value) { this.filters.push(row => row[key] !== value); return this; }
    order(key, options = {}) { this.ordering = [key, options.ascending !== false]; return this; }
    limit(n) { this.limitN = n; return this; }
    update(values) { this.operation = 'update'; this.values = values; return this; }
    insert(values) { this.operation = 'insert'; this.values = values; return this; }
    upsert(values) { this.operation = 'upsert'; this.values = values; return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.one = true; this.optional = true; return this; }
    then(resolve, reject) {
      try {
        let rows = (tables[this.table] ?? []).filter(row => this.filters.every(f => f(row)));
        if (this.operation !== 'read') {
          writes.push({ table: this.table, operation: this.operation, values: plain(this.values) });
          if (failWrite(this.table, this.operation, this.values)) return Promise.resolve({ data: null, error: { message: 'mock write failed' } }).then(resolve, reject);
          if (this.operation === 'update') rows.forEach(row => Object.assign(row, this.values));
          else {
            rows = (Array.isArray(this.values) ? this.values : [this.values]).map((v, i) => ({ id: `saved-${writes.length}-${i}`, is_best: false, created_at: new Date().toISOString(), ...plain(v) }));
            (tables[this.table] ??= []).push(...rows);
          }
        }
        if (this.ordering) { const [key, asc] = this.ordering; rows = [...rows].sort((a, b) => (a[key] > b[key] ? 1 : a[key] < b[key] ? -1 : 0) * (asc ? 1 : -1)); }
        if (this.limitN) rows = rows.slice(0, this.limitN);
        const error = this.one && !this.optional && !rows[0] ? { message: 'mock row not found' } : null;
        return Promise.resolve({ data: this.one ? rows[0] ?? null : rows, error }).then(resolve, reject);
      } catch (error) { return Promise.reject(error).then(resolve, reject); }
    }
  }
  return { writes, from: table => new Query(table), storage: { from: () => ({ download: async () => ({ data: null }) }) } };
}

function backendSetup({ stub = false, adapt = true, modelResult, failWrite } = {}) {
  let handler; const calls = [];
  const initial = loader(); const r = adapt ? omittedRecipe(initial) : recipe(initial);
  const tables = {
    cooks: [{ id: 'cook', recipe_id: 'recipe', base_version_id: 'child', ended_at: null, saved_version_id: null, started_at: new Date().toISOString(), rating: null, notes: null }],
    versions: [{ id: 'child', recipe_id: 'recipe', number: 2, parent_id: 'source', recipe_json: r, diff_json: [], rating: null, notes: null, is_best: false, created_at: new Date().toISOString() }],
    recipes: [{ id: 'recipe', title: r.title }], ref_frames: [], cook_events: [],
  };
  const database = mockDatabase(tables, failWrite);
  const load = loader({
    'https://esm.sh/@supabase/supabase-js@2': { createClient: () => database },
    'supabase/functions/_shared/gemini.ts': { STUB_MODE: stub, bytesToBase64: () => 'AA==', geminiGenerate: async opts => { calls.push(opts); return JSON.stringify(modelResult ?? initial('lib/demoData.ts').DEMO_RECAP); } },
    'lib/demo.ts': { isDemoMode: () => false },
    'lib/supabase.ts': { supabase: database, DEMO_USER_ID: 'test-only' },
    'expo-file-system': { File: class {} },
  }, { Deno: { env: { get: () => 'test-only' }, serve: fn => { handler = fn; } } });
  const serve = file => { load(file); return async body => plain(await (await handler(new Request('http://test-only.local', { method: 'POST', body: JSON.stringify(body) }))).json()); };
  return { serve, load, tables, database, calls, recipe: r };
}

test('backend capability probes perform no database writes and identify STUB_MODE', async () => {
  for (const file of ['coach-frame', 'recap']) {
    const b = backendSetup({ stub: true });
    const result = await b.serve(`supabase/functions/${file}/index.ts`)({ capability_check: true });
    assert.equal(result.adaptation_contract, 'ingredient-options-v1'); assert.equal(result.scripted, true);
    assert.equal(b.database.writes.length, 0); assert.equal(b.calls.length, 0);
  }
});

test('backend coach resolves selected child version and skips a wholly omitted source step', async () => {
  const b = backendSetup();
  const result = await b.serve('supabase/functions/coach-frame/index.ts')({ cook_id: 'cook', step_n: 3, user_frame_b64: 'AA==' });
  assert.equal(result.intentionally_skipped, true); assert.equal(result.event, null);
  assert.equal(b.calls.length, 0); assert.equal(b.database.writes.length, 0);
});

test('backend coach supplies adapted expectations/quantities and rejects an omitted detection', async () => {
  const initial = loader();
  const ev = initial('lib/demoData.ts').DEMO_COACH_SCRIPT[4][0].event;
  const b = backendSetup({ modelResult: ev });
  const soy = b.recipe.ingredients.find(i => i.name === 'soy sauce'); soy.omitted = true;
  const result = await b.serve('supabase/functions/coach-frame/index.ts')({ cook_id: 'cook', step_n: 4, user_frame_b64: 'AA==' });
  assert.equal(result.event, null);
  const prompt = b.calls[0].parts.at(-1).text;
  assert.match(prompt, /Expected ingredients this step: honey/);
  assert.match(prompt, /Intentional changes:.*Omit soy sauce/);
  assert.equal(b.tables.cook_events.length, 0);
});

test('backend STUB_MODE does not replay source coaching for an adapted recipe', async () => {
  const b = backendSetup({ stub: true });
  const result = await b.serve('supabase/functions/coach-frame/index.ts')({ cook_id: 'cook', step_n: 4, user_frame_b64: 'AA==' });
  assert.equal(result.scripted, true); assert.equal(result.event, null); assert.equal(b.tables.cook_events.length, 0);
});

test('backend recap preserves omissions and rejects source-only diff/advice', async () => {
  const b = backendSetup();
  const result = await b.serve('supabase/functions/recap/index.ts')({ cook_id: 'cook', rating: 8, notes: 'No garlic on purpose' });
  assert.equal(result.ok, true); assert.equal(result.scripted, false);
  assert(result.proposed_version.ingredients.find(i => i.name === 'garlic').omitted);
  assert(!result.diff.some(d => d.field.toLowerCase().includes('garlic')));
  assert.equal(result.suggestion, null);
  assert.deepEqual(result.proposed_version.steps.map(s => [s.n, s.ref_frame_sec]), b.recipe.steps.map(s => [s.n, s.ref_frame_sec]));
});

test('backend adapted STUB recap is clearly scripted and makes no inferred measurements', async () => {
  const b = backendSetup({ stub: true });
  const result = await b.serve('supabase/functions/recap/index.ts')({ cook_id: 'cook' });
  assert.equal(result.scripted, true); assert.equal(result.diff.length, 0);
  assert.match(result.spoken_recap, /STUB_MODE cannot measure/);
  assert(result.proposed_version.ingredients.find(i => i.name === 'garlic').omitted);
});

test('cloud data layer saves a child without a fake cook, copies references, and activates that exact version', async () => {
  const b = backendSetup(); const db = b.load('lib/db.ts');
  b.tables.ref_frames.push({ version_id: 'child', step_n: 3, storage_path: 'source/step-3.jpg' });
  const saved = await db.saveVersion({ recipeId: 'recipe', parentId: 'child', recipe: b.recipe, diff: [], rating: null, notes: 'intentional' });
  assert.equal(saved.number, 3); assert.equal(saved.parent_id, 'child');
  assert(b.tables.ref_frames.some(f => f.version_id === saved.id && f.step_n === 3 && f.storage_path === 'source/step-3.jpg'));
  assert(!b.database.writes.some(w => w.table === 'cooks'));
  await db.activateCookVersion('cook', saved.id);
  assert.equal(b.tables.cooks[0].base_version_id, saved.id);
  assert.equal(b.tables.versions.length, 2);
});

test('partial reference-copy failure returns saved child and explicit warning, not false complete success', async () => {
  const b = backendSetup({ failWrite: (table, op) => table === 'ref_frames' && op === 'upsert' });
  b.tables.ref_frames.push({ version_id: 'child', step_n: 3, storage_path: 'source/step-3.jpg' });
  const saved = await b.load('lib/db.ts').saveVersion({ recipeId: 'recipe', parentId: 'child', recipe: b.recipe, diff: [], rating: null, notes: 'intentional' });
  assert(saved.id); assert.match(saved.save_warnings[0], /copying reference-frame links failed/);
  assert.equal(b.tables.versions.length, 2);
});

test('failed cook attachment is retriable without creating a duplicate child', async () => {
  let fail = true;
  const b = backendSetup({ failWrite: table => table === 'cooks' && fail }); const db = b.load('lib/db.ts');
  const saved = await db.saveVersion({ recipeId: 'recipe', parentId: 'child', recipe: b.recipe, diff: [], rating: null, notes: 'intentional' });
  await assert.rejects(db.activateCookVersion('cook', saved.id), /mock write failed/);
  assert.equal(b.tables.cooks[0].base_version_id, 'child');
  fail = false; await db.activateCookVersion('cook', saved.id);
  assert.equal(b.tables.cooks[0].base_version_id, saved.id); assert.equal(b.tables.versions.length, 2);
});

test('preset guidance excludes omissions and uses confirmed quantities from the selected version', () => {
  const load = loader(); const r = omittedRecipe(load); const { answerRecipeQuestion: answer } = load('lib/recipeGuidance.ts');
  assert.match(answer('howmuch', r, 3), /intentionally omitted/);
  assert.match(answer('next', r, 2), /intentionally omitted/);
  assert.match(answer('look', r, 3), /not an exact target/);
  const soy = r.ingredients.find(i => i.name === 'soy sauce');
  soy.source_qty = soy.qty; soy.source_unit = soy.unit; soy.qty = '1'; soy.confidence = 0.1;
  assert.match(answer('howmuch', r, 4), /^1 tbsp soy sauce/);
  assert(!answer('howmuch', r, 4).startsWith('about 1'));
});

test('new speech waits for a delayed device stop rather than being cancelled by it', async () => {
  const stopped = deferred(); const v = voiceSetup({}, () => stopped.promise);
  const first = v.speaker.say('Device fallback', 'step');
  v.requests[0].reject(new Error('mock unavailable')); await first;
  const stopping = v.speaker.stopAll(); const second = v.speaker.say('New step', 'step');
  await flush(); assert.equal(v.requests.length, 1);
  stopped.resolve(); await stopping; await flush();
  assert.equal(v.requests.length, 2); v.resolveAudio(v.requests[1]); await second;
  assert.equal(v.played.length, 1);
});

test('original baseline commit reproduces stale coach and pending-speech bugs under the same mocks', async () => {
  const { execFileSync } = require('node:child_process');
  const source = file => execFileSync('git', ['show', `4e7dece43301899df3d196709c3488f099799e75:${file}`], { cwd: root, encoding: 'utf8' });
  const response = deferred();
  const originalVision = visionSetup({ response, sources: { 'lib/visionLoop.ts': source('lib/visionLoop.ts') } });
  originalVision.loop.start(); const tick = originalVision.loop.tick(); await flush();
  originalVision.loop.stop();
  response.resolve({ data: { ok: true, event: originalVision.load('lib/demoData.ts').DEMO_COACH_SCRIPT[1][0].event }, error: null });
  await tick; assert.equal(originalVision.events.length, 1, 'baseline bug: stopped loop still delivers a late event');
  const originalVoice = voiceSetup({ 'lib/voice.ts': source('lib/voice.ts') });
  const speaking = originalVoice.speaker.say('Old pending step', 'step'); await originalVoice.speaker.stopAll();
  originalVoice.resolveAudio(originalVoice.requests[0]); await speaking;
  assert.equal(originalVoice.played.length, 1, 'baseline bug: cancelled TTS generation still starts audio');
  await originalVoice.speaker.stopAll();
});

function cookHarness({ failAttachOnce = false, restrictions = [] } = {}) {
  // Hook/event smoke test, not a native render or layout test.
  const cells = []; let index = 0; let dirty = true; let tree; let component; const pendingEffects = [];
  const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const hooks = {
    useState(initial) { const n = index++; if (!cells[n]) cells[n] = { value: typeof initial === 'function' ? initial() : initial }; return [cells[n].value, value => { cells[n].value = typeof value === 'function' ? value(cells[n].value) : value; dirty = true; }]; },
    useRef(initial) { const n = index++; return cells[n] ??= { current: initial }; },
    useEffect(fn, deps) { const n = index++; if (!equalDeps(cells[n]?.deps, deps)) { const old = cells[n]; cells[n] = { deps }; pendingEffects.push(() => { old?.cleanup?.(); cells[n].cleanup = fn(); }); } },
    useCallback(fn, deps) { const n = index++; if (!equalDeps(cells[n]?.deps, deps)) cells[n] = { value: fn, deps }; return cells[n].value; },
  };
  const dataLoad = loader(); const db = dataLoad('lib/demoDb.ts').demoDb; const ids = dataLoad('lib/demoData.ts').DEMO_IDS;
  const capability = deferred(); const counts = { save: 0, attach: 0, capability: 0 }; const spoken = []; const loops = [];
  let prefsLanguage = 'en';
  const voice = { revision: 0, isMuted: false, gate: { reset() {} }, prefetch: async () => {}, stopAll: async () => { voice.revision++; }, setMuted() {}, say: async line => { spoken.push(line); } };
  const load = loader({
    react: hooks,
    'react-native': { KeyboardAvoidingView: 'KeyboardAvoidingView', Platform: { OS: 'ios' }, View: 'View', Text: 'Text', TextInput: 'TextInput', ScrollView: 'ScrollView', Modal: 'Modal', Pressable: 'Pressable', StyleSheet: { create: value => value, absoluteFill: {} }, Alert: { alert() {} } },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView' },
    'expo-router': { router: { back() {}, replace() {} }, useLocalSearchParams: () => ({ recipeId: ids.recipe }) },
    'expo-camera': { CameraView: 'CameraView', useCameraPermissions: () => [{ granted: false }, async () => {}] },
    'expo-keep-awake': { useKeepAwake() {} },
    'expo-haptics': { selectionAsync: async () => {}, impactAsync: async () => {}, notificationAsync: async () => {}, ImpactFeedbackStyle: {}, NotificationFeedbackType: {} },
    'components/ui.tsx': Object.fromEntries(['Body', 'Button', 'Card', 'Centered', 'Chip', 'ErrorBox', 'Muted'].map(name => [name, name])),
    'lib/demo.ts': { useDemoMode: () => true },
    'lib/preferences.ts': { usePreferences: () => ({ language: prefsLanguage, error: null, restrictions }), preferences: { setLanguage(value) { prefsLanguage = value; dirty = true; void voice.stopAll(); } } },
    'lib/supabase.ts': { requireAdaptationBackend: () => { counts.capability++; return capability.promise; } },
    'lib/voice.ts': { speaker: voice },
    'lib/visionLoop.ts': { VisionLoop: class { constructor(_camera, r) { this.recipe = r; loops.push(this); } start() { this.active = true; } stop() { this.active = false; } setStep(n) { this.step = n; } } },
    'lib/db.ts': { ...db, saveVersion: async opts => { counts.save++; return db.saveVersion(opts); }, activateCookVersion: async (...args) => { counts.attach++; if (failAttachOnce && counts.attach === 1) throw new Error('mock attachment failed'); return db.activateCookVersion(...args); } },
  });
  component = load('app/cook/[recipeId].tsx').default;
  function render() {
    for (let safety = 0; dirty && safety < 20; safety++) { dirty = false; index = 0; tree = component(); pendingEffects.splice(0).forEach(effect => effect()); }
    assert(!dirty, 'hook renders should settle');
    return tree;
  }
  function find(predicate, node) {
    if (arguments.length === 1) node = render();
    if (Array.isArray(node)) return node.flatMap(child => find(predicate, child));
    if (!node || typeof node !== 'object' || !node.props) return [];
    if (node.type === 'Modal' && !node.props.visible) return [];
    if (typeof node.type === 'function') return find(predicate, node.type(node.props));
    return [...(predicate(node) ? [node] : []), ...find(predicate, node.props.children)];
  }
  const button = title => { const result = find(node => node.type === 'Button' && node.props.title === title)[0]; assert(result, `button ${title} exists`); return result.props; };
  const pressLabel = label => { const result = find(node => node.props.accessibilityLabel === label)[0]; assert(result, `${label} exists`); result.props.onPress(); render(); };
  async function settle() { await flush(); render(); await flush(); render(); }
  async function waitFor(predicate) { for (let i = 0; i < 100 && !predicate(); i++) { await new Promise(r => setTimeout(r, 10)); render(); } assert(predicate(), 'expected async screen state'); }
  return { render, find, button, pressLabel, settle, waitFor, capability, counts, loops, db, ids, spoken, voice,
    unmount: () => cells.forEach(cell => cell?.cleanup?.()) };
}

test('cook screen omission pauses coaching, blocks duplicate saves, applies the saved child, and guides from it', async () => {
  const h = cookHarness(); h.render(); await new Promise(r => setTimeout(r, 100)); await h.settle();
  h.button('Next step').onPress(); h.render(); h.button('Next step').onPress(); h.render();
  h.pressLabel('Omit garlic'); assert(h.loops.every(loop => !loop.active));
  assert(h.button("I'm done").disabled);
  const save = h.button('Save child version & apply'); save.onPress(); save.onPress();
  await h.settle(); assert.equal(h.counts.capability, 1); assert.equal(h.counts.save, 0);
  h.capability.resolve(); await h.waitFor(() => h.find(node => node.type === 'Chip' && node.props.label === 'v2').length > 0);
  assert.equal(h.counts.save, 1); assert.equal(h.counts.attach, 1);
  assert(h.loops.at(-1).recipe.ingredients.find(i => i.name === 'garlic').omitted);
  h.pressLabel('Preset recipe guidance'); h.button('How much goes in?').onPress(); await h.settle();
  assert.match(h.spoken.at(-1), /intentionally omitted/);
  assert(!(await h.db.getVersion(h.ids.version1)).recipe_json.ingredients.find(i => i.name === 'garlic').omitted);
  h.pressLabel('Undo omission of garlic'); assert(h.button("I'm done").disabled);
  h.button('Undo draft').onPress(); h.render(); assert(!h.button("I'm done").disabled);
  h.unmount();
});

test('cook screen retains a saved child after attach failure and retries without a duplicate insert', async () => {
  const h = cookHarness({ failAttachOnce: true }); h.render(); await new Promise(r => setTimeout(r, 100)); await h.settle();
  h.button('Next step').onPress(); h.render(); h.button('Next step').onPress(); h.render();
  h.pressLabel('Omit garlic'); h.capability.resolve(); h.button('Save child version & apply').onPress();
  await h.waitFor(() => h.find(node => node.type === 'Button' && node.props.title === 'Retry attach saved version' && !node.props.loading).length > 0);
  assert.equal(h.counts.save, 1); assert(h.loops.every(loop => !loop.active));
  h.button('Retry attach saved version').onPress(); await h.waitFor(() => h.find(node => node.type === 'Chip' && node.props.label === 'v2').length > 0);
  assert.equal(h.counts.save, 1); assert.equal(h.counts.attach, 2);
  h.unmount();
});

test('backend observation write failure returns an actionable error instead of successful coaching', async () => {
  const initial = loader(); const b = backendSetup({ adapt: false, modelResult: initial('lib/demoData.ts').DEMO_COACH_SCRIPT[1][0].event, failWrite: table => table === 'cook_events' });
  const result = await b.serve('supabase/functions/coach-frame/index.ts')({ cook_id: 'cook', step_n: 1, user_frame_b64: 'AA==' });
  assert.equal(result.ok, false); assert.match(result.error, /Could not save the observation/);
});

test('recap stops before model analysis when saving cook details fails', async () => {
  const b = backendSetup({ failWrite: table => table === 'cooks' });
  const result = await b.serve('supabase/functions/recap/index.ts')({ cook_id: 'cook' });
  assert.equal(result.ok, false); assert.match(result.error, /Retry when connected/); assert.equal(b.calls.length, 0);
});

test('app capability gate requires both deployed functions and sends read-only probes', async () => {
  const calls = [];
  const load = loader({
    '@supabase/supabase-js': { createClient: () => ({ functions: { invoke: async (name, opts) => { calls.push({ name, body: opts.body }); return { data: name === 'coach-frame' ? { ok: true, adaptation_contract: 'ingredient-options-v1' } : { ok: false, error: 'old deployment' }, error: null }; } } }) },
    'lib/demo.ts': { isDemoMode: () => false },
  });
  await assert.rejects(load('lib/supabase.ts').requireAdaptationBackend(), /coach-frame and recap/);
  assert.equal(calls.length, 2); assert(calls.every(call => call.body.capability_check === true && !call.body.cook_id));
});

// Increment 2: deterministic foreground lifecycle and readable selected-version export.
function importHarness(overrides = {}) {
  const load = loader(); const r = recipe(load); const calls = { extract: 0, upload: 0, save: 0 };
  const versions = []; const refs = deferred();
  const deps = {
    createRecipe: async () => 'import-recipe',
    uploadVideo: async () => { calls.upload++; return 'import-recipe/source.mp4'; },
    extract: async () => { calls.extract++; return { version_id: 'import-v1', recipe: r }; },
    getVersions: async () => versions,
    saveVersion: async opts => { calls.save++; return { id: 'import-v2', recipe_json: opts.recipe }; },
    frames: async (_uri, _id, _version, _r, progress) => { progress({ done: 1, total: 1, succeeded: 0, failed: 1, scripted: false }); await refs.promise; },
    ...overrides,
  };
  const controller = new (load('lib/importController.ts').ImportController)(deps);
  const inputs = { clip: { uri: 'local', mimeType: 'video/mp4', durationSec: 10, bytes: 500, name: 'clip' }, caption: 'original caption', variation: 'private', source: 'creator' };
  return { controller, deps, calls, versions, refs, inputs, r };
}
test('foreground import survives subscribers leaving, snapshots inputs, blocks duplicates and waits for reference attempts', async () => {
  const h = importHarness(); const notices = []; h.controller.onNotice(j => notices.push(j.stage));
  const unsubscribe = h.controller.subscribe(() => {});
  assert(h.controller.start(h.inputs, false)); unsubscribe();
  assert.equal(h.controller.start(h.inputs, false), false);
  h.inputs.caption = 'later'; await flush();
  assert.equal(h.controller.getSnapshot().inputs.caption, 'original caption');
  assert.equal(h.controller.getSnapshot().stage, 'review-needed');
  h.controller.editInputs({ caption: 'review only' });
  assert.equal(h.controller.getSnapshot().draftInputs.caption, 'review only');
  assert.equal(h.calls.extract, 1);
  assert.equal(await h.controller.applyReview(h.inputs), false);
  h.refs.resolve(); await flush();
  const first = h.controller.applyReview(h.inputs);
  assert.equal(await h.controller.applyReview(h.inputs), false);
  assert(await first); assert.equal(h.calls.save, 1);
  assert.equal(h.controller.getSnapshot().stage, 'ready');
  assert.equal(h.controller.getSnapshot().frames.failed, 1);
  assert.deepEqual(notices, ['review-needed']);
});
test('lost extraction response recovers saved recipe without deletion or repeat extraction', async () => {
  const h = importHarness(); h.deps.extract = async () => { h.calls.extract++; h.versions.push({ id: 'saved-v1', number: 1, recipe_json: h.r }); throw Error('response lost'); };
  h.controller.start(h.inputs, false); await flush();
  assert.equal(h.controller.getSnapshot().stage, 'review-needed');
  assert.equal(h.controller.getSnapshot().result.versionId, 'saved-v1');
  assert.equal(h.calls.extract, 1); h.refs.resolve(); await flush();
});
test('unknown extraction outcome retries recovery reads only; upload failure safely retries same recipe', async () => {
  const h = importHarness({ extract: async () => { throw Error('network unknown'); } });
  h.controller.start(h.inputs, false); await flush(); await h.controller.retry();
  assert.equal(h.controller.getSnapshot().stage, 'failed');
  assert.match(h.controller.getSnapshot().error, /not resubmitted/);
  const upload = deferred(); const g = importHarness(); let attempts = 0;
  g.deps.uploadVideo = async () => { if (++attempts === 1) throw Error('upload interrupted'); return 'same/path'; };
  g.controller.start(g.inputs, false); await flush(); await g.controller.retry(); await flush();
  assert.equal(g.controller.getSnapshot().stage, 'review-needed'); assert.equal(attempts, 2); g.refs.resolve();
});
test('ambiguous review save recovers child, avoids duplicate insert and ignores late old-job reference callbacks', async () => {
  const h = importHarness(); h.controller.start(h.inputs, false); await flush(); h.refs.resolve(); await flush();
  h.deps.saveVersion = async o => { h.calls.save++; h.versions.push({ id: 'saved-child', parent_id: o.parentId, notes: o.notes, recipe_json: o.recipe }); throw Error('lost insert response'); };
  assert(await h.controller.applyReview(h.inputs)); assert.equal(h.calls.save, 1);
  assert.equal(h.controller.getSnapshot().result.versionId, 'saved-child');
  assert(h.controller.start(h.inputs, false)); await flush(); assert.equal(h.calls.extract, 2);
});
test('library search/Recent/Processing use included ingredients and actual timestamps; export excludes private fields and media URLs', () => {
  const load = loader(); const tools = load('lib/libraryTools.ts'); const now = Date.parse('2026-10-11T16:00:00Z');
  const items = [{ id:'a', title:'Noodles', source_summary:'creator', search_ingredients:'soy sauce', created_at:'2026-10-10T16:00:00Z', version_count:1 }, {id:'b',title:'Old',created_at:'2026-09-01T16:00:00Z',version_count:0}];
  assert.equal(tools.filterLibrary(items,'soy','All',now).length,1);
  assert.equal(tools.filterLibrary(items,'','Recent',now).length,1);
  assert.equal(tools.filterLibrary(items,'','Processing',now)[0].id,'b');
  const r = omittedRecipe(load); r.notes = 'SECRET'; r.source_summary = 'Creator https://private.supabase.co/storage/secret';
  const text = tools.shareVersionText({number:2,recipe_json:r,notes:JSON.stringify({variation_notes:'PRIVATE',source_attribution:'Public creator'})});
  assert.match(text,/v2/); assert.match(text,/Intentionally omitted.*garlic/); assert.match(text,/Attribution: Public creator/);
  assert(!text.includes('SECRET')); assert(!text.includes('PRIVATE')); assert(!text.includes('supabase.co')); assert(!text.includes('private.supabase'));
  assert(!text.split('Steps')[0].includes('cloves garlic'));
});

test('Spanish local presets preserve exact canonical amounts and omission behavior without translating source', () => {
  const load = loader(); const r = omittedRecipe(load); const a = load('lib/recipeGuidance.ts').answerRecipeQuestion;
  const soy = r.ingredients.find(i => i.name === 'soy sauce'); soy.source_qty = soy.qty; soy.source_unit = soy.unit; soy.qty = '1½';
  assert.match(a('howmuch',r,3,'es'),/omitieron intencionalmente/);
  const step = r.steps.find(s => s.ingredients.includes('soy sauce')).n;
  const spanish = a('howmuch',r,step,'es'); assert.match(spanish,/1½ tbsp soy sauce/); assert(!spanish.includes('aproximadamente 1½'));
  assert(a('howmuch',r,step,'en').includes('1½ tbsp soy sauce'));
  assert.match(a('look',r,step,'es'),/sin traducir/); assert.match(a('safe',r,step,'es'),/termómetro/);
  assert.deepEqual(plain(r.steps.map(s=>s.ingredients)),recipe(load).steps.map(s=>s.ingredients));
});
test('preference persistence is separate from resettable demo recipes and late reads cannot overwrite user edits', async () => {
  const load = loader(); const Store = load('lib/preferencesStore.ts').PreferencesStore;
  let disk = null; let stops = 0; const read = deferred();
  const prefs = new Store({read:()=>read.promise,write:t=>{disk=t;}},()=>{stops++;});
  const loading = prefs.load(); prefs.setLanguage('es'); read.resolve('{"language":"en"}'); await loading;
  assert.equal(prefs.getSnapshot().language,'es'); assert.equal(JSON.parse(disk).language,'es');
  load('lib/demoDb.ts').resetDemo(); assert.equal(prefs.getSnapshot().language,'es');
  const restored = new Store({read:async()=>disk,write(){}},()=>{}); await restored.load(); assert.equal(restored.getSnapshot().language,'es');
  assert.equal(stops,1);
  const broken = new Store({read:async()=>'{bad',write(){throw Error('disk full');}},()=>{});
  await broken.load(); assert.match(broken.getSnapshot().error,/Preferences/); broken.setLanguage('es'); assert.match(broken.getSnapshot().error,/could not be saved/);
});
function spanishVoiceSetup(voices) {
  const speech=[]; const stop=[]; let tts=0;
  const load=loader({
    'lib/demo.ts':{isDemoMode:()=>false}, 'lib/supabase.ts':{supabase:{functions:{invoke:async()=>{tts++; throw Error('should not call TTS');}}}},
    'lib/image.ts':{base64ToBytes:()=>new Uint8Array()}, 'expo-file-system':{Paths:{cache:'mock'},File:class{}},
    'expo-audio':{createAudioPlayer(){},setAudioModeAsync:async()=>{}},
    'expo-speech':{getAvailableVoicesAsync:()=>voices,stop:async()=>{stop.push(1);},speak:(text,options)=>speech.push({text,options})}
  });
  return {speaker:load('lib/voice.ts').speaker,speech,stop,get tts(){return tts;}};
}
test('Spanish device speech matches language, avoids cloud TTS, and falls back to English if voice is missing', async () => {
  const v=spanishVoiceSetup(Promise.resolve([{language:'es-MX',identifier:'spanish'}]));
  await v.speaker.say('¿Cuánto?', 'alert',undefined,{language:'es',fallbackText:'How much?',clamp:false});
  assert.equal(v.speech[0].options.voice,'spanish'); assert.equal(v.speech[0].options.language,'es-MX'); assert.equal(v.tts,0);
  const missing=spanishVoiceSetup(Promise.resolve([])); const lines=[]; missing.speaker.onLine=x=>lines.push(x);
  await missing.speaker.say('¿Cuánto?', 'alert',undefined,{language:'es',fallbackText:'How much?'});
  assert.equal(missing.speech[0].text,'How much?'); assert.equal(missing.speech[0].options.language,'en-US'); assert.match(lines.at(-1),/English fallback/);
});
test('language switch cancels a pending Spanish voice lookup and an old device callback cannot stop new speech', async () => {
  const voices=deferred(); const v=spanishVoiceSetup(voices.promise);
  const pending=v.speaker.say('Viejo', 'step',undefined,{language:'es',fallbackText:'Old'});
  await v.speaker.stopAll(); voices.resolve([{language:'es',identifier:'es'}]); await pending;
  assert.equal(v.speech.length,0);
  await v.speaker.say('Nuevo','step',undefined,{language:'es',fallbackText:'New'});
  const old=v.speech[0].options;
  await v.speaker.stopAll(); await v.speaker.say('Segundo','step',undefined,{language:'es',fallbackText:'Second'});
  old.onDone(); assert.equal(v.speech.length,2); assert.equal(v.stop.length,1);
});

test('late reference progress from a completed job cannot update a later import', async () => {
  const h=importHarness(); const callbacks=[];
  h.deps.frames=async (_u,_i,_v,_r,p)=>{callbacks.push(p);};
  h.controller.start(h.inputs,false); await flush();
  assert(await h.controller.applyReview(h.inputs));
  const oldId=h.controller.getSnapshot().id;
  h.controller.start(h.inputs,false); await flush();
  callbacks[0]({done:99,total:99,succeeded:99,failed:0,scripted:false});
  assert.notEqual(h.controller.getSnapshot().id,oldId); assert.equal(h.controller.getSnapshot().frames.done,0);
});
test('Spanish runtime speech errors keep the English fallback and stale error callbacks cannot replace it', async () => {
  const v=spanishVoiceSetup(Promise.resolve([{language:'es-ES',identifier:'es'}]));
  await v.speaker.say('Texto','alert',undefined,{language:'es',fallbackText:'English'});
  v.speech[0].options.onError(Error('voice unavailable'));
  assert.equal(v.speech[1].text,'English'); assert.equal(v.speech[1].options.language,'en-US');
  v.speech[0].options.onError(Error('late')); assert.equal(v.speech.length,2);
});

function screenHarness(file, mocks = {}, params = {}) {
  const cells=[]; let index=0; let dirty=true; let tree; const effects=[]; const routes=[];
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
  const hooks={
    useState(initial){const i=index++; if(!cells[i]) cells[i]={value:typeof initial==='function'?initial():initial}; return [cells[i].value,v=>{cells[i].value=typeof v==='function'?v(cells[i].value):v;dirty=true;}];},
    useRef(initial){const i=index++;return cells[i]??={current:initial};},
    useEffect(fn,deps){const i=index++;if(!same(cells[i]?.deps,deps)){const old=cells[i];cells[i]={deps};effects.push(()=>{old?.cleanup?.();cells[i].cleanup=fn();});}},
    useCallback(fn,deps){const i=index++;if(!same(cells[i]?.deps,deps))cells[i]={value:fn,deps};return cells[i].value;},
    useSyncExternalStore(subscribe,get){const i=index++;if(!cells[i])cells[i]={cleanup:subscribe(()=>{dirty=true;})};return get();},
  };
  const native=Object.fromEntries(['View','Text','TextInput','ScrollView','KeyboardAvoidingView','ActivityIndicator','FlatList','Pressable','RefreshControl'].map(x=>[x,x]));
  const load=loader({react:hooks,'react-native':{...native,Platform:{OS:'ios'},Keyboard:{dismiss(){}},StyleSheet:{create:x=>x},Alert:{alert(){}},Share:{share:async()=>({})}},
    'expo-router':{router:{navigate:r=>routes.push(r),push:r=>routes.push(r),setParams:p=>Object.assign(params,p)},useLocalSearchParams:()=>params,useFocusEffect:fn=>hooks.useEffect(fn,[fn]),Stack:{Screen:'Stack.Screen'}},
    'components/ui.tsx':Object.fromEntries(['Body','Button','Card','Centered','Chip','ErrorBox','Muted','Screen','Title'].map(x=>[x,x])),
    'lib/preferences.ts':{usePreferences:()=>({language:'en',error:null}),preferences:{setLanguage(){}}},
    ...mocks,
  });
  const Component=load(file).default;
  const render=()=>{for(let n=0;dirty&&n<30;n++){dirty=false;index=0;tree=Component();effects.splice(0).forEach(fn=>fn());}assert(!dirty,'UI mock render settles');return tree;};
  function find(predicate,node){if(arguments.length===1)node=render();if(Array.isArray(node))return node.flatMap(c=>find(predicate,c));if(!node?.props)return [];if(typeof node.type==='function')return find(predicate,node.type(node.props));return [...(predicate(node)?[node]:[]),...find(predicate,node.props.children),...find(predicate,node.props.ListHeaderComponent),...find(predicate,node.props.ListEmptyComponent)];};
  const button=title=>{const b=find(n=>n.type==='Button'&&n.props.title===title)[0];assert(b,`button ${title}`);return b.props;};
  const input=placeholder=>{const el=find(n=>n.type==='TextInput'&&n.props.placeholder===placeholder)[0];assert(el,placeholder);return el.props;};
  const settle=async()=>{await flush();render();await flush();render();};
  return {hooks,render,find,button,input,settle,routes,unmount:()=>cells.forEach(c=>c?.cleanup?.())};
}
test('Import screen edits survive screen remount without restarting extraction and cooks the reviewed version', async () => {
  const h=importHarness(); let ui;
  const mocks={
    'lib/demo.ts':{useDemoMode:()=>true},'lib/supabase.ts':{supabaseConfigured:false},'expo-image-picker':{},
    'lib/importJobs.tsx':{imports:h.controller,useImportJob:()=>ui.hooks.useSyncExternalStore(h.controller.subscribe,h.controller.getSnapshot)},
  };
  ui=screenHarness('app/(tabs)/import.tsx',mocks);ui.render();ui.button('Use the demo clip').onPress();ui.render();
  ui.input('Caption').onChangeText('snapshotted');ui.render();ui.button('Extract recipe').onPress();await ui.settle();
  ui.input('Caption').onChangeText('later reviewed caption');ui.render();
  ui.input('Private variation notes (optional)').onChangeText('leave garlic out later');ui.render();
  ui.button('Browse library').onPress();ui.unmount();
  ui=screenHarness('app/(tabs)/import.tsx',mocks,{jobId:h.controller.getSnapshot().id});ui.render();
  assert.equal(ui.input('Caption').value,'later reviewed caption');
  assert.equal(ui.input('Private variation notes (optional)').value,'leave garlic out later');
  assert.equal(h.controller.getSnapshot().inputs.caption,'snapshotted');assert.equal(h.calls.extract,1);
  assert(ui.button('Confirm review & save notes').disabled);
  h.refs.resolve();await ui.settle();assert(!ui.button('Confirm review & save notes').disabled);
  ui.button('Confirm review & save notes').onPress();await ui.settle();
  ui.button('Cook reviewed version').onPress();
  assert.equal(ui.routes.at(-1).params.versionId,'import-v2');ui.unmount();
});
test('Library shows one pending job without its duplicate saved row and keeps another recipe cookable', async () => {
  const h=importHarness();h.controller.start(h.inputs,false);await flush();let ui;
  const rows=[{id:'import-recipe',title:'Duplicate',created_at:new Date().toISOString(),version_count:1,latest:1},
    {id:'other',title:'Other meal',created_at:new Date().toISOString(),version_count:1,latest:1,search_ingredients:'tomato'}];
  ui=screenHarness('app/(tabs)/index.tsx',{'lib/demo.ts':{useDemoMode:()=>true,setDemoMode(){}},'lib/supabase.ts':{supabaseConfigured:false},
    'lib/demoDb.ts':{resetDemo(){}},'lib/db.ts':{listLibrary:async()=>rows,deleteRecipe:async()=>{}},
    'lib/importJobs.tsx':{imports:h.controller,useImportJob:()=>ui.hooks.useSyncExternalStore(h.controller.subscribe,h.controller.getSnapshot)}});
  ui.render();await ui.settle();let list=ui.find(n=>n.type==='FlatList')[0].props;
  assert.equal(list.data.length,1);assert.equal(list.data[0].id,'other');assert(ui.button('Exit demo').disabled);
  assert(ui.find(n=>n.type==='Chip'&&n.props.label==='review-needed').length);
  ui.button('Processing').onPress();ui.render();list=ui.find(n=>n.type==='FlatList')[0].props;assert.equal(list.data.length,0);assert.equal(list.ListEmptyComponent,null);
  ui.button('All').onPress();ui.input('Search titles or included ingredients').onChangeText('tomato');ui.render();
  list=ui.find(n=>n.type==='FlatList')[0].props;assert.equal(list.data.length,1);
  const row=list.renderItem({item:list.data[0]});const cook=ui.find(n=>n.type==='Button'&&n.props.title==='Cook',row)[0];assert(!cook.props.disabled);cook.props.onPress();assert.equal(ui.routes.at(-1),'/cook/other');
  ui.unmount();h.refs.resolve();await flush();
});
test('Versions screen shares the chosen child and guards duplicate share invocations', async () => {
  const load=loader();const r=omittedRecipe(load);const opened=deferred();const messages=[];
  const versions=[{id:'v2',number:2,recipe_id:'r',recipe_json:r,created_at:new Date().toISOString(),diff_json:[],notes:'private'},
    {id:'v1',number:1,recipe_id:'r',recipe_json:recipe(load),created_at:new Date().toISOString(),diff_json:[]}];
  const native=Object.fromEntries(['FlatList','Pressable','Text','View'].map(x=>[x,x]));
  const ui=screenHarness('app/history/[recipeId].tsx',{'lib/db.ts':{getRecipeTitle:async()=>r.title,getVersions:async()=>versions,setBestVersion:async()=>{}},
    'react-native':{...native,StyleSheet:{create:x=>x},Share:{share:async o=>{messages.push(o.message);return opened.promise;}}}},{recipeId:'r'});
  ui.render();await ui.settle();const list=ui.find(n=>n.type==='FlatList')[0].props;
  const row=list.renderItem({item:versions[0]});const share=ui.find(n=>n.type==='Button'&&n.props.title==='Share v2 as text',row)[0];
  share.props.onPress();share.props.onPress();assert.equal(messages.length,1);assert.match(messages[0],/v2/);assert.match(messages[0],/Intentionally omitted.*garlic/);assert(!messages[0].includes('private'));
  opened.resolve({});await ui.settle();ui.unmount();
});
test('Spanish utterance never reuses an English audio cache entry and a language switch cancels pending English generation', async () => {
  const v=voiceSetup({},async()=>{},[{language:'es-ES',identifier:'es'}]);
  const english=v.speaker.say('Same words','step');await v.speaker.stopAll();
  await v.speaker.say('Same words','step',undefined,{language:'es',fallbackText:'English fallback'});
  v.resolveAudio(v.requests[0]);await english;
  assert.equal(v.requests.length,1);assert.equal(v.played.length,0);assert.equal(v.speech[0].options.language,'es-ES');
});

test('bounded restriction reminders handle names, aliases, compounds and negated claims without promising safety', () => {
  const load=loader();const match=load('lib/restrictions.ts').ingredientReminders;
  assert.equal(match([{name:'peanuts'}],['peanut'])[0].restriction,'peanut');
  assert.match(match([{name:'sodium caseinate'}],['milk'])[0].reason,/caseinate/);
  assert.equal(match([{name:'groundnut oil'}],['peanut']).length,1);
  assert.equal(match([{name:'maní'}],['peanut']).length,1);
  assert.equal(match([{name:'nutmeg'}],['peanut']).length,0);
  const unknown=match([{name:'mystery sauce'}],['milk']);assert(unknown[0].unknown);assert.match(unknown[0].reason,/contents are unknown/);
  assert.equal(match([{name:'peanut-free sauce'}],['peanut']).length,1);
  assert(match([{name:'milk',omitted:true}],['milk'])[0].omitted);
  assert.equal(match([{name:'tomato'}],['peanut']).length,0);
});
test('restriction preferences persist together with language; tampered keys are rejected and review keys change with ingredients/settings', async () => {
  const load=loader();const Store=load('lib/preferencesStore.ts').PreferencesStore;let disk='{"language":"es"}';
  const s=new Store({read:async()=>disk,write:t=>{disk=t;}},()=>{});await s.load();s.setRestrictions(['milk','peanut']);s.setLanguage('en');
  assert.deepEqual(JSON.parse(disk),{language:'en',restrictions:['milk','peanut']});
  const restored=new Store({read:async()=>disk,write(){}},()=>{});await restored.load();assert.deepEqual(plain(restored.getSnapshot().restrictions),['milk','peanut']);
  const corrupt=new Store({read:async()=>'{"language":"en","restrictions":["__proto__"]}',write(){}},()=>{});await corrupt.load();assert.match(corrupt.getSnapshot().error,/Invalid restriction/);
  const key=load('lib/restrictions.ts').reminderReviewKey;const ingredients=[{name:'milk',qty:'1',unit:'cup'}];
  assert.notEqual(key('v1',ingredients,['milk']),key('v2',ingredients,['milk']));
  assert.notEqual(key('v1',ingredients,['milk']),key('v1',[{...ingredients[0],omitted:true}],['milk']));
  assert.notEqual(key('v1',ingredients,['milk']),key('v1',ingredients,['peanut']));
});
test('extracted import requires acknowledgement for matching restrictions and physical removal stays disabled', async () => {
  const h=importHarness();let ui;
  ui=screenHarness('app/(tabs)/import.tsx',{'lib/demo.ts':{useDemoMode:()=>true},'lib/supabase.ts':{supabaseConfigured:false},'expo-image-picker':{},
    'lib/preferences.ts':{usePreferences:()=>({language:'en',restrictions:['wheat']})},
    'lib/importJobs.tsx':{imports:h.controller,useImportJob:()=>ui.hooks.useSyncExternalStore(h.controller.subscribe,h.controller.getSnapshot)}});
  h.controller.start(h.inputs,false);await flush();h.refs.resolve();await flush();ui.render();
  assert(ui.button('Confirm review & save notes').disabled);assert(ui.button('Remove matched items (unavailable)').disabled);
  ui.button('Continue with review acknowledgement').onPress();ui.render();assert(!ui.button('Confirm review & save notes').disabled);
  ui.button('Confirm review & save notes').onPress();await ui.settle();assert.equal(h.controller.getSnapshot().stage,'ready');
  assert(ui.button('Cook reviewed version').disabled); // selected saved version gets its own review acknowledgement
  ui.button('Continue with review acknowledgement').onPress();ui.render();assert(!ui.button('Cook reviewed version').disabled);ui.unmount();
});
test('cook pauses coaching/speech for compound ingredient review, allows manual navigation, and resumes only on acknowledgement', async () => {
  const h=cookHarness({restrictions:['wheat']});h.render();await new Promise(r=>setTimeout(r,100));await h.settle();
  assert.equal(h.loops.length,0);assert.equal(h.spoken.length,0);
  assert(h.button('Remove matched items (unavailable)').disabled);assert(h.button("I'm done").disabled);
  h.button('Next step').onPress();await h.settle();assert.equal(h.spoken.length,0);
  h.button('Continue with review acknowledgement').onPress();await h.settle();
  assert(h.loops.length>0);assert(h.spoken.length>0);assert(!h.button("I'm done").disabled);
  h.unmount();
});

test('public attribution survives a later ingredient child while parent private import notes stay excluded', async () => {
  const load=loader();const db=load('lib/demoDb.ts').demoDb;const tools=load('lib/libraryTools.ts');const ids=load('lib/demoData.ts').DEMO_IDS;
  const parent=await db.saveVersion({recipeId:ids.recipe,parentId:ids.version1,recipe:recipe(load),diff:[],rating:null,notes:JSON.stringify({import_caption:'PRIVATE CAPTION',variation_notes:'PRIVATE VARIATION',source_attribution:'@original-creator'})});
  const adapted=omittedRecipe(load);const child=await db.saveVersion({recipeId:ids.recipe,parentId:parent.id,recipe:adapted,diff:[],rating:null,notes:'private change note'});
  const shared=tools.shareVersionText(child);assert.match(shared,/@original-creator/);assert(!shared.includes('PRIVATE'));assert(!shared.includes('private change note'));
  assert(!child.notes.includes('PRIVATE CAPTION'));assert.match(tools.versionNotesLines(child.notes).join(' '),/private change note/);
});
test('root import alerts open the matching result after replacement, and failure alerts open recovery', async () => {
  const h=importHarness();const alerts=[];const routes=[];let cleanup;let fail=false;
  const load=loader({react:{useEffect:fn=>{cleanup=fn();}},'react-native':{Alert:{alert:(title,message,buttons)=>alerts.push({title,message,buttons})}},
    'expo-router':{router:{navigate:r=>routes.push(r),push:r=>routes.push(r)}},'lib/db.ts':{...h.deps},'lib/refFrames.ts':{uploadRefFrames:h.deps.frames},
    'lib/supabase.ts':{invokeFn:async()=>{if(fail)throw Error('extraction response failed');return {ok:true,version_id:'notice-v1',recipe:h.r};}}});
  const runtime=load('lib/importJobs.tsx');assert.equal(runtime.ImportJobs({children:'navigation'}),'navigation');
  runtime.imports.start(h.inputs,false);await flush();assert.match(alerts[0].title,/review needed/);
  const first=runtime.imports.getSnapshot();alerts[0].buttons[1].onPress();assert.equal(routes[0].params.jobId,first.id);
  h.refs.resolve();await flush();await runtime.imports.applyReview(h.inputs);
  runtime.imports.start(h.inputs,false);await flush();alerts[0].buttons[1].onPress();assert.equal(routes.at(-1),'/history/import-recipe');
  await runtime.imports.applyReview(h.inputs);fail=true;runtime.imports.start(h.inputs,false);await flush();
  assert.equal(alerts.at(-1).title,'Import needs attention');alerts.at(-1).buttons[1].onPress();assert.equal(routes.at(-1).params.jobId,runtime.imports.getSnapshot().id);
  cleanup();
  const failed=[];const g=importHarness({extract:async()=>{throw Error('failed extraction');}});g.controller.onNotice(j=>failed.push(j));g.controller.start(g.inputs,false);await flush();assert.equal(failed[0].stage,'failed');
});

test('language switch cancels a delayed step-navigation speech callback before it can enqueue old speech', async () => {
  const h=cookHarness();h.render();await new Promise(r=>setTimeout(r,100));await h.settle();
  const stopping=deferred();h.voice.stopAll=async()=>{h.voice.revision++;await stopping.promise;};
  h.spoken.length=0;h.button('Next step').onPress();h.render();
  h.pressLabel('Preset recipe guidance');h.button('Español').onPress();h.render();
  stopping.resolve();await h.settle();assert.equal(h.spoken.length,0);
  h.button('¿Cuánto agrego?').onPress();await h.settle();assert(h.spoken.length>0);h.unmount();
});
