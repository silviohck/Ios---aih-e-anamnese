// Teste de ponta a ponta: abre o app num navegador com tela de iPhone,
// carrega o PDF de exemplo, preenche, gera e confere o PDF resultante.
// Uso: python3 -m http.server 8123 &  node tests/e2e.js [http://localhost:8123/]
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium, devices } = require('playwright');
const { PDFDocument, PDFName, PDFDict, PDFArray } = require(path.join(__dirname, '..', 'vendor', 'pdf-lib.min.js'));

const URL_APP = process.argv[2] || 'http://localhost:8123/';
const SAMPLE = path.join(__dirname, 'exemplo-formulario.pdf');

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

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ ...devices['iPhone 13'], acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(URL_APP);

  await page.setInputFiles('#pdf-input', SAMPLE);
  await page.waitForSelector('#form-card:not([hidden])');
  assert.match(await page.textContent('#template-info'), /6 campo/);

  await page.fill('#f0', 'Maria José da Conceição');
  await page.fill('#f1', '123456789012345678'); // maxLength 15
  await page.selectOption('#f2', 'Feminino');
  await page.selectOption('#f3', 'Urgencia');
  await page.check('#f4');
  await page.fill('#f5', 'Dor abdominal há 3 dias → febre 38,5 °C.');
  await page.screenshot({ path: process.env.SHOT || '/dev/null', fullPage: true });
  await page.click('#generate');
  await page.waitForSelector('#result-actions:not([hidden])');

  let doc = await PDFDocument.load(await generatedBytes(page));
  const form = doc.getForm();
  assert.strictEqual(form.getTextField('paciente.nome').getText(), 'Maria José da Conceição');
  assert.strictEqual(form.getTextField('paciente.cns').getText(), '123456789012345');
  assert.deepStrictEqual(form.getDropdown('paciente.sexo').getSelected(), ['Feminino']);
  assert.strictEqual(form.getRadioGroup('carater_internacao').getSelected(), 'Urgencia');
  assert.strictEqual(form.getCheckBox('tem_alergia').isChecked(), true);
  assert.strictEqual(form.getTextField('anamnese_hda').getText(), 'Dor abdominal há 3 dias ? febre 38,5 °C.');
  assert.match(doc.getTitle(), /Maria José/);
  const data = JSON.parse(doc.getInfoDict().lookup(PDFName.of('AIHAnamneseDados')).decodeText());
  assert.strictEqual(data.campos['anamnese_hda'], 'Dor abdominal há 3 dias → febre 38,5 °C.');
  assert.strictEqual(data.paciente, 'Maria José da Conceição');
  assert.strictEqual(attachmentCount(doc), 1);

  // Reabre o PDF gerado: os dados gravados devem voltar ao formulário
  const tmp = path.join(require('os').tmpdir(), 'aih-preenchido.pdf');
  fs.writeFileSync(tmp, await generatedBytes(page));
  await page.reload();
  await page.setInputFiles('#pdf-input', tmp);
  await page.waitForFunction(() => document.querySelector('#f0') && document.querySelector('#f0').value);
  assert.strictEqual(await page.inputValue('#f5'), 'Dor abdominal há 3 dias → febre 38,5 °C.');
  assert.match(await page.textContent('#form-info'), /gravados neste PDF/);

  // Gera de novo, travando os campos: o anexo não pode duplicar
  await page.check('#flatten');
  await page.click('#generate');
  await page.waitForFunction(() => document.querySelector('#generate').textContent.startsWith('Gerar'));
  doc = await PDFDocument.load(await generatedBytes(page));
  assert.strictEqual(doc.getForm().getFields().length, 0);
  assert.strictEqual(attachmentCount(doc), 1);

  // O modelo fica salvo no aparelho
  await page.reload();
  await page.waitForSelector('#form-card:not([hidden])');

  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log('OK — todos os testes passaram');
})().catch((e) => { console.error(e); process.exit(1); });
