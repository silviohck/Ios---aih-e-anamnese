// Testes das regras de prazo, status e filtros. Uso: npm test
const test = require('node:test');
const assert = require('assert');
const L = require('../src/renderer/logic.js');

test('Páscoa e Sexta-feira Santa', () => {
  assert.strictEqual(L.pascoa(2025), '2025-04-20');
  assert.strictEqual(L.pascoa(2026), '2026-04-05');
  assert.ok(L.feriadosNacionais(2026).has('2026-04-03'));
});

test('dias úteis pulam fim de semana e feriados', () => {
  // sexta 13/11/2026 + 1 dia útil: 16/11 (segunda); 15/11 é domingo
  assert.strictEqual(L.somarDiasUteis('2026-11-13', 1), '2026-11-16');
  // quinta 19/11/2026 + 1: 20/11 é Consciência Negra (feriado), cai na segunda 23/11
  assert.strictEqual(L.somarDiasUteis('2026-11-19', 1), '2026-11-23');
  // feriado local informado pelo usuário
  assert.strictEqual(L.somarDiasUteis('2026-11-16', 1, ['2026-11-17']), '2026-11-18');
});

test('data limite usa prazo do tipo, prazo próprio e urgência', () => {
  const base = { dataEnvio: '2026-11-02', tipo: 'exame_lab' }; // segunda
  assert.strictEqual(L.dataLimite(base), '2026-11-05');
  assert.strictEqual(L.dataLimite({ ...base, prazoDias: 1 }), '2026-11-03');
  assert.strictEqual(L.dataLimite({ ...base, carater: 'urgencia' }), '2026-11-02');
  assert.strictEqual(L.dataLimite({ ...base, tipo: 'exame' }, { prazos: { exame: 2 } }), '2026-11-04');
  assert.strictEqual(L.dataLimite({ tipo: 'exame' }), null);
});

test('alertas de prazo, senha, retorno e pagamento', () => {
  const s = { status: 'analise', dataEnvio: '2026-11-02', tipo: 'exame_lab' }; // limite 05/11
  assert.deepStrictEqual(L.alertas(s, {}, '2026-11-01').map((a) => a.tipo), []);
  assert.deepStrictEqual(L.alertas(s, {}, '2026-11-05').map((a) => a.tipo), ['vence']);
  assert.deepStrictEqual(L.alertas(s, {}, '2026-11-09').map((a) => a.tipo), ['atrasada']);
  // depois de autorizada o prazo não conta mais; senha vencendo sim
  const aut = { ...s, status: 'autorizada', validadeSenha: '2026-11-12' };
  assert.deepStrictEqual(L.alertas(aut, {}, '2026-11-09').map((a) => a.tipo), ['senha_vence']);
  assert.deepStrictEqual(L.alertas(aut, {}, '2026-11-13').map((a) => a.tipo), ['senha_vencida']);
  assert.deepStrictEqual(L.alertas({ status: 'rascunho', retorno: '2026-11-03' }, {}, '2026-11-03').map((a) => a.tipo), ['retorno']);
  assert.deepStrictEqual(L.alertas({ status: 'realizada', retorno: '2026-11-03' }, {}, '2026-11-04'), []);
  const part = { status: 'agendada', particular: true, valor: 500, pagamento: 'pendente', dataAgendada: '2026-11-10' };
  assert.deepStrictEqual(L.alertas(part, {}, '2026-11-04').map((a) => a.tipo), ['pagamento']);
  assert.deepStrictEqual(L.alertas({ ...part, pagamento: 'pago' }, {}, '2026-11-11').map((a) => a.tipo), ['confirmar']);
});

test('mudarStatus registra histórico e datas', () => {
  const s = { status: 'rascunho', historico: [] };
  const e = L.mudarStatus(s, 'enviada', 'pelo portal', '2026-11-03T10:00:00.000Z');
  assert.strictEqual(e.dataEnvio, '2026-11-03');
  assert.strictEqual(e.historico.length, 1);
  assert.deepStrictEqual([e.historico[0].de, e.historico[0].para, e.historico[0].texto], ['rascunho', 'enviada', 'pelo portal']);
  const a = L.mudarStatus(e, 'autorizada', '', '2026-11-05T10:00:00.000Z');
  assert.strictEqual(a.dataResposta, '2026-11-05');
  assert.strictEqual(a.dataEnvio, '2026-11-03');
  assert.strictEqual(s.historico.length, 0, 'não altera o original');
  assert.strictEqual(L.mudarStatus(a, 'autorizada'), a);
});

test('filtro por texto sem acento, status e alertas', () => {
  const ctx = {
    pacientes: [{ id: 'p1', nome: 'João da Conceição' }, { id: 'p2', nome: 'Maria Souza' }],
    convenios: [{ id: 'c1', nome: 'Unimed' }], config: {}, hoje: '2026-11-20',
  };
  const lista = [
    { id: 1, pacienteId: 'p1', convenioId: 'c1', status: 'analise', tipo: 'exame_lab', dataEnvio: '2026-11-02', descricao: 'Hemograma' },
    { id: 2, pacienteId: 'p2', convenioId: 'c1', status: 'realizada', tipo: 'cirurgia', descricao: 'Colecistectomia' },
  ];
  const ids = (f) => L.filtrar(lista, f, ctx).map((s) => s.id);
  assert.deepStrictEqual(ids({ busca: 'joao conceicao' }), [1]);
  assert.deepStrictEqual(ids({ busca: 'unimed' }), [1, 2]);
  assert.deepStrictEqual(ids({ status: 'abertas' }), [1]);
  assert.deepStrictEqual(ids({ status: 'todas', tipo: 'cirurgia' }), [2]);
  assert.deepStrictEqual(ids({ soAlertas: true }), [1]);
});

test('CSV com ; e aspas para o Excel', () => {
  const s = L.csv([['a', 'b;c'], ['x"y', 1]]);
  assert.strictEqual(s, '﻿a;"b;c"\r\n"x""y";1');
});
