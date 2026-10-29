// Gera PDFs de exemplo no formato usado no app: AIH (página 1) e anamnese
// (página 2) no mesmo arquivo, com o cadastro do paciente já preenchido.
// Saída: tests/exemplo-paciente-1.pdf, tests/exemplo-paciente-2.pdf e dois
// formulários em branco (tests/exemplo-branco-*.pdf)
// Uso: node tests/make-sample.js
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFHexString, StandardFonts } = require(path.join(__dirname, '..', 'vendor', 'pdf-lib.min.js'));

async function build(patient, local = '') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  let page;
  let y;
  const newPage = (title) => {
    page = doc.addPage([595, 842]);
    page.drawText(title, { x: 50, y: 790, size: 16, font });
    y = 740;
  };
  const label = (t) => page.drawText(t, { x: 50, y: y + 6, size: 10, font });
  const text = (name, title, { value, tooltip, multiline } = {}) => {
    label(title);
    const f = form.createTextField(name);
    if (tooltip) f.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(tooltip));
    if (multiline) { f.enableMultiline(); y -= 60; }
    f.addToPage(page, { x: 200, y, width: 340, height: multiline ? 80 : 20 });
    if (value) f.setText(value);
    y -= 40;
  };

  newPage(`Laudo para solicitação de AIH — exemplo${local ? ` — ${local}` : ''}`);
  text('paciente.nome', 'Nome do paciente', { value: patient.nome });
  text('paciente.cns', 'Cartão SUS', { value: patient.cns });
  text('paciente.endereco', 'Endereço', { value: patient.endereco });
  text('estabelecimento', 'Estabelecimento');
  label('Caráter da internação');
  const carater = form.createRadioGroup('carater_internacao');
  carater.addOptionToPage('Eletivo', page, { x: 200, y, width: 15, height: 15 });
  carater.addOptionToPage('Urgencia', page, { x: 300, y, width: 15, height: 15 });
  y -= 40;
  label('Clínica');
  const clinica = form.createDropdown('clinica');
  clinica.addOptions(['Cirúrgica', 'Clínica médica', 'Obstétrica', 'Pediátrica']);
  clinica.addToPage(page, { x: 200, y, width: 200, height: 20 });
  y -= 40;
  text('cid_principal', 'CID principal');
  text('medico_solicitante', 'Médico solicitante');

  newPage('Ficha de anamnese — exemplo');
  text('Texto1', 'Queixa principal', { tooltip: 'Queixa principal' });
  text('Texto2', 'HDA', { tooltip: 'História da doença atual', multiline: true });
  label('Alergias?');
  form.createCheckBox('tem_alergia').addToPage(page, { x: 200, y, width: 15, height: 15 });

  return doc.save();
}

(async () => {
  const pacientes = [
    { nome: 'Maria José da Conceição', cns: '898001234567890', endereco: 'Rua das Flores, 120 — Centro' },
    { nome: 'João Pereira Lima', cns: '700509876543210', endereco: 'Av. Brasil, 45 — Jardim América' },
  ];
  for (const [i, p] of pacientes.entries()) {
    fs.writeFileSync(path.join(__dirname, `exemplo-paciente-${i + 1}.pdf`), await build(p));
  }
  // Formulários em branco de dois locais (para testar o documento favorito)
  fs.writeFileSync(path.join(__dirname, 'exemplo-branco-hospital.pdf'), await build({}, 'Hospital São Lucas'));
  fs.writeFileSync(path.join(__dirname, 'exemplo-branco-upa.pdf'), await build({}, 'UPA Centro'));
  console.log('PDFs de exemplo salvos em tests/');
})();
