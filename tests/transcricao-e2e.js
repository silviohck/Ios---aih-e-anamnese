// Teste de ponta a ponta do app de transcrição, com microfone falso e as APIs
// da OpenAI e da Anthropic simuladas (nenhuma chamada real, nenhuma chave).
// Uso: python3 -m http.server 8123 &  node tests/transcricao-e2e.js [http://localhost:8123/transcricao/]
const assert = require('assert');
const { chromium, devices } = require('playwright');

const BASE = process.argv[2] || 'http://localhost:8123/transcricao/';

const ANAMNESE = {
  identificacao: 'Masculino, 34 anos.',
  queixa_principal: 'Dor abdominal há 2 dias.',
  hda: 'Paciente refere dor periumbilical que migrou para fossa ilíaca direita.',
  interrogatorio_sistemas: '',
  antecedentes_pessoais: 'Nega comorbidades.',
  medicacoes_em_uso: 'Dipirona 1 g se dor.',
  alergias: 'Nega.',
  antecedentes_familiares: '',
  habitos_de_vida: '',
  exame_fisico: 'Blumberg positivo.',
  exames_complementares: '',
  hipoteses_diagnosticas: '1. Apendicite aguda (K35.8)',
  conduta: 'Solicitado hemograma e USG de abdome.',
  orientacoes: 'Jejum.',
  pontos_a_confirmar: ['Confirmar dose da dipirona.'],
  conversa: [
    { falante: 'Médico', texto: 'O que o senhor está sentindo?' },
    { falante: 'Paciente', texto: 'Dor na barriga há dois dias.' },
  ],
};

function sse(events) {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
}

function claudeStream(obj) {
  const json = JSON.stringify(obj);
  const half = Math.floor(json.length / 2);
  return sse([
    { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: json.slice(0, half) } },
    { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: json.slice(half) } },
    { type: 'content_block_stop', index: 1 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 100 } },
    { type: 'message_stop' },
  ]);
}

(async () => {
  const browser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  });
  const context = await browser.newContext({ ...devices['iPhone 13'], permissions: ['microphone'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  const sttCalls = [];
  let claudeBody = null;
  let claudeHeaders = null;
  let failNextStt = false;

  await page.route('https://api.openai.com/**', async (route) => {
    const req = route.request();
    const body = req.postDataBuffer() || Buffer.alloc(0);
    const text = body.toString('latin1');
    sttCalls.push({ auth: req.headers().authorization, size: body.length, hasPt: /name="language"\r\n\r\npt/.test(text) });
    if (failNextStt) {
      failNextStt = false;
      return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'falha simulada' } }) });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ text: `Trecho ${sttCalls.length} da consulta.` }),
    });
  });

  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    claudeHeaders = req.headers();
    claudeBody = JSON.parse(req.postData());
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      headers: { 'access-control-allow-origin': '*' },
      body: claudeStream(ANAMNESE),
    });
  });

  // Partes de 3 s para testar a divisão da gravação
  await page.goto(`${BASE}?seg=3`);

  // Sem chaves, a configuração abre sozinha
  assert.strictEqual(await page.locator('#setup-details').getAttribute('open'), '');
  assert.strictEqual(await page.textContent('#setup-badge'), 'faltam chaves');
  await page.fill('#cfg-openai', 'sk-teste');
  await page.fill('#cfg-anthropic', 'sk-ant-teste');
  await page.click('#cfg-save');
  assert.strictEqual(await page.textContent('#setup-badge'), 'pronto');

  // Não grava sem consentimento
  await page.click('#rec-start');
  await page.waitForSelector('#toast:not([hidden])');
  assert.match(await page.textContent('#toast-text'), /autorizou/);
  assert.ok(await page.isHidden('#rec-card'));

  // Grava ~7 s => 3 partes
  await page.fill('#patient', 'João Teste');
  await page.check('#consent');
  await page.click('#rec-start');
  await page.waitForSelector('#rec-card:not([hidden])');
  await page.waitForTimeout(7500);
  await page.click('#rec-stop');
  await page.waitForSelector('#rec-card', { state: 'hidden' });

  // Transcrição de todas as partes e anamnese gerada automaticamente
  await page.waitForSelector('#anamnese-block:not([hidden])', { timeout: 20000 });
  assert.ok(sttCalls.length >= 3, `esperava >= 3 partes, veio ${sttCalls.length}`);
  assert.ok(sttCalls.every((c) => c.auth === 'Bearer sk-teste' && c.hasPt && c.size > 1000));
  const transcript = await page.inputValue('#transcript');
  assert.match(transcript, /Trecho 1 da consulta\.\n\nTrecho 2 da consulta\./);

  // Requisição ao Claude
  assert.strictEqual(claudeHeaders['x-api-key'], 'sk-ant-teste');
  assert.strictEqual(claudeHeaders['anthropic-dangerous-direct-browser-access'], 'true');
  assert.strictEqual(claudeHeaders['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.strictEqual(claudeBody.model, 'claude-opus-5-5');
  assert.strictEqual(claudeBody.stream, true);
  assert.strictEqual(claudeBody.fallbacks, 'default');
  assert.strictEqual(claudeBody.output_config.format.type, 'json_schema');
  assert.match(claudeBody.messages[0].content, /Paciente: João Teste/);
  assert.match(claudeBody.messages[0].content, /<transcricao>\nTrecho 1/);

  // Campos preenchidos, pendências e conversa
  assert.strictEqual(await page.inputValue('#f-hipoteses_diagnosticas'), '1. Apendicite aguda (K35.8)');
  assert.strictEqual(await page.inputValue('#f-interrogatorio_sistemas'), '');
  assert.match(await page.textContent('#pending-list'), /dose da dipirona/);
  assert.strictEqual(await page.locator('.bubble.medico').count(), 1);
  assert.strictEqual(await page.locator('.bubble.paciente').count(), 1);
  assert.match(await page.textContent('#visit-meta'), /anamnese pronta/);

  // Edição é salva e persiste após recarregar
  await page.fill('#f-conduta', 'Internação para apendicectomia.');
  await page.waitForTimeout(700);
  await page.reload();
  await page.click('#history li button');
  await page.waitForSelector('#anamnese-block:not([hidden])');
  assert.strictEqual(await page.inputValue('#f-conduta'), 'Internação para apendicectomia.');

  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT, fullPage: true });

  // Texto copiado contém só campos preenchidos
  const copied = await page.evaluate(async () => {
    let got = '';
    navigator.clipboard.writeText = async (t) => { got = t; };
    document.getElementById('copy-all').click();
    await new Promise((r) => setTimeout(r, 200));
    return got;
  });
  assert.match(copied, /QUEIXA PRINCIPAL:\nDor abdominal há 2 dias\./);
  assert.match(copied, /CONDUTA:\nInternação para apendicectomia\./);
  assert.ok(!/INTERROGATÓRIO/.test(copied));

  // Áudio não fica guardado depois de transcrito
  const audios = await page.evaluate(() => new Promise((res) => {
    const r = indexedDB.open('transcricao');
    r.onsuccess = () => {
      const q = r.result.transaction('audios').objectStore('audios').count();
      q.onsuccess = () => res(q.result);
    };
  }));
  assert.strictEqual(audios, 0);

  // Falha na transcrição => botão "Tentar de novo"
  failNextStt = true;
  const before = sttCalls.length;
  await page.fill('#patient', 'Maria Teste');
  await page.check('#consent');
  await page.click('#rec-start');
  await page.waitForTimeout(2000);
  await page.click('#rec-stop');
  await page.waitForSelector('#segments button:has-text("Tentar de novo")', { timeout: 10000 });
  assert.match(await page.textContent('#visit-meta'), /erro na transcrição/);
  await page.click('#segments button:has-text("Tentar de novo")');
  await page.waitForSelector('#anamnese-block:not([hidden])', { timeout: 10000 });
  assert.strictEqual(sttCalls.length, before + 2);

  // Apagar consulta
  page.once('dialog', (d) => d.accept());
  await page.click('#visit-delete');
  await page.waitForSelector('#visit-card', { state: 'hidden' });
  assert.strictEqual(await page.locator('#history li').count(), 1);

  assert.deepStrictEqual(errors, []);
  await browser.close();
  console.log('OK: transcrição e anamnese funcionando');
})().catch((e) => { console.error(e); process.exit(1); });
