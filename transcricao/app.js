'use strict';

// Transcrição de Consulta: grava a consulta no iPhone, transcreve na OpenAI
// e organiza a anamnese com o Claude. Tudo fica guardado só neste aparelho.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

const SEGMENT_SEC = Number(params.get('seg')) || 300; // grava em partes de 5 min
const MAX_UPLOAD = 24 * 1024 * 1024; // limite da API de transcrição (25 MB)
const SPLIT_SEC = 600; // partes de 10 min ao dividir áudios grandes
const OPENAI_URL = 'https://api.openai.com/v1/audio/transcriptions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// ---------- Configuração ----------

const CFG_KEY = 'transcricao.config';
const CFG_DEFAULTS = {
  openaiKey: '',
  anthropicKey: '',
  sttModel: 'gpt-4o-transcribe',
  claudeModel: 'claude-opus-5-5',
  extra: '',
};

function loadCfg() {
  try { return { ...CFG_DEFAULTS, ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; }
  catch { return { ...CFG_DEFAULTS }; }
}
let cfg = loadCfg();

function saveCfg() {
  cfg = {
    openaiKey: $('cfg-openai').value.trim(),
    anthropicKey: $('cfg-anthropic').value.trim(),
    sttModel: $('cfg-stt').value,
    claudeModel: $('cfg-claude').value,
    extra: $('cfg-extra').value.trim(),
  };
  try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch { /* armazenamento indisponível */ }
  renderCfg();
  toast('Configuração salva.');
  processQueue();
}

function renderCfg() {
  $('cfg-openai').value = cfg.openaiKey;
  $('cfg-anthropic').value = cfg.anthropicKey;
  $('cfg-stt').value = cfg.sttModel;
  $('cfg-claude').value = cfg.claudeModel;
  $('cfg-extra').value = cfg.extra;
  const ready = cfg.openaiKey && cfg.anthropicKey;
  const badge = $('setup-badge');
  badge.textContent = ready ? 'pronto' : 'faltam chaves';
  badge.className = `badge ${ready ? 'ok' : 'err'}`;
  if (!ready) $('setup-details').open = true;
}

// ---------- Utilidades ----------

function toast(msg, ms = 3500) {
  $('toast-text').textContent = msg;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('toast').hidden = true; }, ms);
}

function fmtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function fmtDate(iso) {
  return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copiado.');
}

function extFor(mime) {
  if (/mp4|m4a|aac/.test(mime)) return 'mp4';
  if (/webm/.test(mime)) return 'webm';
  if (/ogg/.test(mime)) return 'ogg';
  if (/wav/.test(mime)) return 'wav';
  if (/mpeg|mp3/.test(mime)) return 'mp3';
  return 'mp4';
}

async function apiError(res, quem) {
  let msg = '';
  try { const j = await res.json(); msg = (j.error && (j.error.message || j.error.type)) || ''; } catch { /* sem corpo */ }
  if (res.status === 401) return new Error(`Chave da ${quem} inválida. Confira na Configuração.`);
  if (res.status === 429) return new Error(`Limite de uso da ${quem} atingido ou sem créditos. ${msg}`.trim());
  return new Error(`${quem} respondeu ${res.status}. ${msg}`.trim());
}

// ---------- Banco de dados local (IndexedDB) ----------

let db;
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('transcricao', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('consultas', { keyPath: 'id' });
      req.result.createObjectStore('audios', { keyPath: 'key' });
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

function dbReq(store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r && r.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
const dbGet = (store, key) => dbReq(store, 'readonly', (s) => s.get(key));
const dbAll = (store) => dbReq(store, 'readonly', (s) => s.getAll());
const dbPut = (store, val) => dbReq(store, 'readwrite', (s) => s.put(val));
const dbDel = (store, key) => dbReq(store, 'readwrite', (s) => s.delete(key));

// Lê, altera e grava uma consulta numa única transação (evita sobrescrever
// mudanças feitas ao mesmo tempo pela gravação e pela transcrição).
function updateConsulta(id, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('consultas', 'readwrite');
    const st = tx.objectStore('consultas');
    let out = null;
    const r = st.get(id);
    r.onsuccess = () => {
      if (!r.result) return;
      out = r.result;
      fn(out);
      st.put(out);
    };
    tx.oncomplete = () => { resolve(out); onConsultaChanged(out); };
    tx.onerror = () => reject(tx.error);
  });
}

const audioKey = (id, n) => `${id}:${n}`;

function joinSegments(c) {
  return c.segmentos
    .slice()
    .sort((a, b) => a.n - b.n)
    .map((s) => (s.texto || '').trim())
    .filter(Boolean)
    .join('\n\n');
}

// ---------- Estado da tela ----------

const state = {
  openId: null,
  renderedAnamnese: null,
  generating: null,
};

function onConsultaChanged(c) {
  if (!c) return;
  if (c.id === state.openId) renderVisit(c);
  renderHistory();
}

// ---------- Gravação ----------

const rec = {
  active: false,
  stream: null,
  recorder: null,
  mime: '',
  id: null,
  n: 0,
  segElapsed: 0,
  total: 0,
  paused: false,
  timer: null,
  wakeLock: null,
  audioCtx: null,
  meterRaf: 0,
  saving: [],
};

function pickMime() {
  const opts = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  return opts.find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

async function startRecording() {
  if (!$('consent').checked) {
    toast('Marque que o paciente autorizou a gravação.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    toast('Este navegador não grava áudio. Use o Safari atualizado.');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
  } catch {
    toast('Sem acesso ao microfone. Permita o microfone para este site nos Ajustes.');
    return;
  }

  const c = {
    id: newId(),
    criadoEm: new Date().toISOString(),
    paciente: $('patient').value.trim(),
    origem: 'gravacao',
    gravando: true,
    duracao: 0,
    segmentos: [],
    transcricao: '',
    transcricaoEditada: false,
    anamnese: null,
    pendencias: [],
    conversa: [],
  };
  await dbPut('consultas', c);

  Object.assign(rec, {
    active: true, stream, mime: pickMime(), id: c.id, n: 0,
    segElapsed: 0, total: 0, paused: false, saving: [],
  });
  stream.getAudioTracks().forEach((t) => {
    t.onended = () => {
      if (rec.active) {
        stopRecording();
        toast('A gravação foi interrompida pelo aparelho. O que foi gravado está salvo.', 6000);
      }
    };
  });

  startSegment();
  rec.timer = setInterval(tick, 1000);
  startMeter(stream);
  requestWakeLock();

  $('patient').value = '';
  $('consent').checked = false;
  $('new-card').hidden = true;
  $('rec-card').hidden = false;
  renderRecState();
  openVisit(c.id);
}

function startSegment() {
  const opts = rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 64000 } : {};
  const r = new MediaRecorder(rec.stream, opts);
  const chunks = [];
  const n = rec.n++;
  r.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((resolve) => {
    r.onstop = () => {
      const seconds = r.__seconds || 0;
      const blob = new Blob(chunks, { type: r.mimeType || rec.mime || 'audio/mp4' });
      saveSegment(rec.id, n, blob, seconds).finally(resolve);
    };
  });
  rec.saving.push(done);
  r.start();
  rec.recorder = r;
}

// Fecha a parte atual e começa outra sem parar o microfone.
function rotateSegment() {
  const old = rec.recorder;
  old.__seconds = rec.segElapsed;
  rec.segElapsed = 0;
  startSegment();
  old.stop();
}

async function saveSegment(id, n, blob, seconds) {
  if (blob.size < 1000 || seconds < 1) return; // trecho vazio
  const nome = `consulta-parte-${n + 1}.${extFor(blob.type)}`;
  await dbPut('audios', { key: audioKey(id, n), blob, nome });
  await updateConsulta(id, (c) => {
    c.segmentos.push({ n, status: 'pendente', texto: '', seg: seconds });
  });
  processQueue();
}

function tick() {
  if (rec.paused) return;
  rec.total++;
  rec.segElapsed++;
  $('rec-timer').textContent = fmtTime(rec.total);
  if (rec.segElapsed >= SEGMENT_SEC) rotateSegment();
}

function togglePause() {
  if (!rec.active) return;
  if (rec.paused) {
    rec.recorder.resume();
    rec.paused = false;
  } else {
    rec.recorder.pause();
    rec.paused = true;
  }
  renderRecState();
}

function renderRecState() {
  $('rec-state').textContent = rec.paused ? 'Pausado' : 'Gravando';
  $('rec-dot').classList.toggle('paused', rec.paused);
  $('rec-pause').textContent = rec.paused ? 'Continuar' : 'Pausar';
  $('rec-timer').textContent = fmtTime(rec.total);
}

async function stopRecording() {
  if (!rec.active) return;
  rec.active = false;
  clearInterval(rec.timer);
  const r = rec.recorder;
  r.__seconds = rec.segElapsed;
  if (r.state !== 'inactive') r.stop();
  await Promise.all(rec.saving);
  rec.stream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  stopMeter();
  releaseWakeLock();
  const id = rec.id;
  const total = rec.total;
  await updateConsulta(id, (c) => { c.gravando = false; c.duracao = total; });
  $('rec-card').hidden = true;
  $('new-card').hidden = false;
  processQueue();
}

// Nível do microfone, para ver que está captando.
function startMeter(stream) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    rec.audioCtx = new Ctx();
    const src = rec.audioCtx.createMediaStreamSource(stream);
    const an = rec.audioCtx.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const data = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) { const x = (v - 128) / 128; sum += x * x; }
      const level = Math.min(1, Math.sqrt(sum / data.length) * 4);
      $('rec-level').style.width = `${rec.paused ? 0 : Math.round(level * 100)}%`;
      rec.meterRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch { /* o medidor é só visual */ }
}

function stopMeter() {
  cancelAnimationFrame(rec.meterRaf);
  if (rec.audioCtx) rec.audioCtx.close().catch(() => {});
  rec.audioCtx = null;
  $('rec-level').style.width = '0';
}

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      rec.wakeLock = await navigator.wakeLock.request('screen');
      $('rec-hint').textContent = 'A tela vai ficar ligada. Mantenha o app aberto durante a consulta.';
    }
  } catch {
    $('rec-hint').textContent = 'Mantenha a tela ligada e o app aberto: se a tela bloquear, a gravação para.';
  }
}

function releaseWakeLock() {
  if (rec.wakeLock) rec.wakeLock.release().catch(() => {});
  rec.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && rec.active) requestWakeLock();
});

window.addEventListener('beforeunload', (e) => {
  if (rec.active) { e.preventDefault(); e.returnValue = ''; }
});

// ---------- Envio de arquivo de áudio ----------

async function handleAudioFile(file) {
  if (!file) return;
  if (!$('consent').checked) {
    toast('Marque que o paciente autorizou a gravação.');
    $('audio-file').value = '';
    return;
  }
  let parts;
  if (file.size <= MAX_UPLOAD) {
    parts = [{ blob: file, nome: file.name, seg: 0 }];
  } else {
    toast('Áudio grande: dividindo em partes…', 8000);
    try {
      parts = await splitAudio(file);
    } catch {
      toast('Não consegui dividir este áudio. Envie um arquivo menor que 25 MB.', 6000);
      $('audio-file').value = '';
      return;
    }
  }
  const c = {
    id: newId(),
    criadoEm: new Date().toISOString(),
    paciente: $('patient').value.trim() || file.name.replace(/\.[^.]+$/, ''),
    origem: 'arquivo',
    gravando: false,
    duracao: parts.reduce((t, p) => t + p.seg, 0),
    segmentos: [],
    transcricao: '',
    transcricaoEditada: false,
    anamnese: null,
    pendencias: [],
    conversa: [],
  };
  for (let n = 0; n < parts.length; n++) {
    await dbPut('audios', { key: audioKey(c.id, n), blob: parts[n].blob, nome: parts[n].nome });
    c.segmentos.push({ n, status: 'pendente', texto: '', seg: parts[n].seg });
  }
  await dbPut('consultas', c);
  $('patient').value = '';
  $('consent').checked = false;
  $('audio-file').value = '';
  openVisit(c.id);
  renderHistory();
  processQueue();
}

// Decodifica o áudio em 16 kHz mono e corta em partes WAV de 10 minutos.
async function splitAudio(file) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ sampleRate: 16000 });
  try {
    const buf = await ctx.decodeAudioData(await file.arrayBuffer());
    const rate = buf.sampleRate;
    const mono = new Float32Array(buf.length);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < d.length; i++) mono[i] += d[i] / buf.numberOfChannels;
    }
    const per = SPLIT_SEC * rate;
    const parts = [];
    for (let start = 0, n = 1; start < mono.length; start += per, n++) {
      const slice = mono.subarray(start, Math.min(mono.length, start + per));
      parts.push({ blob: encodeWav(slice, rate), nome: `parte-${n}.wav`, seg: Math.round(slice.length / rate) });
    }
    return parts;
  } finally {
    ctx.close().catch(() => {});
  }
}

function encodeWav(samples, rate) {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
  out.setUint32(24, rate, true); out.setUint32(28, rate * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([out], { type: 'audio/wav' });
}

// ---------- Transcrição (OpenAI) ----------

let processing = false;

async function processQueue() {
  if (processing || !db) return;
  processing = true;
  try {
    for (;;) {
      if (!cfg.openaiKey) break;
      const all = (await dbAll('consultas')).sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));
      let next = null;
      for (const c of all) {
        const s = c.segmentos.slice().sort((a, b) => a.n - b.n).find((x) => x.status === 'pendente');
        if (s) { next = { c, s }; break; }
      }
      if (!next) break;
      await transcribeSegment(next.c.id, next.s.n);
    }
  } finally {
    processing = false;
  }
}

async function transcribeSegment(id, n) {
  let c = await updateConsulta(id, (x) => {
    const s = x.segmentos.find((y) => y.n === n);
    if (!s) return;
    s.status = 'transcrevendo';
    s.erro = '';
  });
  if (!c) return;
  try {
    const audio = await dbGet('audios', audioKey(id, n));
    if (!audio) throw new Error('O áudio desta parte não está mais no aparelho.');

    const prev = c.segmentos.filter((s) => s.n < n && s.texto).sort((a, b) => b.n - a.n)[0];
    let prompt = 'Consulta médica em português do Brasil, conversa entre médico e paciente.';
    if (prev) prompt += ` Trecho anterior: ${prev.texto.slice(-300)}`;

    const form = new FormData();
    form.append('file', audio.blob, audio.nome);
    form.append('model', cfg.sttModel);
    form.append('language', 'pt');
    form.append('response_format', 'json');
    form.append('prompt', prompt);

    const res = await fetch(OPENAI_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.openaiKey}` },
      body: form,
    });
    if (!res.ok) throw await apiError(res, 'OpenAI');
    const j = await res.json();
    const texto = (j.text || '').trim();

    c = await updateConsulta(id, (x) => {
      const s = x.segmentos.find((y) => y.n === n);
      if (!s) return;
      s.status = 'ok';
      s.texto = texto;
      if (!x.transcricaoEditada) x.transcricao = joinSegments(x);
    });
    await dbDel('audios', audioKey(id, n)); // o áudio não fica guardado depois de transcrito
    maybeAutoGenerate(c);
  } catch (err) {
    const msg = err instanceof TypeError ? 'Sem conexão com a OpenAI. Tente de novo.' : err.message;
    await updateConsulta(id, (x) => {
      const s = x.segmentos.find((y) => y.n === n);
      if (!s) return;
      s.status = 'erro';
      s.erro = msg;
    });
    if (id === state.openId) toast(msg, 6000);
  }
}

function retrySegment(id, n) {
  updateConsulta(id, (x) => {
    const s = x.segmentos.find((y) => y.n === n);
    if (s && s.status === 'erro') s.status = 'pendente';
  }).then(processQueue);
}

function transcriptionDone(c) {
  return !c.gravando && c.segmentos.length > 0 && c.segmentos.every((s) => s.status === 'ok');
}

function maybeAutoGenerate(c) {
  if (c && transcriptionDone(c) && !c.anamnese && cfg.anthropicKey && !state.generating && c.transcricao.trim()) {
    generateAnamnese(c.id);
  }
}

// ---------- Anamnese (Claude) ----------

const FIELDS = [
  ['identificacao', 'Identificação'],
  ['queixa_principal', 'Queixa principal'],
  ['hda', 'História da doença atual'],
  ['interrogatorio_sistemas', 'Interrogatório sobre os diversos aparelhos'],
  ['antecedentes_pessoais', 'Antecedentes pessoais'],
  ['medicacoes_em_uso', 'Medicações em uso'],
  ['alergias', 'Alergias'],
  ['antecedentes_familiares', 'Antecedentes familiares'],
  ['habitos_de_vida', 'Hábitos de vida'],
  ['exame_fisico', 'Exame físico'],
  ['exames_complementares', 'Exames complementares'],
  ['hipoteses_diagnosticas', 'Hipóteses diagnósticas'],
  ['conduta', 'Conduta'],
  ['orientacoes', 'Orientações ao paciente'],
];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [...FIELDS.map(([k]) => k), 'pontos_a_confirmar', 'conversa'],
  properties: {
    ...Object.fromEntries(FIELDS.map(([k]) => [k, { type: 'string' }])),
    pontos_a_confirmar: { type: 'array', items: { type: 'string' } },
    conversa: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['falante', 'texto'],
        properties: {
          falante: { type: 'string', enum: ['Médico', 'Paciente', 'Acompanhante', 'Outro'] },
          texto: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `Você redige a anamnese de prontuário a partir da transcrição automática de uma consulta médica em português do Brasil. A transcrição não identifica quem fala e pode ter erros de reconhecimento de voz.

Como preencher:
- Registre apenas o que foi dito na consulta. Não invente sintomas, achados de exame, doses ou diagnósticos. Item não abordado fica como string vazia.
- Exame físico: só os achados que o médico verbalizou.
- Hipóteses diagnósticas: as que o médico mencionou, com o CID-10 entre parênteses quando estiver claro. Se o médico não citou nenhuma, você pode listar as mais prováveis marcando cada uma com "(sugestão)".
- Linguagem técnica de prontuário, concisa, em terceira pessoa ("Paciente refere…"). Use quebras de linha para listas.
- Corrija erros óbvios de transcrição em termos médicos e nomes de medicamentos. Quando algo for ambíguo (dose, lateralidade, nome de remédio, tempo de evolução), registre a leitura mais provável e explique em pontos_a_confirmar.
- Em conversa, reconstrua o diálogo indicando quem fala (Médico, Paciente, Acompanhante ou Outro) pelo contexto, fiel ao conteúdo. Cumprimentos e conversa social podem ser omitidos.`;

function buildUserMessage(c) {
  const lines = [
    `Data da consulta: ${fmtDate(c.criadoEm)}`,
    `Paciente: ${c.paciente || 'não informado'}`,
  ];
  if (cfg.extra) lines.push('', `Preferências do médico para a anamnese:\n${cfg.extra}`);
  lines.push('', '<transcricao>', c.transcricao.trim(), '</transcricao>');
  return lines.join('\n');
}

async function generateAnamnese(id) {
  if (state.generating) return;
  if (!cfg.anthropicKey) {
    toast('Coloque a chave da Anthropic na Configuração.');
    $('setup-details').open = true;
    return;
  }
  const c = await dbGet('consultas', id);
  if (!c || !c.transcricao.trim()) {
    toast('Ainda não há transcrição.');
    return;
  }
  state.generating = id;
  setGenStatus(id, 'Analisando a conversa…');
  try {
    const result = await callClaude(c, (chars) => setGenStatus(id, `Escrevendo a anamnese… (${chars} caracteres)`));
    const anamnese = Object.fromEntries(FIELDS.map(([k]) => [k, String(result[k] || '').trim()]));
    await updateConsulta(id, (x) => {
      x.anamnese = anamnese;
      x.pendencias = Array.isArray(result.pontos_a_confirmar) ? result.pontos_a_confirmar : [];
      x.conversa = Array.isArray(result.conversa) ? result.conversa : [];
      x.geradoEm = new Date().toISOString();
      x.modelo = result.__model || cfg.claudeModel;
    });
    setGenStatus(id, '');
    if (id === state.openId) toast('Anamnese pronta. Revise antes de usar.');
  } catch (err) {
    const msg = err instanceof TypeError ? 'Sem conexão com a Anthropic. Tente de novo.' : err.message;
    setGenStatus(id, msg);
    if (id === state.openId) toast(msg, 6000);
  } finally {
    state.generating = null;
    const cur = state.openId && await dbGet('consultas', state.openId);
    if (cur) renderVisit(cur);
  }
}

// Chama a API de Mensagens em streaming e devolve o JSON da anamnese.
async function callClaude(c, onProgress) {
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': cfg.anthropicKey,
      'anthropic-version': '2026-10-21',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: cfg.claudeModel,
      max_tokens: 64000,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: SCHEMA },
      },
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserMessage(c) }],
    }),
  });
  if (!res.ok) throw await apiError(res, 'Anthropic');

  const blocks = [];
  let stopReason = null;
  let model = '';
  let chars = 0;

  const handle = (raw) => {
    const data = raw.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
    if (!data) return;
    let ev;
    try { ev = JSON.parse(data); } catch { return; }
    switch (ev.type) {
      case 'message_start':
        model = (ev.message && ev.message.model) || model;
        break;
      case 'content_block_start':
        blocks[ev.index] = { type: ev.content_block.type, text: ev.content_block.text || '' };
        break;
      case 'content_block_delta':
        if (ev.delta.type === 'text_delta' && blocks[ev.index]) {
          blocks[ev.index].text += ev.delta.text;
          chars += ev.delta.text.length;
          onProgress(chars);
        }
        break;
      case 'message_delta':
        if (ev.delta && ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        break;
      case 'error':
        throw new Error(`Anthropic: ${(ev.error && ev.error.message) || 'erro durante a resposta'}`);
      default:
        break;
    }
  };

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r/g, '');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 2);
    }
  }
  if (buf.trim()) handle(buf);

  if (stopReason === 'refusal') throw new Error('O modelo recusou esta transcrição. Tente de novo ou troque o modelo na Configuração.');
  if (stopReason === 'max_tokens') throw new Error('A resposta ficou longa demais e foi cortada. Tente de novo.');

  // Depois de uma troca de modelo (bloco "fallback"), o texto continua do ponto em que parou.
  const texts = blocks.filter(Boolean);
  const lastFallback = texts.map((b) => b.type).lastIndexOf('fallback');
  const candidates = [
    texts.filter((b) => b.type === 'text').map((b) => b.text).join(''),
    texts.slice(lastFallback + 1).filter((b) => b.type === 'text').map((b) => b.text).join(''),
  ];
  for (const t of candidates) {
    try {
      const obj = JSON.parse(t);
      obj.__model = model;
      return obj;
    } catch { /* tenta o próximo */ }
  }
  throw new Error('A resposta veio incompleta. Tente de novo.');
}

function setGenStatus(id, msg) {
  if (id !== state.openId) return;
  $('gen-status').textContent = msg;
  $('gen-status').hidden = !msg;
}

function anamneseText(c) {
  const a = c.anamnese || {};
  return FIELDS
    .filter(([k]) => (a[k] || '').trim())
    .map(([k, label]) => `${label.toUpperCase()}:\n${a[k].trim()}`)
    .join('\n\n');
}

// ---------- Tela da consulta ----------

async function openVisit(id) {
  state.openId = id;
  state.renderedAnamnese = null;
  const c = await dbGet('consultas', id);
  if (!c) return;
  $('visit-card').hidden = false;
  $('transcript-details').open = !c.anamnese;
  $('gen-status').hidden = true;
  renderVisit(c);
  $('visit-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeVisit() {
  state.openId = null;
  $('visit-card').hidden = true;
}

function statusLabel(c) {
  if (c.gravando) return 'gravando';
  const segs = c.segmentos;
  if (segs.some((s) => s.status === 'erro')) return 'erro na transcrição';
  const ok = segs.filter((s) => s.status === 'ok').length;
  if (ok < segs.length) return `transcrevendo ${ok}/${segs.length}`;
  if (state.generating === c.id) return 'gerando anamnese';
  if (c.anamnese) return 'anamnese pronta';
  return 'transcrita';
}

function renderVisit(c) {
  if (c.id !== state.openId) return;
  $('visit-title').textContent = c.paciente || 'Paciente sem nome';
  const dur = c.gravando ? '' : ` · ${fmtTime(c.duracao || c.segmentos.reduce((t, s) => t + (s.seg || 0), 0))}`;
  $('visit-meta').textContent = `${fmtDate(c.criadoEm)}${dur} · ${statusLabel(c)}`;

  // Partes da gravação
  const segBox = $('segments');
  segBox.textContent = '';
  const segs = c.segmentos.slice().sort((a, b) => a.n - b.n);
  if (segs.length > 1 || segs.some((s) => s.status !== 'ok')) {
    for (const s of segs) {
      const el = document.createElement('span');
      el.className = 'seg';
      const b = document.createElement('span');
      const label = { pendente: 'na fila', transcrevendo: 'transcrevendo…', ok: '✓', erro: 'erro' }[s.status];
      b.className = `badge ${s.status === 'ok' ? 'ok' : s.status === 'erro' ? 'err' : ''}`;
      b.textContent = `Parte ${s.n + 1} ${label}`;
      if (s.erro) b.title = s.erro;
      el.appendChild(b);
      if (s.status === 'erro') {
        const r = document.createElement('button');
        r.className = 'btn small';
        r.type = 'button';
        r.textContent = 'Tentar de novo';
        r.onclick = () => retrySegment(c.id, s.n);
        el.appendChild(r);
      }
      segBox.appendChild(el);
    }
  }
  if (!cfg.openaiKey && segs.some((s) => s.status === 'pendente')) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = 'Coloque a chave da OpenAI na Configuração para transcrever.';
    segBox.appendChild(p);
  }

  // Transcrição
  const ta = $('transcript');
  if (document.activeElement !== ta) ta.value = c.transcricao || '';
  ta.readOnly = c.gravando;

  // Botão de gerar
  const gen = $('gen-anamnese');
  gen.textContent = c.anamnese ? 'Gerar anamnese de novo' : 'Gerar anamnese';
  gen.disabled = !transcriptionDone(c) || !c.transcricao.trim() || !!state.generating;
  if (state.generating !== c.id && $('gen-status').textContent.startsWith('Escrevendo')) setGenStatus(c.id, '');

  // Anamnese
  $('anamnese-block').hidden = !c.anamnese;
  const key = c.anamnese ? c.geradoEm : null;
  if (c.anamnese && state.renderedAnamnese !== key) {
    state.renderedAnamnese = key;
    renderAnamnese(c);
  }
}

function renderAnamnese(c) {
  const box = $('anamnese-fields');
  box.textContent = '';
  for (const [k, label] of FIELDS) {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    const head = document.createElement('div');
    head.className = 'field-head';
    const lab = document.createElement('label');
    lab.htmlFor = `f-${k}`;
    lab.textContent = label;
    const cp = document.createElement('button');
    cp.type = 'button';
    cp.className = 'btn small';
    cp.textContent = 'Copiar';
    const ta = document.createElement('textarea');
    ta.id = `f-${k}`;
    ta.value = c.anamnese[k] || '';
    ta.placeholder = 'Não abordado na consulta';
    ta.rows = Math.min(12, Math.max(2, Math.ceil((ta.value.length || 1) / 45) + (ta.value.match(/\n/g) || []).length));
    cp.onclick = () => (ta.value.trim() ? copyText(ta.value.trim()) : toast('Campo vazio.'));
    let t;
    ta.oninput = () => {
      clearTimeout(t);
      t = setTimeout(() => updateConsulta(c.id, (x) => { x.anamnese[k] = ta.value; }), 400);
    };
    head.append(lab, cp);
    wrap.append(head, ta);
    box.appendChild(wrap);
  }

  const pend = c.pendencias || [];
  $('pending-box').hidden = !pend.length;
  const ul = $('pending-list');
  ul.textContent = '';
  for (const p of pend) {
    const li = document.createElement('li');
    li.textContent = p;
    ul.appendChild(li);
  }

  const dl = $('dialog-list');
  dl.textContent = '';
  for (const m of c.conversa || []) {
    const d = document.createElement('div');
    const cls = m.falante === 'Médico' ? 'medico' : m.falante === 'Paciente' ? 'paciente' : 'outro';
    d.className = `bubble ${cls}`;
    const b = document.createElement('b');
    b.textContent = m.falante;
    d.append(b, document.createTextNode(m.texto));
    dl.appendChild(d);
  }
  $('dialog-details').hidden = !(c.conversa || []).length;
}

async function currentConsulta() {
  return state.openId ? dbGet('consultas', state.openId) : null;
}

// ---------- Histórico ----------

async function renderHistory() {
  if (!db) return;
  const all = (await dbAll('consultas')).sort((a, b) => b.criadoEm.localeCompare(a.criadoEm));
  const ul = $('history');
  ul.textContent = '';
  $('history-empty').hidden = all.length > 0;
  for (const c of all) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    const left = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = c.paciente || 'Paciente sem nome';
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = `${fmtDate(c.criadoEm)} · ${statusLabel(c)}`;
    left.append(name, sub);
    const arrow = document.createElement('span');
    arrow.textContent = '›';
    b.append(left, arrow);
    b.onclick = () => {
      if (rec.active && c.id !== rec.id) { toast('Encerre a gravação antes de abrir outra consulta.'); return; }
      openVisit(c.id);
    };
    li.appendChild(b);
    ul.appendChild(li);
  }
}

async function deleteVisit() {
  const c = await currentConsulta();
  if (!c) return;
  if (rec.active && rec.id === c.id) { toast('Encerre a gravação primeiro.'); return; }
  if (!confirm(`Apagar a consulta de ${c.paciente || 'paciente sem nome'}? Não dá para desfazer.`)) return;
  for (const s of c.segmentos) await dbDel('audios', audioKey(c.id, s.n));
  await dbDel('consultas', c.id);
  closeVisit();
  renderHistory();
  toast('Consulta apagada.');
}

// ---------- Inicialização ----------

async function recoverInterrupted() {
  // Se o app foi fechado no meio de uma gravação ou transcrição, retoma o que foi salvo.
  const all = await dbAll('consultas');
  for (const c of all) {
    if (c.gravando || c.segmentos.some((s) => s.status === 'transcrevendo')) {
      await updateConsulta(c.id, (x) => {
        x.gravando = false;
        x.duracao = x.duracao || x.segmentos.reduce((t, s) => t + (s.seg || 0), 0);
        x.segmentos.forEach((s) => { if (s.status === 'transcrevendo') s.status = 'pendente'; });
      });
    }
  }
}

function bind() {
  $('cfg-save').onclick = saveCfg;
  $('rec-start').onclick = startRecording;
  $('rec-pause').onclick = togglePause;
  $('rec-stop').onclick = stopRecording;
  $('audio-file').onchange = (e) => handleAudioFile(e.target.files[0]);
  $('visit-close').onclick = closeVisit;
  $('visit-delete').onclick = deleteVisit;
  $('copy-transcript').onclick = () => {
    const t = $('transcript').value.trim();
    if (t) copyText(t); else toast('Transcrição vazia.');
  };

  let t;
  $('transcript').oninput = () => {
    const id = state.openId;
    const value = $('transcript').value;
    clearTimeout(t);
    t = setTimeout(() => updateConsulta(id, (x) => { x.transcricao = value; x.transcricaoEditada = true; }), 400);
  };

  $('gen-anamnese').onclick = async () => {
    const c = await currentConsulta();
    if (!c) return;
    if (c.anamnese && !confirm('Gerar de novo substitui a anamnese atual, inclusive o que você editou. Continuar?')) return;
    // grava a transcrição editada antes de enviar
    await updateConsulta(c.id, (x) => {
      if ($('transcript').value !== x.transcricao) { x.transcricao = $('transcript').value; x.transcricaoEditada = true; }
    });
    generateAnamnese(c.id);
  };

  $('copy-all').onclick = async () => {
    const c = await currentConsulta();
    if (c && c.anamnese) copyText(anamneseText(c));
  };
  $('share-all').onclick = async () => {
    const c = await currentConsulta();
    if (!c || !c.anamnese) return;
    const text = anamneseText(c);
    if (navigator.share) {
      try { await navigator.share({ title: `Anamnese - ${c.paciente || 'paciente'}`, text }); } catch { /* cancelado */ }
    } else {
      copyText(text);
    }
  };
}

async function init() {
  bind();
  renderCfg();
  await openDb();
  await recoverInterrupted();
  renderHistory();
  processQueue();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init();
