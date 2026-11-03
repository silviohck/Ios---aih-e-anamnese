// Teste de ponta a ponta: abre o app Electron numa pasta de dados temporária e
// percorre o fluxo convênio → paciente → solicitação → envio → autorização.
// Uso: npm run test:e2e   (em Linux sem tela: xvfb-run -a npm run test:e2e)
// Com SHOTS=pasta, salva capturas de tela.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron: electron } = require('playwright');

(async () => {
  const dados = fs.mkdtempSync(path.join(os.tmpdir(), 'solicitacoes-'));
  const shots = process.env.SHOTS;
  const foto = async (page, nome) => { if (shots) await page.screenshot({ path: path.join(shots, `${nome}.png`) }); };
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox'],
    env: { ...process.env, SOLICITACOES_DADOS: dados },
  });
  const page = await app.firstWindow();
  await page.setViewportSize({ width: 1360, height: 860 });
  const erros = [];
  page.on('pageerror', (e) => erros.push(e.message));
  page.on('dialog', (d) => d.accept());
  const lerDados = () => JSON.parse(fs.readFileSync(path.join(dados, 'dados.json'), 'utf8'));

  await page.waitForSelector('h1:text("Painel")');
  assert.ok(fs.existsSync(path.join(dados, 'dados.json')), 'cria o arquivo de dados');

  // Convênio
  await page.click('nav [data-ir=convenios]');
  await page.click('[data-acao=novo-convenio]');
  await page.fill('#modal [name=nome]', 'Unimed Teste');
  await page.fill('#modal [name=site]', 'unimed.example.com');
  await page.click('#modal button[type=submit]');
  await page.waitForSelector('td:has-text("Unimed Teste")');

  // Paciente
  await page.click('nav [data-ir=pacientes]');
  await page.click('[data-acao=novo-paciente]');
  await page.fill('#modal [name=nome]', 'João da Conceição');
  await page.fill('#modal [name=cpf]', '12345678901');
  await page.selectOption('#modal [name=convenioId]', { label: 'Unimed Teste' });
  await page.fill('#modal [name=carteirinha]', '0001234');
  await page.click('#modal button[type=submit]');
  await page.waitForSelector('td:has-text("123.456.789-01")');

  // Solicitação a partir do paciente: já vem com o convênio dele
  await page.click('[data-nova-para]');
  await page.waitForSelector('h1:has-text("Solicitação #1")');
  assert.strictEqual(await page.inputValue('[name=convenioId] >> xpath=.'), (await page.evaluate(() => state.dados.convenios.find((c) => c.nome === 'Unimed Teste').id)));
  await page.selectOption('[name=tipo]', 'alta_complexidade');
  await page.fill('[name=descricao]', 'Ressonância magnética de joelho');
  await page.fill('[name=codigo]', '41101197');
  await page.fill('[name=cid]', 'M23.2');
  await page.fill('[name=medico]', 'Dra. Ana');

  // Enviar: pede protocolo e data
  await page.click('[data-status=enviada]');
  await page.fill('#modal [name=protocolo]', 'PROT-998');
  await page.fill('#modal [name=dataEnvio]', '2026-11-02');
  await page.fill('#modal [name=texto]', 'Enviado pelo portal');
  await page.click('#modal button[type=submit]');
  await page.waitForSelector('.campo.calc strong:text("02/12/2026")'); // 21 dias úteis com feriados de 15 e 20/11
  await foto(page, '2-editor');

  // Nota no histórico e anexo
  await page.fill('#novaNota', 'Liguei na central, em análise');
  await page.click('[data-acao=add-nota]');
  await page.waitForSelector('.historico p:text("Liguei na central, em análise")');
  // O diálogo de arquivo não é automatizável: envia o caminho como faria o arrastar
  const arq = path.join(dados, 'pedido.txt');
  fs.writeFileSync(arq, 'pedido médico');
  await page.evaluate((f) => anexar(state.solAberta, [f]), arq);
  await page.waitForSelector('.anexos a:text("pedido.txt")');

  await salvar(page);
  let d = lerDados();
  let s = d.solicitacoes[0];
  assert.strictEqual(s.status, 'enviada');
  assert.strictEqual(s.protocolo, 'PROT-998');
  assert.strictEqual(s.descricao, 'Ressonância magnética de joelho');
  assert.strictEqual(s.historico.filter((h) => h.tipo === 'status').length, 1);

  // Autorizar com senha
  await page.click('[data-status=autorizada]');
  await page.fill('#modal [name=senha]', 'SENHA123');
  await page.fill('#modal [name=validadeSenha]', '2099-12-31');
  await page.click('#modal button[type=submit]');
  await page.waitForSelector('h1 .chip:text("Autorizada")');

  // Segunda solicitação particular, atrasada não se aplica; aparece no quadro
  await page.click('[data-acao=nova-solicitacao]');
  await page.waitForSelector('h1:has-text("Solicitação #2")');
  await page.selectOption('[name=pacienteId]', { label: 'João da Conceição' });
  await page.selectOption('[name=convenioId]', 'particular');
  await page.waitForSelector('legend:text("Particular")');
  await page.fill('[name=descricao]', 'Infiltração');
  await page.fill('[name=valor]', '850');
  await page.press('[name=valor]', 'Tab');

  // Terceira: enviada há muito tempo → prazo vencido no painel
  await page.click('[data-acao=nova-solicitacao]');
  await page.waitForSelector('h1:has-text("Solicitação #3")');
  await page.selectOption('[name=pacienteId]', { label: 'João da Conceição' });
  await page.fill('[name=descricao]', 'Tomografia de crânio');
  await page.click('[data-status=enviada]');
  await page.fill('#modal [name=dataEnvio]', '2026-01-05');
  await page.click('#modal button[type=submit]');
  await page.waitForSelector('.alertas-topo .alerta.alto');

  // Painel
  await page.click('nav [data-ir=painel]');
  await page.waitForSelector('.card.vermelho strong:text("1")');
  assert.strictEqual(await page.textContent('#contAlertas'), '1');
  await foto(page, '1-painel');

  // Lista: busca sem acento e filtro
  await page.click('nav [data-ir=solicitacoes]');
  await page.fill('#fBusca', 'ressonancia');
  assert.strictEqual(await page.locator('.tabela tbody tr').count(), 1);
  await page.fill('#fBusca', '');
  assert.strictEqual(await page.locator('.tabela tbody tr').count(), 3);
  await foto(page, '3-lista');

  // Quadro: arrastar a #2 para "Agendada"
  await page.click('[data-modo=quadro]');
  await page.dragAndDrop('.cartao:has-text("Infiltração")', '[data-coluna=agendada]');
  await page.waitForSelector('[data-coluna=agendada] .cartao:has-text("Infiltração")');
  await foto(page, '4-quadro');

  await salvar(page);
  d = lerDados();
  assert.deepStrictEqual(d.solicitacoes.map((x) => x.status), ['autorizada', 'agendada', 'enviada']);
  s = d.solicitacoes[0];
  assert.strictEqual(s.senha, 'SENHA123');
  assert.ok(s.dataResposta);
  assert.strictEqual(s.anexos.length, 1);
  assert.strictEqual(fs.readFileSync(path.join(dados, 'anexos', s.id, s.anexos[0].arquivo), 'utf8'), 'pedido médico');
  assert.strictEqual(d.solicitacoes[1].valor, 850);

  // Conflito: outro computador grava no arquivo → app recarrega sem sobrescrever
  const externo = lerDados();
  externo.config.nomeClinica = 'Gravado em outro PC';
  await new Promise((r) => setTimeout(r, 30));
  fs.writeFileSync(path.join(dados, 'dados.json'), JSON.stringify(externo));
  await page.click('[data-modo=lista]');
  await page.click('.tabela tbody tr >> nth=0');
  await page.fill('[name=obs]', 'alteração local');
  await page.waitForFunction(() => document.querySelector('#nomeClinica').textContent === 'Gravado em outro PC');
  assert.strictEqual(lerDados().config.nomeClinica, 'Gravado em outro PC');

  // Backup diário criado
  assert.ok(fs.readdirSync(path.join(dados, 'backups')).length >= 1);

  assert.deepStrictEqual(erros, []);
  await app.close();
  console.log('OK: fluxo completo passou. Dados em', dados);
})().catch((e) => { console.error(e); process.exit(1); });

async function salvar(page) {
  await page.evaluate(() => salvarAgora());
}
