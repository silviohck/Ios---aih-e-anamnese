'use strict';

const {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, StandardFonts,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup,
} = PDFLib;

const APP_NAME = 'AIH & Anamnese';
const DATA_KEY = 'AIHAnamneseDados';
const ATTACHMENT_NAME = 'dados-preenchidos.json';
const MAX_RECENT = 15;

const $ = (id) => document.getElementById(id);

const state = {
  pdf: null,      // { id, name, bytes: Uint8Array }
  fields: [],     // [{ name, label, type, options, multi, multiline, maxLength, value, original, input }]
  places: [],     // locais de atendimento: [{ id, name, presets, favorite: { name } | null }]
  placeId: null,  // local atual
  presets: {},    // valores fixos do local atual: { nomeDoCampo: valor }
  shortcuts: [],  // atalhos: [{ id, name, values: { nomeDoCampo: valor } }]
  applied: {},    // campos preenchidos por atalho neste PDF: { nomeDoCampo: { name, value } }
  output: null,   // { blob, url, fileName }
  touched: false, // se algo foi preenchido neste PDF (digitado ou por atalho)
  loading: false, // true enquanto um PDF está sendo aberto
  rendering: false,
};

/* ---------- Armazenamento local (IndexedDB) ---------- */

const db = (() => {
  let conn;
  const open = () => conn || (conn = new Promise((resolve, reject) => {
    const req = indexedDB.open('aih-anamnese', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const t = d.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)).catch(() => undefined),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)).catch(() => undefined),
    del: (k) => tx('readwrite', (s) => s.delete(k)).catch(() => undefined),
  };
})();

/* ---------- Utilidades ---------- */

function toast(msg, ms = 3500, action) {
  const el = $('toast');
  const btn = $('toast-action');
  $('toast-text').textContent = msg;
  btn.hidden = !action;
  btn.onclick = action ? () => { el.hidden = true; action.run(); } : null;
  if (action) btn.textContent = action.label;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

function normalize(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function prettyName(name) {
  const last = name.split('.').pop();
  return last
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim() || name;
}

// As fontes padrão do PDF só aceitam o conjunto WinAnsi (latim com acentos).
// Caracteres fora dele são trocados para não quebrar a geração do PDF;
// o texto original continua intacto nos dados gravados no arquivo.
const WIN_ANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function toWinAnsi(text) {
  let out = '';
  for (const ch of String(text).normalize('NFC')) {
    const code = ch.codePointAt(0);
    if (ch === '\n' || ch === '\r' || ch === '\t' || (code >= 0x20 && code <= 0x7e) ||
        (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.includes(ch)) {
      out += ch;
    } else {
      out += '?';
    }
  }
  return out;
}

// Identifica o arquivo pelo conteúdo: dois pacientes com PDFs de mesmo nome
// nunca compartilham rascunho.
async function pdfId(name, bytes) {
  if (window.crypto && crypto.subtle) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return [...hash.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `${name}:${bytes.length}`;
}

function isEmpty(v) {
  return v === undefined || v === null || v === '' || v === false || (Array.isArray(v) && !v.length);
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emptyValue(f) {
  return f.type === 'checkbox' ? false : (f.multi ? [] : '');
}

function displayValue(v) {
  if (v === true) return 'marcado';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

function fitsField(f, v) {
  if (f.type === 'text') return typeof v === 'string';
  if (f.type === 'checkbox') return typeof v === 'boolean';
  if (f.type === 'select' && f.multi) return Array.isArray(v) && v.every((o) => f.options.includes(o));
  return typeof v === 'string' && f.options.includes(v);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ---------- PDFs recentes ---------- */

async function rememberPdf(entry, bytes) {
  let list = ((await db.get('recent')) || []).filter((t) => t.id !== entry.id);
  list.unshift(entry);
  for (const old of list.slice(MAX_RECENT)) {
    await db.del(`pdf:${old.id}`);
    await db.del(`draft:${old.id}`);
  }
  list = list.slice(0, MAX_RECENT);
  if (bytes) await db.set(`pdf:${entry.id}`, { name: entry.name, bytes });
  await db.set('recent', list);
  return list;
}

async function openSavedPdf(id) {
  const saved = await db.get(`pdf:${id}`);
  if (saved && saved.bytes) await loadPdf(saved.name, new Uint8Array(saved.bytes), { fromStorage: true });
}

function renderRecent(list, currentId) {
  const sel = $('recent-select');
  sel.textContent = '';
  for (const t of list) {
    const when = new Date(t.openedAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    sel.append(new Option(`${t.patient || t.name.replace(/\.pdf$/i, '')} — ${when}`, t.id));
  }
  sel.value = currentId;
  sel.hidden = list.length < 2;
}

/* ---------- Dados gravados dentro do PDF ---------- */

function readEmbeddedData(doc) {
  try {
    const value = doc.getInfoDict().lookup(PDFName.of(DATA_KEY));
    if (value && typeof value.decodeText === 'function') return JSON.parse(value.decodeText());
  } catch (e) {
    console.warn('Não foi possível ler os dados gravados no PDF', e);
  }
  return null;
}

// Remove um anexo de dados gravado antes, para não duplicar ao preencher de novo
// um PDF que já foi gerado pelo app.
function removePreviousAttachment(doc) {
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const embedded = names && names.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const list = embedded && embedded.lookupMaybe(PDFName.of('Names'), PDFArray);
  if (!list) return;

  const keep = [];
  const removed = new Set();
  for (let i = 0; i + 1 < list.size(); i += 2) {
    const key = list.lookup(i);
    const isOurs = key && typeof key.decodeText === 'function' && key.decodeText() === ATTACHMENT_NAME;
    if (isOurs) removed.add(list.get(i + 1));
    else keep.push(list.get(i), list.get(i + 1));
  }
  if (!removed.size) return;
  embedded.set(PDFName.of('Names'), doc.context.obj(keep));

  const af = doc.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  if (af) {
    const afKeep = af.asArray().filter((ref) => !removed.has(ref));
    doc.catalog.set(PDFName.of('AF'), doc.context.obj(afKeep));
  }
}

function findPatientName(values) {
  const entry = state.fields.find((f) => {
    const n = normalize(`${f.name} ${f.label}`);
    return n.includes('paciente') && n.includes('nome') && typeof values[f.name] === 'string' && values[f.name].trim();
  });
  return entry ? values[entry.name].trim() : '';
}

// De onde veio cada valor: do PDF recebido, de um atalho, de um valor fixo
// ou digitado aqui.
function originOf(f, value) {
  if (isEmpty(value)) return '';
  if (!isEmpty(f.original) && sameValue(value, f.original)) return 'pdf';
  const a = state.applied[f.name];
  if (a && sameValue(value, a.value)) return 'atalho';
  if (f.name in state.presets && sameValue(value, state.presets[f.name])) return 'fixo';
  return 'digitado';
}

/* ---------- Leitura do PDF ---------- */

function describeField(field) {
  const name = field.getName();
  let label = '';
  try {
    const tu = field.acroField.dict.lookup(PDFName.of('TU'));
    if (tu && typeof tu.decodeText === 'function') label = tu.decodeText().trim();
  } catch (_) { /* sem descrição */ }
  const desc = describeValue(field);
  if (!desc) return null;
  return Object.assign({ name, label: label || prettyName(name), original: desc.value }, desc);
}

function describeValue(field) {
  if (field instanceof PDFTextField) {
    return { type: 'text', multiline: field.isMultiline(), maxLength: field.getMaxLength(), value: field.getText() || '' };
  }
  if (field instanceof PDFCheckBox) {
    return { type: 'checkbox', value: field.isChecked() };
  }
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const multi = field.isMultiselect();
    return { type: 'select', multi, options: field.getOptions(), value: multi ? field.getSelected() : (field.getSelected()[0] || '') };
  }
  if (field instanceof PDFRadioGroup) {
    return { type: 'radio', options: field.getOptions(), value: field.getSelected() || '' };
  }
  return null; // botões e assinaturas não são preenchidos
}

// Aplica os valores fixos só em campos vazios: o que já veio no PDF é mantido.
function applyPresets() {
  let count = 0;
  for (const f of state.fields) {
    const v = state.presets[f.name];
    if (v === undefined || !isEmpty(f.value) || !fitsField(f, v)) continue;
    f.value = v;
    count++;
  }
  return count;
}

// Salva o rascunho do PDF atual e bloqueia novos salvamentos enquanto
// o próximo abre, para nunca gravar campos de um paciente no rascunho de outro.
async function loadPdf(name, bytes, options) {
  await saveDraft();
  state.loading = true;
  try {
    await openPdf(name, bytes, options);
  } finally {
    state.loading = false;
  }
}

async function openPdf(name, bytes, { fromStorage = false } = {}) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (e) {
    console.error(e);
    toast('Não consegui abrir este PDF. Ele pode estar corrompido ou protegido.');
    return;
  }

  const id = await pdfId(name, bytes);
  state.pdf = { id, name, bytes };
  state.fields = doc.getForm().getFields().map(describeField).filter(Boolean);
  state.output = null;
  $('result-actions').hidden = true;
  $('result-info').textContent = '';

  state.applied = {};
  state.touched = false;
  const fromPdf = state.fields.filter((f) => !isEmpty(f.original)).length;
  const embedded = readEmbeddedData(doc);
  const draft = await db.get(`draft:${id}`);
  let source;
  if (embedded && embedded.campos) {
    applyValues(embedded.campos);
    state.applied = embedded.atalhos || {};
    source = 'Dados gravados por este app no PDF foram carregados.';
  } else if (draft) {
    applyValues(draft.values || draft);
    state.applied = draft.applied || {};
    state.touched = !!draft.touched;
    source = 'Rascunho anterior restaurado.';
  } else {
    const applied = applyPresets();
    source = `${fromPdf} campo(s) já vieram preenchidos no PDF.` +
      (applied ? ` ${applied} valor(es) fixo(s) aplicado(s).` : '');
  }

  const patient = findPatientName(Object.fromEntries(state.fields.map((f) => [f.name, f.value])));
  const list = await rememberPdf({ id, name, patient, openedAt: Date.now() }, fromStorage ? null : bytes);
  await db.set('current', id);
  renderRecent(list, id);

  $('pdf-info').textContent = `${patient ? `${patient} — ` : ''}${name} — ${doc.getPageCount()} página(s), ${state.fields.length} campo(s).`;
  $('forget-pdf').hidden = false;
  $('only-empty').checked = false;
  $('field-filter').value = '';
  renderForm();
  renderPresets();
  renderShortcuts();
  renderPlaces();

  $('form-card').hidden = false;
  $('shortcuts-card').hidden = !state.fields.length;
  $('output-card').hidden = !state.fields.length;
  $('data-card').hidden = !state.fields.length;
  $('form-info').textContent = state.fields.length
    ? source
    : 'Este PDF não tem campos preenchíveis. Use um PDF com formulário (campos em que se clica e digita).';
  updatePreview();
}

function applyValues(values) {
  if (!values) return;
  for (const f of state.fields) {
    if (Object.prototype.hasOwnProperty.call(values, f.name)) f.value = values[f.name];
  }
}

/* ---------- Formulário ---------- */

const ORIGIN_LABEL = { pdf: 'do PDF', fixo: 'fixo', atalho: 'atalho', digitado: '' };

function renderForm() {
  const form = $('fields-form');
  // Remover um campo em foco pode disparar "change"; ignorado enquanto redesenha.
  state.rendering = true;
  form.textContent = '';
  state.rendering = false;
  state.fields.forEach((f, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.dataset.search = normalize(`${f.label} ${f.name}`);
    const id = `f${i}`;
    const head = document.createElement('div');
    head.className = 'field-head';

    let input;
    const label = document.createElement('label');
    if (f.type === 'checkbox') {
      label.className = 'check';
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!f.value;
      label.append(input, document.createTextNode(f.label));
    } else {
      label.htmlFor = id;
      label.textContent = f.label;
      if (f.label !== f.name) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = f.name;
        label.append(hint);
      }
    }
    input = input || createInput(f);
    input.id = id;

    const badge = document.createElement('span');
    badge.className = 'badge';
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'pin';
    pin.dataset.field = f.name;

    head.append(label, badge, pin);
    wrap.append(head);
    if (f.type !== 'checkbox') wrap.append(input);
    f.input = input;
    f.badge = badge;
    f.pin = pin;
    form.append(wrap);
    updateFieldStatus(f);
  });
}

function createInput(f) {
  let input;
  if (f.type === 'text') {
    input = document.createElement(f.multiline ? 'textarea' : 'input');
    if (!f.multiline) input.type = 'text';
    if (f.maxLength) input.maxLength = f.maxLength;
    input.value = f.value || '';
  } else {
    input = document.createElement('select');
    if (f.type === 'select' && f.multi) input.multiple = true;
    else input.append(new Option('—', ''));
    for (const opt of f.options) input.append(new Option(opt, opt));
    const selected = Array.isArray(f.value) ? f.value : [f.value];
    for (const o of input.options) o.selected = selected.includes(o.value) && o.value !== '';
    if (!input.multiple && !f.value) input.value = '';
  }
  return input;
}

function readInput(f) {
  const el = f.input;
  if (f.type === 'checkbox') return el.checked;
  if (f.type === 'select' && f.multi) return [...el.selectedOptions].map((o) => o.value);
  return el.value;
}

function updateFieldStatus(f) {
  const value = readInput(f);
  const origin = originOf(f, value);
  f.badge.textContent = origin === 'atalho' ? state.applied[f.name].name : (ORIGIN_LABEL[origin] || '');
  f.badge.dataset.origin = origin;
  f.badge.hidden = !f.badge.textContent;

  const preset = state.presets[f.name];
  if (preset === undefined) {
    f.pin.textContent = 'Fixar';
    f.pin.disabled = isEmpty(value);
    f.pin.setAttribute('aria-pressed', 'false');
  } else if (sameValue(preset, value)) {
    f.pin.textContent = 'Fixado ✓';
    f.pin.disabled = false;
    f.pin.setAttribute('aria-pressed', 'true');
  } else {
    f.pin.textContent = 'Atualizar fixo';
    f.pin.disabled = isEmpty(value);
    f.pin.setAttribute('aria-pressed', 'false');
  }
  f.pin.title = preset === undefined
    ? 'Usar este valor automaticamente nos próximos PDFs'
    : `Valor fixo: ${displayValue(preset)}`;
}

function collectValues() {
  const values = {};
  for (const f of state.fields) values[f.name] = readInput(f);
  return values;
}

function applyFilter() {
  const q = normalize($('field-filter').value.trim());
  const onlyEmpty = $('only-empty').checked;
  state.fields.forEach((f) => {
    const wrap = f.input.closest('.field');
    wrap.hidden = (q && !wrap.dataset.search.includes(q)) || (onlyEmpty && !isEmpty(readInput(f)));
  });
}

/* ---------- Locais de atendimento ---------- */

function currentPlace() {
  return state.places.find((p) => p.id === state.placeId);
}

function selectPlace(id) {
  state.placeId = id;
  state.presets = currentPlace().presets;
}

function savePlaces() {
  return Promise.all([db.set('places', state.places), db.set('place', state.placeId)]);
}

function newPlaceId() {
  return `local-${Date.now().toString(36)}-${state.places.length}`;
}

function renderPlaces() {
  const sel = $('place-select');
  sel.textContent = '';
  for (const p of state.places) sel.append(new Option(p.name, p.id));
  sel.value = state.placeId;
  const place = currentPlace();
  $('favorite-info').textContent = place.favorite
    ? `Documento favorito: ${place.favorite.name}`
    : 'Sem documento favorito. Abra o PDF em branco deste local e toque em "Tornar este PDF o favorito".';
  $('open-favorite').hidden = !place.favorite;
  $('set-favorite').hidden = !state.pdf || !!(place.favorite && place.favorite.id === state.pdf.id);
  $('presets-place').textContent = place.name;
}

async function changePlace(id) {
  selectPlace(id);
  await savePlaces();
  renderPlaces();
  renderPresets();
  state.fields.forEach(updateFieldStatus);
  updatePreview();
  if (currentPlace().favorite) await openFavorite();
}

async function setFavorite() {
  if (!state.pdf) return;
  const place = currentPlace();
  const filled = state.fields.filter((f) => !isEmpty(f.original)).length;
  if (filled && !confirm(`Este PDF já tem ${filled} campo(s) preenchido(s), que vão aparecer sempre que o favorito for aberto. Use de preferência o formulário em branco. Usar este mesmo assim?`)) return;
  if (place.favorite && !confirm(`Substituir o favorito de "${place.name}" (${place.favorite.name})?`)) return;
  await db.set(`fav:${place.id}`, { name: state.pdf.name, bytes: state.pdf.bytes });
  place.favorite = { name: state.pdf.name, id: state.pdf.id };
  await savePlaces();
  renderPlaces();
  toast(`"${state.pdf.name}" é o documento favorito de ${place.name}.`);
}

// Abre o formulário favorito do local para um novo atendimento. Como é sempre
// o mesmo arquivo, um preenchimento anterior não terminado é oferecido antes
// de ser descartado, para nunca misturar dois pacientes.
async function openFavorite() {
  const place = currentPlace();
  const fav = await db.get(`fav:${place.id}`);
  if (!fav || !fav.bytes) {
    toast('Documento favorito não encontrado. Defina de novo.');
    return;
  }
  const bytes = new Uint8Array(fav.bytes);
  const id = await pdfId(fav.name, bytes);
  await saveDraft();
  const draft = await db.get(`draft:${id}`);
  if (draft && (!draft.touched || confirm('Existe um preenchimento em andamento deste documento.\n\nOK: começar um novo atendimento (descarta o anterior)\nCancelar: continuar o anterior'))) {
    await db.del(`draft:${id}`);
    if (state.pdf && state.pdf.id === id) state.pdf = null; // não salvar de volta o rascunho descartado
  }
  await loadPdf(fav.name, bytes);
}

async function addPlace() {
  const name = (prompt('Nome do novo local de atendimento:') || '').trim();
  if (!name) return;
  if (state.places.some((p) => normalize(p.name) === normalize(name))) {
    toast('Já existe um local com esse nome.');
    return;
  }
  state.places.push({ id: newPlaceId(), name, presets: {}, favorite: null });
  await changePlace(state.places[state.places.length - 1].id);
  toast(`Local "${name}" criado. Abra o PDF em branco dele e toque em "Tornar este PDF o favorito".`, 6000);
}

async function renamePlace() {
  const place = currentPlace();
  const name = (prompt('Novo nome do local:', place.name) || '').trim();
  if (!name || name === place.name) return;
  place.name = name;
  await savePlaces();
  renderPlaces();
}

async function removePlace() {
  const place = currentPlace();
  if (state.places.length < 2) {
    toast('É preciso ter pelo menos um local.');
    return;
  }
  if (!confirm(`Remover o local "${place.name}" com o documento favorito e os valores fixos dele?`)) return;
  await db.del(`fav:${place.id}`);
  state.places = state.places.filter((p) => p.id !== place.id);
  selectPlace(state.places[0].id);
  await savePlaces();
  renderPlaces();
  renderPresets();
  state.fields.forEach(updateFieldStatus);
  updatePreview();
}

/* ---------- Valores fixos ---------- */

async function togglePreset(name) {
  const f = state.fields.find((x) => x.name === name);
  if (!f) return;
  const value = readInput(f);
  const preset = state.presets[name];
  if (preset !== undefined && sameValue(preset, value)) {
    delete state.presets[name];
    toast(`"${f.label}" não é mais fixo.`);
  } else {
    if (isEmpty(value)) return;
    state.presets[name] = value;
    toast(`"${f.label}" fixado: será preenchido nos próximos PDFs quando estiver vazio.`);
  }
  updateFieldStatus(f);
  renderPresets();
  updatePreview();
  await savePlaces();
}

function renderPresets() {
  const list = $('presets-list');
  list.textContent = '';
  const names = Object.keys(state.presets);
  $('presets-empty').hidden = names.length > 0;
  for (const name of names) {
    const f = state.fields.find((x) => x.name === name);
    const li = document.createElement('li');
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = f ? f.label : prettyName(name);
    const value = document.createElement('span');
    value.className = 'muted small';
    value.textContent = displayValue(state.presets[name]);
    text.append(title, document.createElement('br'), value);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = 'Remover';
    remove.addEventListener('click', () => {
      delete state.presets[name];
      if (f) updateFieldStatus(f);
      renderPresets();
      updatePreview();
      savePlaces();
    });
    li.append(text, remove);
    list.append(li);
  }
}

/* ---------- Atalhos ---------- */

function setInput(f, v) {
  const el = f.input;
  f.value = v;
  if (f.type === 'checkbox') el.checked = !!v;
  else if (f.type === 'select' && f.multi) for (const o of el.options) o.selected = v.includes(o.value);
  else el.value = v;
}

// Aplica um atalho. O que veio no PDF nunca é alterado. Em campos de texto
// longo (ex.: HDA) que já têm texto, o texto do atalho é acrescentado numa
// nova linha, para poder combinar vários atalhos; nos demais, é substituído.
function applyShortcut(sc) {
  const before = { values: collectValues(), applied: { ...state.applied } };
  const changed = [];
  let skippedPdf = 0;
  for (const [name, v] of Object.entries(sc.values)) {
    const f = state.fields.find((x) => x.name === name);
    if (!f || !fitsField(f, v)) continue;
    const current = readInput(f);
    if (originOf(f, current) === 'pdf') { skippedPdf++; continue; }
    let next = v;
    let names = [sc.name];
    if (f.type === 'text' && f.multiline && !isEmpty(current)) {
      if (current.includes(v)) continue;
      next = `${current.replace(/\s+$/, '')}\n${v}`;
      const prev = state.applied[name];
      if (prev && originOf(f, current) === 'atalho') names = [...(prev.names || [prev.name]), sc.name];
    }
    if (sameValue(current, next)) continue;
    setInput(f, next);
    state.applied[name] = { name: names.join(' + '), names, value: next };
    changed.push(f);
  }
  changed.forEach(updateFieldStatus);
  if (changed.length) state.touched = true;
  updatePreview();
  saveDraft();
  const extra = skippedPdf ? ` (${skippedPdf} mantido(s) como veio no PDF)` : '';
  if (!changed.length) {
    toast(`"${sc.name}": nada a alterar${extra}.`);
    return;
  }
  toast(`"${sc.name}" aplicado em ${changed.length} campo(s)${extra}.`, 6000, {
    label: 'Desfazer',
    run: () => {
      for (const f of state.fields) setInput(f, before.values[f.name]);
      state.applied = before.applied;
      state.fields.forEach(updateFieldStatus);
      updatePreview();
      saveDraft();
    },
  });
}

function renderShortcuts() {
  const bar = $('shortcut-buttons');
  bar.textContent = '';
  for (const sc of state.shortcuts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn shortcut';
    b.textContent = sc.name;
    b.addEventListener('click', () => applyShortcut(sc));
    bar.append(b);
  }
  $('shortcuts-empty').hidden = state.shortcuts.length > 0;

  const list = $('shortcuts-list');
  list.textContent = '';
  for (const sc of state.shortcuts) {
    const li = document.createElement('li');
    const text = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = sc.name;
    const detail = document.createElement('span');
    detail.className = 'muted small';
    detail.textContent = Object.entries(sc.values).map(([n, v]) => {
      const f = state.fields.find((x) => x.name === n);
      return `${f ? f.label : prettyName(n)}: ${displayValue(v)}`;
    }).join(' · ');
    text.append(title, document.createElement('br'), detail);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn';
    remove.textContent = 'Remover';
    remove.addEventListener('click', () => {
      if (!confirm(`Remover o atalho "${sc.name}"?`)) return;
      state.shortcuts = state.shortcuts.filter((x) => x.id !== sc.id);
      db.set('shortcuts', state.shortcuts);
      renderShortcuts();
    });
    li.append(text, remove);
    list.append(li);
  }
}

// Monta a janela "Salvar como atalho" com os campos preenchidos que não
// vieram do PDF (o cadastro do paciente não entra em atalho).
function openShortcutDialog() {
  const box = $('shortcut-fields');
  box.textContent = '';
  const candidates = state.fields.filter((f) => {
    const o = originOf(f, readInput(f));
    return o && o !== 'pdf';
  });
  if (!candidates.length) {
    toast('Preencha na tela os campos que o atalho deve ter e toque de novo em "Salvar como atalho".', 5000);
    return;
  }
  for (const f of candidates) {
    const label = document.createElement('label');
    label.className = 'check pick';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.value = f.name;
    const text = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = f.label;
    const value = document.createElement('span');
    value.className = 'muted small';
    value.textContent = displayValue(readInput(f));
    text.append(title, document.createElement('br'), value);
    label.append(cb, text);
    box.append(label);
  }
  $('shortcut-name').value = '';
  $('shortcut-dialog').showModal();
}

async function saveShortcutFromDialog() {
  const name = $('shortcut-name').value.trim();
  if (!name) {
    toast('Dê um nome ao atalho.');
    $('shortcut-name').focus();
    return false;
  }
  const picked = [...$('shortcut-fields').querySelectorAll('input:checked')].map((cb) => cb.value);
  if (!picked.length) {
    toast('Marque pelo menos um campo.');
    return false;
  }
  const values = {};
  for (const n of picked) values[n] = readInput(state.fields.find((f) => f.name === n));

  const existing = state.shortcuts.find((x) => normalize(x.name) === normalize(name));
  if (existing && !confirm(`Já existe um atalho "${existing.name}". Substituir?`)) return false;
  if (existing) Object.assign(existing, { name, values });
  else state.shortcuts.push({ id: Date.now().toString(36), name, values });
  // Os campos salvos passam a contar como preenchidos por este atalho
  for (const n of picked) state.applied[n] = { name, names: [name], value: values[n] };
  state.fields.forEach(updateFieldStatus);
  renderShortcuts();
  updatePreview();
  saveDraft();
  await db.set('shortcuts', state.shortcuts);
  toast(`Atalho "${name}" salvo com ${picked.length} campo(s).`);
  return true;
}

/* ---------- Backup da configuração ---------- */

async function exportConfig() {
  const config = {
    app: APP_NAME,
    tipo: 'configuracao',
    versao: 1,
    exportadoEm: new Date().toISOString(),
    atalhos: state.shortcuts,
    localAtual: currentPlace().name,
    valoresFixos: state.presets,
    locais: state.places.map((p) => ({ nome: p.name, valoresFixos: p.presets })),
  };
  const fileName = `aih-anamnese-atalhos-${timestamp()}.json`;
  const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
  const file = new File([blob], fileName, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: fileName });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function importConfig(file) {
  let config;
  try {
    config = JSON.parse(await file.text());
  } catch (_) {
    toast('Arquivo inválido.');
    return;
  }
  const shortcuts = Array.isArray(config.atalhos) ? config.atalhos.filter((x) => x && x.name && x.values && typeof x.values === 'object') : [];
  const isObj = (o) => o && typeof o === 'object' && !Array.isArray(o);
  // Backups novos trazem os locais; os antigos, só os valores fixos de um local.
  const places = Array.isArray(config.locais)
    ? config.locais.filter((l) => l && l.nome && isObj(l.valoresFixos))
    : (isObj(config.valoresFixos) ? [{ nome: currentPlace().name, valoresFixos: config.valoresFixos }] : []);
  if (!shortcuts.length && !places.length) {
    toast('Nenhum atalho ou valor fixo encontrado no arquivo.');
    return;
  }
  if (!confirm(`Importar ${shortcuts.length} atalho(s) e ${places.length} local(is) com valores fixos? Atalhos com o mesmo nome serão substituídos.`)) return;
  for (const sc of shortcuts) {
    const existing = state.shortcuts.find((x) => normalize(x.name) === normalize(sc.name));
    if (existing) existing.values = sc.values;
    else state.shortcuts.push({ id: sc.id || `${Date.now().toString(36)}${state.shortcuts.length}`, name: sc.name, values: sc.values });
  }
  for (const l of places) {
    const existing = state.places.find((p) => normalize(p.name) === normalize(l.nome));
    if (existing) Object.assign(existing.presets, l.valoresFixos);
    else state.places.push({ id: newPlaceId(), name: l.nome, presets: { ...l.valoresFixos }, favorite: null });
  }
  await db.set('shortcuts', state.shortcuts);
  await savePlaces();
  renderShortcuts();
  renderPlaces();
  renderPresets();
  state.fields.forEach(updateFieldStatus);
  toast('Configuração importada.');
}

/* ---------- Dados e rascunho ---------- */

function buildPayload(values) {
  const origem = {};
  for (const f of state.fields) {
    const o = originOf(f, values[f.name]);
    if (o) origem[f.name] = o;
  }
  return {
    app: APP_NAME,
    versao: 3,
    geradoEm: new Date().toISOString(),
    arquivoOriginal: state.pdf.name,
    localAtendimento: currentPlace().name,
    paciente: findPatientName(values) || undefined,
    campos: values,
    origem,
    atalhosAplicados: [...new Set(Object.keys(origem).filter((n) => origem[n] === 'atalho')
      .flatMap((n) => state.applied[n].names || [state.applied[n].name]))],
    atalhos: Object.fromEntries(Object.entries(state.applied).filter(([n]) => origem[n] === 'atalho')),
  };
}

function updatePreview() {
  if (!state.fields.length) return;
  $('data-preview').textContent = JSON.stringify(buildPayload(collectValues()), null, 2);
}

let draftTimer;
function onFormInput(e) {
  if (state.rendering) return;
  const f = state.fields.find((x) => x.input === e.target);
  if (f) updateFieldStatus(f);
  state.touched = true;
  updatePreview();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(saveDraft, 400);
}

function saveDraft() {
  clearTimeout(draftTimer);
  if (!state.pdf || state.loading) return Promise.resolve();
  return db.set(`draft:${state.pdf.id}`, { values: collectValues(), applied: state.applied, touched: state.touched });
}

/* ---------- Geração do PDF ---------- */

async function generate() {
  const btn = $('generate');
  btn.disabled = true;
  btn.textContent = 'Gerando…';
  try {
    const values = collectValues();
    const payload = buildPayload(values);
    const json = JSON.stringify(payload, null, 2);

    const doc = await PDFDocument.load(state.pdf.bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    const problems = [];

    for (const f of state.fields) {
      const v = values[f.name];
      if (sameValue(v, f.original)) continue; // mantém intacto o que veio no PDF
      try {
        const field = form.getField(f.name);
        if (field instanceof PDFTextField) {
          let text = toWinAnsi(v || '');
          const max = field.getMaxLength();
          if (max !== undefined && text.length > max) text = text.slice(0, max);
          field.setText(text || undefined);
        } else if (field instanceof PDFCheckBox) {
          if (v) field.check(); else field.uncheck();
        } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
          const list = (Array.isArray(v) ? v : [v]).filter(Boolean);
          if (list.length) field.select(list.length > 1 ? list : list[0]); else field.clear();
        } else if (field instanceof PDFRadioGroup) {
          if (v) field.select(v); else field.clear();
        }
      } catch (e) {
        console.warn(f.name, e);
        problems.push(f.label);
      }
    }

    const font = await doc.embedFont(StandardFonts.Helvetica);
    form.updateFieldAppearances(font);

    // Registro dos dados dentro do arquivo
    const patient = payload.paciente;
    doc.setTitle(patient ? `AIH / Anamnese — ${patient}` : `AIH / Anamnese — ${state.pdf.name}`);
    doc.setSubject(`Preenchido em ${new Date().toLocaleString('pt-BR')} — ${Object.keys(payload.origem).length} campo(s) com dados`);
    doc.setKeywords(['AIH', 'Anamnese', ...(patient ? [patient] : [])]);
    doc.setCreator(APP_NAME);
    doc.setProducer(`${APP_NAME} (pdf-lib)`);
    doc.setModificationDate(new Date());
    doc.getInfoDict().set(PDFName.of(DATA_KEY), PDFHexString.fromText(JSON.stringify(payload)));

    removePreviousAttachment(doc);
    await doc.attach(new TextEncoder().encode(json), ATTACHMENT_NAME, {
      mimeType: 'application/json',
      description: 'Dados preenchidos no formulário (AIH & Anamnese)',
      creationDate: new Date(),
      modificationDate: new Date(),
    });

    if ($('flatten').checked) form.flatten();

    const bytes = await doc.save();
    const base = state.pdf.name.replace(/\.pdf$/i, '');
    const fileName = `${base}-preenchido-${timestamp()}.pdf`;
    if (state.output) URL.revokeObjectURL(state.output.url);
    const blob = new Blob([bytes], { type: 'application/pdf' });
    state.output = { blob, url: URL.createObjectURL(blob), fileName };

    $('download').href = state.output.url;
    $('download').download = fileName;
    $('result-actions').hidden = false;
    $('result-info').textContent = `${fileName} (${Math.round(bytes.length / 1024)} KB)` +
      (problems.length ? ` — Atenção, não foi possível preencher: ${problems.join(', ')}` : '');
    $('data-preview').textContent = json;
    toast('PDF gerado. Toque em "Imprimir / Compartilhar".');
  } catch (e) {
    console.error(e);
    toast('Erro ao gerar o PDF: ' + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Gerar PDF preenchido';
  }
}

async function share() {
  const out = state.output;
  if (!out) return;
  const file = new File([out.blob], out.fileName, { type: 'application/pdf' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: out.fileName });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  openOutput();
}

function openOutput() {
  const out = state.output;
  if (!out) return;
  const win = window.open(out.url, '_blank');
  if (!win) location.href = out.url;
}

/* ---------- Eventos ---------- */

$('pdf-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadPdf(file.name, bytes);
});

$('recent-select').addEventListener('change', (e) => openSavedPdf(e.target.value));

$('forget-pdf').addEventListener('click', async () => {
  if (!confirm(`Remover "${state.pdf.name}" e o rascunho dele deste aparelho?`)) return;
  const id = state.pdf.id;
  const list = ((await db.get('recent')) || []).filter((t) => t.id !== id);
  await db.set('recent', list);
  await db.del(`pdf:${id}`);
  await db.del(`draft:${id}`);
  if (list.length) await db.set('current', list[0].id);
  else await db.del('current');
  location.reload();
});

$('fields-form').addEventListener('input', onFormInput);
$('fields-form').addEventListener('change', onFormInput);
$('fields-form').addEventListener('submit', (e) => e.preventDefault());
$('fields-form').addEventListener('click', (e) => {
  const pin = e.target.closest('.pin');
  if (pin) togglePreset(pin.dataset.field);
});

$('field-filter').addEventListener('input', applyFilter);
$('only-empty').addEventListener('change', applyFilter);

$('restore-form').addEventListener('click', async () => {
  if (!confirm('Voltar os campos para como vieram no PDF (mais os valores fixos)? O que foi digitado aqui será apagado.')) return;
  for (const f of state.fields) f.value = f.original;
  state.applied = {};
  applyPresets();
  renderForm();
  applyFilter();
  updatePreview();
  await saveDraft();
});

$('new-shortcut').addEventListener('click', openShortcutDialog);
$('shortcut-cancel').addEventListener('click', () => $('shortcut-dialog').close());
$('shortcut-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (await saveShortcutFromDialog()) $('shortcut-dialog').close();
});
$('export-config').addEventListener('click', exportConfig);
$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (file) await importConfig(file);
});

$('place-select').addEventListener('change', (e) => changePlace(e.target.value));
$('open-favorite').addEventListener('click', openFavorite);
$('set-favorite').addEventListener('click', setFavorite);
$('add-place').addEventListener('click', addPlace);
$('rename-place').addEventListener('click', renamePlace);
$('remove-place').addEventListener('click', removePlace);

$('generate').addEventListener('click', generate);
$('share').addEventListener('click', share);
$('open').addEventListener('click', openOutput);

/* ---------- Início ---------- */

(async () => {
  state.places = (await db.get('places')) || [];
  if (!state.places.length) {
    // Primeiro uso, ou versão anterior com valores fixos sem local
    state.places = [{ id: newPlaceId(), name: 'Meu local', presets: (await db.get('presets')) || {}, favorite: null }];
    await db.del('presets');
  }
  const placeId = await db.get('place');
  selectPlace(state.places.some((p) => p.id === placeId) ? placeId : state.places[0].id);
  await savePlaces();
  state.shortcuts = (await db.get('shortcuts')) || [];
  renderPlaces();
  renderPresets();
  renderShortcuts();
  const list = (await db.get('recent')) || [];
  const current = await db.get('current');
  const id = list.some((t) => t.id === current) ? current : (list[0] && list[0].id);
  if (id) await openSavedPdf(id);
})();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveDraft();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker', e));
}
