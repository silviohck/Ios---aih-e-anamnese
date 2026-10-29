// Gera um PDF de exemplo com campos preenchíveis para testar o app.
// Uso: node tests/make-sample.js [saida.pdf]
const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts } = require(path.join(__dirname, '..', 'vendor', 'pdf-lib.min.js'));

(async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const form = doc.getForm();
  page.drawText('Laudo de exemplo — AIH / Anamnese', { x: 50, y: 790, size: 16, font });

  let y = 740;
  const label = (t) => page.drawText(t, { x: 50, y: y + 6, size: 10, font });

  label('Nome do paciente');
  form.createTextField('paciente.nome').addToPage(page, { x: 200, y, width: 340, height: 20 });
  y -= 40;
  label('Cartão SUS');
  const cns = form.createTextField('paciente.cns');
  cns.setMaxLength(15);
  cns.addToPage(page, { x: 200, y, width: 200, height: 20 });
  y -= 40;
  label('Sexo');
  const sexo = form.createDropdown('paciente.sexo');
  sexo.addOptions(['Masculino', 'Feminino']);
  sexo.addToPage(page, { x: 200, y, width: 150, height: 20 });
  y -= 40;
  label('Caráter');
  const carater = form.createRadioGroup('carater_internacao');
  carater.addOptionToPage('Eletivo', page, { x: 200, y, width: 15, height: 15 });
  carater.addOptionToPage('Urgencia', page, { x: 300, y, width: 15, height: 15 });
  y -= 40;
  label('Alergias?');
  form.createCheckBox('tem_alergia').addToPage(page, { x: 200, y, width: 15, height: 15 });
  y -= 120;
  label('Anamnese');
  const hda = form.createTextField('anamnese_hda');
  hda.enableMultiline();
  hda.addToPage(page, { x: 200, y, width: 340, height: 100 });

  const out = process.argv[2] || path.join(__dirname, 'exemplo-formulario.pdf');
  fs.writeFileSync(out, await doc.save());
  console.log('PDF de exemplo salvo em', out);
})();
