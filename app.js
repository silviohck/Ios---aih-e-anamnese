'use strict';

const {
  PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, StandardFonts,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup,
} = PDFLib;

const APP_NAME = 'AIH & Anamnese';
const DATA_KEY = 'AIHAnamneseDados';
const ATTACHMENT_NAME = 'dados-preenchidos.json';

const $ = (id) => document.getElementById(id);

const state = {
  template: null, // { name, bytes: Uint8Array, id }
  fields: [],     // [{ name, label, type, options, multiline, maxLength, input }]
  output: null,   // { blob, url, fileName }
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

function toast(msg, ms = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, ms);
}

function normalize(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
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

function templateId(name, bytes) {
  return `${name}:${bytes.length}`;
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
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

/* ---------- Leitura do modelo ---------- */

function describeField(field) {
  const name = field.getName();
  let label = '';
  try {
    const tu = field.acroField.dict.lookup(PDFName.of('TU'));
    if (tu && typeof tu.decodeText === 'function') label = tu.decodeText().trim();
  } catch (_) { /* sem descrição */ }
  label = label || prettyName(name);

  if (field instanceof PDFTextField) {
    return { name, label, type: 'text', multiline: field.isMultiline(), maxLength: field.getMaxLength(), value: field.getText() || '' };
  }
  if (field instanceof PDFCheckBox) {
    return { name, label, type: 'checkbox', value: field.isChecked() };
  }
  if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const multi = field.isMultiselect();
    return { name, label, type: 'select', multi, options: field.getOptions(), value: multi ? field.getSelected() : (field.getSelected()[0] || '') };
  }
  if (field instanceof PDFRadioGroup) {
    return { name, label, type: 'radio', options: field.getOptions(), value: field.getSelected() || '' };
  }
  return null; // botões e assinaturas não são preenchidos
}

async function loadTemplate(name, bytes, { fromStorage = false } = {}) {
  let doc;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true });
  } catch (e) {
    console.error(e);
    toast('Não consegui abrir este PDF. Ele pode estar corrompido ou protegido.');
    return;
  }

  const id = templateId(name, bytes);
  state.template = { name, bytes, id };
  state.fields = doc.getForm().getFields().map(describeField).filter(Boolean);
  state.output = null;
  $('result-actions').hidden = true;
  $('result-info').textContent = '';

  if (!fromStorage) await db.set('template', { name, bytes });

  const embedded = readEmbeddedData(doc);
  const draft = await db.get('draft');
  let source = '';
  if (embedded && embedded.campos) {
    applyValues(embedded.campos);
    source = ' Dados gravados neste PDF foram carregados.';
  } else if (draft && draft.templateId === id) {
    applyValues(draft.values);
    source = ' Rascunho anterior restaurado.';
  }

  $('template-info').textContent = `${name} — ${doc.getPageCount()} página(s), ${state.fields.length} campo(s).`;
  $('forget-template').hidden = false;
  renderForm();

  $('form-card').hidden = false;
  $('output-card').hidden = !state.fields.length;
  $('data-card').hidden = !state.fields.length;
  $('form-info').textContent = state.fields.length
    ? `Campos encontrados automaticamente no PDF.${source}`
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

function renderForm() {
  const form = $('fields-form');
  form.textContent = '';
  state.fields.forEach((f, i) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.dataset.search = normalize(`${f.label} ${f.name}`);
    const id = `f${i}`;

    let input;
    if (f.type === 'checkbox') {
      const label = document.createElement('label');
      label.className = 'check';
      input = document.createElement('input');
      input.type = 'checkbox';
      input.id = id;
      input.checked = !!f.value;
      label.append(input, document.createTextNode(f.label));
      wrap.append(label);
    } else {
      const label = document.createElement('label');
      label.htmlFor = id;
      label.textContent = f.label;
      if (f.label !== f.name) {
        const hint = document.createElement('span');
        hint.className = 'hint';
        hint.textContent = f.name;
        label.append(hint);
      }
      wrap.append(label);

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
      input.id = id;
      wrap.append(input);
    }
    f.input = input;
    form.append(wrap);
  });
}

function collectValues() {
  const values = {};
  for (const f of state.fields) {
    const el = f.input;
    if (f.type === 'checkbox') values[f.name] = el.checked;
    else if (f.type === 'select' && f.multi) values[f.name] = [...el.selectedOptions].map((o) => o.value);
    else values[f.name] = el.value;
  }
  return values;
}

function buildPayload(values) {
  return {
    app: APP_NAME,
    versao: 1,
    geradoEm: new Date().toISOString(),
    modelo: state.template.name,
    paciente: findPatientName(values) || undefined,
    campos: values,
  };
}

function updatePreview() {
  if (!state.fields.length) return;
  $('data-preview').textContent = JSON.stringify(buildPayload(collectValues()), null, 2);
}

let draftTimer;
function onFormInput() {
  updatePreview();
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    db.set('draft', { templateId: state.template.id, values: collectValues() });
  }, 400);
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

    const doc = await PDFDocument.load(state.template.bytes, { ignoreEncryption: true });
    const form = doc.getForm();
    const problems = [];

    for (const f of state.fields) {
      const v = values[f.name];
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
    doc.setTitle(patient ? `AIH / Anamnese — ${patient}` : `AIH / Anamnese — ${state.template.name}`);
    doc.setSubject(`Preenchido em ${new Date().toLocaleString('pt-BR')} — ${Object.keys(values).length} campo(s)`);
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
    const base = state.template.name.replace(/\.pdf$/i, '');
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
  openPdf();
}

function openPdf() {
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
  await loadTemplate(file.name, bytes);
});

$('forget-template').addEventListener('click', async () => {
  if (!confirm('Remover o modelo PDF e o rascunho salvos neste aparelho?')) return;
  await db.del('template');
  await db.del('draft');
  location.reload();
});

$('fields-form').addEventListener('input', onFormInput);
$('fields-form').addEventListener('change', onFormInput);
$('fields-form').addEventListener('submit', (e) => e.preventDefault());

$('field-filter').addEventListener('input', (e) => {
  const q = normalize(e.target.value.trim());
  for (const el of $('fields-form').children) el.hidden = q && !el.dataset.search.includes(q);
});

$('clear-form').addEventListener('click', () => {
  if (!confirm('Apagar tudo o que foi preenchido?')) return;
  for (const f of state.fields) f.value = f.type === 'checkbox' ? false : (f.multi ? [] : '');
  renderForm();
  db.del('draft');
  updatePreview();
});

$('generate').addEventListener('click', generate);
$('share').addEventListener('click', share);
$('open').addEventListener('click', openPdf);

/* ---------- Início ---------- */

(async () => {
  const saved = await db.get('template');
  if (saved && saved.bytes) await loadTemplate(saved.name, new Uint8Array(saved.bytes), { fromStorage: true });
})();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker', e));
}
