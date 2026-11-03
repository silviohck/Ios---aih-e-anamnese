/* global Logic */
// Interface do app: painel, solicitações, pacientes, convênios e configurações.
const L = Logic;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));
const agora = () => new Date().toISOString();

const state = {
  dados: null,
  pasta: '',
  tela: 'painel',
  solAberta: null, // id da solicitação no editor
  filtro: { busca: '', status: 'abertas', tipo: '', convenioId: '', soAlertas: false, pacienteId: '' },
  modo: 'lista',
  buscaPacientes: '',
};

function dadosIniciais() {
  return {
    versao: 1,
    seq: 0,
    config: { nomeClinica: '', prazos: { ...L.PRAZOS_PADRAO }, feriadosExtras: [] },
    convenios: [{ id: 'particular', nome: 'Particular', tipo: 'particular' }],
    pacientes: [],
    solicitacoes: [],
  };
}

// ---------- Persistência ----------
let timerSalvar = null;
function persistir() {
  clearTimeout(timerSalvar);
  timerSalvar = setTimeout(salvarAgora, 250);
}
async function salvarAgora() {
  clearTimeout(timerSalvar);
  timerSalvar = null;
  const r = await window.api.salvar(state.dados);
  if (r && r.conflito) {
    alert('Os dados foram alterados em outro computador. O app vai recarregar a versão mais recente; '
      + 'a última alteração feita aqui não foi gravada e precisa ser refeita.');
    await carregar();
  }
}
async function carregar() {
  const { dados, pasta } = await window.api.carregar();
  state.dados = dados || dadosIniciais();
  state.pasta = pasta;
  const d = state.dados;
  d.config = { ...dadosIniciais().config, ...(d.config || {}) };
  d.config.prazos = { ...L.PRAZOS_PADRAO, ...(d.config.prazos || {}) };
  if (!d.convenios.some((c) => c.tipo === 'particular')) d.convenios.unshift(dadosIniciais().convenios[0]);
  if (!dados) await salvarAgora();
  render();
}
window.addEventListener('beforeunload', () => { if (timerSalvar) salvarAgora(); });

// ---------- Acesso ----------
const paciente = (id) => state.dados.pacientes.find((p) => p.id === id);
const convenio = (id) => state.dados.convenios.find((c) => c.id === id);
const solicitacao = (id) => state.dados.solicitacoes.find((s) => s.id === id);
const ehParticular = (s) => (convenio(s.convenioId) || {}).tipo === 'particular';
const ctx = () => ({ pacientes: state.dados.pacientes, convenios: state.dados.convenios, config: state.dados.config, hoje: L.hoje() });
const alertasDe = (s) => L.alertas({ ...s, particular: ehParticular(s) }, state.dados.config);
const ordenarConvenios = () => [...state.dados.convenios].sort((a, b) =>
  (a.tipo === 'particular' ? -1 : b.tipo === 'particular' ? 1 : a.nome.localeCompare(b.nome)));

function aviso(texto) {
  const a = $('#aviso');
  a.textContent = texto;
  a.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => { a.hidden = true; }, 2600);
}

const chipStatus = (id) => { const s = L.statusPorId(id); return `<span class="chip ${s.cor}">${esc(s.nome)}</span>`; };
const chipsAlerta = (lista) => lista.map((a) => `<span class="alerta ${a.nivel}">${esc(a.texto)}</span>`).join('');
const opcoes = (lista, sel, vazio) => (vazio !== undefined ? `<option value="">${esc(vazio)}</option>` : '')
  + lista.map((o) => `<option value="${esc(o.id)}" ${o.id === sel ? 'selected' : ''}>${esc(o.nome)}</option>`).join('');

// ---------- Navegação ----------
function ir(tela, extra = {}) {
  state.tela = tela;
  Object.assign(state, extra);
  render();
  $('#conteudo').scrollTop = 0;
}

function render() {
  const d = state.dados;
  $('#nomeClinica').textContent = d.config.nomeClinica || '';
  $$('nav [data-ir]').forEach((b) => b.classList.toggle('ativo',
    b.dataset.ir === state.tela || (state.tela === 'editor' && b.dataset.ir === 'solicitacoes')));
  const nAlertas = d.solicitacoes.filter((s) => alertasDe(s).some((a) => a.nivel === 'alto')).length;
  $('#contAlertas').textContent = nAlertas || '';
  const telas = { painel: telaPainel, solicitacoes: telaSolicitacoes, editor: telaEditor, pacientes: telaPacientes, convenios: telaConvenios, config: telaConfig };
  (telas[state.tela] || telaPainel)();
}

// ---------- Painel ----------
function telaPainel() {
  const sols = state.dados.solicitacoes;
  const abertas = sols.filter((s) => !L.statusPorId(s.status).final);
  const com = abertas.map((s) => ({ s, a: alertasDe(s) }));
  const conta = (f) => abertas.filter(f).length;
  const hoje = L.hoje();
  const agenda = abertas.filter((s) => s.status === 'agendada' && s.dataAgendada && L.diffDias(hoje, s.dataAgendada) >= 0)
    .sort((a, b) => a.dataAgendada.localeCompare(b.dataAgendada)).slice(0, 8);
  const atencao = com.filter((x) => x.a.length).sort((x, y) =>
    (y.a.some((a) => a.nivel === 'alto') - x.a.some((a) => a.nivel === 'alto')) || (x.s.numero - y.s.numero));

  const cards = [
    ['Em aberto', abertas.length, { status: 'abertas' }],
    ['A enviar', conta((s) => s.status === 'rascunho'), { status: 'rascunho' }],
    ['Aguardando operadora', conta((s) => L.AGUARDANDO_RESPOSTA.includes(s.status)), { status: 'analise' }],
    ['Pendências', conta((s) => s.status === 'pendencia'), { status: 'pendencia' }],
    ['Autorizadas a agendar', conta((s) => ['autorizada', 'parcial'].includes(s.status)), { status: 'autorizada' }],
    ['Prazo vencido', com.filter((x) => x.a.some((a) => a.tipo === 'atrasada')).length, { status: 'abertas', soAlertas: true }, 'vermelho'],
  ];

  $('#conteudo').innerHTML = `
    <header class="topo"><h1>Painel</h1><span class="sub">${esc(L.fmtData(hoje))}</span></header>
    <section class="cards">
      ${cards.map(([t, n, f, cor], i) => `<button class="card ${cor || ''}" data-card="${i}"><span>${esc(t)}</span><strong>${n}</strong></button>`).join('')}
    </section>
    <div class="duas">
      <section class="bloco">
        <h2>Precisa de atenção <small>${atencao.length}</small></h2>
        ${atencao.length ? `<ul class="lista">${atencao.slice(0, 30).map(({ s, a }) => linhaResumo(s, chipsAlerta(a))).join('')}</ul>`
          : '<p class="vazio">Nada pendente. Tudo em dia.</p>'}
      </section>
      <section class="bloco">
        <h2>Próximos agendamentos</h2>
        ${agenda.length ? `<ul class="lista">${agenda.map((s) => linhaResumo(s, `<span class="data">${esc(L.fmtData(s.dataAgendada))}</span>`)).join('')}</ul>`
          : '<p class="vazio">Nenhum procedimento agendado.</p>'}
      </section>
    </div>
    ${sols.length === 0 ? `<section class="bloco boas-vindas"><h2>Começando</h2>
      <ol><li>Cadastre os <a href="#" data-ir="convenios">convênios</a> com que você trabalha (o "Particular" já existe).</li>
      <li>Clique em <b>+ Nova solicitação</b>, escolha ou cadastre o paciente e preencha o pedido.</li>
      <li>Ao enviar à operadora, mude o status para <b>Enviada</b>: o app calcula o prazo e avisa quando vencer.</li></ol></section>` : ''}`;

  $$('[data-card]').forEach((b) => b.addEventListener('click', () => {
    const f = cards[b.dataset.card][2];
    ir('solicitacoes', { filtro: { ...state.filtro, busca: '', tipo: '', convenioId: '', pacienteId: '', soAlertas: false, ...f } });
  }));
}

function linhaResumo(s, direita) {
  const p = paciente(s.pacienteId) || {};
  const c = convenio(s.convenioId) || {};
  return `<li data-abrir="${esc(s.id)}"><div><strong>${esc(p.nome || 'Sem paciente')}</strong>
    <span>#${s.numero} · ${esc(s.descricao || L.tipoPorId(s.tipo).nome)} · ${esc(c.nome || '')}</span></div>
    <div class="dir">${chipStatus(s.status)}${direita}</div></li>`;
}

// ---------- Lista de solicitações ----------
function solicitacoesFiltradas() {
  let lista = L.filtrar(state.dados.solicitacoes, state.filtro, ctx());
  if (state.filtro.pacienteId) lista = lista.filter((s) => s.pacienteId === state.filtro.pacienteId);
  return lista.sort((a, b) => b.numero - a.numero);
}

function telaSolicitacoes() {
  const f = state.filtro;
  const pacFiltro = f.pacienteId && paciente(f.pacienteId);
  $('#conteudo').innerHTML = `
    <header class="topo"><h1>Solicitações</h1>
      <div class="acoes">
        <div class="segmentado"><button data-modo="lista" class="${state.modo === 'lista' ? 'ativo' : ''}">Lista</button><button data-modo="quadro" class="${state.modo === 'quadro' ? 'ativo' : ''}">Quadro</button></div>
        <button data-acao="exportar-csv">Exportar planilha</button>
      </div>
    </header>
    <div class="filtros">
      <input type="search" id="fBusca" placeholder="Buscar paciente, procedimento, protocolo, senha…" value="${esc(f.busca)}">
      <select id="fStatus"><option value="abertas">Em aberto</option><option value="todas">Todas</option>${opcoes(L.STATUS, f.status)}</select>
      <select id="fTipo">${opcoes(L.TIPOS, f.tipo, 'Todos os tipos')}</select>
      <select id="fConv">${opcoes(ordenarConvenios(), f.convenioId, 'Todos os convênios')}</select>
      <label class="check"><input type="checkbox" id="fAlertas" ${f.soAlertas ? 'checked' : ''}> Só com alertas</label>
      ${pacFiltro ? `<span class="filtro-pac">Paciente: ${esc(pacFiltro.nome)} <button data-acao="limpar-pac" title="Remover filtro">×</button></span>` : ''}
    </div>
    <div id="resultado"></div>`;
  $('#fStatus').value = f.status || 'abertas';
  $('#fBusca').addEventListener('input', (e) => { f.busca = e.target.value; desenharResultado(); });
  $('#fStatus').addEventListener('change', (e) => { f.status = e.target.value; desenharResultado(); });
  $('#fTipo').addEventListener('change', (e) => { f.tipo = e.target.value; desenharResultado(); });
  $('#fConv').addEventListener('change', (e) => { f.convenioId = e.target.value; desenharResultado(); });
  $('#fAlertas').addEventListener('change', (e) => { f.soAlertas = e.target.checked; desenharResultado(); });
  $$('[data-modo]').forEach((b) => b.addEventListener('click', () => { state.modo = b.dataset.modo; telaSolicitacoes(); }));
  desenharResultado();
  $('#fBusca').focus();
}

function desenharResultado() {
  const lista = solicitacoesFiltradas();
  const alvo = $('#resultado');
  if (state.modo === 'quadro') return desenharQuadro(alvo, lista);
  if (!lista.length) {
    alvo.innerHTML = `<p class="vazio">${state.dados.solicitacoes.length ? 'Nenhuma solicitação com esses filtros.' : 'Nenhuma solicitação cadastrada ainda.'}</p>`;
    return;
  }
  alvo.innerHTML = `<table class="tabela"><thead><tr>
      <th>Nº</th><th>Paciente</th><th>Pedido</th><th>Convênio</th><th>Status</th><th>Enviada</th><th>Prazo</th><th>Alertas</th>
    </tr></thead><tbody>
    ${lista.map((s) => {
      const p = paciente(s.pacienteId) || {};
      const c = convenio(s.convenioId) || {};
      const lim = L.dataLimite(s, state.dados.config);
      return `<tr data-abrir="${esc(s.id)}">
        <td class="num">${s.numero}</td>
        <td><strong>${esc(p.nome || '—')}</strong></td>
        <td>${esc(s.descricao || '—')}<small>${esc(L.tipoPorId(s.tipo).nome)}${s.carater === 'urgencia' ? ' · <b class="urg">URGÊNCIA</b>' : ''}</small></td>
        <td>${esc(c.nome || '—')}</td>
        <td>${chipStatus(s.status)}</td>
        <td>${esc(L.fmtData(s.dataEnvio))}</td>
        <td>${L.AGUARDANDO_RESPOSTA.includes(s.status) ? esc(L.fmtData(lim)) : ''}</td>
        <td>${chipsAlerta(alertasDe(s))}</td></tr>`;
    }).join('')}</tbody></table>
    <p class="rodape">${lista.length} solicitação(ões)</p>`;
}

function desenharQuadro(alvo, lista) {
  const colunas = L.STATUS.filter((s) => state.filtro.status === 'todas' || !s.final || s.id === state.filtro.status);
  alvo.innerHTML = `<div class="quadro">${colunas.map((st) => {
    const itens = lista.filter((s) => s.status === st.id);
    return `<div class="coluna" data-coluna="${st.id}"><h3><span class="ponto ${st.cor}"></span>${esc(st.nome)} <small>${itens.length}</small></h3>
      ${itens.map((s) => {
        const p = paciente(s.pacienteId) || {};
        const c = convenio(s.convenioId) || {};
        return `<div class="cartao" draggable="true" data-abrir="${esc(s.id)}" data-id="${esc(s.id)}">
          <strong>${esc(p.nome || '—')}</strong><span>${esc(s.descricao || L.tipoPorId(s.tipo).nome)}</span>
          <small>#${s.numero} · ${esc(c.nome || '')}</small>${chipsAlerta(alertasDe(s))}</div>`;
      }).join('')}</div>`;
  }).join('')}</div>`;
  $$('.cartao', alvo).forEach((el) => el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', el.dataset.id)));
  $$('.coluna', alvo).forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('sobre'); });
    col.addEventListener('dragleave', () => col.classList.remove('sobre'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('sobre');
      const id = e.dataTransfer.getData('text/plain');
      if (id) aplicarStatus(id, col.dataset.coluna);
      desenharResultado();
    });
  });
}

function aplicarStatus(id, novo, texto = '') {
  const i = state.dados.solicitacoes.findIndex((s) => s.id === id);
  if (i < 0) return;
  const antes = state.dados.solicitacoes[i];
  if (antes.status === novo) return;
  state.dados.solicitacoes[i] = L.mudarStatus(antes, novo, texto, agora());
  persistir();
  aviso(`#${antes.numero}: ${L.statusPorId(novo).nome}`);
}

function exportarCSV() {
  const lista = solicitacoesFiltradas();
  const linhas = [['Nº', 'Paciente', 'CPF', 'Carteirinha', 'Convênio', 'Tipo', 'Caráter', 'Pedido', 'Código', 'Qtd', 'CID', 'Médico',
    'Local', 'Status', 'Data do pedido', 'Enviada em', 'Prazo', 'Resposta em', 'Protocolo', 'Guia', 'Senha', 'Validade senha',
    'Agendada para', 'Realizada em', 'Valor', 'Pagamento', 'Observações']];
  for (const s of lista) {
    const p = paciente(s.pacienteId) || {};
    linhas.push([s.numero, p.nome, p.cpf, p.carteirinha, (convenio(s.convenioId) || {}).nome, L.tipoPorId(s.tipo).nome,
      s.carater === 'urgencia' ? 'Urgência' : 'Eletiva', s.descricao, s.codigo, s.quantidade, s.cid, s.medico, s.local,
      L.statusPorId(s.status).nome, L.fmtData(s.dataPedido), L.fmtData(s.dataEnvio), L.fmtData(L.dataLimite(s, state.dados.config)),
      L.fmtData(s.dataResposta), s.protocolo, s.guia, s.senha, L.fmtData(s.validadeSenha), L.fmtData(s.dataAgendada),
      L.fmtData(s.dataRealizada), s.valor ? String(s.valor).replace('.', ',') : '', s.pagamento || '', s.obs]);
  }
  window.api.salvarTexto(`solicitacoes-${L.hoje()}.csv`, L.csv(linhas), { name: 'Planilha (CSV)', extensions: ['csv'] })
    .then((f) => f && aviso('Planilha salva.'));
}

// ---------- Editor de solicitação ----------
function novaSolicitacao(pacienteId = '') {
  const d = state.dados;
  d.seq = (d.seq || d.solicitacoes.reduce((m, s) => Math.max(m, s.numero || 0), 0)) + 1;
  const p = paciente(pacienteId);
  const s = {
    id: uid(), numero: d.seq, pacienteId, convenioId: (p && p.convenioId) || '', tipo: 'exame', carater: 'eletiva',
    descricao: '', status: 'rascunho', dataPedido: L.hoje(), quantidade: 1, anexos: [],
    historico: [{ em: agora(), tipo: 'criacao', texto: 'Solicitação criada' }], criadoEm: agora(), atualizadoEm: agora(),
  };
  d.solicitacoes.push(s);
  persistir();
  ir('editor', { solAberta: s.id });
}

const CAMPOS_SOL = [
  ['pacienteId'], ['convenioId'], ['tipo'], ['carater'], ['descricao'], ['codigo'], ['quantidade'], ['cid'], ['medico'], ['local'],
  ['dataPedido'], ['dataEnvio'], ['protocolo'], ['guia'], ['senha'], ['validadeSenha'], ['prazoDias'], ['retorno'],
  ['dataAgendada'], ['dataResposta'], ['dataRealizada'], ['valor'], ['formaPagamento'], ['pagamento'], ['obs'],
];

function telaEditor() {
  const s = solicitacao(state.solAberta);
  if (!s) return ir('solicitacoes');
  const p = paciente(s.pacienteId);
  const part = ehParticular(s);
  const lim = L.dataLimite(s, state.dados.config);
  const prazoPadrao = state.dados.config.prazos[s.tipo];
  const pacientes = [...state.dados.pacientes].sort((a, b) => a.nome.localeCompare(b.nome));
  const campo = (rot, html, cls = '') => `<label class="campo ${cls}"><span>${rot}</span>${html}</label>`;
  const inp = (nome, tipo = 'text', extra = '') => `<input type="${tipo}" name="${nome}" value="${esc(s[nome] ?? '')}" ${extra}>`;

  $('#conteudo').innerHTML = `
    <header class="topo">
      <div><button class="voltar" data-acao="voltar">← Solicitações</button>
        <h1>Solicitação #${s.numero} ${chipStatus(s.status)}</h1></div>
      <div class="acoes"><button data-acao="imprimir">Imprimir ficha</button><button data-acao="duplicar">Duplicar</button><button class="perigo" data-acao="excluir">Excluir</button></div>
    </header>
    <div class="alertas-topo">${chipsAlerta(alertasDe(s))}</div>
    <div class="editor">
      <form id="formSol" class="formulario" autocomplete="off">
        <fieldset><legend>Paciente e convênio</legend>
          <div class="grade">
            ${campo('Paciente', `<div class="com-botao"><select name="pacienteId">${opcoes(pacientes, s.pacienteId, '— escolha —')}</select>
              <button type="button" data-acao="novo-paciente-sol">Novo</button>${p ? '<button type="button" data-acao="editar-paciente-sol">Editar</button>' : ''}</div>`, 'larg2')}
            ${campo('Convênio', `<select name="convenioId">${opcoes(ordenarConvenios(), s.convenioId, '— escolha —')}</select>`)}
            <div class="info-pac">${p ? `<span>CPF ${esc(p.cpf || '—')}</span><span>Nasc. ${esc(L.fmtData(p.nascimento) || '—')}</span>
              <span>Carteirinha ${esc(p.carteirinha || '—')}${p.validadeCarteirinha ? ` (val. ${esc(L.fmtData(p.validadeCarteirinha))})` : ''}</span>
              <span>${esc(p.telefone || '')}</span>` : ''}</div>
          </div>
        </fieldset>
        <fieldset><legend>Pedido</legend>
          <div class="grade">
            ${campo('Tipo', `<select name="tipo">${opcoes(L.TIPOS, s.tipo)}</select>`)}
            ${campo('Caráter', `<select name="carater"><option value="eletiva">Eletiva</option><option value="urgencia" ${s.carater === 'urgencia' ? 'selected' : ''}>Urgência / emergência</option></select>`)}
            ${campo('Procedimento / exame', inp('descricao', 'text', 'placeholder="Ex.: Ressonância magnética de joelho direito"'), 'larg2')}
            ${campo('Código (TUSS)', inp('codigo'))}
            ${campo('Quantidade', inp('quantidade', 'number', 'min="1"'))}
            ${campo('CID', inp('cid', 'text', 'placeholder="Ex.: M23.2"'))}
            ${campo('Médico solicitante', inp('medico'))}
            ${campo('Local / prestador que vai realizar', inp('local'), 'larg2')}
          </div>
        </fieldset>
        <fieldset><legend>${part ? 'Andamento' : 'Autorização'}</legend>
          <div class="grade">
            ${campo('Data do pedido médico', inp('dataPedido', 'date'))}
            ${part ? '' : campo('Enviada à operadora em', inp('dataEnvio', 'date'))}
            ${part ? '' : campo('Protocolo', inp('protocolo'))}
            ${part ? '' : campo('Nº da guia', inp('guia'))}
            ${part ? '' : campo(`Prazo (dias úteis)`, inp('prazoDias', 'number', `min="0" placeholder="${s.carater === 'urgencia' ? 'imediato' : prazoPadrao}"`))}
            ${part ? '' : `<div class="campo calc"><span>Data limite da resposta</span><strong>${lim ? esc(L.fmtData(lim)) : '<em>defina a data de envio</em>'}</strong></div>`}
            ${part ? '' : campo('Resposta recebida em', inp('dataResposta', 'date'))}
            ${part ? '' : campo('Senha de autorização', inp('senha'))}
            ${part ? '' : campo('Validade da senha', inp('validadeSenha', 'date'))}
            ${campo('Agendado para', inp('dataAgendada', 'date'))}
            ${campo('Realizado em', inp('dataRealizada', 'date'))}
            ${campo('Retornar / cobrar em', inp('retorno', 'date'))}
          </div>
        </fieldset>
        ${part ? `<fieldset><legend>Particular</legend><div class="grade">
            ${campo('Valor (R$)', inp('valor', 'number', 'step="0.01" min="0"'))}
            ${campo('Forma de pagamento', `<select name="formaPagamento">${opcoes(['Pix', 'Dinheiro', 'Cartão de débito', 'Cartão de crédito', 'Boleto', 'Transferência'].map((x) => ({ id: x, nome: x })), s.formaPagamento, '—')}</select>`)}
            ${campo('Pagamento', `<select name="pagamento">${opcoes([{ id: 'pendente', nome: 'Pendente' }, { id: 'sinal', nome: 'Sinal pago' }, { id: 'pago', nome: 'Pago' }], s.pagamento || 'pendente')}</select>`)}
          </div></fieldset>` : ''}
        <fieldset><legend>Observações</legend>
          <textarea name="obs" rows="4" placeholder="Anotações gerais sobre esta solicitação">${esc(s.obs || '')}</textarea>
        </fieldset>
      </form>
      <aside class="lateral">
        <section class="bloco">
          <h2>Mudar status</h2>
          <div class="botoes-status">${L.STATUS.map((st) => `<button data-status="${st.id}" class="${st.id === s.status ? 'atual ' : ''}${st.cor}">${esc(st.nome)}</button>`).join('')}</div>
        </section>
        <section class="bloco">
          <h2>Anexos <small>${(s.anexos || []).length}</small></h2>
          <div class="soltar" id="soltar">Arraste arquivos aqui ou <button type="button" data-acao="anexar">escolha</button></div>
          <ul class="anexos">${(s.anexos || []).map((a) => `<li><a href="#" data-anexo="${esc(a.arquivo)}">${esc(a.nome)}</a>
            <small>${esc(L.fmtData(a.adicionadoEm))}</small><button data-remover-anexo="${esc(a.id)}" title="Remover">×</button></li>`).join('')}</ul>
        </section>
        <section class="bloco">
          <h2>Histórico</h2>
          <div class="nota"><textarea id="novaNota" rows="2" placeholder="Registrar contato, ligação, pendência…"></textarea>
            <button data-acao="add-nota">Registrar</button></div>
          <ol class="historico">${[...(s.historico || [])].reverse().map((h) => `<li>
            <time>${esc(new Date(h.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))}</time>
            ${h.tipo === 'status' ? `<span>${chipStatus(h.de)} → ${chipStatus(h.para)}</span>` : ''}
            ${h.texto ? `<p>${esc(h.texto)}</p>` : ''}</li>`).join('')}</ol>
        </section>
      </aside>
    </div>
    ${fichaImpressao(s)}`;

  const form = $('#formSol');
  const salvarCampo = (e) => {
    const el = e.target;
    if (!el.name) return;
    const atual = solicitacao(s.id);
    let v = el.value;
    if (['quantidade', 'prazoDias', 'valor'].includes(el.name)) v = v === '' ? '' : Number(v);
    atual[el.name] = v;
    atual.atualizadoEm = agora();
    if (el.name === 'pacienteId') {
      const np = paciente(v);
      if (np && np.convenioId && !atual.convenioId) atual.convenioId = np.convenioId;
    }
    persistir();
    // Campos que mudam o que aparece na tela
    if (['pacienteId', 'convenioId', 'tipo', 'carater', 'dataEnvio', 'prazoDias', 'validadeSenha', 'retorno', 'dataAgendada'].includes(el.name)) {
      const foco = el.name;
      telaEditor();
      const novo = $(`[name="${foco}"]`);
      if (novo && e.type === 'change' && novo.tagName !== 'SELECT') novo.focus();
    }
  };
  form.addEventListener('change', salvarCampo);
  form.addEventListener('input', (e) => { if (e.target.matches('input[type=text], input:not([type]), textarea')) {
    const atual = solicitacao(s.id); atual[e.target.name] = e.target.value; atual.atualizadoEm = agora(); persistir();
  } });

  $$('[data-status]').forEach((b) => b.addEventListener('click', () => perguntarStatus(s.id, b.dataset.status)));

  const zona = $('#soltar');
  zona.addEventListener('dragover', (e) => { e.preventDefault(); zona.classList.add('sobre'); });
  zona.addEventListener('dragleave', () => zona.classList.remove('sobre'));
  zona.addEventListener('drop', (e) => { e.preventDefault(); zona.classList.remove('sobre'); anexar(s.id, e.dataTransfer.files); });
  $$('[data-anexo]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); window.api.abrirAnexo(s.id, a.dataset.anexo); }));
  $$('[data-remover-anexo]').forEach((b) => b.addEventListener('click', async () => {
    const atual = solicitacao(s.id);
    const an = atual.anexos.find((a) => a.id === b.dataset.removerAnexo);
    if (!an || !confirm(`Remover o anexo "${an.nome}"?`)) return;
    await window.api.removerAnexo(s.id, an.arquivo);
    atual.anexos = atual.anexos.filter((a) => a !== an);
    atual.historico.push({ em: agora(), tipo: 'nota', texto: `Anexo removido: ${an.nome}` });
    persistir();
    telaEditor();
  }));
}

async function anexar(solId, arquivos) {
  const novos = await window.api.adicionarAnexos(solId, arquivos && arquivos.length ? arquivos : undefined);
  if (!novos || !novos.length) return;
  const s = solicitacao(solId);
  s.anexos = [...(s.anexos || []), ...novos];
  s.historico.push({ em: agora(), tipo: 'nota', texto: `Anexo(s): ${novos.map((a) => a.nome).join(', ')}` });
  persistir();
  telaEditor();
}

function perguntarStatus(id, novo) {
  const s = solicitacao(id);
  if (s.status === novo) return;
  const st = L.statusPorId(novo);
  const extra = {
    enviada: !ehParticular(s) ? `<label class="campo"><span>Protocolo (opcional)</span><input name="protocolo" value="${esc(s.protocolo || '')}"></label>
      <label class="campo"><span>Enviada em</span><input type="date" name="dataEnvio" value="${esc(s.dataEnvio || L.hoje())}"></label>` : '',
    autorizada: !ehParticular(s) ? `<label class="campo"><span>Senha</span><input name="senha" value="${esc(s.senha || '')}"></label>
      <label class="campo"><span>Validade da senha</span><input type="date" name="validadeSenha" value="${esc(s.validadeSenha || '')}"></label>` : '',
    agendada: `<label class="campo"><span>Data agendada</span><input type="date" name="dataAgendada" value="${esc(s.dataAgendada || '')}"></label>`,
    pendencia: `<label class="campo"><span>Retornar / cobrar em</span><input type="date" name="retorno" value="${esc(s.retorno || '')}"></label>`,
  };
  extra.parcial = extra.autorizada;
  abrirModal(`Mudar para "${st.nome}"`, `${extra[novo] || ''}
    <label class="campo"><span>${novo === 'negada' ? 'Motivo da negativa' : novo === 'pendencia' ? 'O que a operadora pediu' : 'Observação (opcional)'}</span>
    <textarea name="texto" rows="3"></textarea></label>`, (dados) => {
    const atual = solicitacao(id);
    for (const k of ['protocolo', 'dataEnvio', 'senha', 'validadeSenha', 'dataAgendada', 'retorno']) if (k in dados) atual[k] = dados[k];
    aplicarStatus(id, novo, dados.texto || '');
    render();
  }, 'Confirmar');
}

function fichaImpressao(s) {
  const p = paciente(s.pacienteId) || {};
  const c = convenio(s.convenioId) || {};
  const linha = (r, v) => (v ? `<tr><th>${esc(r)}</th><td>${esc(v)}</td></tr>` : '');
  return `<section class="ficha">
    <h1>${esc(state.dados.config.nomeClinica || 'Solicitação')}</h1>
    <h2>Solicitação #${s.numero} — ${esc(L.statusPorId(s.status).nome)}</h2>
    <table>${linha('Paciente', p.nome)}${linha('CPF', p.cpf)}${linha('Nascimento', L.fmtData(p.nascimento))}${linha('Telefone', p.telefone)}
      ${linha('Convênio', c.nome)}${linha('Carteirinha', p.carteirinha)}${linha('Tipo', L.tipoPorId(s.tipo).nome)}
      ${linha('Caráter', s.carater === 'urgencia' ? 'Urgência / emergência' : 'Eletiva')}${linha('Pedido', s.descricao)}
      ${linha('Código', s.codigo)}${linha('Quantidade', s.quantidade)}${linha('CID', s.cid)}${linha('Médico solicitante', s.medico)}
      ${linha('Local', s.local)}${linha('Data do pedido', L.fmtData(s.dataPedido))}${linha('Enviada em', L.fmtData(s.dataEnvio))}
      ${linha('Protocolo', s.protocolo)}${linha('Guia', s.guia)}${linha('Senha', s.senha)}${linha('Validade da senha', L.fmtData(s.validadeSenha))}
      ${linha('Agendado para', L.fmtData(s.dataAgendada))}${linha('Valor', L.fmtDinheiro(s.valor))}${linha('Observações', s.obs)}</table>
    <h3>Histórico</h3>
    <ul>${(s.historico || []).map((h) => `<li>${esc(new Date(h.em).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }))} —
      ${h.tipo === 'status' ? `${esc(L.statusPorId(h.de).nome)} → ${esc(L.statusPorId(h.para).nome)}. ` : ''}${esc(h.texto || '')}</li>`).join('')}</ul>
    <p class="impresso">Impresso em ${esc(new Date().toLocaleString('pt-BR'))}</p></section>`;
}

// ---------- Pacientes ----------
function telaPacientes() {
  const q = L.normalizar(state.buscaPacientes);
  const lista = state.dados.pacientes.filter((p) => !q || L.normalizar([p.nome, p.cpf, p.carteirinha, p.telefone].join(' ')).includes(q))
    .sort((a, b) => a.nome.localeCompare(b.nome));
  const contagem = {};
  for (const s of state.dados.solicitacoes) if (!L.statusPorId(s.status).final) contagem[s.pacienteId] = (contagem[s.pacienteId] || 0) + 1;
  $('#conteudo').innerHTML = `
    <header class="topo"><h1>Pacientes</h1><div class="acoes"><button class="primario" data-acao="novo-paciente">+ Novo paciente</button></div></header>
    <div class="filtros"><input type="search" id="buscaPac" placeholder="Buscar por nome, CPF, carteirinha ou telefone" value="${esc(state.buscaPacientes)}"></div>
    ${lista.length ? `<table class="tabela"><thead><tr><th>Nome</th><th>CPF</th><th>Nascimento</th><th>Telefone</th><th>Convênio</th><th>Carteirinha</th><th>Em aberto</th><th></th></tr></thead><tbody>
      ${lista.map((p) => `<tr data-paciente="${esc(p.id)}"><td><strong>${esc(p.nome)}</strong></td><td>${esc(p.cpf || '')}</td>
        <td>${esc(L.fmtData(p.nascimento))}</td><td>${esc(p.telefone || '')}</td><td>${esc((convenio(p.convenioId) || {}).nome || '')}</td>
        <td>${esc(p.carteirinha || '')}</td><td>${contagem[p.id] ? `<a href="#" data-ver-sols="${esc(p.id)}">${contagem[p.id]}</a>` : ''}</td>
        <td class="dir"><button data-nova-para="${esc(p.id)}">+ Solicitação</button></td></tr>`).join('')}</tbody></table>`
      : `<p class="vazio">${state.dados.pacientes.length ? 'Nenhum paciente encontrado.' : 'Nenhum paciente cadastrado.'}</p>`}`;
  const busca = $('#buscaPac');
  busca.addEventListener('input', () => {
    state.buscaPacientes = busca.value;
    const pos = busca.selectionStart;
    telaPacientes();
    $('#buscaPac').focus();
    $('#buscaPac').setSelectionRange(pos, pos);
  });
  $$('[data-paciente]').forEach((tr) => tr.addEventListener('click', (e) => {
    if (e.target.closest('button, a')) return;
    editarPaciente(tr.dataset.paciente);
  }));
  $$('[data-nova-para]').forEach((b) => b.addEventListener('click', () => novaSolicitacao(b.dataset.novaPara)));
  $$('[data-ver-sols]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    ir('solicitacoes', { filtro: { busca: '', status: 'abertas', tipo: '', convenioId: '', soAlertas: false, pacienteId: a.dataset.verSols } });
  }));
}

function editarPaciente(id, aoSalvar) {
  const p = id ? paciente(id) : {};
  const f = (rot, nome, tipo = 'text', extra = '') => `<label class="campo"><span>${rot}</span><input type="${tipo}" name="${nome}" value="${esc(p[nome] || '')}" ${extra}></label>`;
  abrirModal(id ? 'Editar paciente' : 'Novo paciente', `<div class="grade">
      <label class="campo larg2"><span>Nome completo</span><input name="nome" required value="${esc(p.nome || '')}"></label>
      ${f('CPF', 'cpf', 'text', 'placeholder="000.000.000-00"')}${f('Nascimento', 'nascimento', 'date')}
      ${f('Telefone / WhatsApp', 'telefone')}${f('E-mail', 'email', 'email')}
      <label class="campo"><span>Convênio</span><select name="convenioId">${opcoes(ordenarConvenios(), p.convenioId, '—')}</select></label>
      ${f('Plano / produto', 'plano')}${f('Nº da carteirinha', 'carteirinha')}${f('Validade da carteirinha', 'validadeCarteirinha', 'date')}
      <label class="campo larg2"><span>Observações</span><textarea name="obs" rows="2">${esc(p.obs || '')}</textarea></label>
    </div>`, (dados) => {
    if (!dados.nome.trim()) return false;
    dados.cpf = formatarCPF(dados.cpf);
    let reg;
    if (id) { reg = paciente(id); Object.assign(reg, dados, { atualizadoEm: agora() }); } else {
      reg = { id: uid(), ...dados, criadoEm: agora() };
      state.dados.pacientes.push(reg);
    }
    persistir();
    if (aoSalvar) aoSalvar(reg); else render();
    return true;
  }, 'Salvar', id ? () => excluirPaciente(id) : null);
}

function formatarCPF(v) {
  const n = String(v || '').replace(/\D/g, '');
  return n.length === 11 ? n.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : (v || '').trim();
}

function excluirPaciente(id) {
  const n = state.dados.solicitacoes.filter((s) => s.pacienteId === id).length;
  if (n) { alert(`Este paciente tem ${n} solicitação(ões). Exclua-as antes de excluir o paciente.`); return false; }
  if (!confirm('Excluir este paciente?')) return false;
  state.dados.pacientes = state.dados.pacientes.filter((p) => p.id !== id);
  persistir();
  render();
  return true;
}

// ---------- Convênios ----------
function telaConvenios() {
  const lista = ordenarConvenios();
  const uso = {};
  for (const s of state.dados.solicitacoes) if (!L.statusPorId(s.status).final) uso[s.convenioId] = (uso[s.convenioId] || 0) + 1;
  $('#conteudo').innerHTML = `
    <header class="topo"><h1>Convênios</h1><div class="acoes"><button class="primario" data-acao="novo-convenio">+ Novo convênio</button></div></header>
    <table class="tabela"><thead><tr><th>Nome</th><th>Tipo</th><th>Registro ANS</th><th>Telefone</th><th>Portal</th><th>Em aberto</th></tr></thead><tbody>
    ${lista.map((c) => `<tr data-convenio="${esc(c.id)}"><td><strong>${esc(c.nome)}</strong></td>
      <td>${c.tipo === 'particular' ? 'Particular' : 'Plano de saúde'}</td><td>${esc(c.ans || '')}</td><td>${esc(c.telefone || '')}</td>
      <td>${c.site ? `<a href="${esc(/^https?:/.test(c.site) ? c.site : `https://${c.site}`)}" target="_blank">abrir</a>` : ''}</td>
      <td>${uso[c.id] || ''}</td></tr>`).join('')}</tbody></table>`;
  $$('[data-convenio]').forEach((tr) => tr.addEventListener('click', (e) => { if (!e.target.closest('a')) editarConvenio(tr.dataset.convenio); }));
}

function editarConvenio(id, aoSalvar) {
  const c = id ? convenio(id) : { tipo: 'plano' };
  const f = (rot, nome, extra = '') => `<label class="campo"><span>${rot}</span><input name="${nome}" value="${esc(c[nome] || '')}" ${extra}></label>`;
  abrirModal(id ? 'Editar convênio' : 'Novo convênio', `<div class="grade">
      <label class="campo larg2"><span>Nome</span><input name="nome" required value="${esc(c.nome || '')}" placeholder="Ex.: Unimed, Bradesco Saúde"></label>
      <label class="campo"><span>Tipo</span><select name="tipo"><option value="plano">Plano de saúde</option>
        <option value="particular" ${c.tipo === 'particular' ? 'selected' : ''}>Particular</option></select></label>
      ${f('Registro ANS', 'ans')}${f('Telefone / central', 'telefone')}${f('E-mail', 'email')}
      ${f('Portal / site para autorizações', 'site', 'placeholder="https://"')}
      <label class="campo larg2"><span>Observações (documentos exigidos, contatos…)</span><textarea name="obs" rows="3">${esc(c.obs || '')}</textarea></label>
    </div>`, (dados) => {
    if (!dados.nome.trim()) return false;
    let reg;
    if (id) { reg = convenio(id); Object.assign(reg, dados); } else { reg = { id: uid(), ...dados }; state.dados.convenios.push(reg); }
    persistir();
    if (aoSalvar) aoSalvar(reg); else render();
    return true;
  }, 'Salvar', id && id !== 'particular' ? () => {
    if (state.dados.solicitacoes.some((s) => s.convenioId === id) || state.dados.pacientes.some((p) => p.convenioId === id)) {
      alert('Este convênio está em uso por pacientes ou solicitações e não pode ser excluído.');
      return false;
    }
    if (!confirm('Excluir este convênio?')) return false;
    state.dados.convenios = state.dados.convenios.filter((x) => x.id !== id);
    persistir(); render(); return true;
  } : null);
}

// ---------- Configurações ----------
function telaConfig() {
  const cfg = state.dados.config;
  $('#conteudo').innerHTML = `
    <header class="topo"><h1>Configurações</h1></header>
    <section class="bloco"><h2>Clínica / consultório</h2>
      <label class="campo"><span>Nome (aparece no menu e na ficha impressa)</span><input id="cfgNome" value="${esc(cfg.nomeClinica)}"></label></section>
    <section class="bloco"><h2>Prazos de resposta (dias úteis)</h2>
      <p class="ajuda">Usados para calcular a data limite a partir do envio à operadora. Os valores iniciais seguem os prazos de garantia de
      atendimento da ANS (RN 566/2022); confira a norma vigente e o contrato de cada operadora. Urgência/emergência: imediato.
      Também pode ser alterado em cada solicitação.</p>
      <div class="grade prazos">${L.TIPOS.map((t) => `<label class="campo"><span>${esc(t.nome)}</span>
        <input type="number" min="0" data-prazo="${t.id}" value="${esc(cfg.prazos[t.id])}"></label>`).join('')}</div>
      <label class="campo"><span>Feriados locais (municipais/estaduais), um por linha no formato DD/MM/AAAA. Feriados nacionais já são considerados.</span>
        <textarea id="cfgFeriados" rows="3">${esc((cfg.feriadosExtras || []).map(L.fmtData).join('\n'))}</textarea></label>
    </section>
    <section class="bloco"><h2>Dados e backup</h2>
      <p class="ajuda">Pasta dos dados: <code>${esc(state.pasta)}</code><br>Uma cópia automática por dia fica em <code>backups/</code> dentro dessa pasta.
      Para usar em mais de um computador, escolha uma pasta sincronizada (OneDrive, Dropbox, Google Drive) e evite editar nos dois ao mesmo tempo.</p>
      <div class="linha-botoes"><button data-acao="abrir-pasta">Abrir pasta</button><button data-acao="trocar-pasta">Trocar pasta…</button>
        <button data-acao="exportar-backup">Exportar backup</button><button data-acao="importar-backup">Importar backup…</button></div>
    </section>
    <p class="rodape" id="versao"></p>`;
  $('#cfgNome').addEventListener('input', (e) => { cfg.nomeClinica = e.target.value; $('#nomeClinica').textContent = cfg.nomeClinica; persistir(); });
  $$('[data-prazo]').forEach((i) => i.addEventListener('change', () => {
    cfg.prazos[i.dataset.prazo] = i.value === '' ? L.PRAZOS_PADRAO[i.dataset.prazo] : Number(i.value); persistir();
  }));
  $('#cfgFeriados').addEventListener('change', (e) => {
    cfg.feriadosExtras = e.target.value.split(/\s*\n\s*/).map((l) => {
      const m = l.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
    }).filter(Boolean);
    persistir();
    aviso(`${cfg.feriadosExtras.length} feriado(s) local(is) salvo(s).`);
  });
  window.api.versao().then((v) => { const el = $('#versao'); if (el) el.textContent = `Versão ${v}`; });
}

// ---------- Modal genérico ----------
function abrirModal(titulo, corpo, aoConfirmar, rotulo = 'OK', aoExcluir = null) {
  const dlg = $('#modal');
  const form = $('#modalForm');
  form.innerHTML = `<h2>${esc(titulo)}</h2><div class="corpo">${corpo}</div>
    <footer>${aoExcluir ? '<button type="button" class="perigo" data-m="excluir">Excluir</button>' : ''}<span class="esp"></span>
      <button type="button" data-m="cancelar">Cancelar</button><button type="submit" class="primario">${esc(rotulo)}</button></footer>`;
  form.onsubmit = (e) => {
    e.preventDefault();
    const dados = Object.fromEntries(new FormData(form).entries());
    if (aoConfirmar(dados) !== false) dlg.close();
  };
  $('[data-m=cancelar]', form).onclick = () => dlg.close();
  if (aoExcluir) $('[data-m=excluir]', form).onclick = () => { if (aoExcluir() !== false) dlg.close(); };
  dlg.showModal();
  const primeiro = $('input, select, textarea', form);
  if (primeiro) primeiro.focus();
}

// ---------- Ações globais ----------
document.addEventListener('click', async (e) => {
  const irPara = e.target.closest('[data-ir]');
  if (irPara) { e.preventDefault(); return ir(irPara.dataset.ir); }
  const abrir = e.target.closest('[data-abrir]');
  if (abrir && !e.target.closest('button')) return ir('editor', { solAberta: abrir.dataset.abrir });
  const b = e.target.closest('[data-acao]');
  if (!b) return;
  const s = state.solAberta && solicitacao(state.solAberta);
  switch (b.dataset.acao) {
    case 'nova-solicitacao': return novaSolicitacao();
    case 'voltar': return ir('solicitacoes');
    case 'exportar-csv': return exportarCSV();
    case 'limpar-pac': state.filtro.pacienteId = ''; return telaSolicitacoes();
    case 'novo-paciente': return editarPaciente(null);
    case 'novo-convenio': return editarConvenio(null);
    case 'novo-paciente-sol': return editarPaciente(null, (p) => {
      s.pacienteId = p.id; if (p.convenioId) s.convenioId = p.convenioId; persistir(); telaEditor();
    });
    case 'editar-paciente-sol': return editarPaciente(s.pacienteId, () => telaEditor());
    case 'anexar': return anexar(s.id);
    case 'add-nota': {
      const t = $('#novaNota').value.trim();
      if (!t) return;
      s.historico.push({ em: agora(), tipo: 'nota', texto: t });
      s.atualizadoEm = agora();
      persistir();
      return telaEditor();
    }
    case 'imprimir': await salvarAgora(); return window.print();
    case 'duplicar': {
      const d = state.dados;
      d.seq += 1;
      const copia = {
        ...s, id: uid(), numero: d.seq, status: 'rascunho', anexos: [], protocolo: '', guia: '', senha: '', validadeSenha: '',
        dataEnvio: '', dataResposta: '', dataAgendada: '', dataRealizada: '', retorno: '', pagamento: 'pendente',
        historico: [{ em: agora(), tipo: 'criacao', texto: `Cópia da solicitação #${s.numero}` }], criadoEm: agora(), atualizadoEm: agora(),
      };
      d.solicitacoes.push(copia);
      persistir();
      aviso(`Criada a solicitação #${copia.numero}`);
      return ir('editor', { solAberta: copia.id });
    }
    case 'excluir': {
      if (!confirm(`Excluir a solicitação #${s.numero}? Os anexos também serão removidos.`)) return;
      for (const a of s.anexos || []) await window.api.removerAnexo(s.id, a.arquivo);
      state.dados.solicitacoes = state.dados.solicitacoes.filter((x) => x.id !== s.id);
      persistir();
      return ir('solicitacoes');
    }
    case 'abrir-pasta': return window.api.abrirPasta();
    case 'trocar-pasta': {
      await salvarAgora();
      const r = await window.api.escolherPasta();
      if (!r || !r.mudou) return;
      await carregar();
      return aviso(r.usouExistente ? 'Usando os dados que já estavam na pasta escolhida.' : 'Dados copiados para a nova pasta.');
    }
    case 'exportar-backup': {
      const f = await window.api.salvarTexto(`backup-solicitacoes-${L.hoje()}.json`, JSON.stringify(state.dados, null, 1),
        { name: 'Backup', extensions: ['json'] });
      return f && aviso('Backup exportado (os anexos ficam na pasta de dados).');
    }
    case 'importar-backup': {
      const dados = await window.api.importarBackup();
      if (!dados) return;
      if (!Array.isArray(dados.solicitacoes) || !Array.isArray(dados.pacientes)) return alert('Arquivo de backup inválido.');
      if (!confirm(`Substituir os dados atuais por este backup (${dados.solicitacoes.length} solicitações, ${dados.pacientes.length} pacientes)?`)) return;
      state.dados = dados;
      await salvarAgora();
      await carregar();
      return aviso('Backup importado.');
    }
    default:
  }
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !$('#modal').open) { e.preventDefault(); novaSolicitacao(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && state.tela === 'solicitacoes') { e.preventDefault(); $('#fBusca').focus(); }
});

carregar();
