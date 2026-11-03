// Regras de negócio puras (sem DOM): status, prazos em dias úteis, filtros.
// Usado pela interface e pelos testes em Node.
(function (root) {
  const STATUS = [
    { id: 'rascunho', nome: 'A enviar', cor: 'cinza', final: false },
    { id: 'enviada', nome: 'Enviada', cor: 'azul', final: false },
    { id: 'analise', nome: 'Em análise', cor: 'azul', final: false },
    { id: 'pendencia', nome: 'Pendência', cor: 'laranja', final: false },
    { id: 'autorizada', nome: 'Autorizada', cor: 'verde', final: false },
    { id: 'parcial', nome: 'Autorizada parcial', cor: 'verde', final: false },
    { id: 'negada', nome: 'Negada', cor: 'vermelho', final: false },
    { id: 'agendada', nome: 'Agendada', cor: 'roxo', final: false },
    { id: 'realizada', nome: 'Realizada', cor: 'cinza', final: true },
    { id: 'cancelada', nome: 'Cancelada', cor: 'cinza', final: true },
  ];

  // Status em que ainda se espera resposta da operadora (conta prazo)
  const AGUARDANDO_RESPOSTA = ['enviada', 'analise', 'pendencia'];

  const TIPOS = [
    { id: 'consulta', nome: 'Consulta' },
    { id: 'exame_lab', nome: 'Exame laboratorial' },
    { id: 'exame', nome: 'Exame de imagem / diagnóstico' },
    { id: 'terapia', nome: 'Terapia / sessões' },
    { id: 'procedimento', nome: 'Procedimento ambulatorial' },
    { id: 'alta_complexidade', nome: 'Procedimento de alta complexidade' },
    { id: 'hospital_dia', nome: 'Hospital-dia' },
    { id: 'cirurgia', nome: 'Cirurgia / internação eletiva' },
    { id: 'opme', nome: 'OPME (órteses, próteses, materiais)' },
    { id: 'outro', nome: 'Outro' },
  ];

  // Prazos de referência em dias úteis (garantia de atendimento, ANS RN 566/2022).
  // São editáveis em Configurações: confira a norma vigente e o contrato.
  const PRAZOS_PADRAO = {
    consulta: 14, exame_lab: 3, exame: 10, terapia: 10, procedimento: 10,
    alta_complexidade: 21, hospital_dia: 10, cirurgia: 21, opme: 21, outro: 10,
  };

  const statusPorId = (id) => STATUS.find((s) => s.id === id) || STATUS[0];
  const tipoPorId = (id) => TIPOS.find((t) => t.id === id) || TIPOS[TIPOS.length - 1];

  // ---------- Datas (sempre 'AAAA-MM-DD', sem fuso) ----------
  const pad = (n) => String(n).padStart(2, '0');
  const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const fromISO = (s) => {
    const [y, m, d] = String(s).split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const hoje = () => toISO(new Date());
  const addDias = (iso, n) => { const d = fromISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
  const diffDias = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000); // b - a

  function pascoa(ano) {
    const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
    const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const mes = Math.floor((h + l - 7 * m + 114) / 31), dia = ((h + l - 7 * m + 114) % 31) + 1;
    return toISO(new Date(ano, mes - 1, dia));
  }

  const cacheFeriados = {};
  function feriadosNacionais(ano) {
    if (cacheFeriados[ano]) return cacheFeriados[ano];
    const fixos = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '11-20', '12-25'];
    const set = new Set(fixos.map((md) => `${ano}-${md}`));
    set.add(addDias(pascoa(ano), -2)); // Sexta-feira Santa
    cacheFeriados[ano] = set;
    return set;
  }

  function diaUtil(iso, extras = []) {
    const d = fromISO(iso);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return false;
    if (feriadosNacionais(d.getFullYear()).has(iso)) return false;
    return !extras.includes(iso);
  }

  // Conta n dias úteis a partir do dia seguinte a `inicio`
  function somarDiasUteis(inicio, n, extras = []) {
    let d = inicio;
    let restantes = n;
    if (restantes <= 0) return inicio;
    while (restantes > 0) {
      d = addDias(d, 1);
      if (diaUtil(d, extras)) restantes--;
    }
    return d;
  }

  // ---------- Solicitações ----------
  function dataLimite(sol, config = {}) {
    if (!sol.dataEnvio) return null;
    if (sol.carater === 'urgencia') return sol.dataEnvio;
    const prazos = { ...PRAZOS_PADRAO, ...(config.prazos || {}) };
    const dias = Number(sol.prazoDias || prazos[sol.tipo] || PRAZOS_PADRAO.outro);
    return somarDiasUteis(sol.dataEnvio, dias, config.feriadosExtras || []);
  }

  // Situação calculada para o painel: atrasada, vence logo, senha vencendo etc.
  function alertas(sol, config = {}, ref = hoje()) {
    const out = [];
    const lim = dataLimite(sol, config);
    if (AGUARDANDO_RESPOSTA.includes(sol.status) && lim) {
      const d = diffDias(ref, lim);
      if (d < 0) out.push({ tipo: 'atrasada', texto: `Prazo vencido há ${-d} dia(s)`, nivel: 'alto' });
      else if (d <= 2) out.push({ tipo: 'vence', texto: d === 0 ? 'Prazo vence hoje' : `Prazo vence em ${d} dia(s)`, nivel: 'medio' });
    }
    if (['autorizada', 'parcial'].includes(sol.status) && sol.validadeSenha) {
      const d = diffDias(ref, sol.validadeSenha);
      if (d < 0) out.push({ tipo: 'senha_vencida', texto: 'Senha de autorização vencida', nivel: 'alto' });
      else if (d <= 7) out.push({ tipo: 'senha_vence', texto: `Senha vence em ${d} dia(s)`, nivel: 'medio' });
    }
    if (sol.status === 'pendencia') out.push({ tipo: 'pendencia', texto: 'Operadora pediu documentos', nivel: 'medio' });
    if (sol.retorno && !statusPorId(sol.status).final && diffDias(ref, sol.retorno) <= 0) {
      out.push({ tipo: 'retorno', texto: diffDias(ref, sol.retorno) === 0 ? 'Retornar hoje' : 'Retorno atrasado', nivel: 'medio' });
    }
    if (sol.status === 'agendada' && sol.dataAgendada && diffDias(ref, sol.dataAgendada) < 0) {
      out.push({ tipo: 'confirmar', texto: 'Data passou: confirmar se foi realizada', nivel: 'medio' });
    }
    if (sol.particular && sol.valor && sol.pagamento !== 'pago' && ['agendada', 'realizada'].includes(sol.status)) {
      out.push({ tipo: 'pagamento', texto: 'Pagamento particular em aberto', nivel: 'medio' });
    }
    return out;
  }

  // Aplica uma mudança de status registrando no histórico
  function mudarStatus(sol, novo, texto = '', quando = new Date().toISOString()) {
    if (sol.status === novo) return sol;
    const hist = [...(sol.historico || []), { em: quando, tipo: 'status', de: sol.status, para: novo, texto }];
    const out = { ...sol, status: novo, historico: hist, atualizadoEm: quando };
    const dia = quando.slice(0, 10);
    if (novo === 'enviada' && !sol.dataEnvio) out.dataEnvio = dia;
    if (['autorizada', 'parcial', 'negada'].includes(novo) && !sol.dataResposta) out.dataResposta = dia;
    if (novo === 'realizada' && !sol.dataRealizada) out.dataRealizada = dia;
    return out;
  }

  const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function filtrar(lista, filtro, ctx) {
    const q = normalizar(filtro.busca);
    return lista.filter((s) => {
      if (filtro.status === 'abertas' && statusPorId(s.status).final) return false;
      if (filtro.status && filtro.status !== 'abertas' && filtro.status !== 'todas' && s.status !== filtro.status) return false;
      if (filtro.tipo && s.tipo !== filtro.tipo) return false;
      if (filtro.convenioId && s.convenioId !== filtro.convenioId) return false;
      if (filtro.soAlertas && alertas(s, ctx.config, ctx.hoje).length === 0) return false;
      if (q) {
        const pac = ctx.pacientes.find((p) => p.id === s.pacienteId) || {};
        const conv = ctx.convenios.find((c) => c.id === s.convenioId) || {};
        const texto = [s.numero, s.descricao, s.codigo, s.cid, s.medico, s.local, s.protocolo, s.senha,
          pac.nome, pac.cpf, pac.carteirinha, conv.nome].map(normalizar).join(' ');
        if (!q.split(/\s+/).every((t) => texto.includes(t))) return false;
      }
      return true;
    });
  }

  function csv(linhas) {
    const esc = (v) => {
      const s = v == null ? '' : String(v);
      return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // ';' e BOM para abrir direto no Excel em português
    return '﻿' + linhas.map((l) => l.map(esc).join(';')).join('\r\n');
  }

  const fmtData = (iso) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
  const fmtDinheiro = (v) => (v === '' || v == null ? '' :
    Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

  const api = {
    STATUS, TIPOS, PRAZOS_PADRAO, AGUARDANDO_RESPOSTA, statusPorId, tipoPorId,
    hoje, addDias, diffDias, pascoa, feriadosNacionais, diaUtil, somarDiasUteis,
    dataLimite, alertas, mudarStatus, filtrar, normalizar, csv, fmtData, fmtDinheiro,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Logic = api;
})(typeof window !== 'undefined' ? window : globalThis);
