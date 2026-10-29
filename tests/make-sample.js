// Gera PDFs de exemplo com campos preenchíveis para testar o app:
// tests/exemplo-aih.pdf e tests/exemplo-anamnese.pdf
// Uso: node tests/make-sample.js
const fs = require('fs');
const path = require('path');
const { PDFDocument, PDFName, PDFHexString, StandardFonts } = require(path.join(__dirname, '..', 'vendor', 'pdf-lib.min.js'));

async function build(title, draw) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(title, { x: 50, y: 790, size: 16, font });
  const ctx = {
    form: doc.getForm(),
    page,
    y: 740,
    label(t) { page.drawText(t, { x: 50, y: ctx.y + 6, size: 10, font }); },
  };
  draw(ctx);
  return doc.save();
}

(async () => {
  const aihBytes = await build('Laudo de exemplo — AIH', (c) => {
    const { form, page } = c;
    c.label('Nome do paciente');
    form.createTextField('paciente.nome').addToPage(page, { x: 200, y: c.y, width: 340, height: 20 });
    c.y -= 40;
    c.label('Cartão SUS');
    const cns = form.createTextField('paciente.cns');
    cns.setMaxLength(15);
    cns.addToPage(page, { x: 200, y: c.y, width: 200, height: 20 });
    c.y -= 40;
    c.label('Sexo');
    const sexo = form.createDropdown('paciente.sexo');
    sexo.addOptions(['Masculino', 'Feminino']);
    sexo.addToPage(page, { x: 200, y: c.y, width: 150, height: 20 });
    c.y -= 40;
    c.label('Caráter');
    const carater = form.createRadioGroup('carater_internacao');
    carater.addOptionToPage('Eletivo', page, { x: 200, y: c.y, width: 15, height: 15 });
    carater.addOptionToPage('Urgencia', page, { x: 300, y: c.y, width: 15, height: 15 });
    c.y -= 40;
    c.label('Alergias?');
    form.createCheckBox('tem_alergia').addToPage(page, { x: 200, y: c.y, width: 15, height: 15 });
    c.y -= 120;
    c.label('Anamnese');
    const hda = form.createTextField('anamnese_hda');
    hda.enableMultiline();
    hda.addToPage(page, { x: 200, y: c.y, width: 340, height: 100 });
  });

  // Ficha de anamnese com nomes de campo genéricos e descrição (tooltip),
  // como acontece em muitos formulários reais.
  const anamneseBytes = await build('Ficha de anamnese — exemplo', (c) => {
    const { form, page } = c;
    const text = (name, tooltip, label, opts = {}) => {
      c.label(label);
      const f = form.createTextField(name);
      if (tooltip) f.acroField.dict.set(PDFName.of('TU'), PDFHexString.fromText(tooltip));
      if (opts.multiline) f.enableMultiline();
      const h = opts.multiline ? 80 : 20;
      if (opts.multiline) c.y -= h - 20;
      f.addToPage(page, { x: 200, y: c.y, width: 340, height: h });
      c.y -= 40;
    };
    text('Texto1', 'Nome do paciente', 'Nome do paciente');
    text('cns_paciente', null, 'Cartão SUS');
    text('Texto3', 'Queixa principal', 'Queixa principal');
    text('Texto4', 'História da doença atual', 'HDA', { multiline: true });
    text('Texto5', 'Medicamentos em uso', 'Medicamentos', { multiline: true });
    c.label('Alergias?');
    form.createCheckBox('tem_alergia').addToPage(page, { x: 200, y: c.y, width: 15, height: 15 });
  });

  fs.writeFileSync(path.join(__dirname, 'exemplo-aih.pdf'), aihBytes);
  fs.writeFileSync(path.join(__dirname, 'exemplo-anamnese.pdf'), anamneseBytes);
  console.log('PDFs de exemplo salvos em tests/');
})();
