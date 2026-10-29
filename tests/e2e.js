// Teste de ponta a ponta: abre o app num navegador com tela de iPhone e
// percorre o fluxo com dois pacientes (AIH + anamnese no mesmo PDF).
// Uso: python3 -m http.server 8123 &  node tests/e2e.js [http://localhost:8123/]
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium, devices } = require('playwright');
const { PDFDocument, PDFName, PDFDict, PDFArray } = require(path.join(__dirname, '..', 'vendor', 'pdf-lib.min.js'));

const URL_APP = process.argv[2] || 'http://localhost:8123/';
const PACIENTE_1 = path.join(__dirname, 'exemplo-paciente-1.pdf');
const PACIENTE_2 = path.join(__dirname, 'exemplo-paciente-2.pdf');

// Ordem dos campos nos PDFs de exemplo
const F = {
  nome: '#f0', cns: '#f1', endereco: '#f2', estabelecimento: '#f3', carater: '#f4',
  clinica: '#f5', cid: '#f6', medico: '#f7', queixa: '#f8', hda: '#f9', alergia: '#f10',
};
const pin = (sel) => `${sel.replace('#', '.field:has(#')}) .pin`;
const badge = (sel) => `${sel.replace('#', '.field:has(#')}) .badge`;

async function generatedBytes(page) {
  const b64 = await page.evaluate(async () => {
    const buf = new Uint8Array(await state.output.blob.arrayBuffer());
    let s = ''; for (const c of buf) s += String.fromCharCode(c); return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

function attachmentCount(doc) {
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const ef = names && names.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict);
  const arr = ef && ef.lookupMaybe(PDFName.of('Names'), PDFArray);
  return arr ? arr.size() / 2 : 0;
}

async function openFile(page, file, infoPattern) {
  await page.setInputFiles('#pdf-input', file);
  await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('#pdf-info').textContent), infoPattern);
}

async function generate(page) {
  await page.click('#generate');
  await page.waitForSelector('#result-actions:not([hidden])');
  await page.waitForFunction(() => document.querySelector('#generate').textContent.startsWith('Gerar'));
  return PDFDocument.load(await generatedBytes(page));
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.error('PAGE ERROR', e.stack); });
  page.on('dialog', (d) => d.accept()); // confirmações (confirm)
  await page.goto(URL_APP);

  // Paciente 1: o cadastro já vem preenchido no PDF
  await openFile(page, PACIENTE_1, 'Maria José');
  assert.match(await page.textContent('#pdf-info'), /2 página\(s\), 11 campo/);
  assert.match(await page.textContent('#form-info'), /3 campo\(s\) já vieram preenchidos/);
  assert.strictEqual(await page.inputValue(F.endereco), 'Rua das Flores, 120 — Centro');
  assert.strictEqual(await page.textContent(badge(F.nome)), 'do PDF');
  assert.strictEqual(await page.isVisible('#share'), false); // só aparece depois de gerar

  // "Só campos vazios" esconde o cadastro
  await page.check('#only-empty');
  assert.strictEqual(await page.isVisible(F.nome), false);
  assert.strictEqual(await page.isVisible(F.cid), true);
  await page.uncheck('#only-empty');

  // Completa e fixa alguns valores
  assert.strictEqual(await page.isDisabled(pin(F.estabelecimento)), true); // vazio não pode ser fixado
  await page.fill(F.estabelecimento, 'Hospital São Lucas');
  await page.selectOption(F.carater, 'Urgencia');
  await page.selectOption(F.clinica, 'Clínica médica');
  await page.fill(F.medico, 'Dr. Ana Souza — CRM 12345');
  await page.check(F.alergia);
  for (const f of [F.estabelecimento, F.carater, F.clinica, F.medico, F.alergia]) await page.click(pin(f));
  assert.strictEqual(await page.textContent(pin(F.medico)), 'Fixado ✓');
  assert.strictEqual(await page.locator('#presets-list li').count(), 5);
  // Campos só deste paciente
  await page.fill(F.cid, 'K35.8');
  await page.fill(F.queixa, 'Dor abdominal');
  await page.fill(F.hda, 'Dor em FID há 2 dias → febre 38 °C.');
  assert.strictEqual(await page.textContent(badge(F.medico)), 'fixo');

  let doc = await generate(page);
  let form = doc.getForm();
  assert.strictEqual(form.getTextField('paciente.nome').getText(), 'Maria José da Conceição');
  assert.strictEqual(form.getTextField('paciente.endereco').getText(), 'Rua das Flores, 120 — Centro');
  assert.strictEqual(form.getTextField('estabelecimento').getText(), 'Hospital São Lucas');
  assert.strictEqual(form.getRadioGroup('carater_internacao').getSelected(), 'Urgencia');
  assert.deepStrictEqual(form.getDropdown('clinica').getSelected(), ['Clínica médica']);
  assert.strictEqual(form.getCheckBox('tem_alergia').isChecked(), true);
  assert.strictEqual(form.getTextField('Texto2').getText(), 'Dor em FID há 2 dias ? febre 38 °C.');
  assert.match(doc.getTitle(), /Maria José/);
  let data = JSON.parse(doc.getInfoDict().lookup(PDFName.of('AIHAnamneseDados')).decodeText());
  assert.strictEqual(data.campos.Texto2, 'Dor em FID há 2 dias → febre 38 °C.');
  assert.strictEqual(data.origem['paciente.nome'], 'pdf');
  assert.strictEqual(data.origem.medico_solicitante, 'fixo');
  assert.strictEqual(data.origem.cid_principal, 'digitado');
  assert.strictEqual(attachmentCount(doc), 1);
  const preenchido = path.join(os.tmpdir(), 'aih-paciente-1-preenchido.pdf');
  fs.writeFileSync(preenchido, await generatedBytes(page));

  // Paciente 2: recebe os valores fixos, mas nada do paciente 1
  await openFile(page, PACIENTE_2, 'João Pereira');
  assert.match(await page.textContent('#form-info'), /5 valor\(es\) fixo\(s\) aplicado/);
  assert.strictEqual(await page.inputValue(F.nome), 'João Pereira Lima');
  assert.strictEqual(await page.inputValue(F.estabelecimento), 'Hospital São Lucas');
  assert.strictEqual(await page.inputValue(F.carater), 'Urgencia');
  assert.strictEqual(await page.isChecked(F.alergia), true);
  assert.strictEqual(await page.inputValue(F.cid), '');
  assert.strictEqual(await page.inputValue(F.queixa), '');
  // Desmarca alergia só para este paciente; ajusta o fixo do médico
  await page.uncheck(F.alergia);
  await page.fill(F.medico, 'Dr. Ana Souza — CRM 12345 (plantão)');
  assert.strictEqual(await page.textContent(pin(F.medico)), 'Atualizar fixo');
  await page.fill(F.cid, 'J18.9');

  // Volta para o paciente 1 pela lista de recentes: rascunho dele intacto
  await page.waitForTimeout(600); // rascunho é salvo 0,4 s depois da digitação
  await page.reload();
  await page.waitForSelector('#form-card:not([hidden])');
  assert.strictEqual(await page.inputValue(F.cid), 'J18.9'); // rascunho do paciente 2 salvo
  const id1 = await page.evaluate(() => [...document.querySelectorAll('#recent-select option')].find((o) => o.textContent.startsWith('Maria')).value);
  await page.selectOption('#recent-select', id1);
  await page.waitForFunction(() => /Maria José/.test(document.querySelector('#pdf-info').textContent));
  assert.strictEqual(await page.inputValue(F.cid), 'K35.8');
  assert.strictEqual(await page.inputValue(F.queixa), 'Dor abdominal');

  // "Restaurar como veio no PDF" mantém o cadastro e reaplica os fixos
  await page.click('#restore-form');
  await page.waitForFunction(() => document.querySelector('#f6').value === '');
  assert.strictEqual(await page.inputValue(F.nome), 'Maria José da Conceição');
  assert.strictEqual(await page.inputValue(F.estabelecimento), 'Hospital São Lucas');
  assert.strictEqual(await page.inputValue(F.queixa), '');

  // Remove um valor fixo pela lista
  await page.click('#presets-list li:has-text("medico solicitante") button');
  assert.strictEqual(await page.locator('#presets-list li').count(), 4);
  assert.strictEqual(await page.textContent(pin(F.medico)), 'Fixar');

  // Reabrir o PDF gerado traz de volta tudo o que foi gravado nele
  await page.setInputFiles('#pdf-input', preenchido);
  await page.waitForFunction(() => /Dados gravados/.test(document.querySelector('#form-info').textContent));
  assert.strictEqual(await page.inputValue(F.hda), 'Dor em FID há 2 dias → febre 38 °C.');
  await page.check('#flatten');
  doc = await generate(page);
  assert.strictEqual(doc.getForm().getFields().length, 0);
  assert.strictEqual(attachmentCount(doc), 1);

  // ---------- Atalhos ----------
  await openFile(page, PACIENTE_2, 'João Pereira');
  await page.click('#restore-form');
  await page.waitForFunction(() => document.querySelector('#f6').value === '');
  assert.match(await page.textContent('#shortcuts-empty'), /Nenhum atalho/);

  // Cria o atalho "Apendicite" a partir do que está na tela
  await page.fill(F.cid, 'K35.8');
  await page.fill(F.queixa, 'Dor abdominal');
  await page.fill(F.hda, 'Dor em FID.');
  await page.selectOption(F.clinica, 'Cirúrgica');
  await page.click('#new-shortcut');
  await page.waitForSelector('#shortcut-dialog[open]');
  // O cadastro que veio no PDF não aparece como opção
  assert.strictEqual(await page.locator('#shortcut-fields input[value="paciente.nome"]').count(), 0);
  for (const n of ['estabelecimento', 'carater_internacao', 'tem_alergia']) {
    await page.uncheck(`#shortcut-fields input[value="${n}"]`);
  }
  await page.fill('#shortcut-name', 'Apendicite');
  await page.press('#shortcut-name', 'Enter'); // Enter salva
  await page.waitForSelector('#shortcut-dialog', { state: 'hidden' });
  assert.strictEqual(await page.textContent(badge(F.cid)), 'Apendicite');

  // Cria o atalho "Febre" só com a HDA
  await page.click('#restore-form');
  await page.waitForFunction(() => document.querySelector('#f6').value === '');
  await page.fill(F.hda, 'Febre 38 °C há 1 dia.');
  await page.click('#new-shortcut');
  for (const cb of await page.locator('#shortcut-fields input').all()) {
    if (await cb.getAttribute('value') !== 'Texto2') await cb.uncheck();
  }
  await page.fill('#shortcut-name', 'Febre');
  await page.click('#shortcut-form button[type="submit"]');
  await page.waitForSelector('#shortcut-dialog', { state: 'hidden' });
  assert.deepStrictEqual(await page.locator('#shortcut-buttons button').allTextContents(), ['Apendicite', 'Febre']);

  // Aplica os dois: a HDA recebe os dois textos
  await page.click('#restore-form');
  await page.waitForFunction(() => document.querySelector('#f9').value === '');
  await page.click('#shortcut-buttons button:text-is("Apendicite")');
  assert.strictEqual(await page.inputValue(F.cid), 'K35.8');
  assert.strictEqual(await page.inputValue(F.clinica), 'Cirúrgica');
  assert.strictEqual(await page.inputValue(F.hda), 'Dor em FID.');
  await page.click('#shortcut-buttons button:text-is("Febre")');
  assert.strictEqual(await page.inputValue(F.hda), 'Dor em FID.\nFebre 38 °C há 1 dia.');
  // Desfazer
  await page.click('#toast-action');
  assert.strictEqual(await page.inputValue(F.hda), 'Dor em FID.');
  await page.click('#shortcut-buttons button:text-is("Febre")');
  await page.click('#shortcut-buttons button:text-is("Febre")'); // repetir não duplica
  assert.strictEqual(await page.inputValue(F.hda), 'Dor em FID.\nFebre 38 °C há 1 dia.');
  assert.match(await page.textContent('#toast-text'), /nada a alterar/);
  assert.strictEqual(await page.textContent(badge(F.hda)), 'Apendicite + Febre');

  // Backup: exporta e importa
  await page.click('#shortcuts-manage summary');
  assert.match(await page.textContent('#shortcuts-list'), /Apendicite/);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export-config')]);
  const backup = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  assert.strictEqual(backup.atalhos.length, 2);
  assert.strictEqual(backup.valoresFixos.estabelecimento, 'Hospital São Lucas');
  backup.atalhos.push({ name: 'Teste cadastro', values: { 'paciente.nome': 'Outro nome', cid_principal: 'A09' } });
  const backupFile = path.join(os.tmpdir(), 'aih-backup.json');
  fs.writeFileSync(backupFile, JSON.stringify(backup));
  await page.setInputFiles('#import-input', backupFile);
  await page.waitForFunction(() => document.querySelectorAll('#shortcut-buttons button').length === 3);
  // Um atalho nunca altera o que veio no PDF
  await page.click('#shortcut-buttons button:text-is("Teste cadastro")');
  assert.strictEqual(await page.inputValue(F.nome), 'João Pereira Lima');
  assert.strictEqual(await page.inputValue(F.cid), 'A09');
  assert.match(await page.textContent('#toast-text'), /1 mantido\(s\) como veio no PDF/);
  await page.click('#toast-action');
  assert.strictEqual(await page.inputValue(F.cid), 'K35.8');

  // Gera: atalhos registrados no PDF
  doc = await generate(page);
  data = JSON.parse(doc.getInfoDict().lookup(PDFName.of('AIHAnamneseDados')).decodeText());
  assert.deepStrictEqual(data.atalhosAplicados.sort(), ['Apendicite', 'Febre']);
  assert.strictEqual(data.origem.cid_principal, 'atalho');
  assert.strictEqual(data.atalhos.Texto2.name, 'Apendicite + Febre');
  assert.strictEqual(data.origem['paciente.nome'], 'pdf');

  // Depois de recarregar: atalhos e etiquetas continuam
  await page.waitForTimeout(600);
  await page.reload();
  await page.waitForSelector('#form-card:not([hidden])');
  assert.strictEqual(await page.locator('#shortcut-buttons button').count(), 3);
  assert.strictEqual(await page.textContent(badge(F.cid)), 'Apendicite');

  if (process.env.SHOT) {
    await page.screenshot({ path: process.env.SHOT, fullPage: true });
  }

  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log('OK — todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
